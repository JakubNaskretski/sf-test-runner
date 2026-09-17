import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RunRecord, TestIndexSnapshot, TestRunSummary } from '../types';
import {
  coverageOrgChangedNote,
  dropClasses,
  isSelector,
  localOnlyClasses,
  runLabel,
  summaryText,
} from './runLabel';

const index: TestIndexSnapshot = {
  classes: [
    { name: 'AccountServiceTest', source: 'both', methods: [{ name: 'testCreate' }] },
    { name: 'InvoiceCalculatorTest', source: 'local-only', methods: [{ name: 'testNetTotal' }] },
    { name: 'LegacyPricingTest', source: 'org-only', methods: [], methodsUnknown: true },
  ],
};

function summary(over: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    asyncApexJobId: '707xx0000000001',
    status: 'Failed',
    testsRan: 3,
    passing: 1,
    failing: 2,
    skipped: 0,
    testTotalTime: 812,
    results: [
      {
        className: 'AccountServiceTest',
        methodName: 'testCreate',
        outcome: 'Pass',
        runTime: 212,
        message: null,
        stackTrace: null,
      },
      {
        className: 'AccountServiceTest',
        methodName: 'testUpdate',
        outcome: 'Fail',
        runTime: 300,
        message: 'System.AssertException: Assertion Failed:\n  expected 1, got 0',
        stackTrace: 'Class.AccountServiceTest.testUpdate: line 9, column 1',
      },
      {
        className: 'InvoiceCalculatorTest',
        methodName: 'testNetTotal',
        outcome: 'CompileFail',
        runTime: 0,
        message: 'Variable does not exist: total',
        stackTrace: null,
      },
    ],
    ...over,
  };
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    label: '3 tests on acme-dev',
    orgUsername: 'tester@example.com',
    orgAlias: 'acme-dev',
    startedAt: Date.UTC(2026, 8, 17, 12, 0, 0),
    finishedAt: Date.UTC(2026, 8, 17, 12, 0, 30),
    status: 'failed',
    withCoverage: true,
    testRunId: '707xx0000000001',
    summary: summary(),
    ...over,
  };
}

test('runLabel names each scope', () => {
  assert.equal(runLabel('selected', 7, 'acme-dev'), '7 tests on acme-dev');
  assert.equal(runLabel('selected', 1, 'acme-dev'), '1 test on acme-dev');
  assert.equal(runLabel('allLocal', 0, 'acme-dev'), 'All local tests on acme-dev');
  assert.equal(runLabel('allInOrg', 0, 'acme-dev'), 'All tests incl. managed on acme-dev');
});

test('summaryText header carries verdict, counts, org, id and an ISO timestamp', () => {
  const lines = summaryText(record()).split('\n');
  assert.equal(
    lines[0],
    'FAIL · 3 tests on acme-dev · 1/3 passed · 2 failed · 812 ms · org acme-dev · ' +
      '707xx0000000001 · 2026-09-17T12:00:30.000Z',
  );
});

test('summaryText lists one single-line entry per failure, passes excluded', () => {
  const lines = summaryText(record()).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(
    lines[1],
    '✗ AccountServiceTest.testUpdate — System.AssertException: Assertion Failed: expected 1, got 0',
  );
  assert.equal(lines[2], '✗ InvoiceCalculatorTest.testNetTotal — Variable does not exist: total');
});

test('summaryText falls back to the outcome when a failure carries no message', () => {
  const run = record({
    summary: summary({
      results: [
        {
          className: 'AccountServiceTest',
          methodName: 'testUpdate',
          outcome: 'Fail',
          runTime: 1,
          message: null,
          stackTrace: null,
        },
      ],
    }),
  });
  assert.equal(summaryText(run).split('\n')[1], '✗ AccountServiceTest.testUpdate — Fail');
});

test('summaryText works for a run that never produced a summary', () => {
  const run = record({
    status: 'error',
    summary: undefined,
    testRunId: undefined,
    error: 'No authorization information found\nfor tester@example.com',
  });
  const lines = summaryText(run).split('\n');
  assert.equal(lines[0], 'ERROR · 3 tests on acme-dev · org acme-dev · 2026-09-17T12:00:30.000Z');
  assert.equal(lines[1], 'Error: No authorization information found for tester@example.com');
});

test('summaryText reports a cancelled run as CANCELLED', () => {
  assert.match(summaryText(record({ status: 'cancelled', summary: undefined })), /^CANCELLED · /);
});

test('localOnlyClasses finds classes the org does not have, sorted and deduped', () => {
  assert.deepEqual(
    localOnlyClasses(index, [
      'AccountServiceTest',
      'InvoiceCalculatorTest.testNetTotal',
      'InvoiceCalculatorTest.testTax',
      'LegacyPricingTest',
      'UnknownTest',
    ]),
    ['InvoiceCalculatorTest'],
  );
});

test('dropClasses removes every selector of the named classes', () => {
  assert.deepEqual(
    dropClasses(
      ['AccountServiceTest.testCreate', 'InvoiceCalculatorTest', 'InvoiceCalculatorTest.testTax'],
      ['invoicecalculatortest'],
    ),
    ['AccountServiceTest.testCreate'],
  );
});

test('isSelector accepts only Cls and Cls.method', () => {
  assert.ok(isSelector('AccountServiceTest'));
  assert.ok(isSelector('AccountServiceTest.testCreate'));
  assert.ok(!isSelector('Account Service'));
  assert.ok(!isSelector('Account.Service.Test'));
  assert.ok(!isSelector('--test-level'));
  assert.ok(!isSelector(''));
});

test('coverageOrgChangedNote: the org that started the run is still the target', () => {
  const org = { username: 'dev@example.com', alias: 'DevOrg' };
  assert.equal(coverageOrgChangedNote(org, { ...org }), undefined);
  // The CLI treats usernames case-insensitively, so a differently-spelled one
  // is the same org and must not block the coverage.
  assert.equal(
    coverageOrgChangedNote(org, { username: 'DEV@example.com', alias: 'DevOrg' }),
    undefined,
  );
});

test('coverageOrgChangedNote: a switch mid-run names both orgs and where to find it', () => {
  const note = coverageOrgChangedNote(
    { username: 'dev@example.com', alias: 'DevOrg' },
    { username: 'qa@example.com', alias: 'QaOrg' },
  );
  assert.equal(
    note,
    'Coverage from DevOrg not painted: the target org changed to QaOrg during the run. ' +
      'Load Recent Test Runs on DevOrg to see it.',
  );
});

test('coverageOrgChangedNote: an org cleared mid-run also blocks the coverage', () => {
  const note = coverageOrgChangedNote({ username: 'dev@example.com', alias: 'DevOrg' }, undefined);
  assert.match(note ?? '', /^Coverage from DevOrg not painted: the target org changed during/);
});
