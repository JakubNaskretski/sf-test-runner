/**
 * The two halves of "what the Results view shows while a run is still polling".
 *
 * A run reports its methods one poll at a time, and the final summary only
 * arrives when the org is done — until then `run.summary` is undefined and the
 * results tree would sit on its empty state for the whole run. The poller's
 * per-method outcomes are the only thing there is, so they travel to the view as
 * `ResultsViewState.live` and are turned back into rows there.
 *
 * No `vscode` import: `liveForResults` runs in the extension host (PanelState)
 * and `liveResultRows` in the Results webview bundle, so both stay unit-testable
 * and the two sides cannot disagree about the precedence.
 */
import type { RunRecord, TestMethodResult } from '../types';
import type { OutcomeEntry } from '../webview/protocol';

/**
 * The live map to post, or undefined when the view must not use one: a finished
 * run — or any run that already has a summary — is rendered from that summary,
 * which carries the failure messages and stack traces the live map never has.
 */
export function liveForResults(
  run: Pick<RunRecord, 'status' | 'summary'> | undefined,
  live: Record<string, OutcomeEntry>,
): Record<string, OutcomeEntry> | undefined {
  if (!run || run.status !== 'running' || run.summary) return undefined;
  return Object.keys(live).length === 0 ? undefined : live;
}

/**
 * `Cls.method` → outcome, as the rows the results tree groups. Message and
 * stack trace are null on purpose: a poll reports THAT a method failed, and the
 * detail arrives with the final summary.
 */
export function liveResultRows(live: Record<string, OutcomeEntry> | undefined): TestMethodResult[] {
  const rows: TestMethodResult[] = [];
  for (const [key, entry] of Object.entries(live ?? {})) {
    const dot = key.indexOf('.');
    if (dot <= 0 || dot === key.length - 1) continue;
    // 'running' has no TestMethodResult outcome, and calling it a failure would
    // paint a red glyph on a method that is still executing.
    if (entry.o === 'running') continue;
    rows.push({
      className: key.slice(0, dot),
      methodName: key.slice(dot + 1),
      outcome: entry.o === 'pass' ? 'Pass' : entry.o === 'skip' ? 'Skip' : 'Fail',
      runTime: entry.ms,
      message: null,
      stackTrace: null,
    });
  }
  // Grouping keeps first-seen order, and object key order is insertion order —
  // sorting keeps the tree from reshuffling as each poll adds a method.
  rows.sort((a, b) => a.className.localeCompare(b.className) || a.methodName.localeCompare(b.methodName));
  return rows;
}
