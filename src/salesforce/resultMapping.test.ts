import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapTestResult, parseMs } from './resultMapping';

test('parseMs handles the CLI\'s unit-suffixed strings, numbers, and garbage', () => {
  assert.equal(parseMs('81 ms'), 81);
  assert.equal(parseMs('10464 ms'), 10464);
  assert.equal(parseMs(42), 42);
  assert.equal(parseMs(undefined), 0);
  assert.equal(parseMs('fast'), 0);
});

test('mapTestResult maps a real sf apex run test envelope (PascalCase, string times)', () => {
  // Field shapes verified against sf CLI 2.137.7 output.
  const result = {
    summary: {
      outcome: 'Failed',
      testsRan: 2,
      passing: 1,
      failing: 1,
      skipped: 0,
      testTotalTime: '81 ms',
      testRunId: '707000000000001',
    },
    tests: [
      {
        StackTrace: 'Class.SfTrProbeTest.testFail: line 9, column 1',
        Message: 'System.AssertException: Assertion Failed: deliberate failure',
        MethodName: 'testFail',
        Outcome: 'Fail',
        ApexClass: { Name: 'SfTrProbeTest' },
        RunTime: 69,
      },
      {
        StackTrace: null,
        Message: null,
        MethodName: 'testPass',
        Outcome: 'Pass',
        ApexClass: { Name: 'SfTrProbeTest' },
        RunTime: 12,
      },
    ],
  };
  const summary = mapTestResult(result);
  assert.equal(summary.testTotalTime, 81); // not NaN
  assert.ok(Number.isFinite(summary.testTotalTime));
  assert.equal(summary.status, 'Failed');
  assert.equal(summary.asyncApexJobId, '707000000000001');
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[0].className, 'SfTrProbeTest');
  assert.equal(summary.results[0].outcome, 'Fail');
});

test('mapTestResult derives counts from results when the summary omits them', () => {
  const summary = mapTestResult({
    tests: [
      { MethodName: 'a', Outcome: 'Pass', ApexClass: { Name: 'C' }, RunTime: 1 },
      { MethodName: 'b', Outcome: 'Skip', ApexClass: { Name: 'C' }, RunTime: 0 },
    ],
  });
  assert.equal(summary.testsRan, 2);
  assert.equal(summary.passing, 1);
  assert.equal(summary.failing, 0); // Skip is not a failure
  assert.equal(summary.skipped, 1);
  assert.equal(summary.testTotalTime, 0);
});
