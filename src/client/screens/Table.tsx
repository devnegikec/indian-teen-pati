import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { actionId, api, connectSocket, copyText, roomLink } from '../api';
import { navigate } from '../App';
import { Hand, PlayingCard, rankText } from '../components/Card';
import type { Card, Suit } from '../../rules/cards';
import { resolveRanking, type RankingProfile, type ResolvedRanking } from '../../rules/ranking';
import { suggestAssumed } from '../../rules/evaluate';
import {
  BOOT_MODE_LABEL,
  DEALING_MODE_LABEL,
  ROUND_STATE_LABEL,
  THREE_CARD_COMPARE_LABEL,
} from '../../rules/types';
import type { CardView, PlayerView, RoomView, RoundResultView } from '../../shared/views';

interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

export function Table({ roomId }: { roomId: string }) {
  const [view, setView] = useState<RoomView | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [raiseAmount, setRaiseAmount] = useState<string>('');
  const [assumedPick, setAssumedPick] = useState<number | 'suggest' | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictReason, setConflictReason] = useState('');
  const [resolution, setResolution] = useState<{ decision: 'WINNER' | 'SPLIT' | 'VOID'; winnerUserId: string; explanation: string }>({
    decision: 'WINNER',
    winnerUserId: '',
    explanation: '',
  });
  const [now, setNow] = useState(Date.now());
  const [profiles, setProfiles] = useState<RankingProfile[]>([]);
  const socketRef = useRef<Socket | null>(null);

  const pushToast = useCallback((text: string, kind: 'error' | 'info' = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;
    socket.on('connect', () => socket.emit('room:join', { roomId }));
    socket.on('room:view', (payload: RoomView) => setView(payload));
    socket.on('room:error', (payload: { message: string }) => pushToast(payload.message));
    socket.on('disconnect', () => pushToast('Disconnected — reconnecting…', 'info'));
    return () => {
      socket.emit('room:leave');
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, pushToast]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    api<RankingProfile[]>('/api/profiles')
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    socketRef.current?.emit('room:action', { roomId, actionId: actionId(), type, payload });
  }, [roomId]);

  const me = useMemo(() => view?.players.find((p) => p.isYou) ?? null, [view]);
  const round = view?.round ?? null;
  const isAdmin = view?.you.isAdmin ?? false;
  const activePlayers = useMemo(
    () => (view?.players ?? []).filter((p) => p.inRound && !p.folded),
    [view],
  );
  const countdown = round?.provisionalUntil ? Math.max(0, Math.ceil((round.provisionalUntil - now) / 1000)) : null;

  const resolvedRanking: ResolvedRanking | null = useMemo(() => {
    const profile = profiles.find((p) => p.id === (round?.ranking.profileId ?? view?.room.rankingProfileId));
    if (!profile) return null;
    try {
      return resolveRanking(profile);
    } catch {
      return null;
    }
  }, [profiles, round?.ranking.profileId, view?.room.rankingProfileId]);

  const suggestion = useMemo(() => {
    if (!me || !round || !resolvedRanking || round.dealingMode === 'THREE_CARD') return null;
    const physical: Card[] = me.cards
      .filter((c) => !c.virtual && !c.hidden && c.suit)
      .map((c) => ({ id: `${c.suit}${c.rank}`, rank: c.rank, suit: c.suit as Suit }));
    const shared: Card | undefined =
      round.sharedCard && round.sharedCard.suit
        ? {
            id: `${round.sharedCard.suit}${round.sharedCard.rank}`,
            rank: round.sharedCard.rank,
            suit: round.sharedCard.suit as Suit,
          }
        : undefined;
    try {
      return suggestAssumed(physical, resolvedRanking, round.muflis, shared);
    } catch {
      return null;
    }
  }, [me, round, resolvedRanking]);

  if (!view) {
    return (
      <div className="table">
        <div className="panel">
          <p className="muted">Connecting to the table…</p>
        </div>
      </div>
    );
  }

  const { room, players } = view;

  return (
    <div className="table">
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>

      <header className="room-head">
        <div>
          <h2 className="room-head__title">{room.name}</h2>
          <div className="room-head__meta">
            <span className="pill">Code {room.code}</span>
            <button className="link" onClick={() => void copyText(roomLink(room.code))}>
              copy invite link
            </button>
          </div>
        </div>
        <div className="room-head__badges">
          <span className="badge badge--mode">{DEALING_MODE_LABEL[round?.dealingMode ?? room.rules.dealingMode]}</span>
          {((round?.dealingMode ?? room.rules.dealingMode) === 'THREE_CARD') && (
            <span className="badge">{THREE_CARD_COMPARE_LABEL[round?.threeCardCompare ?? room.rules.threeCardCompare]}</span>
          )}
          <span className="badge badge--ranking">
            Ranking: {round ? `${round.ranking.name} v${round.ranking.version}` : room.rankingProfileId}
          </span>
          <span className={`badge ${round?.muflis ? 'badge--muflis' : 'badge--normal'}`}>
            {round?.muflis ? 'MUFLIS — lowest hand wins' : 'NORMAL — highest hand wins'}
          </span>
          <span className="badge">{BOOT_MODE_LABEL[round?.bootMode ?? room.rules.bootMode]}</span>
          <span className="badge">Boot {round?.boot ?? room.rules.boot}</span>
        </div>
      </header>

      <div className="table-layout">
        <section className="felt">
          <div className="felt__board">
            <div className="pot">
              <span className="pot__label">Pot</span>
              <span className="pot__value">{round?.pot ?? 0}</span>
            </div>
            {round && (
              <div className="stakes">
                <span>Bet level {round.stake}</span>
                <span>Seen plays {round.seenStake}</span>
                <span>Last bet {round.lastBet}</span>
                <span className="state">{ROUND_STATE_LABEL[round.state]}</span>
              </div>
            )}
            {round?.sharedCard && (
              <div className="shared">
                <span>Shared open card</span>
                <PlayingCard card={round.sharedCard} />
              </div>
            )}
            {round?.state === 'BETTING' && round.turnSeat !== null && (
              <div className="turn-banner">
                Waiting for {players.find((p) => p.seat === round.turnSeat)?.name ?? '—'}
              </div>
            )}
            {round?.sideShow && round.state === 'SIDE_SHOW_PENDING' && (
              <div className="notice notice--warn">
                <strong>{round.sideShow.initiatorName}</strong> bet and asked{' '}
                <strong>{round.sideShow.targetName}</strong> for a side show. Betting is paused.
                {me?.userId === round.sideShow.targetUserId ? (
                  <div className="row">
                    <button className="btn btn--small btn--primary" onClick={() => send('RESPOND_SIDE_SHOW', { accept: true })}>
                      Accept and compare
                    </button>
                    <button className="btn btn--small" onClick={() => send('RESPOND_SIDE_SHOW', { accept: false })}>
                      Decline
                    </button>
                  </div>
                ) : (
                  <div className="small">Waiting for the invited player to answer.</div>
                )}
              </div>
            )}
            {round?.muflisRequest && round.state === 'MUFLIS_PENDING' && (
              <div className="notice notice--warn">
                <strong>{round.muflisRequest.byName}</strong> requested a Muflis switch. Betting is paused.
                {round.muflisRequest.policy === 'UNANIMOUS' && (
                  <div className="small">
                    Approvals {round.muflisRequest.approvals.length}/{round.muflisRequest.needed.length}
                  </div>
                )}
                {round.muflisRequest.policy === 'UNANIMOUS' && me?.inRound && !me.folded && (
                  <div className="row">
                    <button className="btn btn--small btn--primary" onClick={() => send('VOTE_MUFLIS', { approve: true })}>
                      Approve
                    </button>
                    <button className="btn btn--small" onClick={() => send('VOTE_MUFLIS', { approve: false })}>
                      Reject
                    </button>
                  </div>
                )}
                {round.muflisRequest.policy === 'ADMIN' && isAdmin && (
                  <div className="row">
                    <button className="btn btn--small btn--primary" onClick={() => send('VOTE_MUFLIS', { approve: true })}>
                      Approve Muflis
                    </button>
                    <button className="btn btn--small" onClick={() => send('VOTE_MUFLIS', { approve: false })}>
                      Reject
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="seats">
            {players.map((p) => (
              <Seat
                key={p.userId}
                player={p}
                isTurn={round?.state === 'BETTING' && round.turnSeat === p.seat}
                showBet={!!round}
              />
            ))}
          </div>

          {round?.result && (round.state === 'PROVISIONAL' || round.state === 'DISPUTE' || round.state === 'SETTLED') && (
            <div className="result">
              <div className="result__head">
                <strong>{describeOutcome(round.result)}</strong>
                <span className="pill">{round.result.reason}</span>
              </div>
              <div className="result__hands">
                {round.result.hands.map((h) => (
                  <div key={h.userId} className="result__hand">
                    <span>{h.name}</span>
                    <Hand cards={h.cards} small />
                    <span className="muted small">{h.label}</span>
                  </div>
                ))}
              </div>
              {round.result.steps.length > 0 && (
                <ul className="result__steps">
                  {round.result.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
              {round.result.explanation && (
                <p className="small">
                  Administrator: <em>{round.result.explanation}</em>
                </p>
              )}
              <div className="result__amounts small">
                {Object.entries(round.result.amounts).map(([userId, amount]) => (
                  <span key={userId}>
                    {players.find((p) => p.userId === userId)?.name ?? userId}: +{amount}
                  </span>
                ))}
              </div>
            </div>
          )}

          {round?.sideShow?.announcement && (
            <div className="notice notice--ok">
              <strong>Side show</strong> — {round.sideShow.initiatorName} vs {round.sideShow.targetName}:{' '}
              {round.sideShow.announcement}
            </div>
          )}

          {round?.sideShow?.result && (
            <div className="result">
              <div className="result__head">
                <strong>Your side show</strong>
                <span className="pill">
                  {round.sideShow.initiatorName} vs {round.sideShow.targetName}
                </span>
              </div>
              <p className="small">{round.sideShow.result.reason}</p>
              <div className="result__hands">
                {round.sideShow.result.hands.map((h) => (
                  <div key={h.userId} className="result__hand">
                    <span>
                      {h.name}
                      {h.userId === round.sideShow?.result?.loserUserId ? ' (folded)' : ''}
                    </span>
                    <Hand cards={h.cards} small />
                    <span className="muted small">{h.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {round?.adminVisibleHands && isAdmin && (
            <div className="admin-hands">
              <h4>Administrator view — all cards</h4>
              {round.adminVisibleHands.map((h) => (
                <div key={h.userId} className="admin-hands__row">
                  <span>{h.name}</span>
                  <Hand cards={h.cards} small />
                  <span className="muted small">{h.label}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel panel--tight">
            <h3>Your turn</h3>
            {!round && <p className="muted small">No round yet. Ready up and let the administrator start.</p>}
            {round && round.state === 'BETTING' && me && !me.isTurn && (
              <p className="muted small">
                {me.folded ? 'You folded this round.' : 'Waiting for your turn.'}
              </p>
            )}
            {round?.state === 'SIDE_SHOW_PENDING' && (
              <p className="muted small">A side show is being answered. Betting is paused.</p>
            )}
            {round?.state === 'BETTING' && me?.isTurn && me.legal && (
              <div className="actions">
                <div className="actions__row">
                  {me.legal.canSeeCards && (
                    <button className="btn" onClick={() => send('SEE_CARDS')}>
                      See cards
                    </button>
                  )}
                  <button className="btn btn--primary" onClick={() => send('CHAAL')}>
                    {me.legal.chaal.kind === 'BLIND'
                      ? `Blind ${me.legal.chaal.amount}`
                      : me.legal.chaal.kind === 'BLIND_COUNTER'
                        ? `Blind counter ${me.legal.chaal.amount}`
                        : `Chaal ${me.legal.chaal.amount}`}
                  </button>
                  <button className="btn" onClick={() => send('COUNTER')}>
                    Counter → {me.legal.counter.newLevel}
                  </button>
                  <button className="btn btn--danger" onClick={() => send('FOLD')}>
                    Fold
                  </button>
                </div>
                <div className="actions__row">
                  <input
                    className="input"
                    type="number"
                    min={me.legal.raise.min}
                    max={me.legal.raise.max}
                    placeholder={`Raise (>${me.legal.chaal.amount})`}
                    value={raiseAmount}
                    onChange={(e) => setRaiseAmount(e.target.value)}
                  />
                  <button
                    className="btn"
                    disabled={!raiseAmount || Number(raiseAmount) <= me.legal.chaal.amount}
                    onClick={() => {
                      send('RAISE', { amount: Number(raiseAmount) });
                      setRaiseAmount('');
                    }}
                  >
                    Raise
                  </button>
                </div>
                {activePlayers.length === 2 ? (
                  <button className="btn btn--ghost" onClick={() => setShowPicker(true)}>
                    Request show (ends the round)
                  </button>
                ) : (
                  <button
                    className="btn btn--ghost"
                    disabled={!round.sideShowAllowed}
                    title={
                      round.sideShowBlockedReason ??
                      'Your bet is placed first, then the request goes to the player before you'
                    }
                    onClick={() => send('SIDE_SHOW')}
                  >
                    {me.legal
                      ? `Bet ${me.legal.chaal.amount} & request side show`
                      : 'Request side show'}
                    {round.sideShowTargetName ? ` with ${round.sideShowTargetName}` : ''}
                  </button>
                )}
                {!round.muflis && room.rules.allowMidRoundMuflis && (
                  <button className="btn btn--ghost" onClick={() => send('REQUEST_MUFLIS')}>
                    Request Muflis
                  </button>
                )}
                {me.blind && (
                  <p className="small muted">
                    You are playing blind — press <strong>See cards</strong> to look at your hand
                    {round.dealingMode !== 'THREE_CARD' ? ' (you also need to see them before choosing an assumed card)' : ''}.
                  </p>
                )}
                {me.legalAssumedRanks && (
                  <div className="assumed">
                    <span className="small">Assumed card (rank ≤ {rankText(Math.max(...me.legalAssumedRanks))})</span>
                    <div className="row">
                      <select
                        className="input"
                        value={assumedPick === null ? '' : String(assumedPick)}
                        onChange={(e) => setAssumedPick(e.target.value === 'suggest' ? 'suggest' : Number(e.target.value))}
                      >
                        <option value="">Choose a rank…</option>
                        {me.legalAssumedRanks.map((r) => (
                          <option key={r} value={r}>
                            {rankText(r)}
                          </option>
                        ))}
                        <option value="suggest">Suggest strongest legal</option>
                      </select>
                      <button
                        className="btn"
                        disabled={assumedPick === null}
                        title={suggestion?.reason}
                        onClick={() => {
                          if (assumedPick === 'suggest') {
                            if (suggestion) send('SET_ASSUMED', { rank: suggestion.rank });
                          } else if (assumedPick !== null) {
                            send('SET_ASSUMED', { rank: assumedPick });
                          }
                        }}
                      >
                        Lock
                      </button>
                    </div>
                    {assumedPick === 'suggest' && suggestion && (
                      <span className="small muted">Suggestion: {rankText(suggestion.rank)} — {suggestion.reason}</span>
                    )}
                    {me.assumedRank !== null && <span className="small muted">Locked: {rankText(me.assumedRank)}</span>}
                  </div>
                )}
              </div>
            )}

            {round && ['BETTING', 'SHOW_REQUESTED', 'SIDE_SHOW_PENDING', 'MUFLIS_PENDING'].includes(round.state) && (
              <button className="btn btn--ghost" onClick={() => setConflictOpen(true)}>
                Raise conflict
              </button>
            )}

            {round?.state === 'WINNER_CHOICE' && (
              <div className="actions">
                <p className="small">
                  Everyone else folded. {round.survivorName} takes the pot — show your cards or take it without a
                  comparison.
                </p>
                {me?.userId === round.survivorUserId ? (
                  <div className="actions__row">
                    <button className="btn btn--primary" onClick={() => send('WINNER_ACTION', { show: true })}>
                      Show my cards
                    </button>
                    <button className="btn" onClick={() => send('WINNER_ACTION', { show: false })}>
                      Take the pot (don't show)
                    </button>
                  </div>
                ) : (
                  <p className="muted small">Waiting for {round.survivorName} to show or take the pot.</p>
                )}
              </div>
            )}

            {round?.state === 'PROVISIONAL' && (
              <div className="actions">
                <p className="small">
                  Provisional result in {countdown}s. Raise a conflict now if something looks wrong.
                </p>
                <button className="btn btn--danger" onClick={() => setConflictOpen(true)}>
                  Raise conflict
                </button>
                {isAdmin && (
                  <button className="btn" onClick={() => send('SETTLE_NOW')}>
                    Settle now
                  </button>
                )}
              </div>
            )}

            {round?.state === 'DISPUTE' && (
              <div className="actions">
                <p className="small">
                  Conflict raised by {round.dispute?.byName}: <em>{round.dispute?.reason}</em>. Betting and settlement are
                  frozen.
                </p>
                {isAdmin ? (
                  <div className="resolve">
                    <label className="field">
                      <span>Decision</span>
                      <select
                        value={resolution.decision}
                        onChange={(e) =>
                          setResolution({ ...resolution, decision: e.target.value as 'WINNER' | 'SPLIT' | 'VOID' })
                        }
                      >
                        <option value="WINNER">Award the pot to a player</option>
                        <option value="SPLIT">Split the pot</option>
                        <option value="VOID">Void the round and refund</option>
                      </select>
                    </label>
                    {resolution.decision === 'WINNER' && (
                      <label className="field">
                        <span>Winner</span>
                        <select
                          value={resolution.winnerUserId}
                          onChange={(e) => setResolution({ ...resolution, winnerUserId: e.target.value })}
                        >
                          <option value="">Choose…</option>
                          {players
                            .filter((p) => p.inRound)
                            .map((p) => (
                              <option key={p.userId} value={p.userId}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                    <label className="field">
                      <span>Explanation (required)</span>
                      <textarea
                        rows={3}
                        value={resolution.explanation}
                        onChange={(e) => setResolution({ ...resolution, explanation: e.target.value })}
                      />
                    </label>
                    <button
                      className="btn btn--primary"
                      onClick={() => {
                        send('RESOLVE_CONFLICT', {
                          decision: resolution.decision,
                          winnerUserId: resolution.winnerUserId,
                          explanation: resolution.explanation,
                        });
                        setResolution({ decision: 'WINNER', winnerUserId: '', explanation: '' });
                      }}
                    >
                      Record decision
                    </button>
                  </div>
                ) : (
                  <p className="muted small">Waiting for the administrator.</p>
                )}
              </div>
            )}

            {(!round || round.state === 'SETTLED' || round.state === 'VOID' || !me?.inRound) && (
              <div className="actions">
                <p className="muted small">Ready up to join the next round.</p>
                <button
                  className={`btn ${me?.ready ? '' : 'btn--primary'}`}
                  onClick={() => send('READY', { ready: !me?.ready })}
                >
                  {me?.ready ? 'Cancel ready' : 'I am ready'}
                </button>
                {isAdmin && (
                  <button className="btn btn--primary" onClick={() => send('START_ROUND')}>
                    Start round (boot {room.rules.boot})
                  </button>
                )}
                {!isAdmin && <p className="muted small">The administrator starts each round.</p>}
              </div>
            )}
          </div>

          {isAdmin && <AdminPanel view={view} send={send} />}

          <div className="panel panel--tight">
            <h3>Table log</h3>
            <ul className="log">
              {(round?.log ?? []).slice().reverse().map((entry, i) => (
                <li key={i}>
                  <span className="muted small">{new Date(entry.at).toLocaleTimeString()}</span> {entry.text}
                </li>
              ))}
              {(round?.log ?? []).length === 0 && <li className="muted small">Nothing yet.</li>}
            </ul>
          </div>

          <div className="panel panel--tight">
            <h3>History</h3>
            <ul className="log">
              {view.history
                .filter((h) => h.state === 'SETTLED')
                .map((h) => (
                  <li key={h.roundId}>
                    <span className="muted small">#{h.seq}</span> {h.winnerName ? `${h.winnerName} won` : 'No single winner'} ·{' '}
                    {h.result}
                  </li>
                ))}
              {view.history.filter((h) => h.state === 'SETTLED').length === 0 && (
                <li className="muted small">No settled rounds yet.</li>
              )}
            </ul>
          </div>
        </aside>
      </div>

      {showPicker && round && (
        <div className="modal" onClick={() => setShowPicker(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <h3>Show your cards to…</h3>
            <p className="muted small">
              With two players left, a full show ends the round: both hands are compared and the winner takes
              the pot.
            </p>
            {activePlayers
              .filter((p) => !p.isYou)
              .map((p) => (
                <button
                  key={p.userId}
                  className="btn btn--wide"
                  onClick={() => {
                    send('SHOW', { targetUserId: p.userId });
                    setShowPicker(false);
                  }}
                >
                  {p.name}
                </button>
              ))}
          </div>
        </div>
      )}

      {conflictOpen && (
        <div className="modal" onClick={() => setConflictOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <h3>Raise a conflict</h3>
            <p className="muted small">The round is paused and the administrator reviews everything.</p>
            <textarea
              rows={4}
              className="input"
              placeholder="What went wrong?"
              value={conflictReason}
              onChange={(e) => setConflictReason(e.target.value)}
            />
            <div className="row">
              <button
                className="btn btn--danger"
                onClick={() => {
                  send('RAISE_CONFLICT', { reason: conflictReason });
                  setConflictReason('');
                  setConflictOpen(false);
                }}
              >
                Submit conflict
              </button>
              <button className="btn btn--ghost" onClick={() => setConflictOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function describeOutcome(result: RoundResultView): string {
  if (!result) return '';
  if (result.kind === 'ADMIN_VOID') return 'Round voided — contributions refunded';
  if (result.winnerName) return `${result.winnerName} wins`;
  if (result.split) return 'Pot split';
  return 'Result';
}

function Seat({ player, isTurn, showBet }: { player: PlayerView; isTurn: boolean; showBet: boolean }) {
  return (
    <div
      className={`seat ${isTurn ? 'seat--turn' : ''} ${player.folded ? 'seat--folded' : ''} ${
        !player.connected ? 'seat--offline' : ''
      }`}
    >
      <div className="seat__head">
        <span className="seat__name">
          {player.name}
          {player.isAdmin && <span className="tag">admin</span>}
          {player.isYou && <span className="tag tag--you">you</span>}
        </span>
        <span className="seat__chips">{player.chips}</span>
      </div>
      <div className="seat__cards">
        {player.cards.length > 0 ? <Hand cards={player.cards} small /> : <span className="muted small">no cards</span>}
      </div>
      <div className="seat__meta">
        {player.blind ? <span className="pill pill--blind">blind</span> : <span className="pill">seen</span>}
        {player.folded && <span className="pill pill--folded">folded</span>}
        {!player.connected && <span className="pill pill--offline">offline</span>}
        {showBet && player.totalBet > 0 && <span className="pill">bet {player.totalBet}</span>}
        {player.ready && <span className="pill pill--ready">ready</span>}
        {player.handLabel && <span className="pill pill--hand">{player.handLabel}</span>}
      </div>
    </div>
  );
}

function AdminPanel({ view, send }: { view: RoomView; send: (type: string, payload?: Record<string, unknown>) => void }) {
  const [rules, setRules] = useState({
    boot: view.room.rules.boot,
    minBoot: view.room.rules.minBoot,
    dealingMode: view.room.rules.dealingMode,
    threeCardCompare: view.room.rules.threeCardCompare,
    bootMode: view.room.rules.bootMode,
    muflisApproval: view.room.rules.muflisApproval,
    counterMultiplier: view.room.rules.counterMultiplier,
    seenMultiple: view.room.rules.seenMultiple,
    disputeWindowSeconds: view.room.rules.disputeWindowSeconds,
    maxBetsPerRound: view.room.rules.maxBetsPerRound,
  });

  return (
    <details className="panel panel--tight admin">
      <summary>Administrator settings</summary>
      <p className="muted small">Changes apply to subsequent rounds only.</p>
      <label className="field">
        <span>Ranking profile id</span>
        <input
          className="input"
          defaultValue={view.room.rankingProfileId}
          onBlur={(e) => send('SET_RULES', { rules: {}, rankingProfileId: e.target.value })}
        />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Min boot</span>
          <input
            className="input"
            type="number"
            value={rules.minBoot}
            onChange={(e) => setRules({ ...rules, minBoot: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Boot</span>
          <input
            className="input"
            type="number"
            value={rules.boot}
            onChange={(e) => setRules({ ...rules, boot: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Boot mode</span>
          <select
            className="input"
            value={rules.bootMode}
            onChange={(e) => setRules({ ...rules, bootMode: e.target.value as 'FULL' | 'ROUND' })}
          >
            <option value="FULL">Full boot</option>
            <option value="ROUND">Round boot</option>
          </select>
        </label>
        <label className="field">
          <span>Dealing mode</span>
          <select
            className="input"
            value={rules.dealingMode}
            onChange={(e) => setRules({ ...rules, dealingMode: e.target.value as RoomView['room']['rules']['dealingMode'] })}
          >
            <option value="THREE_CARD">Three card</option>
            <option value="TWO_CARD_ASSUMED">Two card + assumed</option>
            <option value="ONE_CARD_SHARED">One card + shared</option>
          </select>
        </label>
        <label className="field">
          <span>Three-card compare</span>
          <select
            className="input"
            value={rules.threeCardCompare}
            onChange={(e) =>
              setRules({ ...rules, threeCardCompare: e.target.value as RoomView['room']['rules']['threeCardCompare'] })
            }
          >
            <option value="FULL_HAND">Full hand</option>
            <option value="HIGHEST_CARD">Highest single card</option>
          </select>
        </label>
        <label className="field">
          <span>Muflis approval</span>
          <select
            className="input"
            value={rules.muflisApproval}
            onChange={(e) => setRules({ ...rules, muflisApproval: e.target.value as 'ADMIN' | 'UNANIMOUS' })}
          >
            <option value="ADMIN">Administrator</option>
            <option value="UNANIMOUS">Unanimous</option>
          </select>
        </label>
        <label className="field">
          <span>Counter multiplier</span>
          <input
            className="input"
            type="number"
            value={rules.counterMultiplier}
            onChange={(e) => setRules({ ...rules, counterMultiplier: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Seen player pays level ×</span>
          <input
            className="input"
            type="number"
            value={rules.seenMultiple}
            onChange={(e) => setRules({ ...rules, seenMultiple: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Dispute window (s)</span>
          <input
            className="input"
            type="number"
            value={rules.disputeWindowSeconds}
            onChange={(e) => setRules({ ...rules, disputeWindowSeconds: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Round bet cap (0 = off)</span>
          <input
            className="input"
            type="number"
            value={rules.maxBetsPerRound}
            onChange={(e) => setRules({ ...rules, maxBetsPerRound: Number(e.target.value) })}
          />
        </label>
      </div>
      <button className="btn btn--primary btn--wide" onClick={() => send('SET_RULES', { rules })}>
        Save room rules
      </button>
      <button className="btn btn--ghost btn--wide" onClick={() => navigate('/rankings')}>
        Open ranking editor
      </button>
    </details>
  );
}
