/**
 * Which classes a run was actually ABOUT.
 *
 * A run's coverage lists every class its tests touched — a call path, not an
 * intent — so a single test class can drag forty rows in behind it. This module
 * decides, per test class, which of those rows it was aimed at, so the table can
 * lead with them.
 *
 * Three tiers, best first, and the first non-empty one wins for a given test
 * class. `declared` is fact: Salesforce's `testFor` annotation (API v66+), read
 * out of the class body. `named` and `truncated` are inference from the class
 * name and are labelled as such in the view — a test touches everything on its
 * call path, so nothing but the annotation can be strict about intent.
 *
 * No `vscode` import: the same no-host rule as `coverageRows`.
 */
import { classesUnderTest } from './coverageRows';

export type TargetTier = 'declared' | 'named' | 'truncated';

export interface CoverageTarget {
  /** Class or trigger name, spelled as the coverage row spells it where there
   *  is one, otherwise as the annotation declared it. */
  name: string;
  tier: TargetTier;
  /** The test classes that pointed here, for the row's tooltip. */
  by: string[];
  /** Declared by an annotation, but the run never exercised it — a stale
   *  `testFor` is worth showing, not hiding. */
  unexercised?: boolean;
}

/**
 * An Apex class name caps at 40 characters, so a class whose own name is longer
 * than this cannot have a conventionally named test class: `Test` is four more.
 * Only those rows are eligible for the truncated tier.
 */
const LONGEST_CONVENTIONAL = 36;
/**
 * And the tier is only ATTEMPTED for a test class at the cap, which is what
 * says the name was chopped in the first place. Without this an ordinary
 * `AccountServiceTest` whose own class is absent from the run would happily
 * promote whichever long class happens to share its prefix.
 */
const TRUNCATED_NAME = 39;
/** Below this many characters a stem is too generic to identify anything. */
const MIN_STEM = 10;

/** Evidence strength, so a later declaration can upgrade an earlier guess. */
const RANK: Record<TargetTier, number> = { truncated: 0, named: 1, declared: 2 };

export function resolveTargets(
  ranTestClasses: Iterable<string>,
  declaredBy: (testClass: string) => readonly string[],
  coveredNames: Iterable<string>,
): CoverageTarget[] {
  const covered = new Map<string, string>();
  for (const name of coveredNames) covered.set(name.toLowerCase(), name);

  const found = new Map<string, CoverageTarget>();
  const add = (name: string, tier: TargetTier, by: string, unexercised?: true): void => {
    const key = name.toLowerCase();
    const existing = found.get(key);
    if (existing) {
      if (!existing.by.includes(by)) existing.by.push(by);
      // Better evidence wins whenever it turns up, or the tier would depend on
      // the order the CLI happened to report the test classes in.
      if (RANK[tier] > RANK[existing.tier]) {
        existing.tier = tier;
        delete existing.unexercised;
      }
      return;
    }
    found.set(key, { name, tier, by: [by], ...(unexercised ? { unexercised } : {}) });
  };

  const seenTestClass = new Set<string>();
  for (const raw of ranTestClasses) {
    const testClass = raw.trim();
    if (!testClass || seenTestClass.has(testClass.toLowerCase())) continue;
    seenTestClass.add(testClass.toLowerCase());

    const declared = declaredBy(testClass);
    if (declared.length > 0) {
      for (const name of declared) {
        const row = covered.get(name.toLowerCase());
        add(row ?? name, 'declared', testClass, row ? undefined : true);
      }
      continue;
    }

    // The inversion is only trusted when it names a class the run actually
    // covered — that alone stops `Contest` being read as a test for `Con`.
    const named = [...classesUnderTest([testClass])]
      .map((base) => covered.get(base))
      .filter((name): name is string => name !== undefined);
    if (named.length > 0) {
      for (const name of named) add(name, 'named', testClass);
      continue;
    }

    const guess = truncatedMatch(testClass, covered);
    if (guess) add(guess, 'truncated', testClass);
  }
  return [...found.values()];
}

/**
 * The 40-character case: `AccountRelationshipRollupServiceTest` does not fit, so
 * the name on disk is a chopped version of it. Prefix agreement in one direction
 * or the other, longest wins, and a tie declines rather than guessing — two long
 * classes sharing a stem are genuinely unknowable, and both still show up in the
 * table's secondary band.
 */
function truncatedMatch(testClass: string, covered: Map<string, string>): string | undefined {
  if (testClass.length < TRUNCATED_NAME) return undefined;
  const [base] = classesUnderTest([testClass]);
  // No marker survives when the marker itself was the part that got chopped.
  const stem = base ?? testClass.toLowerCase();
  if (stem.length < MIN_STEM) return undefined;

  let best: { name: string; score: number } | undefined;
  let tied = false;
  for (const [key, name] of covered) {
    if (key.length <= LONGEST_CONVENTIONAL) continue;
    if (!key.startsWith(stem) && !stem.startsWith(key)) continue;
    const score = commonPrefix(key, stem);
    if (!best || score > best.score) {
      best = { name, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  return best && !tied ? best.name : undefined;
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}
