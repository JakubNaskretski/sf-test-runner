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
