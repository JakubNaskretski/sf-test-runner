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

/**
 * Which test CLASSES to run for a cross-extension handoff (`sfTestRunner.
 * runTestsFor`): one name in, the test classes to run out. Per name,
 * case-insensitive: the index already knows it as a test class → itself;
 * else every class that DECLARES it via `@IsTest(testFor=…)` (bare class
 * names, see `findTestForTargets`); else the first naming-convention hit.
 * A name matching nothing contributes no test class. Order preserved,
 * duplicates dropped.
 *
 * Deliberately not `testKeysForActiveFile`: that one returns selection KEYS
 * (method-level) for a single file and collects every matching convention;
 * this returns CLASS names (what `--tests` wants) for a whole batch and stops
 * at the first naming-convention match.
 */
export function resolveTestClasses(
  index: TestIndexSnapshot,
  classNames: readonly string[],
): string[] {
  const byName = new Map<string, TestClassEntry>();
  for (const entry of index.classes) byName.set(entry.name.toLowerCase(), entry);

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  for (const raw of classNames) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();

    const own = byName.get(lower);
    if (own) {
      add(own.name);
      continue;
    }

    const declaredBy = [...byName.values()].filter((entry) =>
      (entry.testFor ?? []).some((target) => target.toLowerCase() === lower),
    );
    if (declaredBy.length > 0) {
      for (const entry of declaredBy) add(entry.name);
      continue;
    }

    for (const candidate of candidateNames(name)) {
      const entry = byName.get(candidate.toLowerCase());
      if (entry) {
        add(entry.name);
        break;
      }
    }
  }
  return out;
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
