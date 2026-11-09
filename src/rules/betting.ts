/**
 * Betting engine.
 *
 * One number carries the table: `level`, the amount of the current bet.
 *
 *   - A **blind** player always matches the level (a "pass").
 *     If the previous bet was made by a *seen* player, that match is a
 *     **counter**: the level is then multiplied by `counterMultiplier`
 *     (three times) and everybody after plays at the new level.
 *   - A **seen** player pays **double** the level — but only while the betting
 *     has been blind. Once a seen bet (or a counter) has been made, seen players
 *     simply match the level, so a counter is exactly ×3 and never ×6.
 *   - A **raise** sets the level to any amount above the requirement.
 *
 * Worked example (boot 10): blind 10 → blind 10 → blind 10 → seen 20 →
 * blind counter 20 (level 60) → seen 60 → seen 60 → blind counter 60
 * (level 180) …
 */

export interface BetPlayer {
  userId: string;
  seat: number;
  chips: number;
  inRound: boolean;
  folded: boolean;
  blind: boolean;
  totalBet: number;
  hasActed: boolean;
}

export interface BettingConfig {
  /** Starting level (normally the boot). */
  level: number;
  /** A seen player pays level × this while the betting is still blind. */
  seenMultiple: number;
  /** A counter multiplies the level by this. */
  counterMultiplier: number;
}

export interface BettingState {
  /** Amount of the current bet (what a blind player must put). */
  level: number;
  /** True when the previous bet was made by a player who had seen their cards. */
  lastWasSeen: boolean;
  seenMultiple: number;
  counterMultiplier: number;
  pot: number;
  turnSeat: number;
  counterCount: number;
  betsMade: number;
  players: BetPlayer[];
  roundOver: boolean;
  lastAction: string | null;
}

export type BetActionType = 'SEE_CARDS' | 'CHAAL' | 'RAISE' | 'COUNTER' | 'FOLD';

export interface BetAction {
  type: BetActionType;
  amount?: number;
}

export interface BetEvent {
  userId: string;
  type: BetActionType;
  amount: number;
  levelAfter: number;
  potAfter: number;
  note: string;
}

export type ChaalKind = 'BLIND' | 'BLIND_COUNTER' | 'SEEN';

export interface LegalActions {
  canSeeCards: boolean;
  chaal: { amount: number; allowed: boolean; kind: ChaalKind };
  /** What a seen player pays right now. */
  seenAmount: number;
  raise: { min: number; max: number; allowed: boolean };
  counter: { amount: number; newLevel: number; allowed: boolean };
  fold: { allowed: boolean };
}

export class BettingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'BettingError';
  }
}

export function activePlayers(state: BettingState): BetPlayer[] {
  return state.players.filter((p) => p.inRound && !p.folded);
}

export function playerBySeat(state: BettingState, seat: number): BetPlayer | undefined {
  return state.players.find((p) => p.seat === seat);
}

export function playerById(state: BettingState, userId: string): BetPlayer | undefined {
  return state.players.find((p) => p.userId === userId);
}

export function chaalKind(state: BettingState, player: BetPlayer): ChaalKind {
  if (!player.blind) return 'SEEN';
  return state.lastWasSeen ? 'BLIND_COUNTER' : 'BLIND';
}

/** What this player must put to stay in the hand. */
export function requiredAmount(state: BettingState, player: BetPlayer): number {
  if (player.blind) return state.level;
  return state.lastWasSeen ? state.level : state.level * state.seenMultiple;
}

/** Cost of an explicit counter — the same amount the player would normally put. */
export function counterCost(state: BettingState, player: BetPlayer): number {
  return requiredAmount(state, player);
}

export function counterLevel(state: BettingState, amount: number): number {
  return amount * state.counterMultiplier;
}

function cloneState(state: BettingState): BettingState {
  return { ...state, players: state.players.map((p) => ({ ...p })) };
}

export function legalActions(state: BettingState, userId: string): LegalActions | null {
  const player = playerById(state, userId);
  if (!player || !player.inRound || player.folded) return null;
  if (state.roundOver) return null;
  if (player.seat !== state.turnSeat) return null;
  const need = requiredAmount(state, player);
  return {
    canSeeCards: player.blind,
    chaal: { amount: need, allowed: player.chips >= need, kind: chaalKind(state, player) },
    seenAmount: state.lastWasSeen ? state.level : state.level * state.seenMultiple,
    raise: {
      min: need + 1,
      max: player.chips,
      allowed: player.chips > need,
    },
    counter: {
      amount: need,
      newLevel: counterLevel(state, need),
      allowed: state.betsMade >= 1 && player.chips >= need,
    },
    fold: { allowed: true },
  };
}

function nextTurnSeat(state: BettingState, fromSeat: number): number {
  const candidates = state.players.filter((p) => p.inRound && !p.folded).sort((a, b) => a.seat - b.seat);
  if (candidates.length === 0) return fromSeat;
  if (candidates.length === 1) return candidates[0].seat;
  const after = candidates.find((p) => p.seat > fromSeat);
  return (after ?? candidates[0]).seat;
}

function pay(state: BettingState, player: BetPlayer, amount: number): void {
  if (amount > player.chips) {
    throw new BettingError(`${player.userId} does not have enough chips to put ${amount}.`, 'INSUFFICIENT_CHIPS');
  }
  player.chips -= amount;
  player.totalBet += amount;
  state.pot += amount;
}

function finishTurn(state: BettingState, player: BetPlayer): void {
  player.hasActed = true;
  const remaining = activePlayers(state);
  if (remaining.length <= 1) {
    state.roundOver = true;
    return;
  }
  state.turnSeat = nextTurnSeat(state, player.seat);
}

/**
 * Applies a bet. Throws BettingError for anything illegal; the caller must also
 * have validated that the action comes from the player on turn.
 */
export function applyBet(state: BettingState, userId: string, action: BetAction): { state: BettingState; event: BetEvent } {
  const next = cloneState(state);
  const player = playerById(next, userId);
  if (!player) throw new BettingError('You are not seated in this round.', 'NOT_SEATED');
  if (!player.inRound) throw new BettingError('You are not part of this round.', 'NOT_IN_ROUND');
  if (player.folded) throw new BettingError('You have already folded.', 'FOLDED');
  if (next.roundOver) throw new BettingError('The round is no longer accepting bets.', 'ROUND_OVER');
  if (player.seat !== next.turnSeat) throw new BettingError('It is not your turn.', 'NOT_YOUR_TURN');

  const need = requiredAmount(next, player);
  const kind = chaalKind(next, player);

  switch (action.type) {
    case 'SEE_CARDS': {
      if (!player.blind) throw new BettingError('You have already seen your cards.', 'ALREADY_SEEN');
      player.blind = false;
      next.lastAction = 'see';
      return {
        state: next,
        event: { userId, type: 'SEE_CARDS', amount: 0, levelAfter: next.level, potAfter: next.pot, note: 'Looked at cards' },
      };
    }
    case 'CHAAL': {
      pay(next, player, need);
      next.betsMade++;
      let note: string;
      if (kind === 'SEEN') {
        next.level = need; // double of the blind level, or a plain match
        next.lastWasSeen = true;
        next.lastAction = 'chaal';
        note = `Chaal ${need}`;
      } else if (kind === 'BLIND_COUNTER') {
        // blind bet right after a seen bet: counter, level × 3 exactly once
        next.counterCount++;
        next.level = counterLevel(next, need);
        next.lastWasSeen = true;
        next.lastAction = 'counter';
        note = `Blind counter ${need} (bet raised to ${next.level})`;
      } else {
        // blind pass: match the level
        next.lastWasSeen = false;
        next.lastAction = 'blind';
        note = `Blind ${need}`;
      }
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'CHAAL', amount: need, levelAfter: next.level, potAfter: next.pot, note },
      };
    }
    case 'RAISE': {
      const amount = action.amount ?? 0;
      if (!Number.isInteger(amount) || amount <= need) {
        throw new BettingError(`A raise must be more than the required ${need}.`, 'BAD_RAISE');
      }
      if (amount > player.chips) {
        throw new BettingError('You do not have enough chips for that raise.', 'INSUFFICIENT_CHIPS');
      }
      pay(next, player, amount);
      next.betsMade++;
      next.level = amount;
      next.lastWasSeen = !player.blind;
      next.lastAction = 'raise';
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'RAISE', amount, levelAfter: next.level, potAfter: next.pot, note: `Raise to ${amount}` },
      };
    }
    case 'COUNTER': {
      if (next.betsMade < 1) {
        throw new BettingError('A counter is only possible after a player has bet.', 'COUNTER_NOT_ALLOWED');
      }
      const cost = counterCost(next, player);
      pay(next, player, cost);
      next.betsMade++;
      next.counterCount++;
      next.level = counterLevel(next, cost);
      next.lastWasSeen = true;
      next.lastAction = 'counter';
      finishTurn(next, player);
      return {
        state: next,
        event: {
          userId,
          type: 'COUNTER',
          amount: cost,
          levelAfter: next.level,
          potAfter: next.pot,
          note: `Counter ${cost} (bet raised to ${next.level})`,
        },
      };
    }
    case 'FOLD': {
      player.folded = true;
      next.lastAction = 'fold';
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'FOLD', amount: 0, levelAfter: next.level, potAfter: next.pot, note: 'Folded' },
      };
    }
    default:
      throw new BettingError(`Unknown action ${(action as BetAction).type}.`, 'UNKNOWN_ACTION');
  }
}

export function createBettingState(
  players: BetPlayer[],
  config: BettingConfig,
  turnSeat: number,
  pot = 0,
): BettingState {
  const activeCount = players.filter((p) => p.inRound && !p.folded).length;
  return {
    level: config.level,
    lastWasSeen: false,
    seenMultiple: config.seenMultiple,
    counterMultiplier: config.counterMultiplier,
    pot,
    turnSeat,
    counterCount: 0,
    betsMade: 0,
    players: players.map((p) => ({ ...p })),
    roundOver: activeCount <= 1,
    lastAction: null,
  };
}
