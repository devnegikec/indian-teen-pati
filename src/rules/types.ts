/** Shared rule-level types (no DOM, no server dependencies). */

export type DealingMode = 'THREE_CARD' | 'TWO_CARD_ASSUMED' | 'ONE_CARD_SHARED';

export const DEALING_MODE_LABEL: Record<DealingMode, string> = {
  THREE_CARD: 'Three-card',
  TWO_CARD_ASSUMED: 'Two-card + assumed card',
  ONE_CARD_SHARED: 'One-card + shared open card',
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
  PROVISIONAL: 'Provisional result',
  DISPUTE: 'Dispute',
  SETTLED: 'Settled',
  VOID: 'Void',
};
