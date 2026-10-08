/**
 * The contract behind `sfTestRunner.runTestsFor` — the command a sibling
 * extension (sf-org-deploy-helper, or anything else) calls to hand this plugin
 * a set of classes to find tests for and run. A contributed command is
 * callable by ANY extension, so everything it hands over is validated here
 * before any of it reaches a CLI selector or an org lookup.
 *
 * Pure: no `vscode` import. The known-org check takes the caller's
 * already-resolved org usernames rather than reaching for the org picker
 * itself, and the run-outcome mapping takes a plain `RunRecord`, so this
 * stays unit testable.
 */
import { sameOrg } from './orgMatch';
import { orgMovedDuringDeploy } from './runs/runLabel';
import type { RunRecord } from './types';
import { conventionNames, type HandoffResolution } from './ui/activeFileTests';

const CLASS_NAME = /^\w+$/;
const MAX_CLASS_NAMES = 200;

export const HANDOFF_BUSY_MESSAGE = 'A test run is already in progress. Wait for it to finish.';

export interface HandoffArgs {
  classNames: string[];
  targetOrg: string;
  /** The caller's own claim that `classNames` are on `targetOrg` right now
   *  (it just deployed them) — see `excludeDeployed` in `runs/runLabel.ts`. */
  deployed?: boolean;
}

export type HandoffShapeResult =
  | { ok: true; value: HandoffArgs }
  | { ok: false; message: string };

export type HandoffParseResult = HandoffShapeResult;

/** The `targetOrg` shape rule every command that takes one shares
 *  (`runTestsFor`, `followOrg`): a non-empty string that cannot read as a
 *  CLI flag. Returns the error message, or undefined when it is fine. */
function targetOrgShapeError(targetOrg: unknown): string | undefined {
  if (typeof targetOrg !== 'string' || !targetOrg.trim() || targetOrg.startsWith('-')) {
    return 'targetOrg must be a non-empty org username.';
  }
  return undefined;
}

export type TargetOrgShapeResult =
  | { ok: true; value: { targetOrg: string } }
  | { ok: false; message: string };

/** Shape-only validation for a command whose only argument is `targetOrg`
 *  (`followOrg`) — the same rule `parseHandoffShape` applies to its own
 *  `targetOrg`, factored out so neither copies the other. */
export function parseTargetOrgShape(raw: unknown): TargetOrgShapeResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'Expected an object with targetOrg.' };
  }
  const { targetOrg } = raw as Record<string, unknown>;
  const err = targetOrgShapeError(targetOrg);
  if (err) return { ok: false, message: err };
  return { ok: true, value: { targetOrg: targetOrg as string } };
}

/**
 * Everything about the args EXCEPT whether `targetOrg` is a known org — split
 * out so a caller whose org list might be stale can refresh it and re-check
 * membership without re-validating the rest from scratch.
 */
export function parseHandoffShape(raw: unknown): HandoffShapeResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'Expected an object with classNames and targetOrg.' };
  }
  const { classNames, targetOrg, deployed } = raw as Record<string, unknown>;

  if (!Array.isArray(classNames) || classNames.length === 0 || classNames.length > MAX_CLASS_NAMES) {
    return {
      ok: false,
      message: `classNames must be an array of 1-${MAX_CLASS_NAMES} class names.`,
    };
  }
  if (!classNames.every((n): n is string => typeof n === 'string' && CLASS_NAME.test(n))) {
    return { ok: false, message: 'classNames must all be plain Apex identifiers.' };
  }

  const targetOrgErr = targetOrgShapeError(targetOrg);
  if (targetOrgErr) return { ok: false, message: targetOrgErr };

  if (deployed !== undefined && typeof deployed !== 'boolean') {
    return { ok: false, message: 'deployed must be a boolean when present.' };
  }

  return {
    ok: true,
    value: {
      classNames: [...classNames],
      targetOrg: targetOrg as string,
      ...(deployed !== undefined ? { deployed } : {}),
    },
  };
}

/** Shape, then the known-org check, in one call — for a caller that already
 *  has its org list settled and does not need the refresh-and-retry that an
 *  unknown org might deserve (see `parseHandoffShape` for that split). */
export function parseHandoffArgs(
  raw: unknown,
  knownOrgUsernames: readonly string[],
): HandoffParseResult {
  const shape = parseHandoffShape(raw);
  if (!shape.ok) return shape;
  if (!knownOrgUsernames.some((u) => sameOrg(u, shape.value.targetOrg))) {
    return { ok: false, message: `${shape.value.targetOrg} is not a known org.` };
  }
  return shape;
}

export interface DeployResult {
  status: 'ok' | 'failed' | 'aborted' | 'busy' | 'error';
  message?: string;
}

const DEPLOY_RESULT_STATUSES = new Set(['ok', 'failed', 'aborted', 'busy', 'error']);
/** Caps a deploy reply's `message` — it crosses an extension boundary and is
 *  shown verbatim in a toast, so it gets the same string cap any other
 *  outside input would. */
const MAX_DEPLOY_MESSAGE = 500;

/** A validated `sfOrgDeployWrapper.deployComponents` reply, or undefined for
 *  anything that does not look like one — the result crosses an extension
 *  boundary and is trusted no further than any other outside input. */
export function parseDeployResult(raw: unknown): DeployResult | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { status, message } = raw as Record<string, unknown>;
  if (typeof status !== 'string' || !DEPLOY_RESULT_STATUSES.has(status)) return undefined;
  if (message !== undefined && typeof message !== 'string') return undefined;
  return {
    status: status as DeployResult['status'],
    message: message === undefined ? undefined : message.slice(0, MAX_DEPLOY_MESSAGE),
  };
}

/** Whether a validated deploy reply means "go ahead and run the tests" —
 *  the gate behind the "Deploy first" button. Anything other than a clean
 *  `ok` (including undefined, from a throw or a malformed reply) means no. */
export function deploySucceeded(result: DeployResult | undefined): boolean {
  return result?.status === 'ok';
}

/** Whether a validated deploy reply means the user cancelled DH's OWN
 *  confirmation — reported silently (no toast), unlike every other
 *  not-ok outcome (`failed`/`busy`/`error`, or a throw/malformed reply,
 *  which stay undefined and are not aborted). */
export function deployAborted(result: DeployResult | undefined): boolean {
  return result?.status === 'aborted';
}

/** Whether an installed extension's manifest contributes `command` — the
 *  version-skew guard for "Deploy first": an older sf-org-deploy-wrapper
 *  that predates the handoff has the extension id but not
 *  `deployComponents`, so the button must not appear even though
 *  `vscode.extensions.getExtension` finds it. Takes the raw `packageJSON`
 *  rather than the `vscode.Extension` object so it stays unit testable. */
export function contributesCommand(packageJSON: unknown, command: string): boolean {
  const manifest = packageJSON as { contributes?: { commands?: unknown } } | null | undefined;
  const commands = manifest?.contributes?.commands;
  if (!Array.isArray(commands)) return false;
  return commands.some((entry) => (entry as { command?: unknown })?.command === command);
}

/**
 * `runFor`'s outright refusal when the handoff resolved more test classes
 * than a single `--tests` run can safely carry: a longer command line can
 * be truncated on Windows, and — unlike `runSelected` — a handoff has no
 * "Run All Local" escape hatch to offer instead, so this never asks, it
 * just stops. Returns the message to report, or undefined when the count
 * is within `max`.
 */
export function handoffCapMessage(resolvedCount: number, max: number): string | undefined {
  if (resolvedCount <= max) return undefined;
  return (
    `${resolvedCount} test classes resolved — at most ${max} can run from a handoff ` +
    '(a longer command line can be truncated on Windows).'
  );
}

export type PostDeployDecision = 'run' | 'confirmMoved' | 'stopSilent' | 'stopWithMessage';

/**
 * What `confirmDeployed` does once "Deploy first" comes back, as one table:
 *  - a clean `ok` from the handoff path → `run` (the caller named its org
 *    explicitly — there is no picker to have moved);
 *  - a clean `ok` from `runSelected`, org unchanged → `run`;
 *  - a clean `ok` from `runSelected`, org moved during the wait → ask
 *    (`confirmMoved` — see `orgMovedDuringDeploy`);
 *  - `aborted` (the user declined DH's OWN confirmation) → `stopSilent`,
 *    never this plugin's business to narrate;
 *  - anything else that isn't `ok` (`failed`/`busy`/`error`, or undefined
 *    from a throw/malformed reply) → `stopWithMessage`.
 */
export function decideAfterDeploy(
  result: DeployResult | undefined,
  fromHandoff: boolean,
  deployedTo: { username: string },
  current: { username: string } | undefined,
): PostDeployDecision {
  if (deploySucceeded(result)) {
    if (fromHandoff) return 'run';
    return orgMovedDuringDeploy(deployedTo, current) ? 'confirmMoved' : 'run';
  }
  if (deployAborted(result)) return 'stopSilent';
  return 'stopWithMessage';
}

/**
 * Whether `runFor` needs to move the org picker to match the handoff's
 * target before the run starts — the guard behind `TestRunnerDeps.matchOrg`.
 * A pick is a real event (it clears coverage/results, publishes to family
 * sync, fires `onOrgChanged`…), so this is skipped when the picker already
 * shows the right org; `current` undefined (no org picked yet) always needs
 * the switch.
 */
export function shouldSwitchPicker(
  current: { username: string } | undefined,
  target: { username: string },
): boolean {
  return !sameOrg(current?.username, target.username);
}

/**
 * What `sfTestRunner.runTestsFor` resolves with. `testClasses` is always the
 * resolved test class names, even when the run never started — a caller that
 * gets `noTests`/`busy`/`cancelled` still learns what was tried.
 */
export interface RunTestsForResult {
  status: 'passed' | 'failed' | 'cancelled' | 'noTests' | 'busy' | 'error';
  orgAlias?: string;
  testClasses: string[];
  passed: number;
  failed: number;
  message?: string;
}

/**
 * What `sfTestRunner.followOrg` resolves with: `'ok'` when it switched the
 * picker, `'unchanged'` when the picker already showed `targetOrg` (not an
 * error — there was simply nothing to do), `'error'` for a validation
 * failure or an unknown org. Runs nothing and touches no selection either
 * way — it only ever moves the picker.
 */
export interface FollowOrgResult {
  status: 'ok' | 'unchanged' | 'error';
  message?: string;
}

/** What `TestRunner.runFor` hands back: the finished record (undefined when
 *  the run never executed), the selectors it actually ran with (after
 *  "Skip them" may have trimmed the list), whether a never-started run is
 *  specifically because a second run already held the guard, and `error` —
 *  set only when the run was refused outright (too many resolved classes
 *  for a handoff), which takes priority over `busy`/`cancelled`. */
export interface RunForOutcome {
  record: RunRecord | undefined;
  ranSelectors: string[];
  busy: boolean;
  error?: string;
}

/**
 * Map a `runFor` outcome into the `runTestsFor` result. `record` undefined
 * means the run never executed: `error` (set only for the too-many-classes
 * refusal) wins first, then `busy` reports a guard race (a second handoff
 * raced past the `isRunning` check), and everything else that never
 * started — a declined production confirmation, a dismissed or emptied
 * not-deployed modal — reports `cancelled`. Once something DID run, the
 * reported `testClasses` are the selectors that actually ran, not whatever
 * was resolved before the not-deployed modal could trim them.
 */
export function toRunTestsForResult(
  outcome: RunForOutcome,
  testClasses: string[],
): RunTestsForResult {
  if (!outcome.record) {
    if (outcome.error) {
      return { status: 'error', testClasses, passed: 0, failed: 0, message: outcome.error };
    }
    return outcome.busy
      ? { status: 'busy', testClasses, passed: 0, failed: 0, message: HANDOFF_BUSY_MESSAGE }
      : { status: 'cancelled', testClasses, passed: 0, failed: 0 };
  }
  const { record } = outcome;
  return {
    // `running` cannot actually come back here — `runFor` only resolves once
    // the run has finished one way or another — but the type admits it, so
    // fold it into `error` rather than claim a status it isn't.
    status: record.status === 'running' ? 'error' : record.status,
    orgAlias: record.orgAlias,
    testClasses: outcome.ranSelectors,
    passed: record.summary?.passing ?? 0,
    failed: record.summary?.failing ?? 0,
    message: record.error,
  };
}

/**
 * How long a finished handoff stays joinable: one Run tests click can reach
 * this plugin twice, and a copy landing just after the first run finished
 * should get that run's result rather than start the same run again.
 */
export const HANDOFF_JOIN_GRACE_MS = 10_000;

/**
 * Which handoff request this is, for telling a repeat of the run in progress
 * apart from a new one: the org plus the SET of test classes. Usernames and
 * Apex class names are both case-insensitive, and the order classes were
 * resolved in (or a name listed twice) doesn't make it a different run.
 */
export function handoffKey(orgUsername: string, testClasses: readonly string[]): string {
  const classes = [...new Set(testClasses.map((c) => c.toLowerCase()))].sort();
  return `${orgUsername.toLowerCase()}|${classes.join(',')}`;
}

/**
 * Whether a FINISHED handoff may answer a repeat that arrives after it, for
 * the grace window. Not when it ended `cancelled` (the user said no to a
 * question, or stopped the run) or `busy` (another run had the guard): a new
 * request after either should be asked and tried again, not handed the old
 * no. A repeat that arrives while the first is still going joins it whatever
 * it ends as — both came from the same click.
 */
export function joinableAfterFinish(result: RunTestsForResult): boolean {
  return result.status !== 'cancelled' && result.status !== 'busy';
}

/** Longest `message` a handoff result composes. The deploy panel shows it
 *  verbatim as a Status card title and cuts at 500 itself; stopping short of
 *  that here means a long list ends on "… and N more", not mid-word. */
export const MAX_HANDOFF_MESSAGE = 480;

/** What was checked for a deployed class nothing matched, in checking order. */
export function unmatchedNote(name: string): string {
  return (
    `${name}: not a test class; no @IsTest(testFor) names it; ` +
    `no test class named ${conventionNames(name).join('/')}`
  );
}

/** The plain reading of an `@IsTest` class the org ran and found empty. */
export function emptyAnnotatedNote(testClass: string): string {
  return `${testClass}: @isTest, but the org found no test methods in it`;
}

/**
 * The annotated-only classes (`own: 'annotated'`) that were sent to the org
 * and came back with no result row at all — the org found no test method in
 * them. Only claimed for a run that finished with a summary: a cancelled,
 * refused or still-running one says nothing about what the class holds.
 */
export function emptyAnnotatedClasses(
  resolution: HandoffResolution,
  ranClasses: readonly string[],
  record: RunRecord | undefined,
): string[] {
  const summary = record?.summary;
  if (!summary || record?.status === 'cancelled') return [];
  const ran = new Set(ranClasses.map((name) => name.toLowerCase()));
  const reported = new Set(summary.results.map((r) => r.className.toLowerCase()));
  return resolution.matches
    .filter((m) => m.own === 'annotated')
    .map((m) => m.testClasses[0])
    .filter((name) => ran.has(name.toLowerCase()) && !reported.has(name.toLowerCase()));
}

/** Join sentences with ". " (or a space after one that already ends in a
 *  stop). Over `max`, keep the most leading notes that fit and say how many
 *  were left out ("… and N more") rather than cut one mid-word. */
export function joinNotes(parts: readonly string[], max = MAX_HANDOFF_MESSAGE): string {
  const join = (list: readonly string[]): string =>
    list.reduce((acc, part) => (acc ? `${acc}${/[.!?]$/.test(acc) ? ' ' : '. '}${part}` : part), '');
  const full = join(parts);
  if (full.length <= max) return full;
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const text = `${join(parts.slice(0, keep))} … and ${parts.length - keep} more`;
    if (text.length <= max) return text;
  }
  return `${full.slice(0, max - 1)}…`;
}

/** The lead sentence of a `noTests` message. The deploy panel shows the
 *  message in place of its own "Tests on <org>: …" title, so the org stays in
 *  front when it is known. */
function noTestsLead(orgAlias: string | undefined, what: string): string {
  return orgAlias ? `Tests on ${orgAlias}: ${what}` : what.charAt(0).toUpperCase() + what.slice(1);
}

/**
 * Fold what the matching learned — and, once a run finished, what the org
 * reported — into a `runTestsFor` result's `message`:
 *  - nothing matched at all (`noTests`, no run): "Tests on <org>: no matching
 *    test class", then, per class, exactly what was checked;
 *  - every class that ran was an `@IsTest` class the org found no test
 *    method in, and the run reported nothing (the org answers such a class
 *    with outcome Skipped, 0 ran — not an error): that is `noTests` too, and
 *    the message says so in plain words;
 *  - a run that was cancelled keeps its own wording — notes about what a
 *    run that never happened would have matched would replace it;
 *  - otherwise the status stands, and the notes (empty annotated classes,
 *    unmatched classes) follow whatever message the run itself produced.
 */
export function explainHandoff(
  result: RunTestsForResult,
  resolution: HandoffResolution,
  record?: RunRecord,
): RunTestsForResult {
  const empty = emptyAnnotatedClasses(resolution, result.testClasses, record);
  const unmatched = resolution.matches
    .filter((m) => m.testClasses.length === 0)
    .map((m) => unmatchedNote(m.name));
  const notes = [...empty.map(emptyAnnotatedNote), ...unmatched];
  if (result.status === 'noTests' && result.testClasses.length === 0) {
    return {
      ...result,
      message: joinNotes([noTestsLead(result.orgAlias, 'no matching test class'), ...notes]),
    };
  }
  if (notes.length === 0 || result.status === 'cancelled') return result;

  const emptyKeys = new Set(empty.map((name) => name.toLowerCase()));
  const onlyEmpty =
    record?.summary?.results.length === 0 &&
    result.testClasses.length > 0 &&
    result.testClasses.every((name) => emptyKeys.has(name.toLowerCase()));
  if (onlyEmpty) {
    return {
      ...result,
      status: 'noTests',
      message: joinNotes([noTestsLead(result.orgAlias, 'no test methods ran'), ...notes]),
    };
  }

  return { ...result, message: joinNotes(result.message ? [result.message, ...notes] : notes) };
}
