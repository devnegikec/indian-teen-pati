import { useEffect, useMemo, useState } from 'react';
import { api, copyText, roomLink } from '../api';
import { navigate } from '../App';
import type { RoomRules } from '../../shared/views';
import type { RankingProfile } from '../../rules/ranking';

const MODES = [
  { value: 'THREE_CARD', label: 'Three cards (full hand or highest card)' },
  { value: 'TWO_CARD_ASSUMED', label: 'Two cards + one assumed card' },
  { value: 'ONE_CARD_SHARED', label: 'One card + one shared open card' },
] as const;

export function Lobby({ initialCode }: { initialCode?: string }) {
  const [profiles, setProfiles] = useState<RankingProfile[]>([]);
  const [code, setCode] = useState(initialCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ code: string; roomId: string } | null>(null);

  const [form, setForm] = useState({
    name: 'Friday night table',
    minBoot: 10,
    boot: 20,
    bootMode: 'FULL' as 'FULL' | 'ROUND',
    roundBootScope: 'FIRST_TO_ACT' as 'FIRST_TO_ACT' | 'EACH_TURN',
    dealingMode: 'THREE_CARD' as RoomRules['dealingMode'],
    threeCardCompare: 'FULL_HAND' as RoomRules['threeCardCompare'],
    muflisApproval: 'ADMIN' as RoomRules['muflisApproval'],
    counterMultiplier: 3,
    seenMultiple: 2,
    disputeWindowSeconds: 15,
    startingChips: 5000,
    rankingProfileId: 'house-default',
  });

  useEffect(() => {
    api<RankingProfile[]>('/api/profiles')
      .then(setProfiles)
      .catch((e) => setError((e as Error).message));
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === form.rankingProfileId),
    [profiles, form.rankingProfileId],
  );

  async function createRoom() {
    setBusy(true);
    setError(null);
    try {
      const room = await api<{ roomId: string; code: string }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          rankingProfileId: form.rankingProfileId,
          rules: {
            minBoot: form.minBoot,
            boot: form.boot,
            bootMode: form.bootMode,
            roundBootScope: form.roundBootScope,
            dealingMode: form.dealingMode,
            threeCardCompare: form.threeCardCompare,
            muflisApproval: form.muflisApproval,
            counterMultiplier: form.counterMultiplier,
            seenMultiple: form.seenMultiple,
            disputeWindowSeconds: form.disputeWindowSeconds,
            startingChips: form.startingChips,
          },
        }),
      });
      setCreated(room);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    setBusy(true);
    setError(null);
    try {
      const room = await api<{ roomId: string; code: string }>(`/api/rooms/${code.trim().toUpperCase()}/join`, {
        method: 'POST',
      });
      navigate(`/room/${room.roomId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lobby">
      <section className="panel">
        <h2>Join a table</h2>
        <p className="muted">Enter the six character room code your host shared.</p>
        <div className="row">
          <input
            className="input input--code"
            value={code}
            placeholder="ABC123"
            maxLength={8}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void joinRoom();
            }}
          />
          <button className="btn btn--primary" disabled={busy || !code.trim()} onClick={() => void joinRoom()}>
            Join
          </button>
        </div>
        {created && (
          <div className="notice notice--ok">
            <strong>Room ready.</strong>
            <div>
              Code <code>{created.code}</code>
            </div>
            <div className="row">
              <button className="btn" onClick={() => navigate(`/room/${created.roomId}`)}>
                Open my room
              </button>
              <button className="btn btn--ghost" onClick={() => void copyText(roomLink(created.code))}>
                Copy invite link
              </button>
            </div>
          </div>
        )}
        {error && <div className="notice notice--error">{error}</div>}
      </section>

      <section className="panel">
        <h2>Create a private room</h2>
        <p className="muted">
          You become the room administrator. Rules below apply to rounds that start after you change them.
        </p>

        <div className="form-grid">
          <label className="field">
            <span>Room name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>

          <label className="field">
            <span>Ranking profile</span>
            <select
              value={form.rankingProfileId}
              onChange={(e) => setForm({ ...form, rankingProfileId: e.target.value })}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (v{p.version})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Minimum permitted boot</span>
            <input
              type="number"
              min={1}
              value={form.minBoot}
              onChange={(e) => setForm({ ...form, minBoot: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Boot per round (never below the minimum)</span>
            <input
              type="number"
              min={form.minBoot}
              value={form.boot}
              onChange={(e) => setForm({ ...form, boot: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Boot collection</span>
            <select value={form.bootMode} onChange={(e) => setForm({ ...form, bootMode: e.target.value as 'FULL' | 'ROUND' })}>
              <option value="FULL">Full boot — everyone pays the boot</option>
              <option value="ROUND">Round boot — only the player on turn pays</option>
            </select>
          </label>

          {form.bootMode === 'ROUND' && (
            <label className="field">
              <span>Round boot scope</span>
              <select
                value={form.roundBootScope}
                onChange={(e) => setForm({ ...form, roundBootScope: e.target.value as 'FIRST_TO_ACT' | 'EACH_TURN' })}
              >
                <option value="FIRST_TO_ACT">Only the first player to act pays</option>
                <option value="EACH_TURN">Each player pays when their turn first comes</option>
              </select>
            </label>
          )}

          <label className="field field--wide">
            <span>Dealing mode</span>
            <select
              value={form.dealingMode}
              onChange={(e) => setForm({ ...form, dealingMode: e.target.value as RoomRules['dealingMode'] })}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {form.dealingMode === 'THREE_CARD' && (
            <label className="field field--wide">
              <span>Three-card comparison (shown on the table, never mixed)</span>
              <select
                value={form.threeCardCompare}
                onChange={(e) => setForm({ ...form, threeCardCompare: e.target.value as RoomRules['threeCardCompare'] })}
              >
                <option value="FULL_HAND">Full three-card hand comparison</option>
                <option value="HIGHEST_CARD">Highest single card of the three</option>
              </select>
            </label>
          )}

          <label className="field">
            <span>Mid-round Muflis approval</span>
            <select
              value={form.muflisApproval}
              onChange={(e) => setForm({ ...form, muflisApproval: e.target.value as RoomRules['muflisApproval'] })}
            >
              <option value="ADMIN">Administrator only</option>
              <option value="UNANIMOUS">Unanimous active players</option>
            </select>
          </label>

          <label className="field">
            <span>Counter multiplier (next player pays ×)</span>
            <input
              type="number"
              min={2}
              value={form.counterMultiplier}
              onChange={(e) => setForm({ ...form, counterMultiplier: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Seen player pays level ×</span>
            <input
              type="number"
              min={1}
              value={form.seenMultiple}
              onChange={(e) => setForm({ ...form, seenMultiple: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Starting virtual chips</span>
            <input
              type="number"
              min={form.boot}
              value={form.startingChips}
              onChange={(e) => setForm({ ...form, startingChips: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Dispute window (seconds)</span>
            <input
              type="number"
              min={0}
              value={form.disputeWindowSeconds}
              onChange={(e) => setForm({ ...form, disputeWindowSeconds: Number(e.target.value) })}
            />
          </label>
        </div>

        {selectedProfile && (
          <p className="muted small">
            Active ranking: <strong>{selectedProfile.name}</strong> · v{selectedProfile.version} ·{' '}
            {selectedProfile.overrides.length} custom rule(s).{' '}
            <button className="link" onClick={() => navigate('/rankings')}>
              Edit rankings
            </button>
          </p>
        )}

        <button className="btn btn--primary btn--wide" disabled={busy} onClick={() => void createRoom()}>
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </section>
    </div>
  );
}
