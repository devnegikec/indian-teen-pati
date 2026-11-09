/**
 * Card primitives for a standard 52 card deck (no jokers).
 *
 * Ranks are numeric: 2..10 literal, 11=J, 12=Q, 13=K, 14=A.
 * A card with `suit === null` is a *virtual* card (an "assumed" card in the
 * two-card / one-card dealing modes). Virtual cards never have a suit and are
 * therefore unable to form a flush or win a spade tie-break.
 */

export type Suit = 'S' | 'H' | 'D' | 'C';

/** 2..14, Ace high. */
export type Rank = number;

export interface Card {
  /** Stable identifier. Virtual cards use the `V` prefix. */
  id: string;
  rank: Rank;
  /** null only for virtual (assumed) cards. */
  suit: Suit | null;
  virtual?: boolean;
}

export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
export const MIN_RANK = 2;
export const MAX_RANK = 14;

export const SUIT_SYMBOL: Record<Suit, string> = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };

export function rankLabel(rank: Rank): string {
  if (rank === 14) return 'A';
  if (rank === 13) return 'K';
  if (rank === 12) return 'Q';
  if (rank === 11) return 'J';
  return String(rank);
}

export function cardLabel(card: Card): string {
  return `${rankLabel(card.rank)}${card.suit ? SUIT_SYMBOL[card.suit] : '*'}`;
}

export function physicalCardId(rank: Rank, suit: Suit): string {
  return `${suit}${rank}`;
}

export function virtualCard(rank: Rank): Card {
  return { id: `V${rank}`, rank, suit: null, virtual: true };
}

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
      deck.push({ id: physicalCardId(rank, suit), rank, suit });
    }
  }
  return deck;
}

export function cardFromId(id: string): Card {
  if (id.startsWith('V')) {
    return virtualCard(Number(id.slice(1)));
  }
  const suit = id[0] as Suit;
  const rank = Number(id.slice(1));
  if (!SUITS.includes(suit) || !Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) {
    throw new Error(`Invalid card id: ${id}`);
  }
  return { id, rank, suit };
}

/** Cryptographically strong Fisher-Yates shuffle. Works in Node 20+ and browsers. */
export function shuffle<T>(input: readonly T[]): T[] {
  const arr = input.slice();
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error('A cryptographic RNG is required to shuffle the deck');
  }
  const buf = new Uint32Array(1);
  for (let i = arr.length - 1; i > 0; i--) {
    // Rejection sampling keeps the distribution uniform.
    const limit = Math.floor(0x100000000 / (i + 1)) * (i + 1);
    let value = 0;
    do {
      cryptoObj.getRandomValues(buf);
      value = buf[0];
    } while (value >= limit);
    const j = value % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Sorts descending by rank, then suit order, so hands are canonical. */
export function sortCardsDesc(cards: readonly Card[], suitOrder: Suit[] = SUITS): Card[] {
  return cards.slice().sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    const sa = a.suit ? suitOrder.indexOf(a.suit) : 99;
    const sb = b.suit ? suitOrder.indexOf(b.suit) : 99;
    return sa - sb;
  });
}

/**
 * A *rank pattern* is the unordered multiset of ranks in a hand, strongest
 * card first, e.g. A,9,10 -> "14-10-9". Card input order never matters.
 */
export function patternKeyOfRanks(ranks: readonly Rank[]): string {
  return ranks
    .slice()
    .sort((a, b) => b - a)
    .join('-');
}

export function patternKeyOf(cards: readonly Card[]): string {
  return patternKeyOfRanks(cards.map((c) => c.rank));
}

export function parsePatternKey(key: string): Rank[] {
  const ranks = key.split('-').map(Number);
  if (ranks.length !== 3 || ranks.some((r) => !Number.isInteger(r) || r < MIN_RANK || r > MAX_RANK)) {
    throw new Error(`Invalid rank pattern: ${key}`);
  }
  return ranks.sort((a, b) => b - a);
}

/** True for three distinct ranks that form a run, including A-2-3 and Q-K-A. */
export function isRun(ranks: readonly Rank[]): boolean {
  const distinct = Array.from(new Set(ranks));
  if (distinct.length !== 3) return false;
  const asc = distinct.slice().sort((a, b) => a - b);
  if (asc[1] === asc[0] + 1 && asc[2] === asc[1] + 1) return true;
  // A-2-3
  return asc[0] === 2 && asc[1] === 3 && asc[2] === 14;
}

/** Strength value of a run: AKQ high (14) descending to A23 which counts as 3-high. */
export function runHighValue(ranks: readonly Rank[]): number {
  const asc = Array.from(new Set(ranks)).sort((a, b) => a - b);
  if (asc[0] === 2 && asc[1] === 3 && asc[2] === 14) return 3;
  return asc[2];
}
