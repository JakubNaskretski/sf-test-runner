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

/**
 * Human label for the run bar. `count` is the number of selectors for a
 * selected run and is ignored for the org-wide scopes. `wholeClasses` says
 * every one of those selectors names a WHOLE class (see `allWholeClasses`):
 * "N test class(es)" reads truer than "N test(s)" when none of them is a
 * single method.
 */
export function runLabel(
  scope: RunScope,
  count: number,
  alias: string,
  wholeClasses = false,
): string {
  switch (scope) {
    case 'allLocal':
      return `All local tests on ${alias}`;
    case 'allInOrg':
      return `All tests incl. managed on ${alias}`;
    default: {
      const noun = wholeClasses
        ? count === 1 ? 'test class' : 'test classes'
        : count === 1 ? 'test' : 'tests';
      return `${count} ${noun} on ${alias}`;
    }
  }
}

/**
 * Whether every selector names a WHOLE class — the bare `Cls` form `--tests`
 * accepts, never `Cls.method`. An empty list counts as false: there is
 * nothing to call a class selection, vacuous truth notwithstanding.
 */
export function allWholeClasses(selectors: readonly string[]): boolean {
  return selectors.length > 0 && selectors.every((s) => !s.includes('.'));
}

/** `runLabel`, with a suffix that makes the pairing visible in the Results
 *  view: a run started via the cross-extension handoff (`TestRunner.runFor`)
 *  was asked for by sf-org-deploy-wrapper, not ticked in the Tests view. */
export function handoffLabel(
  scope: RunScope,
  count: number,
  alias: string,
  wholeClasses = false,
): string {
  return `${runLabel(scope, count, alias, wholeClasses)} (from SF Deploy)`;
}

/**
 * Classes in `selectors` that the index knows only from disk. Running one is a
 * guaranteed failure — `--tests` names a class in the ORG — so the runner warns
 * before spending a run on it. Sorted so the warning reads the same every time.
 *
 * `local-only` is only EVIDENCE of that once the org half of the index is known
 * FOR `orgUsername`. Until an org fetch happens (it is opt-in) every local class
 * carries the stamp by default, and after an org switch the stamp describes the
 * previous org — in both cases nothing has been checked, so nothing is claimed.
 *
 * The hidden `annotatedOnly` classes count too: the handoff can send one by
 * name, and a local-only one fails the run exactly like any other.
 */
export function localOnlyClasses(
  index: TestIndexSnapshot,
  selectors: readonly string[],
  orgUsername: string | undefined,
): string[] {
  if (!sameOrg(index.orgUsername, orgUsername)) return [];
  const byName = new Map(
    [...index.classes, ...(index.annotatedOnly ?? [])].map((c) => [c.name.toLowerCase(), c]),
  );
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
 * `notDeployed`, minus whatever the caller itself just claimed is on the org
 * (the cross-extension handoff's `deployed` flag: "the classNames I passed
 * are on targetOrg right now"). Compared case-insensitively, against the
 * NAMES the caller gave — a name the caller never mentioned is still not
 * deployed as far as this is concerned, so it stays in the warning.
 */
export function excludeDeployed(
  notDeployed: readonly string[],
  deployedNames: readonly string[] | undefined,
): string[] {
  if (!deployedNames || deployedNames.length === 0) return [...notDeployed];
  const deployed = new Set(deployedNames.map((n) => n.toLowerCase()));
  return notDeployed.filter((name) => !deployed.has(name.toLowerCase()));
}

/**
 * Whether the org "Deploy first" just deployed to (`deployedTo`, captured
 * before the not-deployed modal opened) is no longer the org the picker
 * currently shows (`current`). A deploy can sit waiting for a while, and the
 * picker is free to move during that wait — this is what tells `runSelected`
 * whether to ask before pinning the run to an org the picker no longer shows.
 * `current` undefined (the org was cleared) counts as moved too.
 */
export function orgMovedDuringDeploy(
  deployedTo: { username: string },
  current: { username: string } | undefined,
): boolean {
  return !sameOrg(deployedTo.username, current?.username);
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

/**
 * The handoff's version of `coverageOrgChangedNote`: a run started through
 * the cross-extension handoff (`TestRunner.runFor`) targets the CALLER's
 * org, which is routinely not the picker's — nothing "changed during the
 * run" when it never matched the picker to begin with, so that wording
 * would be false here. Same gate, honest wording.
 */
export function handoffCoverageNote(
  runOrg: { username: string; alias: string },
  currentOrg: { username: string; alias: string } | undefined,
): string | undefined {
  if (sameOrg(runOrg.username, currentOrg?.username)) return undefined;
  const picker = currentOrg ? currentOrg.alias : 'no org';
  return (
    `Coverage from ${runOrg.alias} not painted: the run was on ${runOrg.alias}, not the ` +
    `picker's org (${picker}). Load Recent Test Runs on ${runOrg.alias} to see it.`
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
  for (const failure of failedResults(summary)) lines.push(failureText(failure));
  return lines.join('\n');
}

/** One failure as the summary lists it — also what a failed row's "copy" copies. */
export function failureText(failure: TestMethodResult): string {
  const detail = oneLine(failure.message) || failure.outcome;
  const frames = stackLines(failure.stackTrace).map((frame) => `    ${frame}`);
  return [`✗ ${failure.className}.${failure.methodName} — ${detail}`, ...frames].join('\n');
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

/** Stack trace as trimmed non-empty lines, oldest-deepest first as the CLI gave it. */
function stackLines(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Collapse a multi-line CLI message onto one line so the copy stays scannable. */
function oneLine(text: string | null | undefined): string {
  // All whitespace, tabs too: a tab pasted into a spreadsheet starts a new cell.
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
