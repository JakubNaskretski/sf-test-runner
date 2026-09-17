/**
 * Pure text/selector helpers for a run: what it is called, what "Copy" puts on
 * the clipboard, and which of its classes only exist on disk.
 *
 * No `vscode` import — this is the wording the user reads and the rule that
 * decides which selectors survive the not-deployed warning, so it stays unit
 * testable.
 */
import { sameOrg } from '../orgMatch';
import type { RunRecord, TestIndexSnapshot, TestMethodResult, TestRunSummary } from '../types';
import type { RunScope } from '../webview/protocol';

/** A `--tests` selector: `Cls` or `Cls.method`, nothing else. Class and method
 *  names reach us from CLI output as well as our own scan and end up on a
 *  command line, so anything that is not a plain Apex identifier is dropped. */
export function isSelector(value: string): boolean {
  return /^\w+(\.\w+)?$/.test(value);
}

/** The class half of a selector (`Cls.method` → `Cls`). */
export function classOfSelector(selector: string): string {
  const dot = selector.indexOf('.');
  return dot === -1 ? selector : selector.slice(0, dot);
}

/** Human label for the run bar. `count` is the number of selectors for a
 *  selected run and is ignored for the org-wide scopes. */
export function runLabel(scope: RunScope, count: number, alias: string): string {
  switch (scope) {
    case 'allLocal':
      return `All local tests on ${alias}`;
    case 'allInOrg':
      return `All tests incl. managed on ${alias}`;
    default:
      return `${count} ${count === 1 ? 'test' : 'tests'} on ${alias}`;
  }
}

/**
 * Classes in `selectors` that the index knows only from disk. Running one is a
 * guaranteed failure — `--tests` names a class in the ORG — so the runner warns
 * before spending a run on it. Sorted so the warning reads the same every time.
 */
export function localOnlyClasses(index: TestIndexSnapshot, selectors: readonly string[]): string[] {
  const byName = new Map(index.classes.map((c) => [c.name.toLowerCase(), c]));
  const out = new Set<string>();
  for (const selector of selectors) {
    const entry = byName.get(classOfSelector(selector).toLowerCase());
    if (entry?.source === 'local-only') out.add(entry.name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Drop every selector belonging to one of `classNames` — the "Skip them"
 *  answer to the not-deployed warning. */
export function dropClasses(selectors: readonly string[], classNames: readonly string[]): string[] {
  const drop = new Set(classNames.map((n) => n.toLowerCase()));
  return selectors.filter((s) => !drop.has(classOfSelector(s).toLowerCase()));
}

/**
 * Why a finished run's coverage must NOT be published, or undefined when it may.
 *
 * A run is polled for as long as the org takes, and the user can switch the
 * target org while it runs. Coverage is painted on the lines of whatever file is
 * open, so publishing the run's numbers after a switch would paint one org's
 * measurements over another org's code — the very thing the org switch in
 * extension.ts clears the snapshot to prevent. The run's results are unaffected:
 * they carry the org they ran on.
 */
export function coverageOrgChangedNote(
  runOrg: { username: string; alias: string },
  currentOrg: { username: string; alias: string } | undefined,
): string | undefined {
  if (sameOrg(runOrg.username, currentOrg?.username)) return undefined;
  const to = currentOrg ? ` to ${currentOrg.alias}` : '';
  return (
    `Coverage from ${runOrg.alias} not painted: the target org changed${to} during the run. ` +
    `Load Recent Test Runs on ${runOrg.alias} to see it.`
  );
}

/** Failures, in the order the run reported them. `Skip` is not a failure. */
export function failedResults(summary: TestRunSummary | undefined): TestMethodResult[] {
  if (!summary) return [];
  return summary.results.filter((r) => r.outcome === 'Fail' || r.outcome === 'CompileFail');
}

/**
 * The text behind "Copy" in the run bar: one header line, then one line per
 * failure with its message. Timestamps are ISO/UTC on purpose — a pasted
 * summary travels between machines, and a locale string would not survive the
 * trip (nor be assertable in a test).
 */
export function summaryText(run: RunRecord): string {
  const parts: string[] = [verdict(run.status), run.label];
  const summary = run.summary;
  if (summary) {
    parts.push(`${summary.passing}/${summary.testsRan} passed`);
    if (summary.failing > 0) parts.push(`${summary.failing} failed`);
    if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
    parts.push(`${Math.round(summary.testTotalTime)} ms`);
  }
  parts.push(`org ${run.orgAlias}`);
  if (run.testRunId) parts.push(run.testRunId);
  parts.push(new Date(run.finishedAt ?? run.startedAt).toISOString());

  const lines = [parts.join(' · ')];
  if (run.error) lines.push(`Error: ${oneLine(run.error)}`);
  for (const failure of failedResults(summary)) {
    const detail = oneLine(failure.message) || failure.outcome;
    lines.push(`✗ ${failure.className}.${failure.methodName} — ${detail}`);
  }
  return lines.join('\n');
}

function verdict(status: RunRecord['status']): string {
  switch (status) {
    case 'passed':
      return 'PASS';
    case 'failed':
      return 'FAIL';
    case 'running':
      return 'RUNNING';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'ERROR';
  }
}

/** Collapse a multi-line CLI message onto one line so the copy stays scannable. */
function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}
