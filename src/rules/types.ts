/** Shared rule-level types (no DOM, no server dependencies). */

export type DealingMode = 'THREE_CARD' | 'FOUR_CARD_BEST_THREE' | 'TWO_CARD_ASSUMED' | 'ONE_CARD_SHARED';

export const DEALING_MODE_LABEL: Record<DealingMode, string> = {
  THREE_CARD: 'Three-card',
  FOUR_CARD_BEST_THREE: 'Four-card (best three of four)',
  TWO_CARD_ASSUMED: 'Two-card + assumed card',
  ONE_CARD_SHARED: 'One-card + shared open card',
};

/** True for modes played with a physical three-card hand and no assumed card. */
export function isPhysicalOnlyMode(mode: DealingMode): boolean {
  return mode === 'THREE_CARD' || mode === 'FOUR_CARD_BEST_THREE';
}

/** How many cards each player receives at the deal. */
export function cardsPerPlayer(mode: DealingMode): number {
  if (mode === 'THREE_CARD') return 3;
  if (mode === 'FOUR_CARD_BEST_THREE') return 4;
  if (mode === 'TWO_CARD_ASSUMED') return 2;
  return 1;
}

/**
 * Muflis is a **game type**, not a request. A Muflis game walks through these
 * dealing stages in order, and only moves on when a round is actually **shown**.
 */
export const MULFIS_STAGE_ORDER: DealingMode[] = [
  'FOUR_CARD_BEST_THREE',
  'TWO_CARD_ASSUMED',
  'ONE_CARD_SHARED',
  'THREE_CARD',
];

/** The final Muflis stage is three-card with reversed (weakest-wins) ranking. */
export const MULFIS_LAST_STAGE = MULFIS_STAGE_ORDER.length - 1;

export type GameType = 'NORMAL' | 'MUFLIS';

export const GAME_TYPE_LABEL: Record<GameType, string> = {
  NORMAL: 'Normal Teen Patti',
  MUFLIS: 'Muflis (staged, weakest hand wins at the end)',
};

/** Only meaningful in THREE_CARD mode. Never inferred silently. */
export type ThreeCardCompare = 'FULL_HAND' | 'HIGHEST_CARD';

export const THREE_CARD_COMPARE_LABEL: Record<ThreeCardCompare, string> = {
  FULL_HAND: 'Full three-card hand comparison',
  HIGHEST_CARD: 'Highest single card of the three',
};

export type BootMode = 'FULL' | 'ROUND';

export const BOOT_MODE_LABEL: Record<BootMode, string> = {
  FULL: 'Full boot - every player pays the boot',
  ROUND: 'Round boot - only the player on turn pays the boot',
};

export type MuflisApproval = 'ADMIN' | 'UNANIMOUS';

export type RoundState =
  | 'LOBBY'
  | 'BOOT'
  | 'DEALING'
  | 'BETTING'
  | 'SHOW_REQUESTED'
  | 'SIDE_SHOW_PENDING'
  | 'MUFLIS_PENDING'
  | 'WINNER_CHOICE'
  | 'PROVISIONAL'
  | 'DISPUTE'
  | 'SETTLED'
  | 'VOID';

export const ROUND_STATE_LABEL: Record<RoundState, string> = {
  LOBBY: 'Lobby',
  BOOT: 'Collecting boot',
  DEALING: 'Dealing',
  BETTING: 'Betting',
  SHOW_REQUESTED: 'Show requested',
  SIDE_SHOW_PENDING: 'Side show requested',
  MUFLIS_PENDING: 'Muflis request pending',
  WINNER_CHOICE: 'Winner deciding',
  PROVISIONAL: 'Provisional result',
  DISPUTE: 'Dispute',
  SETTLED: 'Settled',
  VOID: 'Void',
};
