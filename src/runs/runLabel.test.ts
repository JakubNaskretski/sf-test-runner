import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RunRecord, TestIndexSnapshot, TestRunSummary } from '../types';
import {
  allWholeClasses,
  coverageOrgChangedNote,
  dropClasses,
  excludeDeployed,
  handoffCoverageNote,
  handoffLabel,
  isSelector,
  localOnlyClasses,
  orgMovedDuringDeploy,
  runLabel,
  summaryText,
} from './runLabel';

const ORG = 'tester@example.com';

const index: TestIndexSnapshot = {
  orgUsername: ORG,
  orgFetchedAt: Date.UTC(2026, 8, 17, 11, 0, 0),
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

test('runLabel says "test class(es)" instead of "test(s)" when wholeClasses is true', () => {
  assert.equal(runLabel('selected', 7, 'acme-dev', true), '7 test classes on acme-dev');
  assert.equal(runLabel('selected', 1, 'acme-dev', true), '1 test class on acme-dev');
});

test('runLabel ignores wholeClasses for the org-wide scopes', () => {
  assert.equal(runLabel('allLocal', 0, 'acme-dev', true), 'All local tests on acme-dev');
  assert.equal(runLabel('allInOrg', 0, 'acme-dev', true), 'All tests incl. managed on acme-dev');
});

test('handoffLabel appends the "from SF Deploy" pairing marker to the plain runLabel', () => {
  assert.equal(handoffLabel('selected', 7, 'acme-dev'), '7 tests on acme-dev (from SF Deploy)');
  assert.equal(handoffLabel('selected', 1, 'acme-dev'), '1 test on acme-dev (from SF Deploy)');
});

test('handoffLabel passes wholeClasses through to runLabel', () => {
  assert.equal(
    handoffLabel('selected', 7, 'acme-dev', true),
    '7 test classes on acme-dev (from SF Deploy)',
  );
});

test('allWholeClasses: true only when every selector is a bare class (no method)', () => {
  assert.equal(allWholeClasses(['AccountServiceTest', 'InvoiceCalculatorTest']), true);
  assert.equal(allWholeClasses(['AccountServiceTest']), true);
});

test('allWholeClasses: false when any selector names a method', () => {
  assert.equal(allWholeClasses(['AccountServiceTest.testCreate']), false);
  assert.equal(allWholeClasses(['AccountServiceTest', 'InvoiceCalculatorTest.testNetTotal']), false);
});

test('allWholeClasses: false for an empty list — nothing is not a class selection', () => {
  assert.equal(allWholeClasses([]), false);
});

test('summaryText header carries verdict, counts, org, id and an ISO timestamp', () => {
  const lines = summaryText(record()).split('\n');
  assert.equal(
    lines[0],
    'FAIL · 3 tests on acme-dev · 1/3 passed · 2 failed · 812 ms · org acme-dev · ' +
      '707xx0000000001 · 2026-09-17T12:00:30.000Z',
  );
});

test('summaryText lists one entry per failure with its stack indented beneath, passes excluded', () => {
  const lines = summaryText(record()).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(
    lines[1],
    '✗ AccountServiceTest.testUpdate — System.AssertException: Assertion Failed: expected 1, got 0',
  );
  assert.equal(lines[2], '    Class.AccountServiceTest.testUpdate: line 9, column 1');
  assert.equal(lines[3], '✗ InvoiceCalculatorTest.testNetTotal — Variable does not exist: total');
});

test('summaryText keeps every frame of a multi-line stack, one per line', () => {
  const run = record({
    summary: summary({
      results: [
        {
          className: 'AccountServiceTest',
          methodName: 'testUpdate',
          outcome: 'Fail',
          runTime: 1,
          message: 'boom',
          stackTrace: 'Class.AccountService.save: line 40, column 1\n\nClass.AccountServiceTest.testUpdate: line 9, column 1\n',
        },
      ],
    }),
  });
  assert.deepEqual(summaryText(run).split('\n').slice(1), [
    '✗ AccountServiceTest.testUpdate — boom',
    '    Class.AccountService.save: line 40, column 1',
    '    Class.AccountServiceTest.testUpdate: line 9, column 1',
  ]);
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

const SELECTORS = [
  'AccountServiceTest',
  'InvoiceCalculatorTest.testNetTotal',
  'InvoiceCalculatorTest.testTax',
  'LegacyPricingTest',
  'UnknownTest',
];

test('localOnlyClasses finds classes the org does not have, sorted and deduped', () => {
  assert.deepEqual(localOnlyClasses(index, SELECTORS, ORG), ['InvoiceCalculatorTest']);
  // Usernames are compared case-insensitively, as the CLI treats them.
  assert.deepEqual(localOnlyClasses(index, SELECTORS, ORG.toUpperCase()), [
    'InvoiceCalculatorTest',
  ]);
});

test('localOnlyClasses claims nothing while the org half of the index is unknown', () => {
  // The org fetch is opt-in, so on a fresh install every local class carries the
  // local-only stamp and none of it has been checked against the org.
  const neverFetched: TestIndexSnapshot = { classes: index.classes };
  assert.deepEqual(localOnlyClasses(neverFetched, SELECTORS, ORG), []);
  // Same for an index fetched from a different org, and for no org at all.
  assert.deepEqual(localOnlyClasses(index, SELECTORS, 'other@example.com'), []);
  assert.deepEqual(localOnlyClasses(index, SELECTORS, undefined), []);
});

test('localOnlyClasses also sees the hidden annotated-only classes a handoff can send', () => {
  const withHelpers: TestIndexSnapshot = {
    ...index,
    annotatedOnly: [
      { name: 'AcmeLocalHelper', source: 'local-only', methods: [], annotatedOnly: true },
      { name: 'AcmeDeployedHelper', source: 'both', methods: [], annotatedOnly: true },
    ],
  };
  assert.deepEqual(localOnlyClasses(withHelpers, ['AcmeLocalHelper', 'AcmeDeployedHelper'], ORG), [
    'AcmeLocalHelper',
  ]);
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

test('excludeDeployed drops names the caller claims are already on the org', () => {
  assert.deepEqual(
    excludeDeployed(['AccountServiceTest', 'InvoiceCalculatorTest'], ['AccountServiceTest']),
    ['InvoiceCalculatorTest'],
  );
});

test('excludeDeployed compares case-insensitively', () => {
  assert.deepEqual(
    excludeDeployed(['AccountServiceTest'], ['accountservicetest']),
    [],
  );
});

test('excludeDeployed leaves names the caller never mentioned alone', () => {
  // The caller's claim only covers the classNames it actually passed — a
  // class the handoff did not deploy is still checked as usual.
  assert.deepEqual(
    excludeDeployed(['AccountServiceTest', 'InvoiceCalculatorTest'], ['SomethingElse']),
    ['AccountServiceTest', 'InvoiceCalculatorTest'],
  );
});

test('excludeDeployed is a no-op with no deployed names at all', () => {
  assert.deepEqual(excludeDeployed(['AccountServiceTest'], undefined), ['AccountServiceTest']);
  assert.deepEqual(excludeDeployed(['AccountServiceTest'], []), ['AccountServiceTest']);
});

test('excludeDeployed on an already-empty list stays empty', () => {
  assert.deepEqual(excludeDeployed([], ['AccountServiceTest']), []);
});

test('orgMovedDuringDeploy: the same org has not moved', () => {
  assert.equal(
    orgMovedDuringDeploy({ username: 'dev@example.com' }, { username: 'dev@example.com' }),
    false,
  );
});

test('orgMovedDuringDeploy: a different org has moved', () => {
  assert.equal(
    orgMovedDuringDeploy({ username: 'dev@example.com' }, { username: 'qa@example.com' }),
    true,
  );
});

test('orgMovedDuringDeploy: usernames compare case-insensitively, like every other org match', () => {
  assert.equal(
    orgMovedDuringDeploy({ username: 'dev@example.com' }, { username: 'DEV@EXAMPLE.com' }),
    false,
  );
});

test('orgMovedDuringDeploy: no current org (cleared) counts as moved', () => {
  assert.equal(orgMovedDuringDeploy({ username: 'dev@example.com' }, undefined), true);
});

test('handoffCoverageNote: the run matches the picker — nothing to say', () => {
  const org = { username: 'dev@example.com', alias: 'DevOrg' };
  assert.equal(handoffCoverageNote(org, { ...org }), undefined);
  assert.equal(
    handoffCoverageNote(org, { username: 'DEV@example.com', alias: 'DevOrg' }),
    undefined,
  );
});

test('handoffCoverageNote: says the run was on its own org, not that the target "changed"', () => {
  const note = handoffCoverageNote(
    { username: 'dev@example.com', alias: 'DevOrg' },
    { username: 'qa@example.com', alias: 'QaOrg' },
  );
  assert.ok(note);
  assert.match(note, /was on DevOrg/);
  assert.match(note, /picker's org \(QaOrg\)/);
  assert.doesNotMatch(note, /changed/);
});

test('handoffCoverageNote: no picker org at all still names it honestly', () => {
  const note = handoffCoverageNote({ username: 'dev@example.com', alias: 'DevOrg' }, undefined);
  assert.ok(note);
  assert.match(note, /picker's org \(no org\)/);
});
