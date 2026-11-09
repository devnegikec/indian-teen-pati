import { describe, expect, it } from 'vitest';
import {
  Card,
  REQUIRED_ORDER_HANDS,
  cardsOf,
  decideShowdown,
  defaultProfile,
  evaluateHand,
  isLegalAssumedRank,
  legalAssumedRanks,
  resolveRanking,
  suggestAssumed,
  tryResolveRanking,
  buildAssumedHand,
  type DealingMode,
  type RankingProfile,
  type ThreeCardCompare,
} from '../src/rules';

const profile = defaultProfile();
const ranking = resolveRanking(profile);

function hand(...ids: string[]) {
  return evaluateHand(cardsOf(...ids), ranking);
}

function beats(a: Card[], b: Card[], muflis = false, mode: DealingMode = 'THREE_CARD', cmp: ThreeCardCompare = 'FULL_HAND') {
  const result = decideShowdown(evaluateHand(a, ranking), evaluateHand(b, ranking), {
    ranking,
    muflis,
    mode,
    threeCardCompare: cmp,
  });
  return result.winner;
}

const H = Object.fromEntries(REQUIRED_ORDER_HANDS.map((h) => [h.label, h.cards]));

describe('required custom ranking chain', () => {
  it('orders 222 > 235 > AKQ > AKJ > A109 > KQJ in Normal mode', () => {
    const chain = ['222', '235', 'AKQ', 'AKJ', 'A109', 'KQJ'];
    for (let i = 0; i < chain.length - 1; i++) {
      const strong = H[chain[i]];
      const weak = H[chain[i + 1]];
      expect(beats(strong, weak), `${chain[i]} should beat ${chain[i + 1]}`).toBe('a');
      expect(beats(weak, strong), `${chain[i + 1]} should lose to ${chain[i]}`).toBe('b');
    }
  });

  it('reverses the same chain in Muflis', () => {
    const chain = ['222', '235', 'AKQ', 'AKJ', 'A109', 'KQJ'];
    for (let i = 0; i < chain.length - 1; i++) {
      const strong = H[chain[i]];
      const weak = H[chain[i + 1]];
      expect(beats(strong, weak, true), `${chain[i]} should lose to ${chain[i + 1]} in Muflis`).toBe('b');
      expect(beats(weak, strong, true), `${chain[i + 1]} should beat ${chain[i]} in Muflis`).toBe('a');
    }
  });

  it('is insensitive to the order cards are supplied in', () => {
    const a = hand('S2', 'H3', 'D5');
    const b = hand('D5', 'S2', 'H3');
    const c = hand('H3', 'D5', 'S2');
    expect(a.pattern).toBe('5-3-2');
    expect(a.classKey).toBe(b.classKey);
    expect(b.classKey).toBe(c.classKey);
    expect(a.classIndex).toBe(c.classIndex);
    // and vs a different pattern the winner is the same for every permutation
    const opp = H['KQJ'];
    expect(beats(cardsOf('D5', 'S2', 'H3'), opp)).toBe(beats(cardsOf('H3', 'D5', 'S2'), opp));
  });

  it('keeps 235 above pairs, colours and high cards but below trails', () => {
    expect(beats(H['235'], cardsOf('S5', 'H5', 'D3'))).toBe('a'); // vs pair
    expect(beats(H['235'], cardsOf('D9', 'D8', 'D6'))).toBe('a'); // vs colour
    expect(beats(H['235'], cardsOf('C7', 'D4', 'H2'))).toBe('a'); // vs high card
    expect(beats(H['235'], cardsOf('S13', 'H13', 'D13'))).toBe('b'); // vs KKK trail
  });
});

describe('circular rules', () => {
  it('rejects A > B > C > A', () => {
    const bad: RankingProfile = {
      ...profile,
      id: 'cycle',
      overrides: [
        { stronger: '14-13-12', weaker: '14-13-11' },
        { stronger: '14-13-11', weaker: '14-10-9' },
        { stronger: '14-10-9', weaker: '14-13-12' },
      ],
    };
    const result = tryResolveRanking(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CIRCULAR_RULES');
      expect(result.error).toMatch(/contradict/i);
    }
  });

  it('rejects an outright self-contradiction', () => {
    const bad: RankingProfile = {
      ...profile,
      overrides: [
        { stronger: '2-2-2', weaker: '2-3-5' },
        { stronger: '2-3-5', weaker: '2-2-2' },
      ],
    };
    expect(tryResolveRanking(bad).ok).toBe(false);
  });
});

describe('assumed card rules', () => {
  const physical = cardsOf('S13', 'H7'); // K and 7

  it('allows the higher physical rank or lower, using an A-high scale', () => {
    expect(isLegalAssumedRank(13, physical)).toBe(true);
    expect(isLegalAssumedRank(7, physical)).toBe(true);
    expect(isLegalAssumedRank(2, physical)).toBe(true);
    expect(isLegalAssumedRank(14, physical)).toBe(false);
    expect(isLegalAssumedRank(8, physical)).toBe(true); // anything up to K is allowed
    expect(legalAssumedRanks(physical)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('allows A with two aces', () => {
    expect(legalAssumedRanks(cardsOf('S14', 'H14'))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('rejects an illegal assumed card', () => {
    expect(() => buildAssumedHand(physical, 14)).toThrow(/not allowed/i);
  });

  it('never lets the assumed card create a flush or take a suit', () => {
    const h = evaluateHand(buildAssumedHand(cardsOf('S9', 'S8'), 7), ranking);
    expect(h.hasVirtual).toBe(true);
    expect(h.isFlush).toBe(false);
    expect(h.suitKey).toBeNull();
    expect(h.cards.find((c) => c.virtual)?.suit).toBeNull();
  });

  it('suggests the strongest legal completion normally and the weakest in Muflis', () => {
    const normal = suggestAssumed(cardsOf('S13', 'H13'), ranking, false);
    expect(normal.rank).toBe(13); // KK + K = AAA? no: K,K,K = trail
    const muflis = suggestAssumed(cardsOf('S13', 'H13'), ranking, true);
    expect(muflis.rank).toBe(2); // weakest trail: 222
  });
});

describe('AA spade and initiator tie rules', () => {
  it('gives the Ace of Spades the win when both players hold AA', () => {
    const a = cardsOf('S14', 'H14');
    const b = cardsOf('H14', 'D14');
    const ra = evaluateHand(buildAssumedHand(a, 13), ranking);
    const rb = evaluateHand(buildAssumedHand(b, 13), ranking);
    const result = decideShowdown(ra, rb, {
      ranking,
      muflis: false,
      mode: 'TWO_CARD_ASSUMED',
      threeCardCompare: 'FULL_HAND',
      initiator: 'b',
    });
    expect(result.winner).toBe('a');
    expect(result.reason).toMatch(/spade/i);
  });

  it('falls back to the show initiator when neither has an exclusive spade', () => {
    const a = cardsOf('H14', 'C14');
    const b = cardsOf('D14', 'H14'.replace('H14', 'D14')); // placeholder replaced below
    void b;
    const handA = evaluateHand(buildAssumedHand(cardsOf('H14', 'C14'), 13), ranking);
    const handB = evaluateHand(buildAssumedHand(cardsOf('D14', 'C14'), 13), ranking);
    const result = decideShowdown(handA, handB, {
      ranking,
      muflis: false,
      mode: 'TWO_CARD_ASSUMED',
      threeCardCompare: 'FULL_HAND',
      initiator: 'b',
    });
    expect(result.winner).toBe('b');
    expect(result.reason).toMatch(/initiator/i);
  });

  it('a shared Ace of Spades grants no exclusive advantage', () => {
    const shared = cardsOf('S14')[0];
    // both players privately hold an ace; shared A-spade is common
    const p1 = evaluateHand(buildAssumedHand(cardsOf('H14'), 13, shared), ranking);
    const p2 = evaluateHand(buildAssumedHand(cardsOf('D14'), 13, shared), ranking);
    const result = decideShowdown(p1, p2, {
      ranking,
      muflis: false,
      mode: 'ONE_CARD_SHARED',
      threeCardCompare: 'FULL_HAND',
      initiator: 'a',
      sharedCardId: shared.id,
    });
    expect(result.winner).toBe('a');
    expect(result.reason).toMatch(/initiator/i);
  });
});

describe('highest single card mode', () => {
  it('compares only the top card and reverses for Muflis', () => {
    const a = cardsOf('S14', 'H3', 'D2'); // A high
    const b = cardsOf('S13', 'H12', 'D11'); // K high
    expect(beats(a, b, false, 'THREE_CARD', 'HIGHEST_CARD')).toBe('a');
    expect(beats(a, b, true, 'THREE_CARD', 'HIGHEST_CARD')).toBe('b');
  });
});
