import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RunRecord } from './types';
import {
  deployAborted,
  deploySucceeded,
  parseDeployResult,
  parseHandoffArgs,
  toRunTestsForResult,
} from './handoff';

const KNOWN = ['alice@example.com', 'bob@example.com'];

test('a well-formed request parses', () => {
  const result = parseHandoffArgs(
    { classNames: ['AccountService', 'AccountServiceTest'], targetOrg: 'alice@example.com' },
    KNOWN,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok ? result.value : undefined,
    { classNames: ['AccountService', 'AccountServiceTest'], targetOrg: 'alice@example.com' },
  );
});

test('the org match is case-insensitive, like every other username comparison', () => {
  const result = parseHandoffArgs(
    { classNames: ['AccountService'], targetOrg: 'Alice@Example.com' },
    KNOWN,
  );
  assert.equal(result.ok, true);
});

test('not an object at all is rejected', () => {
  assert.equal(parseHandoffArgs(undefined, KNOWN).ok, false);
  assert.equal(parseHandoffArgs(null, KNOWN).ok, false);
  assert.equal(parseHandoffArgs('AccountService', KNOWN).ok, false);
});

test('classNames must be an array', () => {
  const result = parseHandoffArgs({ classNames: 'AccountService', targetOrg: 'alice@example.com' }, KNOWN);
  assert.equal(result.ok, false);
});

test('an empty classNames array is rejected', () => {
  const result = parseHandoffArgs({ classNames: [], targetOrg: 'alice@example.com' }, KNOWN);
  assert.equal(result.ok, false);
});

test('more than 200 classNames is rejected', () => {
  const classNames = Array.from({ length: 201 }, (_, i) => `Cls${i}`);
  const result = parseHandoffArgs({ classNames, targetOrg: 'alice@example.com' }, KNOWN);
  assert.equal(result.ok, false);
});

test('exactly 200 classNames is accepted', () => {
  const classNames = Array.from({ length: 200 }, (_, i) => `Cls${i}`);
  const result = parseHandoffArgs({ classNames, targetOrg: 'alice@example.com' }, KNOWN);
  assert.equal(result.ok, true);
});

test('a class name that is not a plain Apex identifier is rejected', () => {
  const bad = ['AccountService; DROP', 'Foo.Bar', 'Foo Bar', 'Foo-Bar'];
  for (const name of bad) {
    const result = parseHandoffArgs({ classNames: [name], targetOrg: 'alice@example.com' }, KNOWN);
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to be rejected`);
  }
});

test('one bad name among good ones still rejects the whole batch', () => {
  const result = parseHandoffArgs(
    { classNames: ['AccountService', 'not a class'], targetOrg: 'alice@example.com' },
    KNOWN,
  );
  assert.equal(result.ok, false);
});

test('a non-array element inside classNames is rejected', () => {
  const result = parseHandoffArgs({ classNames: ['AccountService', 42], targetOrg: 'alice@example.com' }, KNOWN);
  assert.equal(result.ok, false);
});

test('targetOrg must be a non-empty string', () => {
  assert.equal(parseHandoffArgs({ classNames: ['A'], targetOrg: '' }, KNOWN).ok, false);
  assert.equal(parseHandoffArgs({ classNames: ['A'], targetOrg: '   ' }, KNOWN).ok, false);
  assert.equal(parseHandoffArgs({ classNames: ['A'], targetOrg: undefined }, KNOWN).ok, false);
  assert.equal(parseHandoffArgs({ classNames: ['A'], targetOrg: 7 }, KNOWN).ok, false);
});

test('a targetOrg starting with "-" is rejected (it would read as a CLI flag), even if it is otherwise a known org', () => {
  // The org list carries the dashed value too, so the only thing that can
  // reject it is the leading-dash check — an "unknown org" rejection would
  // pass this test for the wrong reason.
  const result = parseHandoffArgs(
    { classNames: ['A'], targetOrg: '-alice@example.com' },
    [...KNOWN, '-alice@example.com'],
  );
  assert.equal(result.ok, false);
});

test('a targetOrg that is not in the known org list is rejected', () => {
  const result = parseHandoffArgs({ classNames: ['A'], targetOrg: 'carol@example.com' }, KNOWN);
  assert.equal(result.ok, false);
});

test('an empty known-org list rejects every targetOrg', () => {
  const result = parseHandoffArgs({ classNames: ['A'], targetOrg: 'alice@example.com' }, []);
  assert.equal(result.ok, false);
});

// ───────────────────────────────── deployed ────────────────────────────────

test('deployed is accepted when true or false, and passed through', () => {
  const trueResult = parseHandoffArgs({ classNames: ['A'], targetOrg: 'alice@example.com', deployed: true }, KNOWN);
  assert.equal(trueResult.ok, true);
  assert.equal(trueResult.ok ? trueResult.value.deployed : undefined, true);

  const falseResult = parseHandoffArgs(
    { classNames: ['A'], targetOrg: 'alice@example.com', deployed: false },
    KNOWN,
  );
  assert.equal(falseResult.ok, true);
  assert.equal(falseResult.ok ? falseResult.value.deployed : undefined, false);
});

test('deployed is optional and omitted from the parsed value when absent', () => {
  const result = parseHandoffArgs({ classNames: ['A'], targetOrg: 'alice@example.com' }, KNOWN);
  assert.equal(result.ok, true);
  assert.equal(result.ok && 'deployed' in result.value, false);
});

test('a non-boolean deployed is rejected', () => {
  for (const bad of ['true', 1, {}, []]) {
    const result = parseHandoffArgs({ classNames: ['A'], targetOrg: 'alice@example.com', deployed: bad }, KNOWN);
    assert.equal(result.ok, false, `expected deployed=${JSON.stringify(bad)} to be rejected`);
  }
});

// ─────────────────────────────── parseDeployResult ──────────────────────────

test('parseDeployResult accepts a plain ok reply', () => {
  assert.deepEqual(parseDeployResult({ status: 'ok' }), { status: 'ok', message: undefined });
});

test('parseDeployResult accepts every other status, with a message', () => {
  for (const status of ['failed', 'aborted', 'busy', 'error']) {
    assert.deepEqual(parseDeployResult({ status, message: 'why' }), { status, message: 'why' });
  }
});

test('parseDeployResult rejects a status outside the enum', () => {
  assert.equal(parseDeployResult({ status: 'done' }), undefined);
  assert.equal(parseDeployResult({ status: 'OK' }), undefined);
});

test('parseDeployResult rejects anything that is not an object', () => {
  assert.equal(parseDeployResult(undefined), undefined);
  assert.equal(parseDeployResult(null), undefined);
  assert.equal(parseDeployResult('ok'), undefined);
  assert.equal(parseDeployResult(42), undefined);
});

test('parseDeployResult rejects a non-string message', () => {
  assert.equal(parseDeployResult({ status: 'ok', message: 42 }), undefined);
  assert.equal(parseDeployResult({ status: 'ok', message: {} }), undefined);
});

test('parseDeployResult caps an over-long message at 500 characters', () => {
  const long = 'x'.repeat(600);
  const result = parseDeployResult({ status: 'failed', message: long });
  assert.equal(result?.message?.length, 500);
  assert.equal(result?.message, 'x'.repeat(500));
});

test('parseDeployResult leaves a message within the cap untouched', () => {
  const result = parseDeployResult({ status: 'failed', message: 'short' });
  assert.equal(result?.message, 'short');
});

// ─────────────────────────────── deploySucceeded ────────────────────────────

test('deploySucceeded is true only for a clean ok', () => {
  assert.equal(deploySucceeded({ status: 'ok' }), true);
});

test('deploySucceeded is false for every other validated status', () => {
  for (const status of ['failed', 'aborted', 'busy', 'error'] as const) {
    assert.equal(deploySucceeded({ status }), false);
  }
});

test('deploySucceeded is false for undefined (a throw or a malformed reply)', () => {
  assert.equal(deploySucceeded(undefined), false);
});

// ─────────────────────────────── deployAborted ──────────────────────────────

test('deployAborted is true only for aborted', () => {
  assert.equal(deployAborted({ status: 'aborted' }), true);
});

test('deployAborted is false for ok and for every other failure status', () => {
  for (const status of ['ok', 'failed', 'busy', 'error'] as const) {
    assert.equal(deployAborted({ status }), false);
  }
});

test('deployAborted is false for undefined (a throw or a malformed reply) — those still toast', () => {
  assert.equal(deployAborted(undefined), false);
});

// ─────────────────────────────── toRunTestsForResult ────────────────────────

function baseRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    label: '2 tests on acme-dev',
    orgUsername: 'alice@example.com',
    orgAlias: 'acme-dev',
    startedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
    finishedAt: Date.UTC(2026, 9, 1, 12, 0, 30),
    status: 'passed',
    withCoverage: true,
    ...over,
  };
}

test('toRunTestsForResult: a never-started run with busy reports busy, not cancelled', () => {
  const result = toRunTestsForResult(
    { record: undefined, ranSelectors: [], busy: true },
    ['AccountServiceTest'],
  );
  assert.equal(result.status, 'busy');
  assert.equal(result.testClasses.length, 1);
  assert.ok(result.message);
});

test('toRunTestsForResult: a never-started run without busy (declined/dismissed/skipped-to-empty) reports cancelled', () => {
  const result = toRunTestsForResult(
    { record: undefined, ranSelectors: [], busy: false },
    ['AccountServiceTest'],
  );
  assert.equal(result.status, 'cancelled');
});

test('toRunTestsForResult: a never-started run reports the pre-modal testClasses', () => {
  const result = toRunTestsForResult(
    { record: undefined, ranSelectors: ['Irrelevant'], busy: false },
    ['AccountServiceTest', 'InvoiceCalculatorTest'],
  );
  assert.deepEqual(result.testClasses, ['AccountServiceTest', 'InvoiceCalculatorTest']);
});

test('toRunTestsForResult: a finished run reports the selectors it actually ran, not the pre-modal list', () => {
  const result = toRunTestsForResult(
    { record: baseRecord(), ranSelectors: ['AccountServiceTest'], busy: false },
    ['AccountServiceTest', 'InvoiceCalculatorTest'],
  );
  assert.deepEqual(result.testClasses, ['AccountServiceTest']);
});

test('toRunTestsForResult: passed/failed/cancelled/error statuses and counts pass through from the summary', () => {
  const passed = toRunTestsForResult(
    {
      record: baseRecord({
        status: 'passed',
        summary: {
          asyncApexJobId: '707xx1',
          status: 'Completed',
          testsRan: 2,
          passing: 2,
          failing: 0,
          skipped: 0,
          testTotalTime: 100,
          results: [],
        },
      }),
      ranSelectors: ['AccountServiceTest'],
      busy: false,
    },
    ['AccountServiceTest'],
  );
  assert.equal(passed.status, 'passed');
  assert.equal(passed.passed, 2);
  assert.equal(passed.failed, 0);
  assert.equal(passed.orgAlias, 'acme-dev');
});

test('toRunTestsForResult: no summary at all (an error before results came back) reports 0/0', () => {
  const result = toRunTestsForResult(
    { record: baseRecord({ status: 'error', error: 'boom' }), ranSelectors: ['AccountServiceTest'], busy: false },
    ['AccountServiceTest'],
  );
  assert.equal(result.status, 'error');
  assert.equal(result.passed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.message, 'boom');
});

test('toRunTestsForResult: a record somehow still "running" folds to error rather than claim a status it is not', () => {
  const result = toRunTestsForResult(
    { record: baseRecord({ status: 'running' }), ranSelectors: ['AccountServiceTest'], busy: false },
    ['AccountServiceTest'],
  );
  assert.equal(result.status, 'error');
});
