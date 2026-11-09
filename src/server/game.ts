import { nanoid } from 'nanoid';
import type { DB } from './db';
import {
  BetPlayer,
  BettingConfig,
  BettingState,
  applyBet,
  createBettingState,
  legalActions as computeLegalActions,
} from '../rules/betting';
import { Card, cardFromId, makeDeck, rankLabel, shuffle } from '../rules/cards';
import {
  EvaluatedHand,
  buildAssumedHand,
  decideShowdown,
  effectiveIndex,
  evaluateHand,
  isLegalAssumedRank,
  legalAssumedRanks,
  maxAssumableRank,
  suggestAssumed,
} from '../rules/evaluate';
import { RankingProfile, ResolvedRanking, resolveRanking } from '../rules/ranking';
import { defaultProfile, standardProfile } from '../rules/profiles';
import { DealingMode, RoundState } from '../rules/types';
import {
  CardView,
  DEFAULT_RULES,
  DisputeView,
  HandResultView,
  MAX_SEATS,
  MuflisRequestView,
  PlayerView,
  RoomRules,
  RoomView,
  RoundResultView,
  RoundSummary,
  RoundView,
  ShowInfo,
  SideShowView,
} from '../shared/views';

export class AppError extends Error {
  constructor(message: string, readonly code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
  }
}

interface UserRow {
  id: string;
  name: string;
  created_at: string;
}

interface RoomRow {
  id: string;
  code: string;
  admin_id: string;
  name: string;
  rules_json: string;
  ranking_profile_id: string;
  last_dealer_seat: number;
  created_at: string;
}

interface MemberRow {
  room_id: string;
  user_id: string;
  seat: number;
  chips: number;
  ready: number;
  connected: number;
  joined_at: string;
}

interface RoundRow {
  id: string;
  room_id: string;
  seq: number;
  state: string;
  doc_json: string;
  created_at: string;
  settled_at: string | null;
}

interface RoundPlayerDoc {
  userId: string;
  name: string;
  seat: number;
  cards: string[];
  assumedRank: number | null;
  blind: boolean;
  folded: boolean;
  inRound: boolean;
  hasActed: boolean;
  chips: number;
  chipsAtStart: number;
  totalBet: number;
  bootPaid: boolean;
  muflisVote: 'APPROVE' | 'REJECT' | null;
}

interface DisputeDoc {
  id: string;
  by: string;
  reason: string;
  at: string;
  status: 'OPEN' | 'RESOLVED';
  decision?: string;
  explanation?: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface RoundDoc {
  id: string;
  roomId: string;
  seq: number;
  state: RoundState;
  rules: RoomRules;
  rankingProfile: RankingProfile;
  rankingVersion: string;
  deck: string[];
  sharedCardId: string | null;
  players: RoundPlayerDoc[];
  pot: number;
  /** Amount of the current bet (what a blind player must put). */
  stake: number;
  /** True when the previous bet was made by a player who had seen their cards. */
  lastWasSeen: boolean;
  /** Who made the last bet — the side-show request goes to this player. */
  lastBettorUserId: string | null;
  turnSeat: number;
  betsMade: number;
  counterCount: number;
  muflis: boolean;
  muflisRequest: {
    by: string;
    at: string;
    approvals: string[];
    rejections: string[];
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
  } | null;
  show: { initiator: string; target: string; at: string } | null;
  sideShow: {
    initiator: string;
    target: string;
    at: string;
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    loser?: string | null;
    reason?: string;
    announcement?: string;
    hands?: HandResultView[];
  } | null;
  result: RoundResultView | null;
  provisionalUntil: number | null;
  dispute: DisputeDoc | null;
  log: Array<{ at: string; text: string }>;
  notice: string | null;
  dealerSeat: number;
  createdAt: string;
  settledAt: string | null;
}

const REVEAL_STATES: RoundState[] = ['PROVISIONAL', 'DISPUTE', 'SETTLED'];
const ACTIVE_ROUND_STATES: RoundState[] = [
  'BOOT',
  'DEALING',
  'BETTING',
  'SHOW_REQUESTED',
  'SIDE_SHOW_PENDING',
  'MUFLIS_PENDING',
  'PROVISIONAL',
  'DISPUTE',
];

function nowIso(): string {
  return new Date().toISOString();
}

function nextSeatAfter(seat: number, seats: number[]): number {
  const sorted = seats.slice().sort((a, b) => a - b);
  const after = sorted.find((s) => s > seat);
  return after ?? sorted[0];
}

function isUniqueViolation(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return message.includes('UNIQUE constraint failed');
}

export class GameService {
  private rankingCache = new Map<string, ResolvedRanking>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private db: DB, private broadcast: (roomId: string) => void) {
    this.seedProfiles();
    this.recoverPendingRounds();
  }

  /**
   * In-memory dispute timers are lost when the process restarts. Rounds that
   * were waiting out their dispute window are re-scheduled (or settled) here so
   * that a deploy cannot leave chips stuck in a provisional pot.
   */
  private recoverPendingRounds(): void {
    const rows = this.db.prepare("SELECT * FROM rounds WHERE state = 'PROVISIONAL'").all() as RoundRow[];
    for (const row of rows) {
      try {
        const doc = this.loadDoc(row);
        if (doc.dispute && doc.dispute.status === 'OPEN') continue;
        const remaining = (doc.provisionalUntil ?? 0) - Date.now();
        if (remaining > 0) {
          this.scheduleSettlement(doc.roomId, Math.ceil(remaining / 1000));
        } else {
          this.settleRound(doc.roomId, true);
        }
      } catch {
        /* ignore individual failures so startup always completes */
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Users, sessions, profiles                                         */
  /* ---------------------------------------------------------------- */

  private seedProfiles(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM ranking_profiles').get() as { n: number };
    if (count.n > 0) return;
    const insert = this.db.prepare(
      'INSERT INTO ranking_profiles (id, owner_id, name, version, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const ts = nowIso();
    for (const profile of [defaultProfile(), standardProfile()]) {
      insert.run(profile.id, null, profile.name, profile.version, JSON.stringify(profile), ts, ts);
    }
  }

  createGuest(name: string): { userId: string; name: string; token: string } {
    const clean = (name ?? '').trim().slice(0, 24) || `Player${Math.floor(Math.random() * 9000 + 1000)}`;
    const id = `u_${nanoid(10)}`;
    const token = `t_${nanoid(24)}`;
    const ts = nowIso();
    this.db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, ts);
    this.db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, id, ts);
    return { userId: id, name: clean, token };
  }

  userForToken(token: string | undefined | null): { userId: string; name: string } | null {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
      .get(token) as UserRow | undefined;
    return row ? { userId: row.id, name: row.name } : null;
  }

  listProfiles(): RankingProfile[] {
    const rows = this.db.prepare('SELECT json FROM ranking_profiles ORDER BY created_at ASC').all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as RankingProfile);
  }

  getProfile(id: string): RankingProfile | null {
    const row = this.db.prepare('SELECT json FROM ranking_profiles WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as RankingProfile) : null;
  }

  saveProfile(profile: RankingProfile, ownerId?: string): RankingProfile {
    const resolved = resolveRanking(profile); // validates (throws on circular rules)
    void resolved;
    const existing = this.db.prepare('SELECT version, created_at FROM ranking_profiles WHERE id = ?').get(profile.id) as
      | { version: number; created_at: string }
      | undefined;
    const version = existing ? existing.version + 1 : profile.version || 1;
    const stored: RankingProfile = { ...profile, version, updatedAt: nowIso() };
    if (existing) {
      this.db
        .prepare('UPDATE ranking_profiles SET name = ?, version = ?, json = ?, updated_at = ? WHERE id = ?')
        .run(stored.name, version, JSON.stringify(stored), stored.updatedAt!, stored.id);
    } else {
      const ts = nowIso();
      this.db
        .prepare('INSERT INTO ranking_profiles (id, owner_id, name, version, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(stored.id, ownerId ?? null, stored.name, version, JSON.stringify(stored), ts, ts);
    }
    this.rankingCache.clear();
    return stored;
  }

  deleteProfile(id: string): void {
    this.db.prepare('DELETE FROM ranking_profiles WHERE id = ?').run(id);
    this.rankingCache.clear();
  }

  private resolvedFor(profile: RankingProfile): ResolvedRanking {
    const key = `${profile.id}:${profile.version}:${JSON.stringify(profile.overrides)}:${profile.categoryOrder.join(',')}:${profile.suitSensitive}:${profile.muflisTiePolicy}`;
    const cached = this.rankingCache.get(key);
    if (cached) return cached;
    const resolved = resolveRanking(profile);
    this.rankingCache.set(key, resolved);
    return resolved;
  }

  /* ---------------------------------------------------------------- */
  /* Rooms                                                            */
  /* ---------------------------------------------------------------- */

  private roomRow(roomId: string): RoomRow {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | undefined;
    if (!row) throw new AppError('Room not found.', 'ROOM_NOT_FOUND');
    return row;
  }

  private roomByCode(code: string): RoomRow | null {
    return (this.db.prepare('SELECT * FROM rooms WHERE UPPER(code) = UPPER(?)').get(code) as RoomRow | undefined) ?? null;
  }

  private members(roomId: string): MemberRow[] {
    return this.db.prepare('SELECT * FROM room_members WHERE room_id = ? ORDER BY seat ASC').all(roomId) as MemberRow[];
  }

  private member(roomId: string, userId: string): MemberRow {
    const row = this.db
      .prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as MemberRow | undefined;
    if (!row) throw new AppError('You are not a member of this room.', 'NOT_A_MEMBER');
    return row;
  }

  private isAdmin(room: RoomRow, userId: string): boolean {
    return room.admin_id === userId;
  }

  private requireAdmin(room: RoomRow, userId: string): void {
    if (!this.isAdmin(room, userId)) throw new AppError('Only the room administrator can do that.', 'NOT_ADMIN');
  }

  createRoom(adminUserId: string, name: string, rules: Partial<RoomRules> = {}, rankingProfileId?: string): RoomRow {
    const merged = sanitiseRules({ ...DEFAULT_RULES, ...rules });
    let profileId = rankingProfileId ?? 'house-default';
    if (!this.getProfile(profileId)) profileId = 'house-default';
    const id = `r_${nanoid(10)}`;
    const code = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const ts = nowIso();
    this.db
      .prepare(
        'INSERT INTO rooms (id, code, admin_id, name, rules_json, ranking_profile_id, last_dealer_seat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, code, adminUserId, (name ?? '').trim().slice(0, 40) || 'Teen Patti Room', JSON.stringify(merged), profileId, -1, ts);
    this.db
      .prepare('INSERT INTO room_members (room_id, user_id, seat, chips, ready, connected, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, adminUserId, 0, merged.startingChips, 0, 1, ts);
    return this.roomRow(id);
  }

  joinRoom(roomIdOrCode: string, userId: string): RoomRow {
    const room = this.roomByCode(roomIdOrCode) ?? this.roomRow(roomIdOrCode);
    const existing = this.db
      .prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(room.id, userId) as MemberRow | undefined;
    if (existing) {
      this.db.prepare('UPDATE room_members SET connected = 1 WHERE room_id = ? AND user_id = ?').run(room.id, userId);
      this.broadcast(room.id);
      return room;
    }
    const members = this.members(room.id);
    const rules = JSON.parse(room.rules_json) as RoomRules;
    if (members.length >= rules.maxPlayers) throw new AppError('This room is full.', 'ROOM_FULL');
    const usedSeats = new Set(members.map((m) => m.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;
    this.db
      .prepare('INSERT INTO room_members (room_id, user_id, seat, chips, ready, connected, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(room.id, userId, seat, rules.startingChips, 0, 1, nowIso());
    this.broadcast(room.id);
    return room;
  }

  setConnected(roomId: string, userId: string, connected: boolean): void {
    this.db
      .prepare('UPDATE room_members SET connected = ? WHERE room_id = ? AND user_id = ?')
      .run(connected ? 1 : 0, roomId, userId);
    this.broadcast(roomId);
  }

  /* ---------------------------------------------------------------- */
  /* Round loading helpers                                            */
  /* ---------------------------------------------------------------- */

  private latestRoundRow(roomId: string): RoundRow | null {
    return (
      (this.db.prepare('SELECT * FROM rounds WHERE room_id = ? ORDER BY seq DESC LIMIT 1').get(roomId) as RoundRow | undefined) ??
      null
    );
  }

  private loadDoc(row: RoundRow): RoundDoc {
    return JSON.parse(row.doc_json) as RoundDoc;
  }

  private saveDoc(doc: RoundDoc): void {
    this.db
      .prepare('UPDATE rounds SET state = ?, doc_json = ?, settled_at = ? WHERE id = ?')
      .run(doc.state, JSON.stringify(doc), doc.settledAt, doc.id);
    this.syncChips(doc);
  }

  private syncChips(doc: RoundDoc): void {
    const stmt = this.db.prepare('UPDATE room_members SET chips = ? WHERE room_id = ? AND user_id = ?');
    for (const p of doc.players) stmt.run(p.chips, doc.roomId, p.userId);
  }

  private log(doc: RoundDoc, text: string): void {
    doc.log.push({ at: nowIso(), text });
    doc.notice = text;
    if (doc.log.length > 200) doc.log.splice(0, doc.log.length - 200);
  }

  private addChips(doc: RoundDoc, userId: string, delta: number, reason: string): void {
    if (delta === 0) return;
    this.db
      .prepare('INSERT INTO chip_transactions (id, room_id, round_id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`tx_${nanoid(12)}`, doc.roomId, doc.id, userId, delta, reason, nowIso());
    this.db
      .prepare('UPDATE room_members SET chips = chips + ? WHERE room_id = ? AND user_id = ?')
      .run(delta, doc.roomId, userId);
    const p = doc.players.find((x) => x.userId === userId);
    if (p) p.chips += delta;
  }

  private toBetting(doc: RoundDoc): BettingState {
    const config: BettingConfig = {
      level: doc.stake,
      seenMultiple: doc.rules.seenMultiple ?? 2,
      counterMultiplier: doc.rules.counterMultiplier ?? 3,
    };
    const players: BetPlayer[] = doc.players.map((p) => ({
      userId: p.userId,
      seat: p.seat,
      chips: p.chips,
      inRound: p.inRound,
      folded: p.folded,
      blind: p.blind,
      totalBet: p.totalBet,
      hasActed: p.hasActed,
    }));
    const state = createBettingState(players, config, doc.turnSeat, doc.pot);
    state.level = doc.stake;
    state.lastWasSeen = doc.lastWasSeen ?? false;
    state.betsMade = doc.betsMade;
    state.counterCount = doc.counterCount;
    return state;
  }
  private fromBetting(doc: RoundDoc, state: BettingState): void {
    doc.stake = state.level;
    doc.lastWasSeen = state.lastWasSeen;
    doc.pot = state.pot;
    doc.turnSeat = state.turnSeat;
    doc.betsMade = state.betsMade;
    doc.counterCount = state.counterCount;
    for (const bp of state.players) {
      const p = doc.players.find((x) => x.userId === bp.userId);
      if (!p) continue;
      p.chips = bp.chips;
      p.folded = bp.folded;
      p.blind = bp.blind;
      p.totalBet = bp.totalBet;
      p.hasActed = bp.hasActed;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Action dispatch                                                  */
  /* ---------------------------------------------------------------- */

  handleAction(
    roomId: string,
    userId: string,
    type: string,
    payload: Record<string, unknown> | undefined,
    actionId?: string,
  ): void {
    if (actionId) {
      const seen = this.db.prepare('SELECT id FROM actions WHERE idem_key = ?').get(`${roomId}:${userId}:${actionId}`);
      if (seen) return; // idempotent replay: already applied
    }
    const run = this.db.transaction(() => {
      this.recordAction(roomId, userId, type, payload, actionId);
      this.dispatch(roomId, userId, type, payload ?? {});
    });
    try {
      run();
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    this.broadcast(roomId);
  }

  private recordAction(roomId: string, userId: string, type: string, payload: unknown, actionId?: string): void {
    const latest = this.latestRoundRow(roomId);
    this.db
      .prepare('INSERT INTO actions (id, room_id, round_id, user_id, type, payload_json, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        `a_${nanoid(14)}`,
        roomId,
        latest?.id ?? null,
        userId,
        type,
        payload ? JSON.stringify(payload) : null,
        actionId ? `${roomId}:${userId}:${actionId}` : null,
        nowIso(),
      );
  }

  private dispatch(roomId: string, userId: string, type: string, payload: Record<string, unknown>): void {
    const room = this.roomRow(roomId);
    switch (type) {
      case 'JOIN':
        this.joinRoom(roomId, userId);
        return;
      case 'READY': {
        this.member(roomId, userId);
        const ready = payload.ready === undefined ? 1 : payload.ready ? 1 : 0;
        const latest = this.latestRoundRow(roomId);
        if (latest) {
          const doc = this.loadDoc(latest);
          const inActiveRound =
            ACTIVE_ROUND_STATES.includes(doc.state) &&
            doc.state !== 'PROVISIONAL' &&
            doc.players.some((p) => p.userId === userId);
          if (inActiveRound) {
            throw new AppError('You cannot change ready status while you are playing a round.', 'ROUND_ACTIVE');
          }
        }
        this.db.prepare('UPDATE room_members SET ready = ? WHERE room_id = ? AND user_id = ?').run(ready, roomId, userId);
        return;
      }
      case 'SET_RULES': {
        this.requireAdmin(room, userId);
        const merged = sanitiseRules({ ...(JSON.parse(room.rules_json) as RoomRules), ...(payload.rules as Partial<RoomRules>) });
        if (payload.rankingProfileId) {
          if (!this.getProfile(String(payload.rankingProfileId))) throw new AppError('Unknown ranking profile.', 'BAD_PROFILE');
          this.db
            .prepare('UPDATE rooms SET ranking_profile_id = ? WHERE id = ?')
            .run(String(payload.rankingProfileId), roomId);
        }
        this.db.prepare('UPDATE rooms SET rules_json = ? WHERE id = ?').run(JSON.stringify(merged), roomId);
        return;
      }
      case 'START_ROUND':
        this.startRound(room, userId);
        return;
      case 'SEE_CARDS':
      case 'CHAAL':
      case 'RAISE':
      case 'COUNTER':
      case 'FOLD':
      case 'SET_ASSUMED':
      case 'SHOW':
      case 'SIDE_SHOW':
      case 'RESPOND_SIDE_SHOW':
        this.roundAction(room, userId, type, payload);
        return;
      case 'REQUEST_MUFLIS':
        this.requestMuflis(room, userId);
        return;
      case 'VOTE_MUFLIS':
        this.voteMuflis(room, userId, payload.approve === true);
        return;
      case 'RAISE_CONFLICT':
        this.raiseConflict(room, userId, String(payload.reason ?? ''));
        return;
      case 'RESOLVE_CONFLICT':
        this.requireAdmin(room, userId);
        this.resolveConflict(room, userId, payload);
        return;
      case 'SETTLE_NOW':
        this.settleRound(roomId, true);
        return;
      default:
        throw new AppError(`Unknown action "${type}".`, 'UNKNOWN_ACTION');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Starting a round                                                 */
  /* ---------------------------------------------------------------- */

  startRound(room: RoomRow, userId: string): void {
    this.requireAdmin(room, userId);
    const rules = JSON.parse(room.rules_json) as RoomRules;
    const latest = this.latestRoundRow(room.id);
    if (latest && ACTIVE_ROUND_STATES.includes(latest.state as RoundState)) {
      throw new AppError('A round is already in progress.', 'ROUND_ACTIVE');
    }
    const allMembers = this.members(room.id);
    const participants = allMembers.filter((m) => m.ready === 1 && m.chips >= rules.boot);
    if (participants.length < 2) {
      throw new AppError(`At least two ready players with ${rules.boot} chips are needed to start.`, 'NOT_ENOUGH_PLAYERS');
    }
    const profile = this.getProfile(room.ranking_profile_id) ?? defaultProfile();
    const ranking = this.resolvedFor(profile);
    const seq = (latest?.seq ?? 0) + 1;
    const seats = participants.map((m) => m.seat);
    const dealerSeat = nextSeatAfter(room.last_dealer_seat, seats);
    const firstToAct = nextSeatAfter(dealerSeat, seats);

    const doc: RoundDoc = {
      id: `rd_${nanoid(12)}`,
      roomId: room.id,
      seq,
      state: 'BOOT',
      rules,
      rankingProfile: profile,
      rankingVersion: ranking.version,
      deck: [],
      sharedCardId: null,
      players: participants.map((m) => {
        const user = this.db.prepare('SELECT name FROM users WHERE id = ?').get(m.user_id) as { name: string };
        return {
          userId: m.user_id,
          name: user?.name ?? 'Player',
          seat: m.seat,
          cards: [],
          assumedRank: null,
          blind: true,
          folded: false,
          inRound: true,
          hasActed: false,
          chips: m.chips,
          chipsAtStart: m.chips,
          totalBet: 0,
          bootPaid: false,
          muflisVote: null,
        };
      }),
      pot: 0,
      stake: rules.boot,
      lastWasSeen: false,
      lastBettorUserId: null,
      turnSeat: firstToAct,
      betsMade: 0,
      counterCount: 0,
      muflis: false,
      muflisRequest: null,
      show: null,
      sideShow: null,
      result: null,
      provisionalUntil: null,
      dispute: null,
      log: [],
      notice: null,
      dealerSeat,
      createdAt: nowIso(),
      settledAt: null,
    };

    this.db
      .prepare('INSERT INTO rounds (id, room_id, seq, state, doc_json, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(doc.id, room.id, seq, doc.state, JSON.stringify(doc), doc.createdAt, null);

    // ---- Boot collection (exactly once per player, enforced by chip tx unique key)
    if (rules.bootMode === 'FULL') {
      for (const p of doc.players) this.collectBoot(doc, p);
      doc.state = 'DEALING';
    } else if (rules.roundBootScope === 'FIRST_TO_ACT') {
      const first = doc.players.find((p) => p.seat === firstToAct)!;
      this.collectBoot(doc, first);
      doc.state = 'DEALING';
    } else {
      // EACH_TURN: boot is charged when each player's turn first comes up.
      doc.state = 'DEALING';
    }
    this.log(doc, `Round ${seq} started. Boot ${rules.boot} (${rules.bootMode === 'FULL' ? 'full boot' : 'round boot'}).`);

    // ---- Deal
    this.deal(doc);
    doc.state = 'BETTING';
    doc.stake = rules.boot;
    this.log(
      doc,
      `${rules.dealingMode === 'THREE_CARD' ? 'Three cards' : rules.dealingMode === 'TWO_CARD_ASSUMED' ? 'Two cards + assumed card' : 'One card + shared card'} dealt. Blind ${rules.boot}, seen chaal ${rules.boot * rules.seenMultiple}. ${doc.players.find((p) => p.seat === doc.turnSeat)?.name} to act.`,
    );
    this.db.prepare('UPDATE rooms SET last_dealer_seat = ? WHERE id = ?').run(dealerSeat, room.id);
    this.saveDoc(doc);
  }

  private collectBoot(doc: RoundDoc, player: RoundPlayerDoc): void {
    if (player.bootPaid) return;
    const boot = doc.rules.boot;
    if (player.chips < boot) throw new AppError(`${player.name} does not have enough chips for the boot.`, 'INSUFFICIENT_CHIPS');
    player.bootPaid = true;
    player.totalBet += boot;
    doc.pot += boot;
    // addChips moves the chips from the player to the pot exactly once.
    this.addChips(doc, player.userId, -boot, 'BOOT');
  }

  private deal(doc: RoundDoc): void {
    const deck = shuffle(makeDeck());
    doc.deck = deck.map((c) => c.id);
    let index = 0;
    const perPlayer = doc.rules.dealingMode === 'THREE_CARD' ? 3 : doc.rules.dealingMode === 'TWO_CARD_ASSUMED' ? 2 : 1;
    const ordered = doc.players.slice().sort((a, b) => a.seat - b.seat);
    for (let round = 0; round < perPlayer; round++) {
      for (const p of ordered) {
        p.cards.push(doc.deck[index++]);
      }
    }
    if (doc.rules.dealingMode === 'ONE_CARD_SHARED') {
      doc.sharedCardId = doc.deck[index++];
    }
    doc.deck = doc.deck.slice(index);
    const unique = new Set(ordered.flatMap((p) => p.cards).concat(doc.sharedCardId ? [doc.sharedCardId] : []));
    if (unique.size !== ordered.length * perPlayer + (doc.sharedCardId ? 1 : 0)) {
      throw new AppError('Duplicate physical card detected while dealing.', 'DEAL_ERROR');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Round actions                                                    */
  /* ---------------------------------------------------------------- */

  private currentDoc(roomId: string, allowed: RoundState[]): RoundDoc {
    const row = this.latestRoundRow(roomId);
    if (!row) throw new AppError('No round in progress.', 'NO_ROUND');
    const doc = this.loadDoc(row);
    if (!allowed.includes(doc.state)) {
      throw new AppError(`That action is not allowed while the round is "${doc.state}".`, 'BAD_STATE');
    }
    return doc;
  }

  private roundAction(room: RoomRow, userId: string, type: string, payload: Record<string, unknown>): void {
    if (type === 'RESPOND_SIDE_SHOW') {
      this.respondSideShow(room, userId, payload.accept === true);
      return;
    }
    const doc = this.currentDoc(room.id, ['BETTING', 'SHOW_REQUESTED', 'SIDE_SHOW_PENDING']);
    this.member(room.id, userId);
    const player = doc.players.find((p) => p.userId === userId);
    if (!player) throw new AppError('You are not part of this round.', 'NOT_IN_ROUND');

    switch (type) {
      case 'SET_ASSUMED': {
        if (doc.rules.dealingMode === 'THREE_CARD') {
          throw new AppError('This mode does not use an assumed card.', 'NO_ASSUMED_CARD');
        }
        if (REVEAL_STATES.includes(doc.state)) {
          throw new AppError('Assumed cards are locked once the reveal begins.', 'ASSUMED_LOCKED');
        }
        if (player.blind) {
          throw new AppError('Press "See cards" before choosing an assumed card.', 'SEE_CARDS_FIRST');
        }
        const rank = Number(payload.rank);
        const physical = player.cards.map(cardFromId);
        const shared = doc.sharedCardId ? cardFromId(doc.sharedCardId) : undefined;
        const pool = shared ? [...physical, shared] : physical;
        if (!isLegalAssumedRank(rank, pool)) {
          throw new AppError(
            `Assumed rank must be ${rankLabel(maxAssumableRank(pool))} or lower for this hand.`,
            'ILLEGAL_ASSUMED_CARD',
          );
        }
        player.assumedRank = rank;
        this.log(doc, `${player.name} chose an assumed card.`);
        this.saveDoc(doc);
        return;
      }
      case 'SIDE_SHOW': {
        this.requestSideShow(doc, userId);
        return;
      }
      case 'SHOW': {
        if (doc.state !== 'BETTING') throw new AppError('That action is not allowed right now.', 'BAD_STATE');
        const targetId = String(payload.targetUserId ?? '');
        const target = doc.players.find((p) => p.userId === targetId);
        if (!target) throw new AppError('Choose an opponent to show against.', 'BAD_TARGET');
        if (target.userId === userId) throw new AppError('You cannot show against yourself.', 'BAD_TARGET');
        if (target.folded || !target.inRound) throw new AppError('That player is no longer in the round.', 'BAD_TARGET');
        if (player.folded || !player.inRound) throw new AppError('You have folded.', 'FOLDED');
        const activeCount = doc.players.filter((p) => p.inRound && !p.folded).length;
        if (activeCount > 2) {
          throw new AppError(
            'A full show is only allowed when two players are left. Use a side show request while three or more remain.',
            'SHOW_NOT_ALLOWED',
          );
        }
        doc.show = { initiator: userId, target: targetId, at: nowIso() };
        doc.state = 'SHOW_REQUESTED';
        this.log(doc, `${player.name} requested a show against ${target.name}.`);
        this.resolveShowdown(doc, userId, targetId, 'SHOW');
        return;
      }
      case 'REQUEST_MUFLIS':
        this.requestMuflis(room, userId);
        return;
      default: {
        if (doc.state !== 'BETTING') {
          throw new AppError('Betting is paused.', 'BETTING_PAUSED');
        }
        if (doc.rules.bootMode === 'ROUND' && doc.rules.roundBootScope === 'EACH_TURN') {
          const turnPlayer = doc.players.find((p) => p.seat === doc.turnSeat);
          if (turnPlayer && !turnPlayer.bootPaid && turnPlayer.userId === userId) {
            this.collectBoot(doc, turnPlayer);
          }
        }
        const state = this.toBetting(doc);
        const betAction = {
          type: type as 'SEE_CARDS' | 'CHAAL' | 'RAISE' | 'COUNTER' | 'FOLD',
          amount: payload.amount === undefined ? undefined : Number(payload.amount),
        };
        const { state: after, event } = applyBet(state, userId, betAction);
        this.fromBetting(doc, after);
        if (betAction.type !== 'FOLD') doc.lastBettorUserId = userId;
        this.log(doc, `${player.name}: ${event.note}. Pot ${doc.pot}.`);
        if (after.roundOver) {
          const active = doc.players.filter((p) => p.inRound && !p.folded);
          this.resolveLastPlayer(doc, active[0]);
        } else if (doc.rules.maxBetsPerRound > 0 && doc.betsMade >= doc.rules.maxBetsPerRound) {
          this.resolveCapShowdown(doc);
        }
        this.saveDoc(doc);
        return;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Muflis requests                                                  */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* Side show (3+ players)                                           */
  /* ---------------------------------------------------------------- */

  private requestSideShow(doc: RoundDoc, userId: string): void {
    if (doc.state !== 'BETTING') throw new AppError('A side show can only be requested while betting.', 'BAD_STATE');
    const active = doc.players.filter((p) => p.inRound && !p.folded);
    if (active.length < 3) {
      throw new AppError('Only two players are left, so use "Request show" to end the round.', 'SHOW_INSTEAD');
    }
    const player = active.find((p) => p.userId === userId);
    if (!player) throw new AppError('Only active players can request a side show.', 'NOT_ACTIVE');

    // A side show always goes to the player who made the last bet.
    const targetId = doc.lastBettorUserId;
    if (!targetId) throw new AppError('Nobody has bet yet, so there is nobody to show against.', 'NO_LAST_BETTOR');
    const target = active.find((p) => p.userId === targetId);
    if (!target) throw new AppError('The player who made the last bet has folded.', 'NO_LAST_BETTOR');
    if (target.userId === userId) {
      throw new AppError('You made the last bet, so somebody else has to ask you.', 'BAD_TARGET');
    }
    if (doc.sideShow && doc.sideShow.status === 'PENDING') {
      throw new AppError('A side show request is already pending.', 'SIDE_SHOW_PENDING');
    }
    doc.sideShow = { initiator: userId, target: targetId, at: nowIso(), status: 'PENDING' };
    doc.state = 'SIDE_SHOW_PENDING';
    this.log(doc, `${player.name} requested a side show with ${target.name}. Betting is paused until they answer.`);
    this.saveDoc(doc);
  }

  private respondSideShow(room: RoomRow, userId: string, accept: boolean): void {
    const doc = this.currentDoc(room.id, ['SIDE_SHOW_PENDING']);
    const request = doc.sideShow;
    if (!request || request.status !== 'PENDING') throw new AppError('There is no pending side show.', 'NO_SIDE_SHOW');
    if (userId !== request.target) throw new AppError('Only the invited player can answer a side show.', 'NOT_TARGET');
    const a = doc.players.find((p) => p.userId === request.initiator)!;
    const b = doc.players.find((p) => p.userId === request.target)!;

    if (a.folded || b.folded || !a.inRound || !b.inRound) {
      request.status = 'DECLINED';
      doc.state = 'BETTING';
      this.log(doc, 'The side show was cancelled because a player had already folded.');
      this.saveDoc(doc);
      return;
    }

    if (!accept) {
      request.status = 'DECLINED';
      doc.state = 'BETTING';
      this.log(doc, `${b.name} declined the side show. Betting resumes.`);
      this.saveDoc(doc);
      return;
    }

    const ranking = this.resolvedFor(doc.rankingProfile);
    const handA = this.buildHand(doc, a, ranking);
    const handB = this.buildHand(doc, b, ranking);
    const showdown = decideShowdown(handA, handB, {
      ranking,
      muflis: doc.muflis,
      mode: doc.rules.dealingMode,
      threeCardCompare: doc.rules.threeCardCompare,
      initiator: 'a',
      sharedCardId: doc.sharedCardId ?? undefined,
    });
    const loserId = showdown.winner === 'a' ? b.userId : showdown.winner === 'b' ? a.userId : null;
    const winnerName = showdown.winner === 'a' ? a.name : showdown.winner === 'b' ? b.name : null;
    const loserName = loserId ? doc.players.find((p) => p.userId === loserId)!.name : null;
    request.status = 'ACCEPTED';
    request.loser = loserId;
    // Full detail is stored for the two participants; the table only gets the
    // announcement below (no cards, no hand classes).
    request.reason = showdown.reason;
    request.announcement = loserName
      ? `${winnerName} won the side show — ${loserName} folded.`
      : 'The side show was tied — nobody folds.';
    // Once your cards have been compared you have effectively seen them.
    a.blind = false;
    b.blind = false;
    request.hands = [
      { userId: a.userId, name: a.name, cards: this.cardViews(a), assumedRank: a.assumedRank, label: handA.label, folded: false },
      { userId: b.userId, name: b.name, cards: this.cardViews(b), assumedRank: b.assumedRank, label: handB.label, folded: false },
    ];

    if (loserId) {
      const loser = doc.players.find((p) => p.userId === loserId)!;
      loser.folded = true;
      loser.hasActed = true;
    }
    // Public log line: who was involved and who folded, never the hands.
    this.log(doc, `Side show: ${a.name} vs ${b.name}. ${request.announcement}`);

    const remaining = doc.players.filter((p) => p.inRound && !p.folded);
    if (remaining.length <= 1) {
      this.resolveLastPlayer(doc, remaining[0]);
      return;
    }
    doc.state = 'BETTING';
    const onTurn = doc.players.find((p) => p.seat === doc.turnSeat);
    if (!onTurn || onTurn.folded) {
      doc.turnSeat = nextSeatAfter(doc.turnSeat, remaining.map((p) => p.seat));
    }
    this.saveDoc(doc);
  }

  private requestMuflis(room: RoomRow, userId: string): void {
    const doc = this.currentDoc(room.id, ['BETTING']);
    if (!doc.rules.allowMidRoundMuflis) throw new AppError('Mid-round Muflis is disabled in this room.', 'MULFIS_DISABLED');
    if (doc.muflis) throw new AppError('This round is already Muflis.', 'ALREADY_MUFLIS');
    if (REVEAL_STATES.includes(doc.state)) throw new AppError('A Muflis switch is not allowed after the reveal.', 'MULFIS_TOO_LATE');
    if (doc.muflisRequest && doc.muflisRequest.status === 'PENDING') {
      throw new AppError('A Muflis request is already pending.', 'MULFIS_PENDING');
    }
    const player = doc.players.find((p) => p.userId === userId);
    if (!player || player.folded) throw new AppError('Only active players can request Muflis.', 'NOT_ACTIVE');
    doc.muflisRequest = { by: userId, at: nowIso(), approvals: [], rejections: [], status: 'PENDING' };
    for (const p of doc.players) p.muflisVote = null;
    player.muflisVote = 'APPROVE';
    doc.state = 'MUFLIS_PENDING';
    this.log(doc, `${player.name} requested a Muflis switch. Betting is paused.`);
    this.saveDoc(doc);
  }

  private voteMuflis(room: RoomRow, userId: string, approve: boolean): void {
    const doc = this.currentDoc(room.id, ['MUFLIS_PENDING']);
    const request = doc.muflisRequest;
    if (!request || request.status !== 'PENDING') throw new AppError('There is no pending Muflis request.', 'NO_MULFIS_REQUEST');

    if (doc.rules.muflisApproval === 'ADMIN') {
      this.requireAdmin(room, userId);
      const adminName = (this.db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined)?.name ?? 'the administrator';
      this.applyMuflisDecision(doc, () => adminName, approve);
      this.saveDoc(doc);
      return;
    }

    const player = doc.players.find((p) => p.userId === userId);
    if (!player || player.folded || !player.inRound) throw new AppError('Only active players can vote.', 'NOT_ACTIVE');

    // Unanimous approval by all active players.
    player.muflisVote = approve ? 'APPROVE' : 'REJECT';
    const active = doc.players.filter((p) => p.inRound && !p.folded);
    request.approvals = active.filter((p) => p.muflisVote === 'APPROVE').map((p) => p.userId);
    request.rejections = active.filter((p) => p.muflisVote === 'REJECT').map((p) => p.userId);
    if (request.rejections.length > 0) {
      this.applyMuflisDecision(doc, () => player.name, false);
    } else if (request.approvals.length === active.length) {
      this.applyMuflisDecision(doc, () => 'all active players', true);
    }
    this.saveDoc(doc);
  }

  private applyMuflisDecision(doc: RoundDoc, approverName: (fallback: string) => string, approve: boolean): void {
    const request = doc.muflisRequest!;
    const by = doc.players.find((p) => p.userId === request.by);
    request.status = approve ? 'APPROVED' : 'REJECTED';
    if (approve) {
      doc.muflis = true;
      this.log(doc, `Muflis APPROVED by ${approverName('the administrator')} (requested by ${by?.name ?? 'a player'}) at ${nowIso()}.`);
    } else {
      this.log(doc, `Muflis request from ${by?.name ?? 'a player'} was rejected. The round continues as Normal.`);
    }
    doc.state = 'BETTING';
    for (const p of doc.players) p.muflisVote = p.muflisVote ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Showdown / settlement                                            */
  /* ---------------------------------------------------------------- */

  private buildHand(doc: RoundDoc, player: RoundPlayerDoc, ranking: ResolvedRanking): EvaluatedHand {
    const mode: DealingMode = doc.rules.dealingMode;
    const physical = player.cards.map(cardFromId);
    if (mode === 'THREE_CARD') return evaluateHand(physical, ranking);
    const shared = doc.sharedCardId ? cardFromId(doc.sharedCardId) : undefined;
    const pool = shared ? [...physical, shared] : physical;
    if (player.assumedRank === null) {
      const suggestion = suggestAssumed(physical, ranking, doc.muflis, shared);
      player.assumedRank = suggestion.rank;
    }
    if (!isLegalAssumedRank(player.assumedRank, pool)) {
      const suggestion = suggestAssumed(physical, ranking, doc.muflis, shared);
      player.assumedRank = suggestion.rank;
    }
    return evaluateHand(buildAssumedHand(physical, player.assumedRank, shared), ranking);
  }

  private resolveShowdown(doc: RoundDoc, initiatorId: string, targetId: string, kind: 'SHOW' | 'ADMIN'): void {
    const ranking = this.resolvedFor(doc.rankingProfile);
    const a = doc.players.find((p) => p.userId === initiatorId)!;
    const b = doc.players.find((p) => p.userId === targetId)!;
    const handA = this.buildHand(doc, a, ranking);
    const handB = this.buildHand(doc, b, ranking);
    const showdown = decideShowdown(handA, handB, {
      ranking,
      muflis: doc.muflis,
      mode: doc.rules.dealingMode,
      threeCardCompare: doc.rules.threeCardCompare,
      initiator: 'a',
      sharedCardId: doc.sharedCardId ?? undefined,
    });

    const winnerId = showdown.winner === 'a' ? a.userId : showdown.winner === 'b' ? b.userId : null;
    const hands: HandResultView[] = [
      { userId: a.userId, name: a.name, cards: this.cardViews(a), assumedRank: a.assumedRank, label: handA.label, folded: false },
      { userId: b.userId, name: b.name, cards: this.cardViews(b), assumedRank: b.assumedRank, label: handB.label, folded: false },
    ];
    doc.result = {
      kind: kind === 'SHOW' ? 'SHOW' : 'ADMIN_WINNER',
      winnerUserId: winnerId,
      winnerName: winnerId ? (winnerId === a.userId ? a.name : b.name) : null,
      split: showdown.winner === 'tie',
      amounts: {},
      reason: showdown.reason,
      steps: showdown.steps,
      hands,
      decidedBy: null,
      explanation: null,
    };
    doc.state = 'PROVISIONAL';
    doc.provisionalUntil = Date.now() + doc.rules.disputeWindowSeconds * 1000;
    this.log(doc, `Show: ${a.name} (${handA.label}) vs ${b.name} (${handB.label}). ${showdown.reason}`);
    this.saveDoc(doc);
    this.scheduleSettlement(doc.roomId, doc.rules.disputeWindowSeconds);
  }

  /**
   * Safety valve: once the round bet cap is reached every remaining hand is
   * opened and the best hand (weakest in Muflis) takes the pot.
   */
  private resolveCapShowdown(doc: RoundDoc): void {
    const ranking = this.resolvedFor(doc.rankingProfile);
    const active = doc.players.filter((p) => p.inRound && !p.folded);
    if (active.length <= 1) {
      this.resolveLastPlayer(doc, active[0]);
      return;
    }
    const scored = active.map((p) => ({
      player: p,
      hand: this.buildHand(doc, p, ranking),
    }));
    scored.sort((a, b) => effectiveIndex(a.hand, ranking, doc.muflis) - effectiveIndex(b.hand, ranking, doc.muflis));
    const bestIndex = effectiveIndex(scored[0].hand, ranking, doc.muflis);
    const best = scored.filter((s) => effectiveIndex(s.hand, ranking, doc.muflis) === bestIndex);
    const hands: HandResultView[] = scored.map((s) => ({
      userId: s.player.userId,
      name: s.player.name,
      cards: this.cardViews(s.player),
      assumedRank: s.player.assumedRank,
      label: s.hand.label,
      folded: false,
    }));
    const split = best.length > 1;
    doc.result = {
      kind: 'BET_CAP',
      winnerUserId: split ? null : best[0].player.userId,
      winnerName: split ? null : best[0].player.name,
      split,
      splitAmong: split ? best.map((b) => b.player.userId) : null,
      amounts: {},
      reason: split
        ? `Betting reached the round cap (${doc.rules.maxBetsPerRound}); the tied best hands split the pot.`
        : `Betting reached the round cap (${doc.rules.maxBetsPerRound}); hands were opened and ${best[0].player.name} (${best[0].hand.label}) wins.`,
      steps: [
        `The round bet cap (${doc.rules.maxBetsPerRound}) was reached, so all hands were opened.`,
        ...scored.map((s) => `${s.player.name}: ${s.hand.label}`),
      ],
      hands,
      decidedBy: null,
      explanation: null,
    };
    doc.state = 'PROVISIONAL';
    doc.provisionalUntil = Date.now() + doc.rules.disputeWindowSeconds * 1000;
    this.log(doc, doc.result.reason);
    this.saveDoc(doc);
    this.scheduleSettlement(doc.roomId, doc.rules.disputeWindowSeconds);
  }

  private resolveLastPlayer(doc: RoundDoc, survivor: RoundPlayerDoc): void {
    const ranking = this.resolvedFor(doc.rankingProfile);
    const hands: HandResultView[] = doc.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      cards: this.cardViews(p),
      assumedRank: p.assumedRank,
      label: p.folded ? 'Folded' : p.userId === survivor.userId ? this.safeLabel(doc, p, ranking) : 'Folded',
      folded: p.folded,
    }));
    doc.result = {
      kind: 'LAST_PLAYER',
      winnerUserId: survivor.userId,
      winnerName: survivor.name,
      split: false,
      amounts: {},
      reason: `Everyone else folded, so ${survivor.name} wins the pot.`,
      steps: ['All other players folded.'],
      hands,
      decidedBy: null,
      explanation: null,
    };
    doc.state = 'PROVISIONAL';
    doc.provisionalUntil = Date.now() + doc.rules.disputeWindowSeconds * 1000;
    this.log(doc, `${survivor.name} wins as the last player standing.`);
    this.saveDoc(doc);
    this.scheduleSettlement(doc.roomId, doc.rules.disputeWindowSeconds);
  }

  private safeLabel(doc: RoundDoc, player: RoundPlayerDoc, ranking: ResolvedRanking): string {
    try {
      return this.buildHand(doc, player, ranking).label;
    } catch {
      return '';
    }
  }

  private scheduleSettlement(roomId: string, seconds: number): void {
    const existing = this.timers.get(roomId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      try {
        this.settleRound(roomId, false);
        this.broadcast(roomId);
      } catch {
        /* the round may have moved on (dispute/void) - ignore */
      }
    }, Math.max(1, seconds) * 1000);
    timer.unref?.();
    this.timers.set(roomId, timer);
  }

  settleRound(roomId: string, force: boolean): void {
    const run = this.db.transaction(() => {
      const row = this.latestRoundRow(roomId);
      if (!row) throw new AppError('No round to settle.', 'NO_ROUND');
      const doc = this.loadDoc(row);
      if (doc.state === 'SETTLED' || doc.state === 'VOID') return;
      if (doc.dispute && doc.dispute.status === 'OPEN') {
        throw new AppError('A dispute is open; settle it before paying out.', 'DISPUTE_OPEN');
      }
      if (doc.state !== 'PROVISIONAL') throw new AppError('The round is not awaiting settlement.', 'BAD_STATE');
      if (!force && doc.provisionalUntil && Date.now() < doc.provisionalUntil) {
        throw new AppError('The dispute window is still open.', 'DISPUTE_WINDOW');
      }
      this.finalize(doc, doc.result!, doc.result!.split);
      this.saveDoc(doc);
    });
    run();
    this.broadcast(roomId);
  }

  /** Pays out the pot exactly once (chip transaction keys make it idempotent). */
  private finalize(doc: RoundDoc, result: RoundResultView, split: boolean): void {
    if (doc.state === 'SETTLED') return;
    const pot = doc.pot;
    const amounts: Record<string, number> = {};

    if (result.kind === 'ADMIN_VOID') {
      for (const p of doc.players) {
        if (p.totalBet <= 0) continue;
        amounts[p.userId] = p.totalBet;
        this.addChips(doc, p.userId, p.totalBet, 'REFUND');
        p.totalBet = 0;
      }
      doc.pot = 0;
      doc.state = 'SETTLED';
    } else if (split) {
      const active = doc.players.filter((p) => p.inRound && !p.folded);
      const tied = result.splitAmong?.length ? doc.players.filter((p) => result.splitAmong!.includes(p.userId)) : [];
      const eligible = tied.length > 0 ? tied : active.length > 0 ? active : doc.players.filter((p) => p.inRound);
      const share = Math.floor(pot / eligible.length);
      let remainder = pot - share * eligible.length;
      const ordered = eligible.slice().sort((a, b) => a.seat - b.seat);
      let remainderTarget = ordered[0];
      if (doc.rules.remainderRule === 'INITIATOR' && doc.show) {
        remainderTarget = ordered.find((p) => p.userId === doc.show!.initiator) ?? ordered[0];
      }
      for (const p of ordered) {
        let amount = share;
        if (p.userId === remainderTarget?.userId) {
          amount += remainder;
          remainder = 0;
        }
        amounts[p.userId] = amount;
        this.addChips(doc, p.userId, amount, 'SETTLE');
      }
      doc.pot = 0;
      doc.state = 'SETTLED';
    } else {
      const winnerId = result.winnerUserId;
      if (!winnerId) throw new AppError('No winner to settle.', 'NO_WINNER');
      amounts[winnerId] = pot;
      this.addChips(doc, winnerId, pot, 'SETTLE');
      doc.pot = 0;
      doc.state = 'SETTLED';
    }

    result.amounts = amounts;
    doc.result = result;
    doc.settledAt = nowIso();
    this.log(doc, `Round settled. ${result.reason}`);
    this.db.prepare('UPDATE room_members SET ready = 0 WHERE room_id = ?').run(doc.roomId);
    const summary: RoundSummary = {
      roundId: doc.id,
      seq: doc.seq,
      at: doc.settledAt!,
      pot,
      state: doc.state,
      result: result.reason,
      winnerName: result.winnerName,
    };
    this.history.set(doc.id, summary);
  }

  private history = new Map<string, RoundSummary>();

  /* ---------------------------------------------------------------- */
  /* Disputes                                                         */
  /* ---------------------------------------------------------------- */

  private raiseConflict(room: RoomRow, userId: string, reason: string): void {
    const row = this.latestRoundRow(room.id);
    if (!row) throw new AppError('No round in progress.', 'NO_ROUND');
    const doc = this.loadDoc(row);
    if (doc.state === 'SETTLED' || doc.state === 'VOID') {
      throw new AppError('This round is already settled.', 'ALREADY_SETTLED');
    }
    if (doc.dispute && doc.dispute.status === 'OPEN') throw new AppError('A conflict is already open.', 'DISPUTE_EXISTS');
    if (!reason.trim()) throw new AppError('Please describe the conflict.', 'REASON_REQUIRED');
    const raiser = doc.players.find((p) => p.userId === userId);
    if (!raiser) throw new AppError('You are not part of this round.', 'NOT_IN_ROUND');

    const dispute: DisputeDoc = {
      id: `d_${nanoid(10)}`,
      by: userId,
      reason: reason.trim().slice(0, 500),
      at: nowIso(),
      status: 'OPEN',
    };
    doc.dispute = dispute;
    doc.state = 'DISPUTE';
    this.db
      .prepare(
        'INSERT INTO disputes (id, round_id, room_id, raised_by, reason, status, decision_json, explanation, resolved_by, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(dispute.id, doc.id, doc.roomId, userId, dispute.reason, 'OPEN', null, null, null, dispute.at, null);
    this.log(doc, `Conflict raised by ${raiser.name}. Betting and settlement are frozen.`);
    this.saveDoc(doc);
  }

  private resolveConflict(room: RoomRow, adminId: string, payload: Record<string, unknown>): void {
    const row = this.latestRoundRow(room.id);
    if (!row) throw new AppError('No round in progress.', 'NO_ROUND');
    const doc = this.loadDoc(row);
    if (!doc.dispute || doc.dispute.status !== 'OPEN') throw new AppError('There is no open conflict.', 'NO_DISPUTE');
    const decision = String(payload.decision ?? '');
    const explanation = String(payload.explanation ?? '').trim();
    if (!explanation) throw new AppError('An explanation is required for an administrator decision.', 'EXPLANATION_REQUIRED');

    const previous = doc.result;
    let result: RoundResultView;
    let split = false;

    if (decision === 'WINNER') {
      const winnerId = String(payload.winnerUserId ?? '');
      const winner = doc.players.find((p) => p.userId === winnerId);
      if (!winner) throw new AppError('Choose a player in this round.', 'BAD_WINNER');
      result = {
        kind: 'ADMIN_WINNER',
        winnerUserId: winner.userId,
        winnerName: winner.name,
        split: false,
        amounts: {},
        reason: `The administrator awarded the pot to ${winner.name}.`,
        steps: previous?.steps ?? [],
        hands: previous?.hands ?? [],
        decidedBy: adminId,
        explanation,
      };
    } else if (decision === 'SPLIT') {
      split = true;
      result = {
        kind: 'ADMIN_SPLIT',
        winnerUserId: null,
        winnerName: null,
        split: true,
        amounts: {},
        reason: 'The administrator split the pot between the remaining players.',
        steps: previous?.steps ?? [],
        hands: previous?.hands ?? [],
        decidedBy: adminId,
        explanation,
      };
    } else if (decision === 'VOID') {
      result = {
        kind: 'ADMIN_VOID',
        winnerUserId: null,
        winnerName: null,
        split: false,
        amounts: {},
        reason: 'The administrator voided the round and refunded all contributions.',
        steps: previous?.steps ?? [],
        hands: previous?.hands ?? [],
        decidedBy: adminId,
        explanation,
      };
    } else {
      throw new AppError('Unknown decision.', 'BAD_DECISION');
    }

    doc.dispute.status = 'RESOLVED';
    doc.dispute.decision = decision;
    doc.dispute.explanation = explanation;
    doc.dispute.resolvedBy = adminId;
    doc.dispute.resolvedAt = nowIso();
    this.db
      .prepare('UPDATE disputes SET status = ?, decision_json = ?, explanation = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run('RESOLVED', JSON.stringify({ decision, winnerUserId: payload.winnerUserId ?? null }), explanation, adminId, doc.dispute.resolvedAt!, doc.dispute.id);

    const adminName = (this.db.prepare('SELECT name FROM users WHERE id = ?').get(adminId) as { name: string } | undefined)?.name ?? 'Admin';
    doc.state = 'PROVISIONAL';
    doc.result = result;
    this.finalize(doc, result, split);
    this.log(doc, `Administrator ${adminName} resolved the conflict: ${result.reason} (${explanation})`);
    this.saveDoc(doc);
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                            */
  /* ---------------------------------------------------------------- */

  private cardViews(player: RoundPlayerDoc): CardView[] {
    const views: CardView[] = player.cards.map((id) => {
      const card = cardFromId(id);
      return { rank: card.rank, suit: card.suit };
    });
    if (player.assumedRank !== null) {
      views.push({ rank: player.assumedRank, suit: null, virtual: true });
    }
    return views;
  }

  /**
   * Read-only hand label used by views. Never mutates the round (unlike
   * buildHand, which may auto-fill a missing assumed card at showdown).
   */
  private peekLabel(doc: RoundDoc, player: RoundPlayerDoc, ranking: ResolvedRanking): string | null {
    try {
      const physical = player.cards.map(cardFromId);
      if (doc.rules.dealingMode === 'THREE_CARD') return evaluateHand(physical, ranking).label;
      const shared = doc.sharedCardId ? cardFromId(doc.sharedCardId) : undefined;
      if (player.assumedRank === null) return null;
      const cards = shared ? [...physical, shared] : physical;
      return evaluateHand(buildAssumedHand(cards, player.assumedRank), ranking).label;
    } catch {
      return null;
    }
  }

  roomView(roomId: string, viewerId: string): RoomView {
    const room = this.roomRow(roomId);
    const rules = JSON.parse(room.rules_json) as RoomRules;
    const members = this.members(roomId);
    const viewerMember = members.find((m) => m.user_id === viewerId);
    const viewer = (this.db.prepare('SELECT id, name FROM users WHERE id = ?').get(viewerId) as UserRow) ?? {
      id: viewerId,
      name: 'Guest',
    };
    const latest = this.latestRoundRow(roomId);
    const doc = latest ? this.loadDoc(latest) : null;
    const ranking = doc ? this.resolvedFor(doc.rankingProfile) : null;
    const revealed = !!doc && REVEAL_STATES.includes(doc.state);
    const viewerIsAdmin = room.admin_id === viewerId;
    const adminSeesAll = viewerIsAdmin && !!doc && doc.state === 'DISPUTE';
    // A side show reveals cards only once the invited player has accepted.
    const sideShowPair =
      doc?.sideShow &&
      doc.sideShow.status === 'ACCEPTED' &&
      (doc.sideShow.initiator === viewerId || doc.sideShow.target === viewerId)
        ? new Set([doc.sideShow.initiator, doc.sideShow.target])
        : null;

    const players: PlayerView[] = members.map((m) => {
      const rp = doc?.players.find((p) => p.userId === m.user_id);
      const user = this.db.prepare('SELECT name FROM users WHERE id = ?').get(m.user_id) as UserRow | undefined;
      const isYou = m.user_id === viewerId;
      const showCards =
        !!rp && ((isYou && !rp.blind) || revealed || adminSeesAll || (sideShowPair?.has(m.user_id) ?? false));
      let cards: CardView[] = [];
      if (rp) {
        const raw = rp.cards.map(cardFromId);
        if (showCards) {
          cards = raw.map((c) => ({ rank: c.rank, suit: c.suit }));
          if (rp.assumedRank !== null) cards.push({ rank: rp.assumedRank, suit: null, virtual: true });
        } else {
          cards = raw.map(() => ({ rank: 0, suit: null, hidden: true }));
        }
      }
      const legal =
        !!doc && isYou && doc.state === 'BETTING' && doc.turnSeat === m.seat
          ? computeLegalActions(this.toBetting(doc), viewerId)
          : null;
      // You must look at your cards before you can choose an assumed card.
      const canAssume =
        !!rp && !!doc && doc.rules.dealingMode !== 'THREE_CARD' && !revealed && isYou && !rp.blind;
      const shared = doc?.sharedCardId ? cardFromId(doc.sharedCardId) : null;

      const handLabel = rp && ranking && showCards && !rp.blind ? this.peekLabel(doc!, rp, ranking) : null;

      return {
        userId: m.user_id,
        name: user?.name ?? 'Player',
        seat: m.seat,
        chips: rp ? rp.chips : m.chips,
        ready: m.ready === 1,
        connected: m.connected === 1,
        isAdmin: m.user_id === room.admin_id,
        isYou,
        inRound: rp ? rp.inRound : false,
        folded: rp ? rp.folded : false,
        blind: rp ? rp.blind : false,
        seen: rp ? !rp.blind : false,
        cards,
        assumedRank: rp && (isYou || revealed || adminSeesAll) ? rp.assumedRank : null,
        legalAssumedRanks:
          canAssume && rp
            ? legalAssumedRanks(shared ? [...rp.cards.map(cardFromId), shared] : rp.cards.map(cardFromId))
            : null,
        totalBet: rp ? rp.totalBet : 0,
        isTurn: !!doc && doc.turnSeat === m.seat && doc.state === 'BETTING',
        legal,
        muflisVote: rp?.muflisVote ?? null,
        handLabel,
        chipsAtStart: rp ? rp.chipsAtStart : null,
        muflisPending: !!doc?.muflisRequest && doc.muflisRequest.status === 'PENDING' && rp?.muflisVote === null,
      };
    });

    let round: RoundView | null = null;
    if (doc) {
      const sharedCard = doc.sharedCardId ? cardFromId(doc.sharedCardId) : null;
      const show: ShowInfo | null = doc.show
        ? {
            initiatorUserId: doc.show.initiator,
            initiatorName: doc.players.find((p) => p.userId === doc.show!.initiator)?.name ?? '',
            targetUserId: doc.show.target,
            targetName: doc.players.find((p) => p.userId === doc.show!.target)?.name ?? '',
            at: doc.show.at,
          }
        : null;
      const sideShow: SideShowView | null = doc.sideShow
        ? {
            initiatorUserId: doc.sideShow.initiator,
            initiatorName: doc.players.find((p) => p.userId === doc.sideShow!.initiator)?.name ?? '',
            targetUserId: doc.sideShow.target,
            targetName: doc.players.find((p) => p.userId === doc.sideShow!.target)?.name ?? '',
            at: doc.sideShow.at,
            status: doc.sideShow.status,
            announcement: doc.sideShow.announcement ?? null,
            // Only the two players involved (and the admin during a dispute) get
            // the hands and the ranked reason.
            result:
              doc.sideShow.hands && (adminSeesAll || sideShowPair)
                ? {
                    loserUserId: doc.sideShow.loser ?? null,
                    loserName: doc.players.find((p) => p.userId === doc.sideShow!.loser)?.name ?? null,
                    reason: doc.sideShow.reason ?? '',
                    hands: doc.sideShow.hands,
                  }
                : null,
          }
        : null;
      const muflisRequest: MuflisRequestView | null = doc.muflisRequest        ? {
            by: doc.muflisRequest.by,
            byName: doc.players.find((p) => p.userId === doc.muflisRequest!.by)?.name ?? '',
            at: doc.muflisRequest.at,
            approvals: doc.muflisRequest.approvals,
            rejections: doc.muflisRequest.rejections,
            needed: doc.players.filter((p) => p.inRound && !p.folded).map((p) => p.userId),
            policy: doc.rules.muflisApproval,
          }
        : null;
      const dispute: DisputeView | null = doc.dispute
        ? {
            id: doc.dispute.id,
            by: doc.dispute.by,
            byName: doc.players.find((p) => p.userId === doc.dispute!.by)?.name ?? '',
            reason: doc.dispute.reason,
            at: doc.dispute.at,
            status: doc.dispute.status,
          }
        : null;
      round = {
        id: doc.id,
        seq: doc.seq,
        state: doc.state,
        pot: doc.pot,
        stake: doc.stake,
        seenStake: doc.lastWasSeen ? doc.stake : doc.stake * (doc.rules.seenMultiple ?? 2),
        lastBet: doc.stake,
        lastBettorUserId: doc.lastBettorUserId ?? null,
        lastBettorName: doc.lastBettorUserId ? (doc.players.find((p) => p.userId === doc.lastBettorUserId)?.name ?? null) : null,
        turnSeat: doc.state === 'BETTING' ? doc.turnSeat : null,
        muflis: doc.muflis,
        dealingMode: doc.rules.dealingMode,
        threeCardCompare: doc.rules.threeCardCompare,
        boot: doc.rules.boot,
        bootMode: doc.rules.bootMode,
        sharedCard: sharedCard ? { rank: sharedCard.rank, suit: sharedCard.suit } : null,
        show,
        sideShow,
        muflisRequest,
        revealed,
        result: doc.result,
        provisionalUntil: doc.provisionalUntil,
        dispute,
        log: doc.log.slice(-40),
        ranking: { profileId: doc.rankingProfile.id, name: doc.rankingProfile.name, version: doc.rankingProfile.version },
        adminVisibleHands:
          adminSeesAll && ranking
            ? doc.players.map((p) => ({
                userId: p.userId,
                name: p.name,
                cards: this.cardViews(p),
                assumedRank: p.assumedRank,
                label: this.safeLabel(doc, p, ranking),
                folded: p.folded,
              }))
            : null,
      };
    }

    const history: RoundSummary[] = (this.db
      .prepare('SELECT id, doc_json FROM rounds WHERE room_id = ? ORDER BY seq DESC LIMIT 10')
      .all(roomId) as Array<{ id: string; doc_json: string }>)
      .map((r) => {
        const d = JSON.parse(r.doc_json) as RoundDoc;
        return {
          roundId: d.id,
          seq: d.seq,
          at: d.settledAt ?? d.createdAt,
          pot: d.result?.amounts ? Object.values(d.result.amounts).reduce((a, b) => a + b, 0) : d.pot,
          state: d.state,
          result: d.result?.reason ?? 'In progress',
          winnerName: d.result?.winnerName ?? null,
        };
      });

    return {
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        adminId: room.admin_id,
        rules,
        rankingProfileId: room.ranking_profile_id,
        createdAt: room.created_at,
      },
      you: {
        userId: viewerId,
        name: viewer.name,
        isAdmin: viewerIsAdmin,
        seat: viewerMember ? viewerMember.seat : null,
      },
      players,
      round,
      history,
      serverTime: Date.now(),
      notice: doc?.notice ?? null,
    };
  }
}

function sanitiseRules(input: RoomRules): RoomRules {
  const rules: RoomRules = { ...DEFAULT_RULES, ...input };
  rules.minBoot = Math.max(1, Math.floor(Number(rules.minBoot) || 1));
  rules.boot = Math.max(rules.minBoot, Math.floor(Number(rules.boot) || rules.minBoot));
  rules.counterMultiplier = Math.max(2, Math.floor(Number(rules.counterMultiplier) || 3));
  rules.seenMultiple = Math.max(1, Math.floor(Number(rules.seenMultiple) || 2));
  rules.disputeWindowSeconds = Math.max(0, Math.min(600, Math.floor(Number(rules.disputeWindowSeconds) || 0)));
  rules.maxPlayers = Math.max(2, Math.min(MAX_SEATS, Math.floor(Number(rules.maxPlayers) || 2)));
  rules.startingChips = Math.max(rules.boot, Math.floor(Number(rules.startingChips) || 1000));
  if (rules.dealingMode !== 'THREE_CARD' && rules.dealingMode !== 'TWO_CARD_ASSUMED' && rules.dealingMode !== 'ONE_CARD_SHARED') {
    rules.dealingMode = 'THREE_CARD';
  }
  if (rules.threeCardCompare !== 'FULL_HAND' && rules.threeCardCompare !== 'HIGHEST_CARD') {
    rules.threeCardCompare = 'FULL_HAND';
  }
  if (rules.bootMode !== 'FULL' && rules.bootMode !== 'ROUND') rules.bootMode = 'FULL';
  if (rules.roundBootScope !== 'FIRST_TO_ACT' && rules.roundBootScope !== 'EACH_TURN') rules.roundBootScope = 'FIRST_TO_ACT';
  if (rules.muflisApproval !== 'ADMIN' && rules.muflisApproval !== 'UNANIMOUS') rules.muflisApproval = 'ADMIN';
  if (rules.remainderRule !== 'LOWEST_SEAT' && rules.remainderRule !== 'INITIATOR') rules.remainderRule = 'LOWEST_SEAT';
  rules.maxBetsPerRound = Math.max(0, Math.min(500, Math.floor(Number(rules.maxBetsPerRound) || 0)));
  return rules;
}
