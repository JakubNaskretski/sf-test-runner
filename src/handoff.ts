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

  if (typeof targetOrg !== 'string' || !targetOrg.trim() || targetOrg.startsWith('-')) {
    return { ok: false, message: 'targetOrg must be a non-empty org username.' };
  }

  if (deployed !== undefined && typeof deployed !== 'boolean') {
    return { ok: false, message: 'deployed must be a boolean when present.' };
  }

  return {
    ok: true,
    value: { classNames: [...classNames], targetOrg, ...(deployed !== undefined ? { deployed } : {}) },
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
