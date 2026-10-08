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
import { stripCommentsAndStrings as codeOnly } from '../salesforce/testMethods';
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

/** At most this many "referencing" test classes are offered for ONE deployed
 *  class: it is a fallback guess, and a name used everywhere (a selector, a
 *  utility) must not turn one deploy into a full test run. */
export const MAX_REFERENCING_TESTS = 10;

/** Which rule matched a deployed class — in the order they are tried. */
export type HandoffStep =
  /** The deployed class is itself a test class the index lists. */
  | 'own'
  /** The deployed class is declared `@IsTest` but no method in it was
   *  recognised: sent to the org by name, which decides what runs. */
  | 'annotated'
  /** Test classes declaring it via `@IsTest(testFor=…)`. */
  | 'testFor'
  /** The first `XTest`/`TestX`/`X_Test`/`XTests` the index has. */
  | 'naming'
  /** Local test classes whose code mentions it as a whole word. */
  | 'referencing'
  /** Nothing matched. */
  | 'none';

export interface HandoffMatch {
  /** The deployed class, spelled as the caller spelled it. */
  name: string;
  step: HandoffStep;
  /** The test classes this name contributes, before batch-wide dedupe. */
  testClasses: string[];
  /** `referencing` only: how many more matched beyond the cap (not run). */
  omitted?: number;
}

export interface HandoffResolution {
  /** Every test class to run, in first-seen order, deduped. */
  testClasses: string[];
  /** One entry per (non-blank) deployed name, in input order. */
  matches: HandoffMatch[];
}

/** A local test class and its source text, for the `referencing` step. */
export interface TestSource {
  name: string;
  text: string;
}

/**
 * Which test CLASSES to run for a cross-extension handoff (`sfTestRunner.
 * runTestsFor`), and why — flag first, then semantics. Per deployed name,
 * case-insensitively, the first rule that matches wins:
 *  1. the class itself is a test class: the index lists it (`own`), or its
 *     declaration carries `@IsTest` though no method was recognised
 *     (`annotated`, from `index.annotatedOnly`) — it runs as its own test;
 *  2. every test class that DECLARES it via `@IsTest(testFor=…)`;
 *  3. the first naming-convention hit (`XTest`, `TestX`, `X_Test`, `XTests`);
 *  4. only when `sources` are given: the local test classes whose code (no
 *     comments, no string literals) mentions it as a whole word — `Helper.`,
 *     `new Helper(`, `Helper::` — sorted by name, capped at
 *     `MAX_REFERENCING_TESTS` (the rest counted in `omitted`). Never the
 *     class itself: a deployed class the index lists already matched step 1.
 * A name matching nothing contributes no test class and reports `none`.
 *
 * Deliberately not `testKeysForActiveFile`: that one returns selection KEYS
 * (method-level) for a single file and collects every matching convention;
 * this returns CLASS names (what `--tests` wants) for a whole batch and stops
 * at the first naming-convention match.
 */
export function resolveHandoff(
  index: TestIndexSnapshot,
  classNames: readonly string[],
  sources?: readonly TestSource[],
): HandoffResolution {
  const byName = new Map<string, TestClassEntry>();
  for (const entry of index.classes) byName.set(entry.name.toLowerCase(), entry);
  const annotated = new Map<string, TestClassEntry>();
  for (const entry of index.annotatedOnly ?? []) annotated.set(entry.name.toLowerCase(), entry);
  /** Only the classes the index lists as tests may be offered as referencing
   *  tests — a source for anything else (a stale read) is ignored. Stripped
   *  once here, not once per deployed name. */
  const listed = sources
    ?.filter((source) => byName.has(source.name.toLowerCase()))
    .map((source) => ({ name: source.name, code: codeOnly(source.text) }));

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
    const match = matchOne(name, byName, annotated, listed);
    matches.push(match);
    for (const testClass of match.testClasses) add(testClass);
  }
  return { testClasses, matches };
}

function matchOne(
  name: string,
  byName: Map<string, TestClassEntry>,
  annotated: Map<string, TestClassEntry>,
  sources: readonly { name: string; code: string }[] | undefined,
): HandoffMatch {
  const lower = name.toLowerCase();

  const own = byName.get(lower);
  if (own) return { name, step: 'own', testClasses: [own.name] };
  const flagged = annotated.get(lower);
  if (flagged) return { name, step: 'annotated', testClasses: [flagged.name] };

  const declaredBy = [...byName.values()].filter((entry) =>
    (entry.testFor ?? []).some((target) => target.toLowerCase() === lower),
  );
  if (declaredBy.length > 0) {
    return { name, step: 'testFor', testClasses: declaredBy.map((entry) => entry.name) };
  }

  for (const candidate of candidateNames(name)) {
    const entry = byName.get(candidate.toLowerCase());
    if (entry) return { name, step: 'naming', testClasses: [entry.name] };
  }

  if (sources && /^\w+$/.test(name)) {
    const mention = new RegExp(`(?<!\\w)${name}(?!\\w)`, 'i');
    const hits = sources
      .filter((source) => mention.test(source.code))
      .map((source) => byName.get(source.name.toLowerCase())?.name ?? source.name)
      .sort((a, b) => a.localeCompare(b));
    const unique = [...new Set(hits)];
    if (unique.length > 0) {
      const kept = unique.slice(0, MAX_REFERENCING_TESTS);
      return {
        name,
        step: 'referencing',
        testClasses: kept,
        ...(unique.length > kept.length ? { omitted: unique.length - kept.length } : {}),
      };
    }
  }

  return { name, step: 'none', testClasses: [] };
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
  sources?: readonly TestSource[],
): string[] {
  return resolveHandoff(index, classNames, sources).testClasses;
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
