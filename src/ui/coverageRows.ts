/**
 * Pure coverage arithmetic — the percentages, bands and row ordering the
 * coverage surfaces all agree on. No `vscode` import: this module is compiled
 * into the extension host, into the browser bundle (`webview/coverage.ts`
 * imports {@link band}) and into the unit-test program, so it must stay free of
 * both the host and the DOM.
 *
 * `PanelState.toCoverageViewState` builds the wire rows for the view; the
 * functions here are the same arithmetic in reusable form, used by the status
 * bar (which needs one class's row and the project overall) and by the view
 * bundle (which needs the band for a bar's colour).
 */
import { overallCoveragePercent } from '../salesforce/coverageMapping';
import { CoverageInfo } from '../types';
import { CoverageRow } from '../webview/protocol';

/** 75 is Salesforce's production deploy floor — below it a deploy is blocked. */
export const DEPLOY_FLOOR_PCT = 75;

export type CoverageBand = 'hi' | 'mid' | 'lo';

/**
 * The three coverage bands. This is the single definition; the identical
 * `covBand` in `webview/shared.ts` is a browser-side twin that stays untouched
 * because that module is DOM-only and cannot be imported by the host.
 */
export function band(pct: number): CoverageBand {
  if (pct >= DEPLOY_FLOOR_PCT) return 'hi';
  return pct >= 50 ? 'mid' : 'lo';
}

/** Measured lines for a class: covered + uncovered, never negative. */
export function totalLinesOf(info: CoverageInfo): number {
  const total = info.numLinesCovered + info.numLinesUncovered;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * Whole-percent coverage for one class. A class with no measurable lines counts
 * as 100%: Salesforce reports interface-only/constant-only classes that way, and
 * showing them as 0% would put them at the top of a worst-first table for no
 * reason. Mirrors `PanelState.toCoverageViewState` exactly — the table and the
 * status bar must never disagree by a rounding step.
 */
export function pctOf(info: CoverageInfo): number {
  const total = totalLinesOf(info);
  if (total === 0) return 100;
  return Math.round((info.numLinesCovered / total) * 100);
}

/**
 * The coverage table's rows, worst first (ties broken by name so the order is
 * stable across runs).
 *
 * @param hasSource decides the greyed "no local source" rows — a class the org
 *                  measured but the workspace does not have cannot be opened.
 * @param focus lower-cased names of the classes the run was aimed at (see
 *              {@link classesUnderTest}); those rows lead the table.
 */
export function rowsFor(
  infos: CoverageInfo[],
  hasSource: (className: string) => boolean,
  focus: ReadonlySet<string> = new Set(),
): CoverageRow[] {
  const rows = infos.map((info): CoverageRow => {
    const total = totalLinesOf(info);
    return {
      className: info.className,
      pct: pctOf(info),
      covered: info.numLinesCovered,
      total,
      hasSource: hasSource(info.className),
      focus: focus.has(info.className.toLowerCase()),
    };
  });
  rows.sort((a, b) => a.pct - b.pct || a.className.localeCompare(b.className));
  return rows;
}

/**
 * Line coverage across the whole snapshot, as a whole percent — null when no
 * class carried any measurable line, so callers can print "—" instead of
 * claiming a misleading 0%.
 *
 * Delegates to the already-shipped `overallCoveragePercent`; the map is keyed by
 * index rather than class name so two entries for the same class (which the CLI
 * has no reason to emit, but nothing forbids) cannot silently collapse into one.
 */
export function overallOf(infos: CoverageInfo[]): number | null {
  return overallCoveragePercent(new Map(infos.map((info, index) => [String(index), info])));
}

/** Case-insensitive lookup table, the way every coverage surface keys classes. */
export function indexByClassName(infos: CoverageInfo[]): Map<string, CoverageInfo> {
  const out = new Map<string, CoverageInfo>();
  for (const info of infos) out.set(info.className.toLowerCase(), info);
  return out;
}

/**
 * The classes a run's test classes are named FOR — the inverse of the four
 * conventions `activeFileTests` uses (`FooTest`, `TestFoo`, `Foo_Test`,
 * `FooTests`). Running `FooTest` is nearly always a question about `Foo`'s
 * coverage, so the table leads with those rows and folds away everything else
 * the run happened to touch.
 *
 * Names come back lower-cased: Apex is case-insensitive about class names, so
 * callers must compare that way too. A test class that matches no convention
 * contributes nothing — the table then falls back to showing every row.
 */
export function classesUnderTest(testClasses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of testClasses) {
    const name = raw.trim();
    // Case-SENSITIVE on the marker, deliberately: the conventions capitalise it,
    // and matching `test` would turn `Contest` into `con` and `Latest` into `la`.
    const suffix = /^(.+?)_*Tests?$/.exec(name);
    // The prefix form needs a class-shaped remainder, or `Tester` yields `er`.
    const prefix = suffix ? null : /^Tests?_*([A-Z].*)$/.exec(name);
    const base = suffix?.[1] ?? prefix?.[1];
    if (base) out.add(base.toLowerCase());
  }
  return out;
}
