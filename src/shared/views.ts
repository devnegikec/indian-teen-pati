/**
 * Wire types shared by the authoritative server and the browser client.
 * Nothing here imports server-only code.
 */

import type { LegalActions } from '../rules/betting';
import type { BootMode, DealingMode, MuflisApproval, RoundState, ThreeCardCompare } from '../rules/types';

export const MAX_SEATS = 6;

export type RemainderRule = 'LOWEST_SEAT' | 'INITIATOR';
export type RoundBootScope = 'FIRST_TO_ACT' | 'EACH_TURN';

export interface RoomRules {
  /** Boot charged for each round; never below `minBoot`. */
  boot: number;
  /** Room's minimum permitted boot. */
  minBoot: number;
  bootMode: BootMode;
  /** Only used with ROUND boot mode. */
  roundBootScope: RoundBootScope;
  dealingMode: DealingMode;
  /** Explicit; never inferred. Only meaningful for THREE_CARD. */
  threeCardCompare: ThreeCardCompare;
  muflisApproval: MuflisApproval;
  counterMultiplier: number;
  /** Seen player pays level × seenMultiple (double by default). */
  seenMultiple: number;
  disputeWindowSeconds: number;
  remainderRule: RemainderRule;
  maxPlayers: number;
  startingChips: number;
  allowMidRoundMuflis: boolean;
  /**
   * Safety valve against endless blind-chaal loops: when this many bets have
   * been made the hands are opened automatically. 0 disables the cap.
   */
  maxBetsPerRound: number;
}

export const DEFAULT_RULES: RoomRules = {
  boot: 10,
  minBoot: 10,
  bootMode: 'FULL',
  roundBootScope: 'FIRST_TO_ACT',
  dealingMode: 'THREE_CARD',
  threeCardCompare: 'FULL_HAND',
  muflisApproval: 'ADMIN',
  counterMultiplier: 3,
  seenMultiple: 2,
  disputeWindowSeconds: 15,
  remainderRule: 'LOWEST_SEAT',
  maxPlayers: MAX_SEATS,
  startingChips: 5000,
  allowMidRoundMuflis: true,
  maxBetsPerRound: 24,
};

export interface CardView {
  /** Rank 2..14, Ace high. */
  rank: number;
  suit: 'S' | 'H' | 'D' | 'C' | null;
  /** Face-down cards expose no rank or suit. */
  hidden?: boolean;
  /** True for an assumed (virtual) card. */
  virtual?: boolean;
}

export interface PlayerView {
  userId: string;
  name: string;
  seat: number;
  chips: number;
  ready: boolean;
  connected: boolean;
  isAdmin: boolean;
  isYou: boolean;
  inRound: boolean;
  folded: boolean;
  blind: boolean;
  seen: boolean;
  cards: CardView[];
  assumedRank: number | null;
  legalAssumedRanks: number[] | null;
  totalBet: number;
  isTurn: boolean;
  /** Populated only for the requesting player. */
  legal: LegalActions | null;
  muflisVote: 'APPROVE' | 'REJECT' | null;
  handLabel: string | null;
  chipsAtStart: number | null;
  muflisPending?: boolean;
}

export interface ShowInfo {
  initiatorUserId: string;
  initiatorName: string;
  targetUserId: string;
  targetName: string;
  at: string;
}

export interface SideShowView {
  initiatorUserId: string;
  initiatorName: string;
  targetUserId: string;
  targetName: string;
  at: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  /**
   * Public one-liner shown to the whole table. Deliberately carries no cards or
   * hand classes: "Ravi won the side show — Bot Ana folded."
   */
  announcement: string | null;
  /**
   * Full comparison (hands + reason). Only ever populated for the two players
   * involved in the side show (and the administrator during a dispute).
   */
  result: {
    loserUserId: string | null;
    loserName: string | null;
    reason: string;
    hands: HandResultView[];
  } | null;
}

export interface MuflisRequestView {
  by: string;
  byName: string;
  at: string;
  approvals: string[];
  rejections: string[];
  needed: string[];
  policy: MuflisApproval;
}

export interface HandResultView {
  userId: string;
  name: string;
  cards: CardView[];
  assumedRank: number | null;
  label: string;
  folded: boolean;
}

export interface RoundResultView {
  kind: 'SHOW' | 'LAST_PLAYER' | 'BET_CAP' | 'ADMIN_WINNER' | 'ADMIN_SPLIT' | 'ADMIN_VOID';
  winnerUserId: string | null;
  winnerName: string | null;
  split: boolean;
  /** When splitting, the players who share the pot (defaults to all active). */
  splitAmong?: string[] | null;
  amounts: Record<string, number>;
  reason: string;
  steps: string[];
  hands: HandResultView[];
  decidedBy?: string | null;
  explanation?: string | null;
}

export interface DisputeView {
  id: string;
  by: string;
  byName: string;
  reason: string;
  at: string;
  status: 'OPEN' | 'RESOLVED';
}

export interface RoundView {
  id: string;
  seq: number;
  state: RoundState;
  pot: number;
  /** Amount of the current bet (what a blind player must put). */
  stake: number;
  /** What a seen player pays right now. */
  seenStake: number;
  /** Amount of the current bet (alias of `stake`, kept for the UI). */
  lastBet: number;
  /** The player who made the last bet — a side show is offered to them. */
  lastBettorUserId: string | null;
  lastBettorName: string | null;
  turnSeat: number | null;
  muflis: boolean;
  dealingMode: DealingMode;
  threeCardCompare: ThreeCardCompare;
  boot: number;
  bootMode: BootMode;
  sharedCard: CardView | null;
  show: ShowInfo | null;
  sideShow: SideShowView | null;
  muflisRequest: MuflisRequestView | null;
  revealed: boolean;
  result: RoundResultView | null;
  provisionalUntil: number | null;
  dispute: DisputeView | null;
  log: Array<{ at: string; text: string }>;
  ranking: { profileId: string; name: string; version: number };
  /**
   * Cards of every player, only present once authorised (your own cards are
   * always visible in `players`). Admin sees these during a dispute.
   */
  adminVisibleHands: HandResultView[] | null;
}

export interface RoundSummary {
  roundId: string;
  seq: number;
  at: string;
  pot: number;
  state: string;
  result: string;
  winnerName: string | null;
}

export interface RoomView {
  room: {
    id: string;
    code: string;
    name: string;
    adminId: string;
    rules: RoomRules;
    rankingProfileId: string;
    createdAt: string;
  };
  you: { userId: string; name: string; isAdmin: boolean; seat: number | null };
  players: PlayerView[];
  round: RoundView | null;
  history: RoundSummary[];
  serverTime: number;
  /** One-shot banner for the viewer (e.g. "Muflis approved"). */
  notice: string | null;
}
