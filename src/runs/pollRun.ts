/**
 * The poll loop of an async test run, with every side effect injected.
 *
 * A run is started, then watched: the org's counters and the results it has
 * written so far are asked for on a timer until the job reaches a terminal
 * state. That loop is the part with the interesting edges — the ceiling, the
 * cancel, the window before the org has written a status row at all — so it
 * lives here as a pure function over injected `status`/`live`/`sleep`/`now`
 * rather than inside `TestRunner`, where testing it would mean an org.
 */
import type { RunProgress } from '../types';

/** `ApexTestRunResult.Status` values that mean the org is done with the job. */
const TERMINAL = new Set(['Completed', 'Failed', 'Aborted']);

/** The first poll comes early: a handful of tests can be over well inside one
 *  full interval, and an empty progress line for 3s reads as a hang. */
export const FIRST_POLL_MS = 1500;
export const POLL_INTERVAL_MS = 3000;

/** The counters a poll reads off the run's `ApexTestRunResult` row. */
export interface PollStatus {
  status: string;
  enqueued: number;
  completed: number;
  failed: number;
}

/** The shape the loop needs from a result row: enough to key it, no more. */
export interface PollResult {
  className: string;
  methodName: string;
}

export interface PollDeps<R extends PollResult> {
  /** The run's counters, or null while the org has not written the row yet. */
  status(): Promise<PollStatus | null>;
  /** Every per-method result the org has written so far, in any order. */
  live(): Promise<R[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Once per poll: the counters, plus the results not reported before. */
  onTick(progress: RunProgress, newResults: R[]): void;
  isCancelled(): boolean;
}

export type PollOutcome = 'completed' | 'aborted' | 'cancelled' | 'ceiling';

export interface PollVerdict {
  outcome: PollOutcome;
  /** The org's last reported status, when a row had been written by then. */
  status?: string;
}

/**
 * Watch a started run until it finishes, is aborted, is cancelled here, or
 * outlives `ceilingMs`. Every poll reports progress through `onTick`; results
 * are de-duplicated by `Class.method`, so `onTick` only ever sees a method the
 * caller has not been told about yet.
 */
export async function pollUntilDone<R extends PollResult>(
  deps: PollDeps<R>,
  ceilingMs: number,
): Promise<PollVerdict> {
  const startedAt = deps.now();
  const seen = new Set<string>();
  let wait = FIRST_POLL_MS;

  for (;;) {
    if (deps.isCancelled()) return { outcome: 'cancelled' };
    await deps.sleep(wait);
    wait = POLL_INTERVAL_MS;
    // Checked again coming out of the sleep: a cancel during those seconds must
    // not buy the org two more queries for a run nobody is waiting on.
    if (deps.isCancelled()) return { outcome: 'cancelled' };

    const status = await deps.status();
    const results = await deps.live();
    const fresh = results.filter((r) => !seen.has(key(r)));
    for (const r of fresh) seen.add(key(r));

    deps.onTick(
      {
        // The org's own counters lead; `seen` only stands in for the window
        // before the status row exists, when they are all we have.
        done: status?.completed ?? seen.size,
        total: status?.enqueued ?? 0,
        failed: status?.failed ?? 0,
      },
      fresh,
    );

    if (status && TERMINAL.has(status.status)) {
      return {
        outcome: status.status === 'Aborted' ? 'aborted' : 'completed',
        status: status.status,
      };
    }
    if (deps.now() - startedAt >= ceilingMs) {
      return { outcome: 'ceiling', status: status?.status };
    }
  }
}

function key(result: PollResult): string {
  return `${result.className}.${result.methodName}`;
}
