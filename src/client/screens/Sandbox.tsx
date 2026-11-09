import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { patternText } from '../rankInput';
import { PlayingCard, rankText } from '../components/Card';
import {
  buildAssumedHand,
  decideShowdown,
  effectiveIndex,
  evaluateHand,
  isLegalAssumedRank,
  legalAssumedRanks,
  maxAssumableRank,
  suggestAssumed,
  type EvaluatedHand,
} from '../../rules/evaluate';
import {
  tryResolveRanking,
  type RankOverride,
  type RankingProfile,
  type ResolvedRanking,
} from '../../rules/ranking';
import { MAX_RANK, MIN_RANK, SUITS, type Card, type Suit } from '../../rules/cards';
import { REQUIRED_ORDER_HANDS, EXTRA_SAMPLE_HANDS } from '../../rules/profiles';
import type { DealingMode, ThreeCardCompare } from '../../rules/types';

interface SandboxHand {
  id: string;
  cards: Card[]; // physical cards only
  assumed: number | null;
  custom?: boolean;
}

const emptyCard = (rank = 14, suit: Suit = 'S'): Card => ({ id: `${suit}${rank}`, rank, suit });

function makeCard(rank: number, suit: Suit): Card {
  return { id: `${suit}${rank}`, rank, suit };
}

function physicalCountFor(mode: DealingMode): number {
  return mode === 'THREE_CARD' ? 3 : mode === 'TWO_CARD_ASSUMED' ? 2 : 1;
}

let idCounter = 0;
const nextId = () => `h${++idCounter}`;

export function Sandbox() {
  const [profiles, setProfiles] = useState<RankingProfile[]>([]);
  const [profileId, setProfileId] = useState<string>('house-default');
  const [muflis, setMuflis] = useState(false);
  const [mode, setMode] = useState<DealingMode>('THREE_CARD');
  const [threeCardCompare, setThreeCardCompare] = useState<ThreeCardCompare>('FULL_HAND');
  const [shared, setShared] = useState<Card>(() => makeCard(14, 'S'));
  const [hands, setHands] = useState<SandboxHand[]>(() =>
    REQUIRED_ORDER_HANDS.slice(0, 3).map((h) => ({ id: nextId(), cards: h.cards, assumed: null })),
  );
  const [manualOrder, setManualOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [extraOverrides, setExtraOverrides] = useState<RankOverride[]>([]);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);

  useEffect(() => {
    api<RankingProfile[]>('/api/profiles')
      .then((list) => {
        setProfiles(list);
        if (list.length && !list.some((p) => p.id === profileId)) setProfileId(list[0].id);
      })
      .catch(() => setProfiles([]));
  }, [profileId]);

  const baseProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId],
  );
  const effectiveProfile = useMemo<RankingProfile | null>(
    () => (baseProfile ? { ...baseProfile, overrides: [...baseProfile.overrides, ...extraOverrides] } : null),
    [baseProfile, extraOverrides],
  );
  const resolution = useMemo(() => (effectiveProfile ? tryResolveRanking(effectiveProfile) : null), [effectiveProfile]);

  const ranking: ResolvedRanking | null = resolution?.ok ? resolution.ranking : null;
  const physicalCount = physicalCountFor(mode);

  const evaluated = useMemo(() => {
    if (!ranking) return [] as Array<{ hand: SandboxHand; result: EvaluatedHand | null; error: string | null; index: number }>;
    return hands.map((hand) => {
      try {
        const physical = hand.cards.slice(0, physicalCount).filter((c) => c.suit !== null);
        if (physical.length < physicalCount) {
          return { hand, result: null, error: 'Hand is incomplete for this dealing mode.', index: Number.POSITIVE_INFINITY };
        }
        if (mode === 'THREE_CARD') {
          const result = evaluateHand(physical, ranking);
          return { hand, result, error: null, index: effectiveIndex(result, ranking, muflis) };
        }
        const pool = mode === 'ONE_CARD_SHARED' ? [...physical, shared] : physical;
        const suggested = suggestAssumed(physical, ranking, muflis, mode === 'ONE_CARD_SHARED' ? shared : undefined);
        const assumed = hand.assumed ?? suggested.rank;
        if (!isLegalAssumedRank(assumed, pool)) {
          return {
            hand,
            result: null,
            error: `Assumed ${rankText(assumed)} is not allowed: it must be ${rankText(maxAssumableRank(pool))} or lower.`,
            index: Number.POSITIVE_INFINITY,
          };
        }
        const result = evaluateHand(
          buildAssumedHand(physical, assumed, mode === 'ONE_CARD_SHARED' ? shared : undefined),
          ranking,
        );
        return { hand, result, error: null, index: effectiveIndex(result, ranking, muflis) };
      } catch (error) {
        return { hand, result: null, error: (error as Error).message, index: Number.POSITIVE_INFINITY };
      }
    });
  }, [hands, ranking, mode, muflis, shared, physicalCount]);

  const duplicateCards = useMemo(() => {
    const seen = new Map<string, number>();
    const dups = new Set<string>();
    for (const hand of hands) {
      for (const card of hand.cards.slice(0, physicalCount)) {
        const key = `${card.suit}${card.rank}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > 1) dups.add(key);
      }
    }
    if (mode === 'ONE_CARD_SHARED') {
      for (const hand of hands) {
        const card = hand.cards[0];
        if (card && card.rank === shared.rank && card.suit === shared.suit) dups.add(`${shared.suit}${shared.rank}`);
      }
    }
    return dups;
  }, [hands, physicalCount, mode, shared]);

  const display = useMemo(() => {
    const valid = evaluated.filter((e) => e.result);
    if (manualOrder) {
      const byId = new Map(evaluated.map((e) => [e.hand.id, e]));
      return manualOrder.map((id) => byId.get(id)).filter(Boolean) as typeof evaluated;
    }
    return valid.slice().sort((a, b) => a.index - b.index);
  }, [evaluated, manualOrder]);

  const comparisons = useMemo(() => {
    if (!ranking || !display.length) return [];
    const out: Array<{ a: string; b: string; reason: string; winner: 'a' | 'b' | 'tie'; correct: boolean }> = [];
    for (let i = 0; i < display.length - 1; i++) {
      const a = display[i];
      const b = display[i + 1];
      if (!a.result || !b.result) continue;
      const res = decideShowdown(a.result, b.result, {
        ranking,
        muflis,
        mode,
        threeCardCompare,
        initiator: 'a',
        sharedCardId: mode === 'ONE_CARD_SHARED' ? shared.id : undefined,
      });
      out.push({
        a: a.result.label,
        b: b.result.label,
        reason: res.reason,
        winner: res.winner,
        correct: res.winner === 'a',
      });
    }
    return out;
  }, [display, ranking, muflis, mode, threeCardCompare, shared]);

  function updateHand(id: string, patch: Partial<SandboxHand>) {
    setHands((list) => list.map((h) => (h.id === id ? { ...h, ...patch } : h)));
    setManualOrder(null);
  }

  function addHand(cards?: Card[]) {
    const used = hands.flatMap((h) => h.cards.slice(0, physicalCount).map((c) => `${c.suit}${c.rank}`));
    const defaults: Card[] = [];
    for (let i = 0; i < physicalCount; i++) {
      const ranks = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
      let candidate: Card | null = null;
      for (const rank of ranks) {
        for (const suit of SUITS) {
          const key = `${suit}${rank}`;
          if (!used.includes(key) && !defaults.some((c) => `${c.suit}${c.rank}` === key)) {
            candidate = makeCard(rank, suit);
            break;
          }
        }
        if (candidate) break;
      }
      defaults.push(candidate ?? emptyCard());
    }
    setHands((list) => [...list, { id: nextId(), cards: mode === 'THREE_CARD' ? cards ?? defaults : defaults.slice(0, physicalCount), assumed: null }]);
    setManualOrder(null);
  }

  function loadRequiredHands() {
    setHands(REQUIRED_ORDER_HANDS.map((h) => ({ id: nextId(), cards: h.cards, assumed: null })));
    setManualOrder(null);
    setMode('THREE_CARD');
    setMessage(null);
  }

  function loadSamples() {
    setHands(EXTRA_SAMPLE_HANDS.map((h) => ({ id: nextId(), cards: h.cards, assumed: null })));
    setManualOrder(null);
    setMessage(null);
  }

  function saveOrderAsConstraints() {
    if (!display.length) return;
    const rules: RankOverride[] = [];
    for (let i = 0; i < display.length - 1; i++) {
      const a = display[i].result;
      const b = display[i + 1].result;
      if (!a || !b || a.pattern === b.pattern) continue;
      rules.push({ stronger: a.pattern, weaker: b.pattern });
    }
    if (rules.length === 0) {
      setMessage({ text: 'The order only contains identical rank patterns.', kind: 'error' });
      return;
    }
    const merged = [...extraOverrides];
    for (const rule of rules) {
      if (!merged.some((r) => r.stronger === rule.stronger && r.weaker === rule.weaker)) merged.push(rule);
    }
    const candidate = baseProfile ? { ...baseProfile, overrides: [...baseProfile.overrides, ...merged] } : null;
    const check = candidate ? tryResolveRanking(candidate) : null;
    if (!candidate || !check?.ok) {
      setExtraOverrides(merged);
      setMessage({ text: check && !check.ok ? check.error : 'No profile selected.', kind: 'error' });
      return;
    }
    setExtraOverrides(merged);
    setMessage({ text: `Added ${rules.length} constraint(s): ${rules.map((r) => `${patternText(r.stronger)} > ${patternText(r.weaker)}`).join(', ')}.`, kind: 'ok' });
    setManualOrder(null);
  }

  async function saveAsProfile() {
    if (!effectiveProfile) return;
    try {
      const saved = await api<RankingProfile>('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({ ...effectiveProfile, id: `sandbox_${Math.random().toString(36).slice(2, 9)}`, name: `${effectiveProfile.name} (sandbox)` }),
      });
      setProfiles((list) => [...list, saved]);
      setProfileId(saved.id);
      setExtraOverrides([]);
      setMessage({ text: `Saved as "${saved.name}" v${saved.version}. Live rooms keep their frozen profile.`, kind: 'ok' });
    } catch (error) {
      setMessage({ text: (error as Error).message, kind: 'error' });
    }
  }

  function runRequiredTests() {
    if (!ranking) return;
    const results: string[] = [];
    const chain = REQUIRED_ORDER_HANDS;
    const evaluatePair = (a: (typeof chain)[number], b: (typeof chain)[number], reversed: boolean) => {
      const ha = evaluateHand(a.cards, ranking);
      const hb = evaluateHand(b.cards, ranking);
      const res = decideShowdown(ha, hb, { ranking, muflis: reversed, mode: 'THREE_CARD', threeCardCompare: 'FULL_HAND' });
      return reversed ? res.winner === 'b' : res.winner === 'a';
    };
    for (let i = 0; i < chain.length - 1; i++) {
      const normal = evaluatePair(chain[i], chain[i + 1], false);
      const reversed = evaluatePair(chain[i], chain[i + 1], true);
      results.push(`${chain[i].label} > ${chain[i + 1].label}: Normal ${normal ? 'PASS' : 'FAIL'}, Muflis ${reversed ? 'PASS' : 'FAIL'}`);
    }
    // card order independence
    const shuffled = chain[1].cards.slice().reverse();
    const a = evaluateHand(chain[1].cards, ranking);
    const b = evaluateHand(shuffled, ranking);
    results.push(`Card order independence: ${a.classKey === b.classKey ? 'PASS' : 'FAIL'}`);
    setMessage({ text: results.join(' · '), kind: results.every((r) => r.includes('PASS')) ? 'ok' : 'error' });
  }

  const legalAssumedFor = (hand: SandboxHand): number[] => {
    const physical = hand.cards.slice(0, physicalCount).filter((c) => c.suit);
    if (!physical.length) return [];
    try {
      return legalAssumedRanks(mode === 'ONE_CARD_SHARED' ? [...physical, shared] : physical);
    } catch {
      return [];
    }
  };

  return (
    <div className="sandbox">
      <header className="editor__head">
        <div>
          <h2>Ranking test &amp; ordering sandbox</h2>
          <p className="muted small">
            Nothing here touches live games or chip balances. Compare hands, drag them into an order, and turn that order
            into constraints.
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={loadRequiredHands}>
            Load required example
          </button>
          <button className="btn" onClick={loadSamples}>
            Load samples
          </button>
          <button className="btn" onClick={runRequiredTests}>
            Run required tests
          </button>
        </div>
      </header>

      {message && <div className={`notice notice--${message.kind}`}>{message.text}</div>}
      {resolution && !resolution.ok && <div className="notice notice--error">{resolution.error}</div>}
      {duplicateCards.size > 0 && (
        <div className="notice notice--error">
          Impossible physical deal: card(s) {Array.from(duplicateCards).join(', ')} appear more than once.
        </div>
      )}

      <div className="sandbox__grid">
        <section className="panel">
          <h3>Setup</h3>
          <label className="field">
            <span>Ranking profile</span>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (v{p.version})
                </option>
              ))}
            </select>
          </label>

          <label className="checkline">
            <input type="checkbox" checked={muflis} onChange={(e) => setMuflis(e.target.checked)} />
            <span>Muflis (lowest hand wins — strength reversed)</span>
          </label>

          <label className="field">
            <span>Dealing mode</span>
            <select
              value={mode}
              onChange={(e) => {
                const next = e.target.value as DealingMode;
                setMode(next);
                setHands((list) => list.map((h) => ({ ...h, cards: h.cards.slice(0, physicalCountFor(next)) })));
                setManualOrder(null);
              }}
            >
              <option value="THREE_CARD">Three-card</option>
              <option value="TWO_CARD_ASSUMED">Two-card + assumed card</option>
              <option value="ONE_CARD_SHARED">One-card + shared open card</option>
            </select>
          </label>

          {mode === 'THREE_CARD' && (
            <label className="field">
              <span>Three-card comparison</span>
              <select value={threeCardCompare} onChange={(e) => setThreeCardCompare(e.target.value as ThreeCardCompare)}>
                <option value="FULL_HAND">Full three-card hand</option>
                <option value="HIGHEST_CARD">Highest single card</option>
              </select>
            </label>
          )}

          {mode === 'ONE_CARD_SHARED' && (
            <div className="field">
              <span>Shared open card</span>
              <div className="row">
                <select value={shared.rank} onChange={(e) => setShared(makeCard(Number(e.target.value), shared.suit as Suit))}>
                  {ranks().map((r) => (
                    <option key={r} value={r}>
                      {rankText(r)}
                    </option>
                  ))}
                </select>
                <select value={shared.suit ?? 'S'} onChange={(e) => setShared(makeCard(shared.rank, e.target.value as Suit))}>
                  {SUITS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <PlayingCard card={{ rank: shared.rank, suit: shared.suit }} small />
              </div>
            </div>
          )}

          <button className="btn btn--wide" onClick={() => addHand()}>
            + Add hand
          </button>

          <h4>Hands</h4>
          <div className="hand-editors">
            {hands.map((hand) => (
              <div key={hand.id} className="hand-editor">
                <div className="row row--tight">
                  <strong>{hand.cards.slice(0, physicalCount).map((c) => `${rankText(c.rank)}${c.suit}`).join(' ')}</strong>
                  <button className="mini mini--danger" onClick={() => setHands((l) => l.filter((h) => h.id !== hand.id))}>
                    ✕
                  </button>
                </div>
                {Array.from({ length: physicalCount }).map((_, index) => {
                  const card = hand.cards[index] ?? emptyCard();
                  return (
                    <div className="row row--tight" key={index}>
                      <select
                        value={card.rank}
                        onChange={(e) => {
                          const cards = hand.cards.slice();
                          cards[index] = makeCard(Number(e.target.value), (card.suit ?? 'S') as Suit);
                          updateHand(hand.id, { cards });
                        }}
                      >
                        {ranks().map((r) => (
                          <option key={r} value={r}>
                            {rankText(r)}
                          </option>
                        ))}
                      </select>
                      <select
                        value={card.suit ?? 'S'}
                        onChange={(e) => {
                          const cards = hand.cards.slice();
                          cards[index] = makeCard(card.rank, e.target.value as Suit);
                          updateHand(hand.id, { cards });
                        }}
                      >
                        {SUITS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
                {mode !== 'THREE_CARD' && (
                  <div className="row row--tight">
                    <span className="small">Assumed</span>
                    <select
                      value={hand.assumed ?? ''}
                      onChange={(e) => updateHand(hand.id, { assumed: e.target.value === '' ? null : Number(e.target.value) })}
                    >
                      <option value="">auto (suggested)</option>
                      {legalAssumedFor(hand).map((r) => (
                        <option key={r} value={r}>
                          {rankText(r)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>Order (strongest first)</h3>
          <p className="muted small">
            Drag to reorder, then save the order as constraints. {muflis ? 'Muflis is active.' : 'Normal mode.'}
          </p>
          <ul className="sortable sortable--hands">
            {display.map((entry) => (
              <li
                key={entry.hand.id}
                draggable
                onDragStart={() => setDragId(entry.hand.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragId || dragId === entry.hand.id) return;
                  const order = display.map((d) => d.hand.id);
                  const from = order.indexOf(dragId);
                  const to = order.indexOf(entry.hand.id);
                  order.splice(from, 1);
                  order.splice(to, 0, dragId);
                  setManualOrder(order);
                  setDragId(null);
                }}
                className={dragId === entry.hand.id ? 'dragging' : ''}
              >
                <span className="grip">⋮⋮</span>
                <span className="hand-row">
                  {entry.result && <HandPreview result={entry.result} />}
                  <span>
                    <strong>{entry.result?.label ?? '—'}</strong>
                    {entry.result?.assumedRank != null && (
                      <em className="small"> (assumed {rankText(entry.result.assumedRank)})</em>
                    )}
                    <div className="muted small">{entry.error}</div>
                  </span>
                </span>
              </li>
            ))}
            {display.length === 0 && <li className="muted small">Add or complete a hand to see the order.</li>}
          </ul>

          <div className="row">
            <button className="btn" onClick={() => setManualOrder(null)}>
              Reset to rules order
            </button>
            <button className="btn btn--primary" disabled={!manualOrder} onClick={saveOrderAsConstraints}>
              Save order as constraints
            </button>
            <button className="btn" disabled={!effectiveProfile} onClick={() => void saveAsProfile()}>
              Save as new profile
            </button>
          </div>

          <h4>Pairwise explanations</h4>
          <ul className="explain">
            {comparisons.map((c, i) => (
              <li key={i} className={c.correct ? '' : 'explain--bad'}>
                <strong>{c.a}</strong> vs <strong>{c.b}</strong> → {c.winner === 'tie' ? 'tie' : c.winner === 'a' ? 'first wins' : 'second wins'}.{' '}
                <span className="muted">{c.reason}</span>
              </li>
            ))}
            {comparisons.length === 0 && <li className="muted small">Nothing to compare yet.</li>}
          </ul>

          {extraOverrides.length > 0 && (
            <>
              <h4>Sandbox constraints</h4>
              <ul className="rules">
                {extraOverrides.map((r, i) => (
                  <li key={i}>
                    <strong>{patternText(r.stronger)}</strong> <span className="arrow">beats</span>{' '}
                    <strong>{patternText(r.weaker)}</strong>
                    <button className="mini mini--danger" onClick={() => setExtraOverrides(extraOverrides.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function HandPreview({ result }: { result: EvaluatedHand }) {
  return (
    <span className="hand">
      {result.cards.map((c, i) => (
        <PlayingCard key={i} card={{ rank: c.rank, suit: c.suit }} small />
      ))}
    </span>
  );
}

function ranks(): number[] {
  const out: number[] = [];
  for (let r = MAX_RANK; r >= MIN_RANK; r--) out.push(r);
  return out;
}
