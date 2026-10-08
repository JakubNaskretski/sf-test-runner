/**
 * "Tests for active file": which selection keys the panel should tick when the
 * user is looking at an Apex file.
 *
 * Two cases. The file IS a test class the index knows — select its methods. It
 * is production code — select the test class that goes with it, trying the four
 * naming conventions this family sees in the wild (`FooTest`, `TestFoo`,
 * `Foo_Test`, `FooTests`).
 *
 * No `vscode` import: it takes the file NAME, not a document, so the rule that
 * decides what gets ticked is unit testable.
 */
import type { TestClassEntry, TestIndexSnapshot } from '../types';
import { keysForEntry } from './selection';

/** Suffix/prefix conventions for "the tests for <Name>", in preference order. */
function candidateNames(base: string): string[] {
  return [`${base}Test`, `Test${base}`, `${base}_Test`, `${base}Tests`];
}

export function testKeysForActiveFile(index: TestIndexSnapshot, fileName: string): string[] {
  const base = classNameOf(fileName);
  if (!base) return [];

  const byName = new Map<string, TestClassEntry>();
  // Lower-cased lookup: Apex is case-insensitive about class names, and the file
  // on disk does not always match the declaration's casing exactly.
  for (const entry of index.classes) byName.set(entry.name.toLowerCase(), entry);

  const own = byName.get(base.toLowerCase());
  if (own) {
    const keys = keysForEntry(own);
    // An entry with no keys at all (no methods, methods known) has nothing to
    // tick; fall through to the naming conventions rather than return nothing.
    if (keys.length > 0) return keys;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidateNames(base)) {
    const entry = byName.get(candidate.toLowerCase());
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(...keysForEntry(entry));
  }
  return out;
}

/** Class name behind a file path: basename minus the Apex extension. Works for
 *  both path separators, and for a bare name with no extension at all. */
export function classNameOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(cls|trigger)$/i, '').trim();
}

/** How a deployed class itself counts as a test class, if it does. */
export type OwnMatch =
  /** The index lists it as a test class (recognised test methods). */
  | 'own'
  /** Its declaration carries `@IsTest` but no method in it was recognised:
   *  sent to the org by name, which decides what in it is a test. */
  | 'annotated';

/** Which semantic rule found test classes FOR a deployed class, if any. */
export type SemanticMatch =
  /** Test classes declaring it via `@IsTest(testFor=…)`. */
  | 'testFor'
  /** The first `XTest`/`TestX`/`X_Test`/`XTests` the index has. */
  | 'naming';

export interface HandoffMatch {
  /** The deployed class, spelled as the caller spelled it. */
  name: string;
  /** Set when the deployed class is itself a test class (flag first). */
  own?: OwnMatch;
  /** Set when testFor or a naming convention found its tests. */
  semantic?: SemanticMatch;
  /** The test classes this name contributes — itself first when it is one,
   *  then its semantic matches — before batch-wide dedupe. Empty when
   *  nothing matched. */
  testClasses: string[];
}

export interface HandoffResolution {
  /** Every test class to run, in first-seen order, deduped. */
  testClasses: string[];
  /** One entry per (non-blank) deployed name, in input order. */
  matches: HandoffMatch[];
}

/**
 * Which test CLASSES to run for a cross-extension handoff (`sfTestRunner.
 * runTestsFor`), and why — the flag first, then the semantics, and BOTH: per
 * deployed name, case-insensitively, the result is the union of
 *  1. the class itself, when it is a test class: the index lists it (`own`),
 *     or its declaration carries `@IsTest` though no method in it was
 *     recognised (`annotated`, from `index.annotatedOnly`) — it runs by its
 *     own name and the org decides what in it is a test;
 *  2. its semantic matches: every test class that DECLARES it via
 *     `@IsTest(testFor=…)`, or else the first naming-convention hit
 *     (`XTest`, `TestX`, `X_Test`, `XTests`).
 * A flag never hides the semantics: a test data factory `Helper` declared
 * `@IsTest` still brings in the `HelperTest` (or the `testFor` test) that
 * exercises it. A name matching nothing contributes no test class.
 *
 * Deliberately not `testKeysForActiveFile`: that one returns selection KEYS
 * (method-level) for a single file and collects every matching convention;
 * this returns CLASS names (what `--tests` wants) for a whole batch and stops
 * at the first naming-convention match.
 */
export function resolveHandoff(
  index: TestIndexSnapshot,
  classNames: readonly string[],
): HandoffResolution {
  const byName = new Map<string, TestClassEntry>();
  for (const entry of index.classes) byName.set(entry.name.toLowerCase(), entry);
  const annotated = new Map<string, TestClassEntry>();
  for (const entry of index.annotatedOnly ?? []) annotated.set(entry.name.toLowerCase(), entry);

  const testClasses: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    testClasses.push(name);
  };

  const matches: HandoffMatch[] = [];
  for (const raw of classNames) {
    const name = raw.trim();
    if (!name) continue;
    const match = matchOne(name, byName, annotated);
    matches.push(match);
    for (const testClass of match.testClasses) add(testClass);
  }
  return { testClasses, matches };
}

function matchOne(
  name: string,
  byName: Map<string, TestClassEntry>,
  annotated: Map<string, TestClassEntry>,
): HandoffMatch {
  const lower = name.toLowerCase();
  const match: HandoffMatch = { name, testClasses: [] };
  const push = (testClass: string): void => {
    if (!match.testClasses.some((n) => n.toLowerCase() === testClass.toLowerCase())) {
      match.testClasses.push(testClass);
    }
  };

  // The flag: the deployed class is itself a test class.
  const own = byName.get(lower);
  const flagged = own ? undefined : annotated.get(lower);
  if (own) {
    match.own = 'own';
    push(own.name);
  } else if (flagged) {
    match.own = 'annotated';
    push(flagged.name);
  }

  // Then the semantics, whatever the flag said.
  const declaredBy = [...byName.values()].filter((entry) =>
    (entry.testFor ?? []).some((target) => target.toLowerCase() === lower),
  );
  if (declaredBy.length > 0) {
    match.semantic = 'testFor';
    for (const entry of declaredBy) push(entry.name);
    return match;
  }
  for (const candidate of candidateNames(name)) {
    const entry = byName.get(candidate.toLowerCase());
    if (entry) {
      match.semantic = 'naming';
      push(entry.name);
      break;
    }
  }
  return match;
}

/** The naming conventions `resolveHandoff` tries, spelled out for a message. */
export function conventionNames(base: string): string[] {
  return candidateNames(base);
}

/**
 * Just the test class names of `resolveHandoff` — for callers (and tests)
 * that do not need to know why each one matched.
 */
export function resolveTestClasses(
  index: TestIndexSnapshot,
  classNames: readonly string[],
): string[] {
  return resolveHandoff(index, classNames).testClasses;
}

/**
 * Selection keys for a batch of test CLASS names — already resolved (see
 * `resolveTestClasses`), one entry per name expected. Used right before a
 * cross-extension handoff run starts, to replace whatever was ticked in the
 * Tests view with exactly the classes SF Deploy is about to run, so nothing
 * stale stays visibly selected. Case-insensitive, like every other lookup
 * here; a name the index does not currently have (a stale index, a race)
 * contributes nothing rather than guessing. Order preserved, duplicates
 * dropped.
 */
export function keysForClasses(index: TestIndexSnapshot, classNames: readonly string[]): string[] {
  const byName = new Map<string, TestClassEntry>();
  for (const entry of index.classes) byName.set(entry.name.toLowerCase(), entry);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of classNames) {
    const entry = byName.get(raw.trim().toLowerCase());
    if (!entry) continue;
    for (const key of keysForEntry(entry)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
