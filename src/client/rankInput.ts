import { MAX_RANK, MIN_RANK, patternKeyOfRanks, rankLabel } from '../rules/cards';

const TOKEN = /(1[0-4]|[2-9]|[AJQKT])/gi;

/**
 * Accepts "AKQ", "A K Q", "A,K,Q", "A109", "10-A-9" or "14-10-9" and returns a
 * canonical rank pattern key ("14-13-12") plus the ranks sorted descending.
 */
export function parseRankInput(text: string): { key: string; ranks: number[] } | null {
  if (!text) return null;
  const matches = text.toUpperCase().match(TOKEN);
  if (!matches || matches.length !== 3) return null;
  const ranks: number[] = [];
  for (const token of matches) {
    const rank = token === 'A' ? 14 : token === 'K' ? 13 : token === 'Q' ? 12 : token === 'J' ? 11 : token === 'T' ? 10 : Number(token);
    if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) return null;
    ranks.push(rank);
  }
  return { key: patternKeyOfRanks(ranks), ranks };
}

export function patternText(key: string): string {
  return key
    .split('-')
    .map((r) => rankLabel(Number(r)))
    .join('');
}
