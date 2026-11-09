import { Card, cardFromId } from './cards';
import { ALL_VARIANTS, RankOverride, RankingProfile } from './ranking';

/**
 * The mandatory house chain, from strongest to weakest:
 *   222 > 235 > AKQ > AKJ > A109 > KQJ
 */
export const REQUIRED_ORDER_OVERRIDES: RankOverride[] = [
  { stronger: '2-2-2', weaker: '2-3-5' },
  { stronger: '2-3-5', weaker: '14-13-12' },
  { stronger: '14-13-12', weaker: '14-13-11' },
  { stronger: '14-13-11', weaker: '14-10-9' },
  { stronger: '14-10-9', weaker: '13-12-11' },
];

export const DEFAULT_CATEGORY_ORDER = ALL_VARIANTS.slice();

export function standardProfile(id = 'standard'): RankingProfile {
  return {
    id,
    name: 'Standard Teen Patti',
    version: 1,
    categoryOrder: DEFAULT_CATEGORY_ORDER.slice(),
    overrides: [],
    suitSensitive: true,
    suitOrder: ['S', 'H', 'D', 'C'],
    muflisTiePolicy: 'UNCHANGED',
    notes: 'Classic order: trail > pure sequence > sequence > colour > pair > high card.',
  };
}

export function defaultProfile(id = 'house-default'): RankingProfile {
  return {
    id,
    name: 'House rules: 222 > 235 > AKQ > AKJ > A109 > KQJ',
    version: 1,
    categoryOrder: DEFAULT_CATEGORY_ORDER.slice(),
    overrides: REQUIRED_ORDER_OVERRIDES.map((o) => ({ ...o })),
    suitSensitive: true,
    suitOrder: ['S', 'H', 'D', 'C'],
    muflisTiePolicy: 'UNCHANGED',
    notes:
      'Required custom chain. Overrides place the listed rank patterns above each other regardless of suit; all other hands keep the default order.',
  };
}

export interface SampleHand {
  label: string;
  cards: Card[];
  pattern: string;
}

function hand(label: string, ...ids: string[]): SampleHand {
  const cards = ids.map(cardFromId);
  return {
    label,
    cards,
    pattern: cards
      .map((c) => c.rank)
      .sort((a, b) => b - a)
      .join('-'),
  };
}

/** Ready-made sandbox / acceptance-test fixtures. */
export const REQUIRED_ORDER_HANDS: SampleHand[] = [
  hand('222', 'S2', 'H2', 'D2'),
  hand('235', 'S2', 'H3', 'D5'),
  hand('AKQ', 'S14', 'H13', 'D12'),
  hand('AKJ', 'S14', 'H13', 'D11'),
  hand('A109', 'S14', 'H10', 'D9'),
  hand('KQJ', 'S13', 'H12', 'D11'),
];

export const EXTRA_SAMPLE_HANDS: SampleHand[] = [
  hand('AAA', 'S14', 'H14', 'D14'),
  hand('KKK', 'S13', 'H13', 'D13'),
  hand('QKA pure', 'S12', 'S13', 'S14'),
  hand('234 run', 'H2', 'H3', 'H4'),
  hand('A23 run', 'C14', 'C2', 'C3'),
  hand('Colour 986', 'D9', 'D8', 'D6'),
  hand('Pair AA + K', 'S14', 'H14', 'D13'),
  hand('Pair 55 + 3', 'S5', 'H5', 'D3'),
  hand('High A K 9 offsuit', 'S14', 'H13', 'D9'),
  hand('High 7 4 2', 'C7', 'D4', 'H2'),
];

/** Card id helper used by tests and the sandbox. */
export function cardsOf(...ids: string[]): Card[] {
  return ids.map(cardFromId);
}

export const REQUIRED_ORDER_CHAIN = ['222', '235', 'AKQ', 'AKJ', 'A109', 'KQJ'];
