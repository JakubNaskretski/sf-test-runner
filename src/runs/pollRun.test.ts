import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_POLL_MS,
  POLL_INTERVAL_MS,
  PollStatus,
  PollVerdict,
  pollUntilDone,
} from './pollRun';
import type { RunProgress } from '../types';

interface FakeResult {
  className: string;
  methodName: string;
}

interface Tick {
  progress: RunProgress;
  fresh: string[];
}

/**
 * Drive the loop over scripted poll answers, with a clock that only moves when
 * the loop sleeps. `cancelAfter` cancels once that many polls have happened, so
 * a cancel can be placed exactly mid-run.
 */
async function run(script: {
  statuses: (PollStatus | null)[];
  results?: FakeResult[][];
  ceilingMs?: number;
  cancelAfter?: number;
}): Promise<{ verdict: PollVerdict; ticks: Tick[]; waits: number[]; polls: number }> {
  let clock = 0;
  let polls = 0;
  let cancelled = false;
  const waits: number[] = [];
  const ticks: Tick[] = [];

  const at = <T>(list: T[] | undefined, fallback: T): T =>
    list && list.length > 0 ? (list[Math.min(polls - 1, list.length - 1)] ?? fallback) : fallback;

  const verdict = await pollUntilDone<FakeResult>(
    {
      status: async () => {
        polls++;
        return at(script.statuses, null);
      },
      live: async () => at(script.results, []),
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
      isCancelled: () => {
        if (script.cancelAfter !== undefined && polls >= script.cancelAfter) cancelled = true;
        return cancelled;
      },
      onTick: (progress, fresh) =>
        ticks.push({ progress, fresh: fresh.map((r) => `${r.className}.${r.methodName}`) }),
    },
    script.ceilingMs ?? 600_000,
  );
  return { verdict, ticks, waits, polls };
}

const processing = (done: number, total: number, failed = 0): PollStatus => ({
  status: 'Processing',
  enqueued: total,
  completed: done,
  failed,
});

test('a run that finishes reports every result exactly once', async () => {
  const { verdict, ticks, waits } = await run({
    statuses: [null, processing(1, 2), { ...processing(2, 2, 1), status: 'Completed' }],
    results: [
      [],
      [{ className: 'AcmeTest', methodName: 'testOne' }],
      [
        { className: 'AcmeTest', methodName: 'testOne' },
        { className: 'AcmeTest', methodName: 'testTwo' },
      ],
    ],
  });

  assert.deepEqual(verdict, { outcome: 'completed', status: 'Completed' });
  // The first poll is early, the rest are on the interval.
  assert.deepEqual(waits, [FIRST_POLL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  assert.deepEqual(
    ticks.map((t) => t.fresh),
    [[], ['AcmeTest.testOne'], ['AcmeTest.testTwo']],
  );
  assert.deepEqual(ticks[2].progress, { done: 2, total: 2, failed: 1 });
});

test('before the org writes a status row, progress falls back to what has arrived', async () => {
  const { ticks } = await run({
    statuses: [null, { ...processing(1, 1), status: 'Completed' }],
    results: [[{ className: 'AcmeTest', methodName: 'testOne' }]],
  });

  assert.deepEqual(ticks[0].progress, { done: 1, total: 0, failed: 0 });
});

test('a run aborted in the org ends as aborted, not as a finished run', async () => {
  const { verdict } = await run({
    statuses: [processing(0, 3), { status: 'Aborted', enqueued: 3, completed: 1, failed: 0 }],
  });

  assert.deepEqual(verdict, { outcome: 'aborted', status: 'Aborted' });
});

test('a run whose job failed is terminal too — the results are still fetched', async () => {
  const { verdict } = await run({
    statuses: [{ status: 'Failed', enqueued: 1, completed: 1, failed: 1 }],
  });

  assert.equal(verdict.outcome, 'completed');
});

test('a run that outlives the ceiling is handed back, not declared finished', async () => {
  const { verdict, polls } = await run({
    statuses: [processing(0, 9)],
    ceilingMs: 5000,
  });

  // 1500 + 3000 is still under the ceiling; the third poll crosses it.
  assert.deepEqual(verdict, { outcome: 'ceiling', status: 'Processing' });
  assert.equal(polls, 3);
});

test('a cancel mid-run stops the loop instead of polling on', async () => {
  const { verdict, polls, ticks } = await run({
    statuses: [processing(0, 4), processing(2, 4)],
    cancelAfter: 2,
  });

  assert.deepEqual(verdict, { outcome: 'cancelled' });
  assert.equal(polls, 2, 'the poll after the cancel never happens');
  assert.equal(ticks.length, 2);
});

test('a run cancelled before the first sleep never asks the org anything', async () => {
  const { verdict, polls, waits } = await run({ statuses: [], cancelAfter: 0 });

  assert.deepEqual(verdict, { outcome: 'cancelled' });
  assert.equal(polls, 0);
  assert.deepEqual(waits, []);
});
