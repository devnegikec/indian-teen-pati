/**
 * Hand evaluation, comparison and assumed-card rules.
 * Pure functions only: no IO, no randomness, fully unit-testable.
 */

import {
  Card,
  MAX_RANK,
  MIN_RANK,
  Rank,
  SUITS,
  Suit,
  isRun,
  patternKeyOfRanks,
  rankLabel,
  sortCardsDesc,
  virtualCard,
} from './cards';
import {
  HandVariant,
  RankOverride,
  ResolvedRanking,
  VARIANT_SHORT,
  classKey,
} from './ranking';
import { DealingMode, ThreeCardCompare } from './types';

export interface EvaluatedHand {
  cards: Card[];
  ranks: Rank[];
  pattern: string;
  variant: HandVariant;
  classKey: string;
  /** Position in the resolved order; 0 is the strongest class. */
  classIndex: number;
  label: string;
  isFlush: boolean;
  hasVirtual: boolean;
  /** Suit strength indices in descending rank order, or null when unknowable. */
  suitKey: number[] | null;
  assumedRank: Rank | null;
  /** All physical cards in the hand are aces (used by the AA tie-break). */
  physicalAA: boolean;
  /** Physical cards (suit is never null). */
  physicalCards: Card[];
}

export class RulesError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RulesError';
  }
}

export function handVariantOf(cards: readonly Card[]): { variant: HandVariant; isFlush: boolean } {
  const ranks = cards.map((c) => c.rank);
  const distinct = new Set(ranks);
  const isFlush = cards.length === 3 && cards.every((c) => c.suit !== null) && new Set(cards.map((c) => c.suit)).size === 1;
  if (distinct.size === 1) return { variant: 'TRAIL', isFlush };
  if (distinct.size === 3) {
    if (isRun(ranks)) return { variant: isFlush ? 'PURE_SEQUENCE' : 'SEQUENCE', isFlush };
    return { variant: isFlush ? 'COLOUR' : 'HIGH_CARD', isFlush };
  }
  return { variant: 'PAIR', isFlush };
}

export function evaluateHand(cards: readonly Card[], ranking: ResolvedRanking): EvaluatedHand {
  if (cards.length !== 3) {
    throw new RulesError(`A comparison hand must contain exactly 3 cards, received ${cards.length}.`, 'BAD_HAND');
  }
  const sorted = sortCardsDesc(cards, ranking.suitOrder);
  const ranks = sorted.map((c) => c.rank);
  const { variant, isFlush } = handVariantOf(sorted);
  const pattern = patternKeyOfRanks(ranks);
  const key = classKey(variant, pattern);
  const classIndex = ranking.index.get(key);
  if (classIndex === undefined) {
    throw new RulesError(`Hand class ${key} is not part of this ranking profile.`, 'UNKNOWN_CLASS');
  }
  const physicalCards = sorted.filter((c) => c.suit !== null);
  const hasVirtual = sorted.some((c) => c.suit === null);
  let suitKey: number[] | null = null;
  if (!hasVirtual) {
    suitKey = sorted.map((c) => ranking.suitOrder.indexOf(c.suit as Suit));
  }
  const handClass = ranking.classes.get(key)!;
  return {
    cards: sorted,
    ranks,
    pattern,
    variant,
    classKey: key,
    classIndex,
    label: handClass.label,
    isFlush,
    hasVirtual,
    suitKey,
    assumedRank: sorted.find((c) => c.suit === null)?.rank ?? null,
    physicalAA: physicalCards.length > 0 && physicalCards.every((c) => c.rank === 14),
    physicalCards,
  };
}

/** Effective index with Muflis applied (0 strongest, lower = better). */
export function effectiveIndex(hand: EvaluatedHand, ranking: ResolvedRanking, muflis: boolean): number {
  return muflis ? ranking.order.length - 1 - hand.classIndex : hand.classIndex;
}

export type Winner = 'a' | 'b' | 'tie';

export interface ShowdownContext {
  ranking: ResolvedRanking;
  muflis: boolean;
  mode: DealingMode;
  threeCardCompare: ThreeCardCompare;
  /** Who requested the show; used by tie rules in assumed-card modes. */
  initiator?: 'a' | 'b';
  /** Card id of the shared open card, excluded from the spade advantage. */
  sharedCardId?: string;
}

export interface ShowdownResult {
  winner: Winner;
  reason: string;
  steps: string[];
  tie: boolean;
  reversedByMuflis: boolean;
}

function compareSuitKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function hasExclusiveSpadeAce(hand: EvaluatedHand, sharedCardId?: string): boolean {
  return hand.physicalCards.some((c) => c.rank === 14 && c.suit === 'S' && c.id !== sharedCardId);
}

function patternLabel(pattern: string): string {
  return pattern
    .split('-')
    .map((r) => rankLabel(Number(r)))
    .join('');
}

/**
 * Decides a two-player showdown following the documented evaluation order:
 *  1. hands are already locked by the caller
 *  2. compare with the active ranking profile
 *  3. reverse strength when Muflis is active
 *  4. apply the AA / Ace-of-Spades rule
 *  5. apply the show-initiator rule in the assumed-card modes
 *  6. otherwise split
 */
export function decideShowdown(a: EvaluatedHand, b: EvaluatedHand, ctx: ShowdownContext): ShowdownResult {
  const { ranking, muflis, mode, threeCardCompare } = ctx;
  const steps: string[] = [];
  let winner: Winner = 'tie';
  let reason = 'The hands are equal.';

  const highestOnly = mode === 'THREE_CARD' && threeCardCompare === 'HIGHEST_CARD';

  if (highestOnly) {
    const ra = a.ranks[0];
    const rb = b.ranks[0];
    steps.push(`Highest single card: ${rankLabel(ra)} vs ${rankLabel(rb)}`);
    if (ra !== rb) {
      const natural: Winner = ra > rb ? 'a' : 'b';
      winner = muflis ? (natural === 'a' ? 'b' : 'a') : natural;
      reason = muflis
        ? `Muflis is active, so the lower highest card wins (${rankLabel(ra)} vs ${rankLabel(rb)}).`
        : `Higher highest card wins (${rankLabel(ra)} vs ${rankLabel(rb)}).`;
      steps.push(muflis ? 'Muflis reverses the highest-card comparison.' : 'Normal comparison.');
    }
  } else {
    const ia = effectiveIndex(a, ranking, muflis);
    const ib = effectiveIndex(b, ranking, muflis);
    if (ia !== ib) {
      winner = ia < ib ? 'a' : 'b';
      const stronger = ia < ib ? a : b;
      const weaker = ia < ib ? b : a;
      reason = muflis
        ? `Muflis is active: the weaker hand wins, so ${stronger.label} beats ${weaker.label}.`
        : `${stronger.label} beats ${weaker.label} in this ranking profile.`;
      steps.push(`Profile order: ${stronger.label} ranks ahead of ${weaker.label}.`);
      if (muflis) steps.push('Muflis reverses hand strength.');
      if (stronger.classKey !== weaker.classKey && ranking.overrides.length > 0) {
        const override = findExplainingOverride(stronger.pattern, weaker.pattern, ranking.overrides);
        if (override) steps.push(`Custom rule: ${patternLabel(override.stronger)} beats ${patternLabel(override.weaker)}.`);
      }
    }
  }

  // Suit tie-break when the profile is suit sensitive.
  if (winner === 'tie' && !highestOnly && ranking.suitSensitive && a.suitKey && b.suitKey) {
    const cmp = compareSuitKeys(a.suitKey, b.suitKey);
    if (cmp !== 0) {
      const natural: Winner = cmp < 0 ? 'a' : 'b';
      const reverse = muflis && ranking.muflisTiePolicy === 'REVERSE_SUIT';
      winner = reverse ? (natural === 'a' ? 'b' : 'a') : natural;
      const winSuit = (winner === 'a' ? a : b).cards[0].suit;
      reason = `Same hand class; suit tie-break gives ${winSuit ? winSuit : 'the win'} the edge.`;
      steps.push(`Suit order tie-break${reverse ? ' (reversed for Muflis)' : ''}.`);
    }
  }

  // AA / Ace of Spades rule (assumed-card modes only).
  if (winner === 'tie' && mode !== 'THREE_CARD') {
    if (a.physicalAA && b.physicalAA) {
      const sa = hasExclusiveSpadeAce(a, ctx.sharedCardId);
      const sb = hasExclusiveSpadeAce(b, ctx.sharedCardId);
      if (sa !== sb) {
        winner = sa ? 'a' : 'b';
        reason = 'Both players hold AA; the exclusive Ace of Spades wins the tie.';
        steps.push('AA tie-break: exclusive Ace of Spades.');
      } else {
        steps.push('AA tie-break: no exclusive spade advantage.');
      }
    }
  }

  // Show-initiator tie rule in the assumed-card modes.
  if (winner === 'tie' && mode !== 'THREE_CARD' && ctx.initiator) {
    winner = ctx.initiator;
    reason = 'The hands are still tied, so the show initiator wins.';
    steps.push('Show-initiator tie rule.');
  }

  if (winner === 'tie') {
    reason = mode === 'THREE_CARD' ? 'The hands are equal; the pot is split.' : 'The hands are equal; the pot is split.';
  }

  return { winner, reason, steps, tie: winner === 'tie', reversedByMuflis: muflis && !highestOnly };
}

function findExplainingOverride(a: string, b: string, overrides: RankOverride[]): RankOverride | undefined {
  return overrides.find((o) => o.stronger === a && o.weaker === b) ?? overrides.find((o) => o.stronger === b && o.weaker === a);
}

/* ------------------------------------------------------------------ */
/* Assumed (virtual) card rules                                        */
/* ------------------------------------------------------------------ */

/**
 * The assumed card's rank must be <= the higher-ranked physical card, using an
 * explicit numeric rank scale (Ace high). This rule is deliberately independent
 * of any custom hand ranking.
 */
export function maxAssumableRank(physicalCards: readonly Card[]): Rank {
  const physical = physicalCards.filter((c) => c.suit !== null);
  if (physical.length === 0) throw new RulesError('At least one physical card is required.', 'NO_PHYSICAL');
  return physical.reduce((max, c) => (c.rank > max ? c.rank : max), MIN_RANK);
}

export function legalAssumedRanks(physicalCards: readonly Card[]): Rank[] {
  const max = maxAssumableRank(physicalCards);
  const ranks: Rank[] = [];
  for (let r = MIN_RANK; r <= max; r++) ranks.push(r);
  return ranks;
}

export function isLegalAssumedRank(rank: Rank, physicalCards: readonly Card[]): boolean {
  if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) return false;
  return rank <= maxAssumableRank(physicalCards);
}

export function assertLegalAssumedRank(rank: Rank, physicalCards: readonly Card[]): void {
  if (!isLegalAssumedRank(rank, physicalCards)) {
    throw new RulesError(
      `Assumed rank ${rankLabel(rank)} is not allowed: it must be ${rankLabel(maxAssumableRank(physicalCards))} or lower.`,
      'ILLEGAL_ASSUMED_CARD',
    );
  }
}

/**
 * Builds the comparison hand for the assumed-card modes.
 * Virtual cards are never removed from the deck and never carry a suit.
 */
export function buildAssumedHand(physicalCards: readonly Card[], assumedRank: Rank, sharedCard?: Card): Card[] {
  assertLegalAssumedRank(assumedRank, sharedCard ? [...physicalCards, sharedCard] : physicalCards);
  const cards = sharedCard ? [...physicalCards, sharedCard, virtualCard(assumedRank)] : [...physicalCards, virtualCard(assumedRank)];
  return cards;
}

export interface AssumedSuggestion {
  rank: Rank;
  hand: EvaluatedHand;
  reason: string;
}

/**
 * "Suggest strongest legal choice": respects Normal vs Muflis.
 * In Muflis the weakest legal completion is the winning one, so it is offered.
 */
export function suggestAssumed(
  physicalCards: readonly Card[],
  ranking: ResolvedRanking,
  muflis: boolean,
  sharedCard?: Card,
): AssumedSuggestion {
  const max = maxAssumableRank(sharedCard ? [...physicalCards, sharedCard] : physicalCards);
  let bestRank = max;
  let bestHand: EvaluatedHand | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (let rank = MIN_RANK; rank <= max; rank++) {
    const cards = sharedCard ? [...physicalCards, sharedCard, virtualCard(rank)] : [...physicalCards, virtualCard(rank)];
    const hand = evaluateHand(cards, ranking);
    const idx = effectiveIndex(hand, ranking, muflis);
    if (idx < bestIndex) {
      bestIndex = idx;
      bestRank = rank;
      bestHand = hand;
    }
  }
  return {
    rank: bestRank,
    hand: bestHand!,
    reason: muflis
      ? `With Muflis active the weakest completion wins, so ${rankLabel(bestRank)} is suggested.`
      : `Assuming ${rankLabel(bestRank)} gives ${bestHand!.label}, the strongest legal completion.`,
  };
}

/** Hands that the sandbox can render for a set of cards. */
export function describeHand(hand: EvaluatedHand): string {
  const cards = hand.cards.map((c) => `${rankLabel(c.rank)}${c.suit ?? '*'}`).join(' ');
  return `${cards} = ${VARIANT_SHORT[hand.variant]}${hand.assumedRank ? ` (assumed ${rankLabel(hand.assumedRank)})` : ''}`;
}

export const ALL_SUITS = SUITS;
