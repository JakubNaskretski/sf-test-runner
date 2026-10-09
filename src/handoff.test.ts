import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapTestResult } from './salesforce/resultMapping';
import type { RunRecord, TestMethodResult } from './types';
import type { HandoffResolution } from './ui/activeFileTests';
import {
  contributesCommand,
  decideAfterDeploy,
  deployAborted,
  deploySucceeded,
  explainHandoff,
  handoffCapMessage,
  handoffKey,
  joinNotes,
  MAX_HANDOFF_MESSAGE,
  parseDeployResult,
  parseHandoffArgs,
  parseTargetOrgShape,
  shouldSwitchPicker,
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

// ───────────────────────────────── parseTargetOrgShape ──────────────────────

test('parseTargetOrgShape accepts a well-formed targetOrg', () => {
  const result = parseTargetOrgShape({ targetOrg: 'alice@example.com' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : undefined, { targetOrg: 'alice@example.com' });
});

test('parseTargetOrgShape rejects the same shapes parseHandoffShape rejects for targetOrg', () => {
  for (const raw of [
    undefined,
    null,
    'alice@example.com',
    { targetOrg: '' },
    { targetOrg: '   ' },
    { targetOrg: undefined },
    { targetOrg: 7 },
    { targetOrg: '-alice@example.com' },
    {},
  ]) {
    assert.equal(parseTargetOrgShape(raw).ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
  }
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

test('toRunTestsForResult: a never-started run with an error message reports error, even if busy is also set', () => {
  // error (the too-many-classes refusal) is the only outcome that can carry
  // its own message, so it must win over busy when something sets both.
  const result = toRunTestsForResult(
    { record: undefined, ranSelectors: [], busy: true, error: 'too many classes' },
    ['AccountServiceTest'],
  );
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'too many classes');
});

// ─────────────────────────────── handoffCapMessage ──────────────────────────

test('handoffCapMessage is undefined at or under the cap', () => {
  assert.equal(handoffCapMessage(100, 100), undefined);
  assert.equal(handoffCapMessage(1, 100), undefined);
});

test('handoffCapMessage reports the count and the cap once over it', () => {
  const message = handoffCapMessage(101, 100);
  assert.ok(message);
  assert.match(message, /101/);
  assert.match(message, /100/);
  assert.match(message, /handoff/);
});

// ─────────────────────────────── contributesCommand ─────────────────────────

test('contributesCommand is true when the manifest lists the command', () => {
  const packageJSON = {
    contributes: {
      commands: [
        { command: 'sfOrgDeployWrapper.deploy', title: 'Deploy' },
        { command: 'sfOrgDeployWrapper.deployComponents', title: 'Deploy Components' },
      ],
    },
  };
  assert.equal(contributesCommand(packageJSON, 'sfOrgDeployWrapper.deployComponents'), true);
});

test('contributesCommand is false when the manifest lists other commands but not this one', () => {
  const packageJSON = {
    contributes: { commands: [{ command: 'sfOrgDeployWrapper.deploy' }] },
  };
  assert.equal(contributesCommand(packageJSON, 'sfOrgDeployWrapper.deployComponents'), false);
});

test('contributesCommand is false with no contributes section at all (an older manifest)', () => {
  assert.equal(contributesCommand({ name: 'sf-org-deploy-wrapper' }, 'sfOrgDeployWrapper.deployComponents'), false);
});

test('contributesCommand is false when contributes has no commands array', () => {
  assert.equal(contributesCommand({ contributes: {} }, 'sfOrgDeployWrapper.deployComponents'), false);
  assert.equal(
    contributesCommand({ contributes: { commands: 'not-an-array' } }, 'sfOrgDeployWrapper.deployComponents'),
    false,
  );
});

test('contributesCommand tolerates a malformed packageJSON', () => {
  assert.equal(contributesCommand(undefined, 'x'), false);
  assert.equal(contributesCommand(null, 'x'), false);
  assert.equal(contributesCommand('not an object', 'x'), false);
  assert.equal(
    contributesCommand({ contributes: { commands: [null, 42, 'x', {}] } }, 'x'),
    false,
  );
});

// ─────────────────────────────── decideAfterDeploy ──────────────────────────

const DEV = { username: 'dev@example.com' };
const QA = { username: 'qa@example.com' };

test('decideAfterDeploy: ok + fromHandoff always runs, even if "current" differs from the deployed-to org', () => {
  assert.equal(decideAfterDeploy({ status: 'ok' }, true, DEV, QA), 'run');
  assert.equal(decideAfterDeploy({ status: 'ok' }, true, DEV, undefined), 'run');
  assert.equal(decideAfterDeploy({ status: 'ok' }, true, DEV, DEV), 'run');
});

test('decideAfterDeploy: ok + not fromHandoff + the picker never moved runs', () => {
  assert.equal(decideAfterDeploy({ status: 'ok' }, false, DEV, DEV), 'run');
});

test('decideAfterDeploy: ok + not fromHandoff + the picker moved asks', () => {
  assert.equal(decideAfterDeploy({ status: 'ok' }, false, DEV, QA), 'confirmMoved');
});

test('decideAfterDeploy: ok + not fromHandoff + no picker org at all asks (cleared counts as moved)', () => {
  assert.equal(decideAfterDeploy({ status: 'ok' }, false, DEV, undefined), 'confirmMoved');
});

test('decideAfterDeploy: aborted always stops silently, regardless of fromHandoff or the org', () => {
  assert.equal(decideAfterDeploy({ status: 'aborted' }, true, DEV, QA), 'stopSilent');
  assert.equal(decideAfterDeploy({ status: 'aborted' }, false, DEV, DEV), 'stopSilent');
});

test('decideAfterDeploy: failed/busy/error and a malformed/thrown (undefined) reply all stop with a message', () => {
  for (const status of ['failed', 'busy', 'error'] as const) {
    assert.equal(decideAfterDeploy({ status }, false, DEV, DEV), 'stopWithMessage');
    assert.equal(decideAfterDeploy({ status }, true, DEV, DEV), 'stopWithMessage');
  }
  assert.equal(decideAfterDeploy(undefined, false, DEV, DEV), 'stopWithMessage');
  assert.equal(decideAfterDeploy(undefined, true, DEV, DEV), 'stopWithMessage');
});

// ─────────────────────────────── shouldSwitchPicker ─────────────────────────

test('shouldSwitchPicker: false when the picker already shows the target org', () => {
  assert.equal(shouldSwitchPicker(DEV, DEV), false);
  assert.equal(shouldSwitchPicker({ username: 'dev@example.com' }, DEV), false);
});

test('shouldSwitchPicker: usernames compare case-insensitively, like every other org match', () => {
  assert.equal(shouldSwitchPicker({ username: 'DEV@EXAMPLE.com' }, DEV), false);
});

test('shouldSwitchPicker: true when the picker shows a different org', () => {
  assert.equal(shouldSwitchPicker(DEV, QA), true);
});

test('shouldSwitchPicker: true when the picker has no org at all yet', () => {
  assert.equal(shouldSwitchPicker(undefined, DEV), true);
});

// ──────────────────────────────── explainHandoff ────────────────────────────────

const NO_TESTS = { status: 'noTests' as const, testClasses: [], passed: 0, failed: 0 };

function finished(results: Pick<TestMethodResult, 'className' | 'outcome'>[], over: Partial<RunRecord> = {}): RunRecord {
  const full = results.map((r) => ({ methodName: 't', runTime: 1, message: null, stackTrace: null, ...r }));
  const failing = full.filter((r) => r.outcome !== 'Pass').length;
  return baseRecord({
    status: full.length === 0 ? 'error' : failing > 0 ? 'failed' : 'passed',
    ...(full.length === 0 ? { error: 'This run reported no test results.' } : {}),
    summary: {
      asyncApexJobId: '707xx1',
      status: 'Completed',
      testsRan: full.length,
      passing: full.length - failing,
      failing,
      skipped: 0,
      testTotalTime: 10,
      results: full,
    },
    ...over,
  });
}

const ANNOTATED_ONLY: HandoffResolution = {
  testClasses: ['AcmeHelper'],
  matches: [{ name: 'AcmeHelper', own: 'annotated', testClasses: ['AcmeHelper'] }],
};

test('explainHandoff: nothing matched says what was checked, per class, with the org in front', () => {
  const resolution: HandoffResolution = {
    testClasses: [],
    matches: [{ name: 'AcmeHelper', testClasses: [] }],
  };
  const result = explainHandoff({ ...NO_TESTS, orgAlias: 'acme-dev' }, resolution);
  assert.equal(result.status, 'noTests');
  assert.equal(
    result.message,
    'Tests on acme-dev: no matching test class. AcmeHelper: not a test class; no @IsTest(testFor) names it; ' +
      'no test class named AcmeHelperTest/TestAcmeHelper/AcmeHelper_Test/AcmeHelperTests',
  );
  // No org known: the sentence still stands on its own.
  assert.match(explainHandoff(NO_TESTS, resolution).message ?? '', /^No matching test class\. AcmeHelper: /);
});

test('explainHandoff: an @IsTest class the org found empty reads as noTests, in plain words', () => {
  const run = toRunTestsForResult({ record: finished([]), ranSelectors: ['AcmeHelper'], busy: false }, ['AcmeHelper']);
  assert.equal(run.status, 'error');
  const result = explainHandoff(run, ANNOTATED_ONLY, finished([]));
  assert.equal(result.status, 'noTests');
  assert.equal(
    result.message,
    'Tests on acme-dev: no test methods ran. AcmeHelper: @isTest, but the org found no test methods in it',
  );
  assert.deepEqual(result.testClasses, ['AcmeHelper']);
});

test("explainHandoff: the org's Skipped / 0-ran answer for an @IsTest class maps to the note, not an error", () => {
  // `sf apex get test` for a run of only an @IsTest class without test
  // methods, as the org answers it: outcome Skipped, nothing ran, no tests.
  const summary = mapTestResult({
    summary: {
      outcome: 'Skipped',
      testsRan: 0,
      passing: 0,
      failing: 0,
      skipped: 0,
      passRate: '0%',
      failRate: '0%',
      testRunId: '707000000000001',
      testTotalTime: '0 ms',
      testExecutionTime: '0 ms',
    },
    tests: [],
  });
  assert.equal(summary.results.length, 0);
  // What the runner records for a run that reported nothing (verdictOf).
  const record = baseRecord({ status: 'error', error: 'This run reported no test results.', summary });
  const run = toRunTestsForResult({ record, ranSelectors: ['AcmeHelper'], busy: false }, ['AcmeHelper']);
  const result = explainHandoff(run, ANNOTATED_ONLY, record);
  assert.equal(result.status, 'noTests');
  assert.match(result.message ?? '', /AcmeHelper: @isTest, but the org found no test methods in it$/);
  assert.doesNotMatch(result.message ?? '', /reported no test results/);
});

test('explainHandoff: an @IsTest class whose methods the org DID find needs no note', () => {
  const record = finished([{ className: 'AcmeHelper', outcome: 'Pass' }]);
  const run = toRunTestsForResult({ record, ranSelectors: ['AcmeHelper'], busy: false }, ['AcmeHelper']);
  assert.deepEqual(explainHandoff(run, ANNOTATED_ONLY, record), run);
});

test('explainHandoff: an empty @IsTest factory run beside its testFor test keeps the pass, with a note', () => {
  const resolution: HandoffResolution = {
    testClasses: ['AcmeHelper', 'AcmeDeclares'],
    matches: [
      { name: 'AcmeHelper', own: 'annotated', semantic: 'testFor', testClasses: ['AcmeHelper', 'AcmeDeclares'] },
    ],
  };
  const record = finished([{ className: 'AcmeDeclares', outcome: 'Pass' }]);
  const run = toRunTestsForResult(
    { record, ranSelectors: ['AcmeHelper', 'AcmeDeclares'], busy: false },
    ['AcmeHelper', 'AcmeDeclares'],
  );
  const result = explainHandoff(run, resolution, record);
  assert.equal(result.status, 'passed');
  assert.equal(result.passed, 1);
  assert.equal(result.message, 'AcmeHelper: @isTest, but the org found no test methods in it');
});

test('explainHandoff: a mixed run keeps its status and notes the empty @IsTest class and the unmatched one', () => {
  const resolution: HandoffResolution = {
    testClasses: ['AcmeHelper', 'AcmeOrderTest'],
    matches: [
      { name: 'AcmeHelper', own: 'annotated', testClasses: ['AcmeHelper'] },
      { name: 'AcmeOrder', semantic: 'naming', testClasses: ['AcmeOrderTest'] },
      { name: 'AcmeGhost', testClasses: [] },
    ],
  };
  const record = finished([{ className: 'AcmeOrderTest', outcome: 'Pass' }]);
  const run = toRunTestsForResult(
    { record, ranSelectors: ['AcmeHelper', 'AcmeOrderTest'], busy: false },
    ['AcmeHelper', 'AcmeOrderTest'],
  );
  const result = explainHandoff(run, resolution, record);
  assert.equal(result.status, 'passed');
  assert.match(result.message ?? '', /^AcmeHelper: @isTest, but the org found no test methods in it\. AcmeGhost: not a test class;/);
});

test('explainHandoff: a cancelled run claims nothing about what an @IsTest class holds', () => {
  const record = finished([], { status: 'cancelled', error: 'Run cancelled.' });
  const run = toRunTestsForResult({ record, ranSelectors: ['AcmeHelper'], busy: false }, ['AcmeHelper']);
  const result = explainHandoff(run, ANNOTATED_ONLY, record);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.message, 'Run cancelled.');
});

test('explainHandoff: a run cancelled before it started keeps the plain cancel, not a list of notes', () => {
  // A declined production confirm or a dismissed not-deployed modal: no
  // message of its own, so the deploy panel shows its "run cancelled" title.
  const resolution: HandoffResolution = {
    testClasses: ['AcmeOrderTest'],
    matches: [
      { name: 'AcmeOrder', semantic: 'naming', testClasses: ['AcmeOrderTest'] },
      { name: 'AcmeGhost', testClasses: [] },
    ],
  };
  const run = toRunTestsForResult({ record: undefined, ranSelectors: [], busy: false }, ['AcmeOrderTest']);
  const result = explainHandoff(run, resolution);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.message, undefined);
});

test('explainHandoff: a fully matched run gets no message of its own; busy keeps its sentence', () => {
  const resolution: HandoffResolution = {
    testClasses: ['AcmeOrderTest'],
    matches: [{ name: 'AcmeOrder', semantic: 'naming', testClasses: ['AcmeOrderTest'] }],
  };
  const record = finished([{ className: 'AcmeOrderTest', outcome: 'Pass' }]);
  const run = toRunTestsForResult({ record, ranSelectors: ['AcmeOrderTest'], busy: false }, ['AcmeOrderTest']);
  assert.deepEqual(explainHandoff(run, resolution, record), run);
  const busy = explainHandoff(
    toRunTestsForResult({ record: undefined, ranSelectors: [], busy: true }, resolution.testClasses),
    resolution,
  );
  assert.equal(busy.status, 'busy');
  assert.equal(busy.message, 'A test run is already in progress. Wait for it to finish.');
});

test('explainHandoff: many unmatched classes stay within the cap and say how many were left out', () => {
  const matches = Array.from({ length: 12 }, (_, i) => ({
    name: `AcmeUnmatchedService${i}`,
    testClasses: [],
  }));
  const result = explainHandoff(NO_TESTS, { testClasses: [], matches });
  assert.ok((result.message ?? '').length <= MAX_HANDOFF_MESSAGE);
  assert.match(result.message ?? '', /^No matching test class\. AcmeUnmatchedService0: /);
  assert.match(result.message ?? '', / … and \d+ more$/);
});

test('joinNotes: joins with a stop, keeps an existing stop, and cuts only between notes', () => {
  assert.equal(joinNotes(['a', 'b']), 'a. b');
  assert.equal(joinNotes(['Done.', 'b']), 'Done. b');
  assert.equal(joinNotes(['aaaaaa', 'bbbbbb', 'cccccc'], 20), 'aaaaaa … and 2 more');
  assert.equal(joinNotes(['x'.repeat(30)], 10), `${'x'.repeat(9)}…`);
  assert.equal(joinNotes([]), '');
});

test('a handoff is the same request for the same org and the same set of test classes', () => {
  const key = handoffKey('dev@acme.example', ['AcmeServiceTest', 'AcmeOtherTest']);
  assert.equal(handoffKey('Dev@Acme.example', ['acmeothertest', 'AcmeServiceTest']), key);
  assert.equal(
    handoffKey('dev@acme.example', ['AcmeOtherTest', 'AcmeServiceTest', 'AcmeOtherTest']),
    key,
  );
});

test('another org, or another set of test classes, is a different request', () => {
  const key = handoffKey('dev@acme.example', ['AcmeServiceTest', 'AcmeOtherTest']);
  assert.notEqual(handoffKey('qa@acme.example', ['AcmeServiceTest', 'AcmeOtherTest']), key);
  assert.notEqual(handoffKey('dev@acme.example', ['AcmeServiceTest']), key);
  assert.notEqual(
    handoffKey('dev@acme.example', ['AcmeServiceTest', 'AcmeOtherTest', 'AcmeThirdTest']),
    key,
  );
});

test('the caller\'s requestId is part of the request: same id same request, another id another', () => {
  const classes = ['AcmeServiceTest'];
  const key = handoffKey('dev@acme.example', classes, 'deploy-7');
  assert.equal(handoffKey('DEV@acme.example', classes, 'deploy-7'), key);
  assert.notEqual(handoffKey('dev@acme.example', classes, 'deploy-8'), key);
  assert.notEqual(handoffKey('dev@acme.example', classes), key, 'no id is not any id');
  assert.equal(handoffKey('dev@acme.example', classes), handoffKey('dev@acme.example', classes));
});

test('requestId is optional, and when present a short plain id', () => {
  const base = { classNames: ['AcmeService'], targetOrg: 'alice@example.com' };
  const plain = parseHandoffArgs(base, KNOWN);
  assert.equal(plain.ok, true);
  assert.equal(plain.ok && 'requestId' in plain.value, false);

  for (const requestId of ['0Af000000000001AAA', 'deploy-7_b', 'x'.repeat(64)]) {
    const result = parseHandoffArgs({ ...base, requestId }, KNOWN);
    assert.equal(result.ok && result.value.requestId, requestId, requestId);
  }
  for (const requestId of ['', 'x'.repeat(65), 'a b', '../x', 'a|b', 7, null, ['a']]) {
    const result = parseHandoffArgs({ ...base, requestId }, KNOWN);
    assert.equal(result.ok, false, String(requestId));
    assert.match(result.ok ? '' : result.message, /requestId/);
  }
});
