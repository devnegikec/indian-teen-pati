/**
 * Betting engine.
 *
 * Two prices live side by side:
 *
 *   - `blindPrice` — what a **blind** player puts. A blind player always pays
 *     exactly what the previous player paid (the "pass"). After the first blind
 *     bet it stays at that amount until somebody raises or counters.
 *   - `seenPrice` — what a **seen** player puts: double the blind price.
 *
 * A blind player's bet is a **counter** only when the previous bet was made by a
 * *seen* player ("it came after the seen bet"). A counter raises the seen price
 * to three times the counter amount. A blind player who comes *after* a counter
 * is not forced to pay the tripled price — they simply pass with the same
 * amount again.
 *
 * Sequence from the house rules (boot 10):
 *   Dev blind 10 → Yet blind 10 → Hem blind 10 → Dev seen 20 →
 *   Yet blind counter 20 (seen price 60) → Hem blind pass 20 →
 *   Dev seen 60 → blind counter 60 (seen price 180) → …
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
  /** Boot — the opening blind price. */
  boot: number;
  /** A seen player pays blindPrice × this (2 = double). */
  seenMultiple: number;
  /** A counter raises the seen price to counterAmount × this. */
  counterMultiplier: number;
}

export interface BettingState {
  /** Amount a blind player puts (matches the previous bet). */
  blindPrice: number;
  /** Amount a seen player puts. */
  seenPrice: number;
  /** True when the previous bet was made by a seen player (so a blind bet counters). */
  counterNeeded: boolean;
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
  return state.counterNeeded ? 'BLIND_COUNTER' : 'BLIND';
}

/** What this player must put to stay in the hand. */
export function requiredAmount(state: BettingState, player: BetPlayer): number {
  return player.blind ? state.blindPrice : state.seenPrice;
}

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
    seenAmount: state.seenPrice,
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
        event: { userId, type: 'SEE_CARDS', amount: 0, levelAfter: next.seenPrice, potAfter: next.pot, note: 'Looked at cards' },
      };
    }
    case 'CHAAL': {
      pay(next, player, need);
      next.betsMade++;
      let note: string;
      if (kind === 'SEEN') {
        // the seen bet becomes the new blind price
        next.blindPrice = need;
        next.counterNeeded = true;
        next.lastAction = 'chaal';
        note = `Chaal ${need}`;
      } else if (kind === 'BLIND_COUNTER') {
        // blind bet right after a seen bet -> counter
        next.counterCount++;
        next.seenPrice = counterLevel(next, need);
        next.counterNeeded = false;
        next.lastAction = 'counter';
        note = `Blind counter ${need} (seen play now ${next.seenPrice})`;
      } else {
        // plain pass: match the previous bet
        next.counterNeeded = false;
        next.lastAction = 'blind';
        note = `Blind ${need}`;
      }
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'CHAAL', amount: need, levelAfter: next.seenPrice, potAfter: next.pot, note },
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
      next.blindPrice = amount;
      next.seenPrice = player.blind ? amount * next.seenMultiple : amount;
      next.counterNeeded = !player.blind;
      next.lastAction = 'raise';
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'RAISE', amount, levelAfter: next.seenPrice, potAfter: next.pot, note: `Raise to ${amount}` },
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
      next.seenPrice = counterLevel(next, cost);
      next.counterNeeded = false;
      next.lastAction = 'counter';
      finishTurn(next, player);
      return {
        state: next,
        event: {
          userId,
          type: 'COUNTER',
          amount: cost,
          levelAfter: next.seenPrice,
          potAfter: next.pot,
          note: `Counter ${cost} (seen play now ${next.seenPrice})`,
        },
      };
    }
    case 'FOLD': {
      player.folded = true;
      next.lastAction = 'fold';
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'FOLD', amount: 0, levelAfter: next.seenPrice, potAfter: next.pot, note: 'Folded' },
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
    blindPrice: config.boot,
    seenPrice: config.boot * config.seenMultiple,
    counterNeeded: false,
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
