import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { parseRankInput, patternText } from '../rankInput';
import {
  VARIANT_LABEL,
  type RankingProfile,
  tryResolveRanking,
} from '../../rules/ranking';
import { defaultProfile } from '../../rules/profiles';
import type { Suit } from '../../rules/cards';

const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

function newId(): string {
  return `custom_${Math.random().toString(36).slice(2, 10)}`;
}

export function RankingEditor() {
  const [profiles, setProfiles] = useState<RankingProfile[]>([]);
  const [draft, setDraft] = useState<RankingProfile | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [newRule, setNewRule] = useState({ stronger: '', weaker: '' });

  const load = useCallback(async () => {
    const list = await api<RankingProfile[]>('/api/profiles');
    setProfiles(list);
    setDraft((current) => current ?? list[0] ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolution = useMemo(() => (draft ? tryResolveRanking(draft) : null), [draft]);

  if (!draft) {
    return (
      <div className="panel">
        <p className="muted">Loading ranking profiles…</p>
      </div>
    );
  }

  const model: RankingProfile = draft;

  const update = (patch: Partial<RankingProfile>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  function moveCategory(from: number, to: number) {
    setDraft((current) => {
      if (!current) return current;
      const order = current.categoryOrder.slice();
      const [item] = order.splice(from, 1);
      order.splice(to, 0, item);
      return { ...current, categoryOrder: order };
    });
  }

  function addRule() {
    const s = parseRankInput(newRule.stronger);
    const w = parseRankInput(newRule.weaker);
    if (!s || !w) {
      setMessage({ text: 'Use three ranks per side, e.g. AKQ or 14-10-9.', kind: 'error' });
      return;
    }
    if (s.key === w.key) {
      setMessage({ text: 'A hand cannot beat itself.', kind: 'error' });
      return;
    }
    update({ overrides: [...model.overrides, { stronger: s.key, weaker: w.key }] });
    setNewRule({ stronger: '', weaker: '' });
    setMessage(null);
  }

  async function save() {
    try {
      const saved = await api<RankingProfile>('/api/profiles', { method: 'POST', body: JSON.stringify(model) });
      setMessage({ text: `Saved "${saved.name}" as version ${saved.version}.`, kind: 'ok' });
      setDraft(saved);
      await load();
    } catch (error) {
      setMessage({ text: (error as Error).message, kind: 'error' });
    }
  }

  function duplicate() {
    const copy: RankingProfile = {
      ...model,
      id: newId(),
      name: `${model.name} (copy)`,
      version: 1,
    };
    setDraft(copy);
    setMessage({ text: 'Copy created locally — save it to keep it.', kind: 'ok' });
  }

  async function remove() {
    if (!confirm(`Delete ranking profile "${model.name}"?`)) return;
    await api(`/api/profiles/${model.id}`, { method: 'DELETE' });
    setDraft(null);
    await load();
  }

  return (
    <div className="editor">
      <header className="editor__head">
        <div>
          <h2>Ranking editor</h2>
          <p className="muted small">
            Rules form one consistent ordering. Circular rules are rejected. A profile is frozen when a round starts.
          </p>
        </div>
        <div className="row">
          <select
            className="input"
            value={draft.id}
            onChange={(e) => {
              const found = profiles.find((p) => p.id === e.target.value);
              if (found) setDraft(found);
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (v{p.version})
              </option>
            ))}
            {!profiles.some((p) => p.id === draft.id) && <option value={draft.id}>{draft.name} (unsaved)</option>}
          </select>
          <button className="btn" onClick={duplicate}>
            Duplicate
          </button>
          <button className="btn" onClick={() => setDraft({ ...(profiles[0] ?? defaultProfile()), id: newId(), name: 'New ranking profile', overrides: [], version: 1 })}>
            New
          </button>
          <button className="btn btn--danger" onClick={() => void remove()}>
            Delete
          </button>
          <button
            className="btn btn--primary"
            disabled={!resolution?.ok}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </header>

      {message && <div className={`notice notice--${message.kind}`}>{message.text}</div>}

      <div className="editor__grid">
        <section className="panel">
          <h3>Profile</h3>
          <label className="field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
          </label>

          <h4>Category order (strongest first)</h4>
          <p className="muted small">Drag to reorder, or use the arrows.</p>
          <ul className="sortable">
            {draft.categoryOrder.map((variant, index) => (
              <li
                key={variant}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== index) moveCategory(dragIndex, index);
                  setDragIndex(null);
                }}
                className={dragIndex === index ? 'dragging' : ''}
              >
                <span className="grip">⋮⋮</span>
                <span>{VARIANT_LABEL[variant]}</span>
                <span className="row row--tight">
                  <button className="mini" disabled={index === 0} onClick={() => moveCategory(index, index - 1)}>
                    ↑
                  </button>
                  <button
                    className="mini"
                    disabled={index === draft.categoryOrder.length - 1}
                    onClick={() => moveCategory(index, index + 1)}
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <h4>Suit rules</h4>
          <label className="checkline">
            <input
              type="checkbox"
              checked={draft.suitSensitive}
              onChange={(e) => update({ suitSensitive: e.target.checked })}
            />
            <span>Suits break otherwise equal hands</span>
          </label>
          <div className="row">
            {draft.suitOrder.map((suit, index) => (
              <span key={suit} className="suit-chip">
                {suit}
                <button
                  className="mini"
                  disabled={index === 0}
                  onClick={() => {
                    const order = draft.suitOrder.slice();
                    [order[index - 1], order[index]] = [order[index], order[index - 1]];
                    update({ suitOrder: order });
                  }}
                >
                  ↑
                </button>
              </span>
            ))}
          </div>

          <label className="field">
            <span>Muflis tie policy (hand strength always reverses in Muflis)</span>
            <select
              value={draft.muflisTiePolicy}
              onChange={(e) => update({ muflisTiePolicy: e.target.value as RankingProfile['muflisTiePolicy'] })}
            >
              <option value="UNCHANGED">Keep the normal suit tie-break</option>
              <option value="REVERSE_SUIT">Reverse the suit tie-break too</option>
            </select>
          </label>
        </section>

        <section className="panel">
          <h3>Rank pattern overrides</h3>
          <p className="muted small">
            A rule places every hand of one rank pattern above every hand of another, regardless of suit.
          </p>
          <ul className="rules">
            {draft.overrides.map((rule, index) => (
              <li key={`${rule.stronger}-${rule.weaker}-${index}`}>
                <strong>{patternText(rule.stronger)}</strong>
                <span className="arrow">beats</span>
                <strong>{patternText(rule.weaker)}</strong>
                <button
                  className="mini mini--danger"
                  onClick={() => update({ overrides: draft.overrides.filter((_, i) => i !== index) })}
                >
                  ✕
                </button>
              </li>
            ))}
            {draft.overrides.length === 0 && <li className="muted small">No overrides — default order only.</li>}
          </ul>

          <div className="row">
            <input
              className="input"
              placeholder="Stronger (e.g. 235)"
              value={newRule.stronger}
              onChange={(e) => setNewRule({ ...newRule, stronger: e.target.value })}
            />
            <span className="arrow">beats</span>
            <input
              className="input"
              placeholder="Weaker (e.g. AKQ)"
              value={newRule.weaker}
              onChange={(e) => setNewRule({ ...newRule, weaker: e.target.value })}
            />
            <button className="btn" onClick={addRule}>
              Add rule
            </button>
          </div>

          <h4>Validation</h4>
          {resolution?.ok ? (
            <div className="notice notice--ok">{resolution.ranking.warnings.length === 0 ? 'Rules form one consistent ordering.' : resolution.ranking.warnings.join(' ')}</div>
          ) : (
            <div className="notice notice--error">{resolution?.error}</div>
          )}

          {resolution?.ok && (
            <>
              <h4>Resolved order (first 24 classes)</h4>
              <ol className="order-preview">
                {resolution.ranking.order.slice(0, 24).map((key) => (
                  <li key={key}>{resolution.ranking.classes.get(key)?.label}</li>
                ))}
              </ol>
              <p className="muted small">
                {resolution.ranking.order.length} hand classes resolved from 6 categories and {draft.overrides.length} rule(s).
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
