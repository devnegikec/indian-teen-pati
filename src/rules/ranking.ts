/**
 * Configurable hand-ranking engine.
 *
 * Design
 * ------
 * A hand's *shape* is described by a (variant, rank-pattern) pair, called a
 * "hand class". There are 741 possible hand classes:
 *
 *   TRAIL           13   (222 .. AAA)
 *   PURE_SEQUENCE   13   (same suit runs)
 *   SEQUENCE        13   (mixed suit runs)
 *   COLOUR         273   (three suiting, non-run)
 *   HIGH_CARD      273   (three offsuit, non-run)
 *   PAIR           156   (pair rank x kicker)
 *
 * A ranking profile supplies (a) the order of the variants, (b) optional
 * overrides that place a *rank pattern* above another rank pattern regardless
 * of variant, and (c) suit sensitivity rules.
 *
 * Overrides are resolved into one complete, consistent total order with a
 * greedy topological sort: only the user's constraints are hard edges, and
 * ties are broken by the profile's default order. Circular constraints
 * therefore fail to resolve (and are rejected with a readable error) instead of
 * producing inconsistent pairwise exceptions.
 */

import {
  MAX_RANK,
  MIN_RANK,
  Rank,
  Suit,
  SUITS,
  isRun,
  parsePatternKey,
  patternKeyOfRanks,
  rankLabel,
  runHighValue,
} from './cards';

export type HandVariant = 'TRAIL' | 'PURE_SEQUENCE' | 'SEQUENCE' | 'COLOUR' | 'PAIR' | 'HIGH_CARD';

export const ALL_VARIANTS: HandVariant[] = ['TRAIL', 'PURE_SEQUENCE', 'SEQUENCE', 'COLOUR', 'PAIR', 'HIGH_CARD'];

export const VARIANT_LABEL: Record<HandVariant, string> = {
  TRAIL: 'Trail (three of a kind)',
  PURE_SEQUENCE: 'Pure sequence (straight flush)',
  SEQUENCE: 'Sequence (run)',
  COLOUR: 'Colour (flush)',
  PAIR: 'Pair',
  HIGH_CARD: 'High card',
};

export const VARIANT_SHORT: Record<HandVariant, string> = {
  TRAIL: 'Trail',
  PURE_SEQUENCE: 'Pure seq',
  SEQUENCE: 'Sequence',
  COLOUR: 'Colour',
  PAIR: 'Pair',
  HIGH_CARD: 'High card',
};

export type MuflisTiePolicy = 'UNCHANGED' | 'REVERSE_SUIT';

export interface RankOverride {
  /** Rank pattern that wins, e.g. "2-2-2". */
  stronger: string;
  /** Rank pattern that loses, e.g. "2-3-5". */
  weaker: string;
}

export interface RankingProfile {
  id: string;
  name: string;
  version: number;
  categoryOrder: HandVariant[];
  overrides: RankOverride[];
  /** When false, suits never break a tie. */
  suitSensitive: boolean;
  /** Strongest suit first. */
  suitOrder: Suit[];
  /** Muflis tie handling; hand strength is always reversed in Muflis. */
  muflisTiePolicy: MuflisTiePolicy;
  notes?: string;
  updatedAt?: string;
}

export interface HandClass {
  /** `${variant}|${pattern}` */
  key: string;
  variant: HandVariant;
  /** Canonical rank pattern, e.g. "14-13-12". */
  pattern: string;
  ranks: Rank[];
  label: string;
}

export interface ResolvedRanking {
  version: string;
  profileId: string;
  profileName: string;
  categoryOrder: HandVariant[];
  overrides: RankOverride[];
  suitSensitive: boolean;
  suitOrder: Suit[];
  muflisTiePolicy: MuflisTiePolicy;
  /** Class keys ordered strongest -> weakest. */
  order: string[];
  /** class key -> strength index (0 is strongest). */
  index: Map<string, number>;
  classes: Map<string, HandClass>;
  /** rank pattern -> class keys belonging to it. */
  classesByPattern: Map<string, string[]>;
  warnings: string[];
}

export class RankingError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_CATEGORY_ORDER'
      | 'INVALID_OVERRIDE'
      | 'CIRCULAR_RULES'
      | 'INVALID_SUIT_ORDER'
      | 'UNKNOWN_CLASS',
  ) {
    super(message);
    this.name = 'RankingError';
  }
}

const SUIT_SET = new Set<Suit>(SUITS);

export function classKey(variant: HandVariant, pattern: string): string {
  return `${variant}|${pattern}`;
}

function intraCompare(a: HandClass, b: HandClass): number {
  const va = a.ranks;
  const vb = b.ranks;
  switch (a.variant) {
    case 'TRAIL':
      return vb[0] - va[0];
    case 'PURE_SEQUENCE':
    case 'SEQUENCE': {
      const ha = runHighValue(va);
      const hb = runHighValue(vb);
      return hb - ha;
    }
    case 'COLOUR':
    case 'HIGH_CARD':
      for (let i = 0; i < 3; i++) {
        if (va[i] !== vb[i]) return vb[i] - va[i];
      }
      return 0;
    case 'PAIR': {
      // ranks are sorted desc; the duplicated value is the pair rank
      const pairA = va[0] === va[1] ? va[0] : va[1];
      const pairB = vb[0] === vb[1] ? vb[0] : vb[1];
      if (pairA !== pairB) return pairB - pairA;
      const kickerA = va[0] === va[1] ? va[2] : va[0];
      const kickerB = vb[0] === vb[1] ? vb[2] : vb[0];
      return kickerB - kickerA;
    }
    default:
      return 0;
  }
}

function classLabel(variant: HandVariant, ranks: Rank[]): string {
  const text = ranks.map((r) => (r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : r === 10 ? '10' : String(r))).join('');
  return `${text} ${VARIANT_SHORT[variant]}`;
}

/** Builds every hand class and sorts them by the profile's default ordering. */
export function buildDefaultClasses(categoryOrder: HandVariant[]): HandClass[] {
  const classes: HandClass[] = [];
  const push = (variant: HandVariant, ranks: Rank[]) => {
    const pattern = patternKeyOfRanks(ranks);
    classes.push({ key: classKey(variant, pattern), variant, pattern, ranks: ranks.slice().sort((a, b) => b - a), label: classLabel(variant, ranks) });
  };

  for (let r = MIN_RANK; r <= MAX_RANK; r++) push('TRAIL', [r, r, r]);

  const distinct: Rank[][] = [];
  for (let a = MAX_RANK; a >= MIN_RANK; a--) {
    for (let b = a - 1; b >= MIN_RANK; b--) {
      for (let c = b - 1; c >= MIN_RANK; c--) {
        distinct.push([a, b, c]);
      }
    }
  }
  for (const ranks of distinct) {
    if (isRun(ranks)) {
      push('PURE_SEQUENCE', ranks);
      push('SEQUENCE', ranks);
    } else {
      push('COLOUR', ranks);
      push('HIGH_CARD', ranks);
    }
  }

  for (let p = MIN_RANK; p <= MAX_RANK; p++) {
    for (let k = MIN_RANK; k <= MAX_RANK; k++) {
      if (k === p) continue;
      push('PAIR', [p, p, k]);
    }
  }

  const categoryIndex = new Map(categoryOrder.map((v, i) => [v, i]));
  classes.sort((a, b) => {
    const ca = categoryIndex.get(a.variant)!;
    const cb = categoryIndex.get(b.variant)!;
    if (ca !== cb) return ca - cb;
    const intra = intraCompare(a, b);
    if (intra !== 0) return intra;
    return a.pattern.localeCompare(b.pattern);
  });
  return classes;
}

function stableHash(value: string): string {
  // FNV-1a 32 bit, deterministic across browser and node.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function canonicalProfileJson(profile: RankingProfile): string {
  return JSON.stringify({
    name: profile.name,
    categoryOrder: profile.categoryOrder,
    overrides: profile.overrides
      .map((o) => ({ stronger: o.stronger, weaker: o.weaker }))
      .slice()
      .sort((a, b) => (a.stronger + a.weaker).localeCompare(b.stronger + b.weaker)),
    suitSensitive: profile.suitSensitive,
    suitOrder: profile.suitOrder,
    muflisTiePolicy: profile.muflisTiePolicy,
  });
}

export function profileFingerprint(profile: RankingProfile): string {
  return `p${profile.version}-${stableHash(canonicalProfileJson(profile))}`;
}

export function validateProfile(profile: RankingProfile): void {
  if (profile.categoryOrder.length !== ALL_VARIANTS.length || new Set(profile.categoryOrder).size !== ALL_VARIANTS.length) {
    throw new RankingError('Category order must contain each of the six hand categories exactly once.', 'INVALID_CATEGORY_ORDER');
  }
  for (const variant of profile.categoryOrder) {
    if (!ALL_VARIANTS.includes(variant)) {
      throw new RankingError(`Unknown hand category "${variant}".`, 'INVALID_CATEGORY_ORDER');
    }
  }
  if (profile.suitOrder.length !== 4 || new Set(profile.suitOrder).size !== 4 || profile.suitOrder.some((s) => !SUIT_SET.has(s))) {
    throw new RankingError('Suit order must contain each of S, H, D, C exactly once.', 'INVALID_SUIT_ORDER');
  }
  if (profile.muflisTiePolicy !== 'UNCHANGED' && profile.muflisTiePolicy !== 'REVERSE_SUIT') {
    throw new RankingError('Muflis tie policy must be UNCHANGED or REVERSE_SUIT.', 'INVALID_OVERRIDE');
  }
  for (const override of profile.overrides) {
    let stronger: Rank[];
    let weaker: Rank[];
    try {
      stronger = parsePatternKey(override.stronger);
      weaker = parsePatternKey(override.weaker);
    } catch {
      throw new RankingError(`Invalid rank pattern in rule "${override.stronger} > ${override.weaker}".`, 'INVALID_OVERRIDE');
    }
    if (patternKeyOfRanks(stronger) === patternKeyOfRanks(weaker)) {
      throw new RankingError(`A rule cannot compare a hand with itself ("${override.stronger} > ${override.weaker}").`, 'INVALID_OVERRIDE');
    }
  }
}

interface TopoNode {
  key: string;
  defaultRank: number;
  indegree: number;
  out: string[];
}

function patternText(pattern: string): string {
  return pattern
    .split('-')
    .map((r) => rankLabel(Number(r)))
    .join('');
}

function detectPatternCycles(edges: Map<string, Set<string>>): void {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    const s = state.get(node) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node].map(patternText);
      throw new RankingError(
        `The custom rules contradict each other - they form a loop: ${cycle.join(' > ')}. Remove one of those rules.`,
        'CIRCULAR_RULES',
      );
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) visit(node);
}

/**
 * Resolves a profile into a full total order over hand classes.
 * Throws RankingError('CIRCULAR_RULES') when the constraints cannot be
 * satisfied.
 */
export function resolveRanking(profile: RankingProfile): ResolvedRanking {
  validateProfile(profile);
  const classes = buildDefaultClasses(profile.categoryOrder);
  const classMap = new Map(classes.map((c) => [c.key, c]));
  const classesByPattern = new Map<string, string[]>();
  for (const c of classes) {
    const list = classesByPattern.get(c.pattern) ?? [];
    list.push(c.key);
    classesByPattern.set(c.pattern, list);
  }

  const nodes = new Map<string, TopoNode>();
  classes.forEach((c, i) => nodes.set(c.key, { key: c.key, defaultRank: i, indegree: 0, out: [] }));

  /*
   * Patterns that appear in a custom rule are ranked as a *unit* (a rule is
   * about rank patterns, not suits). Each pattern gets an anchor: the default
   * position of its strongest possible hand (so 2-3-5 is anchored by the 2-3-5
   * colour, not by a weak offsuit 5-high).
   *
   * The anchors are then relaxed along the rule edges so a rule such as
   * `235 > AKQ` pulls 235 up next to AKQ instead of leaving it in the colour
   * band. Unconstrained patterns keep their plain default position.
   */
  const patternEdges = new Map<string, Set<string>>();
  const overriddenPatterns = new Set<string>();
  for (const override of profile.overrides) {
    const sp = patternKeyOfRanks(parsePatternKey(override.stronger));
    const wp = patternKeyOfRanks(parsePatternKey(override.weaker));
    overriddenPatterns.add(sp);
    overriddenPatterns.add(wp);
    if (!patternEdges.has(sp)) patternEdges.set(sp, new Set());
    patternEdges.get(sp)!.add(wp);
  }

  // Reject cycles before anything else so the relaxation below terminates.
  detectPatternCycles(patternEdges);

  const patternAnchor = new Map<string, number>();
  for (const [pattern, keys] of classesByPattern) {
    patternAnchor.set(pattern, Math.min(...keys.map((k) => nodes.get(k)!.defaultRank)));
  }
  for (let iteration = 0; iteration < overriddenPatterns.size + 2; iteration++) {
    let changed = false;
    for (const [stronger, weakers] of patternEdges) {
      for (const weaker of weakers) {
        const target = patternAnchor.get(weaker);
        if (target === undefined) continue;
        const current = patternAnchor.get(stronger);
        if (current === undefined) continue;
        if (current > target) {
          patternAnchor.set(stronger, target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const anchor = new Map<string, number>();
  for (const [pattern, keys] of classesByPattern) {
    if (!overriddenPatterns.has(pattern)) continue;
    for (const k of keys) anchor.set(k, patternAnchor.get(pattern)!);
  }
  const priorityOf = (node: TopoNode): number => anchor.get(node.key) ?? node.defaultRank;

  const addEdge = (strongerKey: string, weakerKey: string) => {
    if (strongerKey === weakerKey) return;
    const from = nodes.get(strongerKey)!;
    const to = nodes.get(weakerKey)!;
    if (from.out.includes(weakerKey)) return;
    from.out.push(weakerKey);
    to.indegree++;
  };

  const warnings: string[] = [];
  for (const override of profile.overrides) {
    const strongerClasses = classesByPattern.get(patternKeyOfRanks(parsePatternKey(override.stronger)));
    const weakerClasses = classesByPattern.get(patternKeyOfRanks(parsePatternKey(override.weaker)));
    if (!strongerClasses || !weakerClasses) continue;
    for (const s of strongerClasses) {
      for (const w of weakerClasses) addEdge(s, w);
    }
  }

  const order: string[] = [];
  const remaining = new Set(nodes.keys());
  const picked = new Set<string>();

  while (order.length < classes.length) {
    let best: TopoNode | null = null;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (const key of remaining) {
      const node = nodes.get(key)!;
      if (node.indegree !== 0) continue;
      const pr = priorityOf(node);
      if (pr < bestPriority || (pr === bestPriority && best && node.defaultRank < best.defaultRank)) {
        best = node;
        bestPriority = pr;
      }
    }
    if (!best) {
      const stuck = Array.from(remaining)
        .map((k) => {
          const c = classMap.get(k)!;
          return c.label;
        })
        .slice(0, 8);
      throw new RankingError(
        `The custom rules contradict each other, so no consistent order exists. Conflicting hands include: ${stuck.join(', ')}. Remove one of the rules that forms the loop.`,
        'CIRCULAR_RULES',
      );
    }
    order.push(best.key);
    remaining.delete(best.key);
    picked.add(best.key);
    for (const outKey of best.out) {
      const target = nodes.get(outKey)!;
      target.indegree--;
    }
  }

  // Warn about rules that duplicate the default ordering (harmless but noisy).
  const patternDefaultRank = (pattern: string): number => {
    const keys = classesByPattern.get(pattern) ?? [];
    return keys.length ? Math.min(...keys.map((k) => nodes.get(k)!.defaultRank)) : 0;
  };
  for (const override of profile.overrides) {
    const sp = patternKeyOfRanks(parsePatternKey(override.stronger));
    const wp = patternKeyOfRanks(parsePatternKey(override.weaker));
    if (patternDefaultRank(sp) < patternDefaultRank(wp)) {
      warnings.push(`Rule "${override.stronger} > ${override.weaker}" matches the default order and has no effect.`);
    }
  }

  const index = new Map<string, number>();
  order.forEach((key, i) => index.set(key, i));

  return {
    version: profileFingerprint(profile),
    profileId: profile.id,
    profileName: profile.name,
    categoryOrder: profile.categoryOrder.slice(),
    overrides: profile.overrides.slice(),
    suitSensitive: profile.suitSensitive,
    suitOrder: profile.suitOrder.slice(),
    muflisTiePolicy: profile.muflisTiePolicy,
    order,
    index,
    classes: classMap,
    classesByPattern,
    warnings,
  };
}

/** Minimum answer for the editor UI: is this profile valid and with what order? */
export function tryResolveRanking(profile: RankingProfile):
  | { ok: true; ranking: ResolvedRanking }
  | { ok: false; error: string; code: string } {
  try {
    return { ok: true, ranking: resolveRanking(profile) };
  } catch (error) {
    if (error instanceof RankingError) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: (error as Error).message, code: 'UNKNOWN' };
  }
}
