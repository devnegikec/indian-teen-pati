/**
 * Betting engine: chaal / blind / raise / counter.
 *
 * House rules implemented here (see README "Assumptions"):
 *  - A blind player's stake is half of the seen ("open") stake, so the next
 *    seen player automatically puts double what the blind player put.
 *  - A blind player who does not open may either match the same blind amount or
 *    raise.
 *  - A counter is only legal after at least one bet has been made in the round.
 *    The next player then has to put `counterMultiplier` (default 3) times the
 *    previous seen stake.
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
  /** Blind player pays half of the seen stake (next seen player pays double). */
  blindPlaysHalf: boolean;
  /** Multiplier applied to the seen stake by a counter action. */
  counterMultiplier: number;
}

export interface BettingState {
  stake: number;
  pot: number;
  turnSeat: number;
  counterCount: number;
  betsMade: number;
  players: BetPlayer[];
  config: BettingConfig;
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
  stakeAfter: number;
  potAfter: number;
  note: string;
}

export interface LegalActions {
  canSeeCards: boolean;
  chaal: { amount: number; allowed: boolean };
  raise: { min: number; max: number; allowed: boolean };
  counter: { amount: number; newStake: number; allowed: boolean };
  fold: { allowed: boolean };
}

export class BettingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'BettingError';
  }
}

export function blindAmount(stake: number, config: BettingConfig): number {
  return config.blindPlaysHalf ? Math.ceil(stake / 2) : stake;
}

export function requiredAmount(state: BettingState, player: BetPlayer): number {
  return player.blind ? blindAmount(state.stake, state.config) : state.stake;
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

function cloneState(state: BettingState): BettingState {
  return { ...state, players: state.players.map((p) => ({ ...p })) };
}

export function legalActions(state: BettingState, userId: string): LegalActions | null {
  const player = playerById(state, userId);
  if (!player || !player.inRound || player.folded) return null;
  if (state.roundOver) return null;
  if (player.seat !== state.turnSeat) return null;
  const need = requiredAmount(state, player);
  const counterAmount = need;
  return {
    canSeeCards: player.blind,
    chaal: { amount: need, allowed: player.chips >= need },
    raise: {
      min: need + 1,
      max: player.chips,
      allowed: player.chips > need,
    },
    counter: {
      amount: counterAmount,
      newStake: state.stake * state.config.counterMultiplier,
      allowed: state.betsMade >= 1 && player.chips >= counterAmount,
    },
    fold: { allowed: true },
  };
}

function nextTurnSeat(state: BettingState, fromSeat: number): number {
  const candidates = state.players
    .filter((p) => p.inRound && !p.folded)
    .sort((a, b) => a.seat - b.seat);
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
 * Applies a bet. Throws BettingError for anything illegal; the caller must
 * validate ownership of the turn first (server side) which this function also
 * enforces.
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

  switch (action.type) {
    case 'SEE_CARDS': {
      if (!player.blind) throw new BettingError('You have already seen your cards.', 'ALREADY_SEEN');
      player.blind = false;
      next.lastAction = 'see';
      return {
        state: next,
        event: { userId, type: 'SEE_CARDS', amount: 0, stakeAfter: next.stake, potAfter: next.pot, note: 'Looked at cards' },
      };
    }
    case 'CHAAL': {
      pay(next, player, need);
      next.betsMade++;
      next.lastAction = 'chaal';
      const note = player.blind ? `Blind chaal ${need}` : `Chaal ${need}`;
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'CHAAL', amount: need, stakeAfter: next.stake, potAfter: next.pot, note },
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
      const wasBlind = player.blind;
      pay(next, player, amount);
      next.betsMade++;
      next.stake = wasBlind && next.config.blindPlaysHalf ? amount * 2 : amount;
      next.lastAction = 'raise';
      finishTurn(next, player);
      return {
        state: next,
        event: {
          userId,
          type: 'RAISE',
          amount,
          stakeAfter: next.stake,
          potAfter: next.pot,
          note: `Raise to ${next.stake}${wasBlind ? ' (blind raise)' : ''}`,
        },
      };
    }
    case 'COUNTER': {
      if (next.betsMade < 1) {
        throw new BettingError('A counter is only possible after a player has bet.', 'COUNTER_NOT_ALLOWED');
      }
      pay(next, player, need);
      next.betsMade++;
      next.counterCount++;
      next.stake = next.stake * next.config.counterMultiplier;
      next.lastAction = 'counter';
      finishTurn(next, player);
      return {
        state: next,
        event: {
          userId,
          type: 'COUNTER',
          amount: need,
          stakeAfter: next.stake,
          potAfter: next.pot,
          note: `Counter - next player must put ${next.stake}`,
        },
      };
    }
    case 'FOLD': {
      player.folded = true;
      next.lastAction = 'fold';
      finishTurn(next, player);
      return {
        state: next,
        event: { userId, type: 'FOLD', amount: 0, stakeAfter: next.stake, potAfter: next.pot, note: 'Folded' },
      };
    }
    default:
      throw new BettingError(`Unknown action ${(action as BetAction).type}.`, 'UNKNOWN_ACTION');
  }
}

export function createBettingState(
  players: BetPlayer[],
  stake: number,
  turnSeat: number,
  config: BettingConfig,
  pot = 0,
): BettingState {
  const activeCount = players.filter((p) => p.inRound && !p.folded).length;
  return {
    stake,
    pot,
    turnSeat,
    counterCount: 0,
    betsMade: 0,
    players: players.map((p) => ({ ...p })),
    config: { ...config },
    roundOver: activeCount <= 1,
    lastAction: null,
  };
}
