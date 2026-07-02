import { CoverageInfo } from '../types';

/**
 * Per-class coverage as it arrives inside a `sf apex run test --code-coverage
 * --result-format json` run envelope (`result.coverage.coverage[]`). The CLI has
 * shipped a few shapes across versions, so every field here is optional and
 * `mapRunCoverage` copes with whichever is present:
 *  - `lines`: a `{ "<lineNo>": <hitCount> }` map (hitCount 0 ⇒ uncovered) — the
 *    modern shape.
 *  - `coveredLines` / `uncoveredLines`: explicit number arrays — older shape and
 *    the same shape the ApexCodeCoverageAggregate query returns, so downstream
 *    stays uniform.
 */
export interface RunCoverageEntry {
  id?: string;
  name?: string;
  totalLines?: number;
  totalCovered?: number;
  numLinesCovered?: number;
  numLinesUncovered?: number;
  coveredPercent?: number;
  lines?: Record<string, number>;
  coveredLines?: number[];
  uncoveredLines?: number[];
}

/** The `result.coverage` block. `coverage` is the per-class array; some CLI
 *  versions nest it, others put the array directly under `result.coverage`. */
export interface RunCoverageBlock {
  coverage?: RunCoverageEntry[];
}

/**
 * Normalise the `coverage` array from a `--code-coverage` run into a map keyed by
 * lowercased class name. Returns the per-class `CoverageInfo` the decorator
 * consumes, computed from whichever shape the CLI gave us. This is the data the
 * old code discarded — using it means the classes actually under test get their
 * gutter coverage straight from the run, with no follow-up
 * ApexCodeCoverageAggregate query.
 */
export function mapRunCoverage(block: unknown): Map<string, CoverageInfo> {
  const out = new Map<string, CoverageInfo>();
  const entries = extractEntries(block);
  for (const entry of entries) {
    const info = coverageFromEntry(entry);
    if (info) out.set(info.className.toLowerCase(), info);
  }
  return out;
}

/** Pull the per-class array out of the `result.coverage` block, tolerating both
 *  the `{ coverage: [...] }` wrapper and a bare array. */
function extractEntries(block: unknown): RunCoverageEntry[] {
  if (!block || typeof block !== 'object') return [];
  const b = block as { coverage?: unknown };
  if (Array.isArray(b.coverage)) return b.coverage as RunCoverageEntry[];
  if (Array.isArray(block)) return block as RunCoverageEntry[];
  return [];
}

/** Turn one per-class entry into CoverageInfo, deriving covered/uncovered line
 *  lists from whichever field the entry carries. Returns null for an unnamed or
 *  empty entry. */
export function coverageFromEntry(entry: RunCoverageEntry | undefined): CoverageInfo | null {
  if (!entry) return null;
  const className = (entry.name ?? '').trim();
  if (!className) return null;

  let coveredLines: number[];
  let uncoveredLines: number[];

  if (entry.lines && typeof entry.lines === 'object') {
    coveredLines = [];
    uncoveredLines = [];
    for (const [rawLine, rawCount] of Object.entries(entry.lines)) {
      const line = Number(rawLine);
      if (!Number.isFinite(line)) continue;
      // Hit count > 0 ⇒ covered, 0 ⇒ uncovered.
      if (Number(rawCount) > 0) coveredLines.push(line);
      else uncoveredLines.push(line);
    }
  } else {
    coveredLines = sanitizeLines(entry.coveredLines);
    uncoveredLines = sanitizeLines(entry.uncoveredLines);
  }

  const numLinesCovered = entry.numLinesCovered ?? entry.totalCovered ?? coveredLines.length;
  const numLinesUncovered =
    entry.numLinesUncovered ??
    (typeof entry.totalLines === 'number' && typeof entry.totalCovered === 'number'
      ? entry.totalLines - entry.totalCovered
      : uncoveredLines.length);

  return {
    className,
    numLinesCovered,
    numLinesUncovered,
    coveredLines,
    uncoveredLines,
  };
}

function sanitizeLines(lines: unknown): number[] {
  if (!Array.isArray(lines)) return [];
  return lines.map(Number).filter((n) => Number.isFinite(n));
}
