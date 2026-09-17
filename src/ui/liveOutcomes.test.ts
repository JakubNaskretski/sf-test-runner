import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RunRecord, TestRunSummary } from '../types';
import type { OutcomeEntry } from '../webview/protocol';
import { liveForResults, liveResultRows } from './liveOutcomes';

const live: Record<string, OutcomeEntry> = {
  'AcmeOrderTest.testRefund': { o: 'fail', ms: 412 },
  'AcmeOrderTest.testCreate': { o: 'pass', ms: 96 },
};

const summary: TestRunSummary = {
  asyncApexJobId: '707000000000001AAA',
  status: 'Completed',
  testsRan: 1,
  passing: 1,
  failing: 0,
  skipped: 0,
  testTotalTime: 96,
  results: [
    {
      className: 'AcmeOrderTest',
      methodName: 'testCreate',
      outcome: 'Pass',
      runTime: 96,
      message: null,
      stackTrace: null,
    },
  ],
};

function run(over: Partial<RunRecord> = {}): Pick<RunRecord, 'status' | 'summary'> {
  return { status: 'running', ...over };
}

test('a running run with no summary posts the live outcomes', () => {
  assert.deepEqual(liveForResults(run(), live), live);
});

test('a summary wins over the live map the moment it exists', () => {
  assert.equal(liveForResults(run({ summary }), live), undefined);
});

test('a finished run never posts live outcomes', () => {
  assert.equal(liveForResults(run({ status: 'passed' }), live), undefined);
  assert.equal(liveForResults(run({ status: 'cancelled' }), live), undefined);
  assert.equal(liveForResults(run({ status: 'error' }), live), undefined);
});

test('no run, or a run that has reported nothing yet, posts nothing', () => {
  assert.equal(liveForResults(undefined, live), undefined);
  assert.equal(liveForResults(run(), {}), undefined);
});

test('live rows carry the outcome and the duration, and no failure detail', () => {
  const rows = liveResultRows(live);
  assert.deepEqual(
    rows.map((r) => [r.className, r.methodName, r.outcome, r.runTime]),
    [
      ['AcmeOrderTest', 'testCreate', 'Pass', 96],
      ['AcmeOrderTest', 'testRefund', 'Fail', 412],
    ],
  );
  assert.equal(rows[1].message, null);
  assert.equal(rows[1].stackTrace, null);
});

test('a method still executing is not turned into a failure', () => {
  assert.deepEqual(liveResultRows({ 'AcmeOrderTest.testSlow': { o: 'running', ms: 0 } }), []);
});

test('a key that is not Cls.method is ignored, and no map is no rows', () => {
  assert.deepEqual(liveResultRows({ AcmeOrderTest: { o: 'pass', ms: 5 } }), []);
  assert.deepEqual(liveResultRows({ '.testOrphan': { o: 'pass', ms: 5 } }), []);
  assert.deepEqual(liveResultRows(undefined), []);
});
