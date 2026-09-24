import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, readFileSync } from 'fs';
import { SfCliError } from '../kit/sfCli';

// The service imports `vscode` for its command-log emitter and settings; the
// coverage-envelope logic under test touches neither, so a minimal stub is
// enough to load the module outside the extension host.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]): unknown {
  if (request !== 'vscode') return realLoad.call(this, request, ...rest);
  return {
    EventEmitter: class {
      event = (): void => {};
      fire = (): void => {};
      dispose = (): void => {};
    },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  };
};

let mod: typeof import('./sfCliService');
let kitOrgs: typeof import('../kit/orgs');
before(async () => {
  mod = await import('./sfCliService');
  kitOrgs = await import('../kit/orgs');
});

/** A service whose kit call returns `envelope` instead of spawning `sf`. */
function withEnvelope(envelope: unknown): InstanceType<typeof mod.SfCliService> {
  const svc = new mod.SfCliService({ appendLine: () => {} } as any);
  (svc as any).kit = { runJson: async (): Promise<unknown> => envelope };
  return svc;
}

/** A service whose kit calls are answered by `respond(args)`, recording every
 *  argv: building the right command line is half of what these methods do. */
function withCalls(respond: (args: string[]) => unknown): {
  svc: InstanceType<typeof mod.SfCliService>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const svc = new mod.SfCliService({ appendLine: () => {} } as any);
  (svc as any).kit = {
    runJson: async (args: string[]): Promise<unknown> => {
      calls.push(args);
      return respond(args);
    },
  };
  return { svc, calls };
}

/** Shape of a real 18-character async job id. */
const RUN_ID = '707000000000001AAA';

test('getCoverageForClass maps a coverage row', async () => {
  const info = await withEnvelope({
    status: 0,
    result: {
      records: [
        {
          ApexClassOrTrigger: { Name: 'AccountService' },
          NumLinesCovered: 3,
          NumLinesUncovered: 1,
          Coverage: { coveredLines: [1, 2, 3], uncoveredLines: [4] },
        },
      ],
    },
  }).getCoverageForClass('AccountService', 'u@example.com');
  assert.equal(info?.className, 'AccountService');
  assert.equal(info?.numLinesCovered, 3);
  assert.deepEqual(info?.uncoveredLines, [4]);
});

test('getCoverageForClass returns null only for a genuinely empty record set', async () => {
  const info = await withEnvelope({ status: 0, result: { records: [] } }).getCoverageForClass(
    'AccountService',
    'u@example.com',
  );
  assert.equal(info, null);
});

test('getCoverageForClass throws the CLI envelope error instead of returning null', async () => {
  const err = await withEnvelope({
    status: 1,
    name: 'RefreshTokenAuthError',
    message: 'expired access/refresh token',
  })
    .getCoverageForClass('AccountService', 'u@example.com')
    .then(() => null, (e: unknown) => e as SfCliError);
  assert.ok(err instanceof SfCliError);
  assert.equal(err!.message, 'RefreshTokenAuthError: expired access/refresh token');
  assert.equal(err!.errorName, 'RefreshTokenAuthError');
});

test('listOrgs keeps the fields the org badge classifies on', async () => {
  const svc = new mod.SfCliService({ appendLine: () => {} } as any);
  (svc as any).kit = {
    listOrgs: async (): Promise<unknown[]> => [
      {
        username: 'dev@example.com',
        alias: 'DevOrg',
        instanceUrl: 'https://dev.my.salesforce.com',
        orgEdition: 'Developer Edition',
      },
    ],
  };
  const [org] = await svc.listOrgs();
  assert.equal(org.orgEdition, 'Developer Edition');
  assert.equal(kitOrgs.orgBadge(org), 'DEV');
  assert.equal(kitOrgs.isLikelyProduction(org), false);
});

test('a class name that is not an Apex identifier never reaches a SOQL string', async () => {
  const { svc, calls } = withCalls(() => ({ status: 0, result: { records: [] } }));
  await assert.rejects(
    () => svc.getCoverageForClass("Account' OR Name != '", 'u@example.com'),
    /invalid class name/,
  );
  assert.equal(calls.length, 0);
});

test('getCoverageForClass throws when the query result carries no records array', async () => {
  await assert.rejects(
    () => withEnvelope({ status: 0, result: {} }).getCoverageForClass('X', 'u@example.com'),
    /returned no result/,
  );
});

test('listRecentTestRuns throws the CLI envelope error instead of returning []', async () => {
  await assert.rejects(
    withEnvelope({ status: 1, name: 'RefreshTokenAuthError', message: 'expired access/refresh token' })
      .listRecentTestRuns('u@example.com'),
    (err: unknown) => {
      assert.ok(err instanceof SfCliError);
      assert.match((err as Error).message, /expired access\/refresh token/);
      return true;
    },
  );
});

// `getTestRun` throws when the envelope carries no `result`. Failing tests must
// NOT trip it — the fetch reports exit 100 for a run whose tests failed while
// still emitting a complete result, verified live against an org.
test('a run whose tests failed is a result, not an error, despite status 100', async () => {
  const { summary } = await withEnvelope({
    status: 100,
    result: {
      summary: { outcome: 'Failed', testsRan: 2, passing: 1, failing: 1, testTotalTime: '38 ms' },
      tests: [
        { ApexClass: { Name: 'SfProbeTest' }, MethodName: 'testPass', Outcome: 'Pass', RunTime: 4 },
        {
          ApexClass: { Name: 'SfProbeTest' },
          MethodName: 'testFail',
          Outcome: 'Fail',
          RunTime: 34,
          Message: 'Assertion Failed',
          StackTrace: 'Class.SfProbeTest.testFail: line 10, column 1',
        },
      ],
    },
  }).getTestRun(RUN_ID, 'u@example.com');

  assert.equal(summary.testsRan, 2);
  assert.equal(summary.failing, 1);
  assert.equal(summary.results[1].outcome, 'Fail');
});

test('a success envelope without a status field still counts as a run', async () => {
  // A plain run (no --code-coverage) comes back as `{ result }` with no `status`.
  const { summary } = await withEnvelope({
    result: {
      summary: { outcome: 'Passed', testsRan: 1, passing: 1, failing: 0, testTotalTime: '4 ms' },
      tests: [{ ApexClass: { Name: 'SfProbeTest' }, MethodName: 'testPass', Outcome: 'Pass' }],
    },
  }).getTestRun(RUN_ID, 'u@example.com');

  assert.equal(summary.passing, 1);
});

test('an envelope with no result at all is reported as the CLI failure it is', async () => {
  await assert.rejects(
    () =>
      withEnvelope({
        status: 1,
        name: 'INVALID_INPUT',
        message: "This class name's value is invalid: NoSuchClass.",
      }).runTestSelection(['NoSuchClass'], 'u@example.com'),
    (err: unknown) =>
      err instanceof SfCliError && /INVALID_INPUT.*value is invalid/.test((err as Error).message),
  );
});

// ───────────────────────── async run: start, poll, abort ────────────────────

test('runTestSelection starts the run and returns the id the org queued it as', async () => {
  const { svc, calls } = withCalls(() => ({ status: 0, result: { testRunId: RUN_ID } }));
  const started = await svc.runTestSelection(['AcmeTest', 'AcmeTest.testOne'], 'u@example.com');

  assert.equal(started.testRunId, RUN_ID);
  assert.match(calls[0].join(' '), /apex run test --tests AcmeTest --tests AcmeTest\.testOne/);
  // No --wait is the whole point: the CLI must hand the run back immediately.
  assert.ok(!calls[0].includes('--wait'));
  assert.ok(calls[0].includes('--json'));
  assert.ok(!calls[0].includes('--code-coverage'));
});

test('a coverage run asks for coverage at START time, not at fetch time', async () => {
  const { svc, calls } = withCalls(() => ({ result: { testRunId: RUN_ID } }));
  await svc.runAllLocalTests('u@example.com', { coverage: true });

  assert.ok(calls[0].includes('--code-coverage'));
  assert.deepEqual(calls[0].slice(3, 5), ['--test-level', 'RunLocalTests']);
});

test('runAllTestsInOrg asks for the managed-package-inclusive level', async () => {
  const { svc, calls } = withCalls(() => ({ result: { testRunId: RUN_ID } }));
  await svc.runAllTestsInOrg('u@example.com');

  assert.deepEqual(calls[0].slice(3, 5), ['--test-level', 'RunAllTestsInOrg']);
});

test('a start that produced no run id is the CLI failure it is', async () => {
  // Word for word what an org with no test classes answers (checked 2026-09-17).
  await assert.rejects(
    () =>
      withEnvelope({
        status: 1,
        name: 'INVALID_INPUT',
        message: 'No tests found for category: Apex',
      }).runAllLocalTests('u@example.com'),
    (err: unknown) =>
      err instanceof SfCliError && /No tests found for category/.test((err as Error).message),
  );
});

test('getTestRunStatus maps the run row the org writes', async () => {
  const { svc, calls } = withCalls(() => ({
    status: 0,
    result: {
      records: [
        {
          Status: 'Processing',
          MethodsEnqueued: 7,
          MethodsCompleted: 3,
          MethodsFailed: 1,
          StartTime: '2026-09-17T07:13:48.000+0000',
        },
      ],
    },
  }));
  const status = await svc.getTestRunStatus(RUN_ID, 'u@example.com');

  assert.deepEqual(status, { status: 'Processing', enqueued: 7, completed: 3, failed: 1 });
  assert.ok(calls[0].includes('--use-tooling-api'));
});

test('getTestRunStatus returns null while the org has not written the row yet', async () => {
  const { svc } = withCalls(() => ({ status: 0, result: { records: [] } }));
  assert.equal(await svc.getTestRunStatus(RUN_ID, 'u@example.com'), null);
});

test('an id that is not a Salesforce id never reaches a SOQL string', async () => {
  const { svc, calls } = withCalls(() => ({ status: 0, result: { records: [] } }));
  await assert.rejects(
    () => svc.getTestRunStatus("707' OR Id != '", 'u@example.com'),
    /invalid test run id/,
  );
  await assert.rejects(() => svc.getLiveResults('707', 'u@example.com'), /invalid test run id/);
  await assert.rejects(() => svc.abortTestRun('707', 'u@example.com'), /invalid test run id/);
  assert.equal(calls.length, 0);
});

test('getLiveResults maps rows, falling back to the stack frame when the class is gone', async () => {
  // ApexClass comes back null for a class deleted after the run — seen live.
  const { svc } = withCalls(() => ({
    status: 0,
    result: {
      records: [
        { ApexClass: { Name: 'AcmeTest' }, MethodName: 'testOne', Outcome: 'Pass', RunTime: 4 },
        {
          ApexClass: null,
          MethodName: 'testTwo',
          Outcome: 'Fail',
          RunTime: 34,
          Message: 'Assertion Failed',
          StackTrace: 'Class.AcmeTest.testTwo: line 9, column 1',
        },
      ],
    },
  }));
  const results = await svc.getLiveResults(RUN_ID, 'u@example.com');

  assert.deepEqual(
    results.map((r) => `${r.className}.${r.methodName}:${r.outcome}`),
    ['AcmeTest.testOne:Pass', 'AcmeTest.testTwo:Fail'],
  );
  assert.equal(results[1].runTime, 34);
  assert.equal(results[0].message, null);
});

test('abortTestRun patches only what can still be stopped, 200 rows per request', async () => {
  const queued = Array.from({ length: 250 }, (_, i) => ({
    Id: `709${String(i).padStart(12, '0')}AAA`,
    Status: i % 2 === 0 ? 'Queued' : 'Holding',
  }));
  const finished = { Id: '709999999999999AAA', Status: 'Completed' };
  const bodies: { file: string; body: any }[] = [];
  const { svc, calls } = withCalls((args) => {
    if (args[0] === 'data') return { status: 0, result: { records: [...queued, finished] } };
    const file = args[args.indexOf('--body') + 1].slice(1);
    const body = JSON.parse(readFileSync(file, 'utf8'));
    bodies.push({ file, body });
    return body.records.map((r: any) => ({ id: r.Id, success: true, errors: [] }));
  });

  assert.equal(await svc.abortTestRun(RUN_ID, 'u@example.com'), 250);
  assert.equal(bodies.length, 2, 'one composite request per 200 records');
  assert.equal(bodies[0].body.records.length, 200);
  assert.equal(bodies[1].body.records.length, 50);
  assert.equal(bodies[0].body.allOrNone, false);
  assert.deepEqual(bodies[0].body.records[0], {
    attributes: { type: 'ApexTestQueueItem' },
    Id: queued[0].Id,
    Status: 'Aborted',
  });
  // A row the org has already finished is not ours to touch.
  assert.ok(!JSON.stringify(bodies).includes(finished.Id));
  // Standard collections API: the Tooling API has no composite/sobjects.
  assert.ok(!calls[0].includes('--use-tooling-api'));
  assert.ok(calls[1].includes('/services/data/v62.0/composite/sobjects'));
  assert.deepEqual(calls[1].slice(4, 8), [
    '--target-org',
    'u@example.com',
    '--method',
    'PATCH',
  ]);
  // The request bodies do not outlive the call that wrote them.
  assert.ok(!existsSync(bodies[0].file));
});

test('abortTestRun surfaces a refused composite request instead of counting zero', async () => {
  const { svc } = withCalls((args) =>
    args[0] === 'data'
      ? { status: 0, result: { records: [{ Id: '709000000000001AAA', Status: 'Processing' }] } }
      : [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }],
  );
  await assert.rejects(() => svc.abortTestRun(RUN_ID, 'u@example.com'), /NOT_FOUND/);
});

test('abortTestRun sends nothing when the queue has already drained', async () => {
  const { svc, calls } = withCalls(() => ({
    status: 0,
    result: { records: [{ Id: '709000000000001AAA', Status: 'Completed' }] },
  }));
  assert.equal(await svc.abortTestRun(RUN_ID, 'u@example.com'), 0);
  assert.equal(calls.length, 1, 'the query, and no PATCH at all');
});

// ─────────────────────────── debug logs ───────────────────────────

const USER_ID = '005000000000001AAA';
const FLAG_ID = '7tf000000000001AAA';
const LEVEL_ID = '7dl000000000001AAA';
const LOG_ID = '07L000000000001AAA';
const HOUR = 60 * 60 * 1000;

/** Answer the queries `ensureDebugLogging` makes, in order, from a script. */
function debugOrg(over: {
  flags?: unknown[];
  level?: boolean;
  levelApexCode?: string;
  created?: string;
}): ReturnType<typeof withCalls> {
  return withCalls((args) => {
    const q = args[args.indexOf('--query') + 1] ?? '';
    if (q.startsWith('SELECT Id FROM User')) return { status: 0, result: { records: [{ Id: USER_ID }] } };
    if (q.includes('FROM TraceFlag')) return { status: 0, result: { records: over.flags ?? [] } };
    if (q.includes('FROM DebugLevel')) {
      const row = { Id: LEVEL_ID, ApexCode: over.levelApexCode ?? 'DEBUG' };
      return { status: 0, result: { records: over.level === false ? [] : [row] } };
    }
    if (args[1] === 'create' || args[1] === 'update') {
      return { status: 0, result: { id: over.created ?? LEVEL_ID, success: true } };
    }
    throw new Error(`unexpected call ${args.join(' ')}`);
  });
}

const writes = (calls: string[][]): string[][] => calls.filter((a) => a[0] === 'data' && a[2] === 'record');

test('ensureDebugLogging creates level and flag for a user with none, scoped to that user', async () => {
  const { svc, calls } = debugOrg({ flags: [], level: false, created: LEVEL_ID });
  const out = await svc.ensureDebugLogging('u@example.com', HOUR);
  assert.deepEqual(out, { note: 'trace flag created', relevelled: false });
  const w = writes(calls);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0].slice(0, 6), ['data', 'create', 'record', '--use-tooling-api', '-s', 'DebugLevel']);
  assert.match(w[0][7], /^DeveloperName=SfTestRunner MasterLabel=SfTestRunner ApexCode=DEBUG /);
  assert.deepEqual(w[1].slice(0, 6), ['data', 'create', 'record', '--use-tooling-api', '-s', 'TraceFlag']);
  assert.match(w[1][7], new RegExp(`^TracedEntityId=${USER_ID} DebugLevelId=${LEVEL_ID} LogType=USER_DEBUG StartDate=\\S+ ExpirationDate=\\S+$`));
  const flagQuery = calls.find((a) => (a[a.indexOf('--query') + 1] ?? '').includes('FROM TraceFlag'))!;
  assert.match(flagQuery[flagQuery.indexOf('--query') + 1], /TracedEntityId = '005000000000001AAA' AND LogType = 'USER_DEBUG' ORDER BY ExpirationDate DESC NULLS LAST LIMIT 1$/);
});

test('ensureDebugLogging leaves an active flag on a DEBUG-or-higher level alone', async () => {
  const flags = [{ Id: FLAG_ID, ExpirationDate: new Date(Date.now() + 3 * HOUR).toISOString(), DebugLevel: { ApexCode: 'FINEST' } }];
  const { svc, calls } = debugOrg({ flags });
  assert.deepEqual(await svc.ensureDebugLogging('u@example.com', HOUR), { note: 'trace flag already active', relevelled: false });
  assert.equal(writes(calls).length, 0);
});

test('ensureDebugLogging extends an expired flag in place and repoints a too-low level', async () => {
  const flags = [{ Id: FLAG_ID, ExpirationDate: '2025-07-29T22:29:00.000+0000', DebugLevel: { ApexCode: 'INFO' } }];
  const { svc, calls } = debugOrg({ flags });
  const out = await svc.ensureDebugLogging('u@example.com', HOUR);
  assert.equal(out.relevelled, true);
  assert.match(out.note, /^trace flag extended, now logging Apex at DEBUG$/);
  const w = writes(calls);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].slice(0, 8), ['data', 'update', 'record', '--use-tooling-api', '-s', 'TraceFlag', '-i', FLAG_ID]);
  assert.match(w[0][9], new RegExp(`^StartDate=\\S+ ExpirationDate=\\S+ DebugLevelId=${LEVEL_ID}$`));
});

test('ensureDebugLogging never asks the org for a window past its 24 h limit', async () => {
  const { svc, calls } = debugOrg({ flags: [], created: LEVEL_ID });
  await svc.ensureDebugLogging('u@example.com', 72 * HOUR);
  const values = writes(calls)[0][7];
  const start = Date.parse(/StartDate=(\S+)/.exec(values)![1]);
  const end = Date.parse(/ExpirationDate=(\S+)/.exec(values)![1]);
  assert.ok(end - start < 24 * HOUR, `window was ${(end - start) / HOUR} h`);
});

test('ensureDebugLogging escapes the username in the User lookup', async () => {
  const { svc, calls } = debugOrg({ flags: [{ Id: FLAG_ID, ExpirationDate: new Date(Date.now() + 3 * HOUR).toISOString(), DebugLevel: { ApexCode: 'DEBUG' } }] });
  await svc.ensureDebugLogging("o'brien@example.com", HOUR);
  assert.equal(calls[0][calls[0].indexOf('--query') + 1], "SELECT Id FROM User WHERE Username = 'o\\'brien@example.com'");
  assert.ok(!calls[0].includes('--use-tooling-api'), 'User is a standard object');
});

test('ensureDebugLogging refuses an id the org returned that is not a Salesforce id', async () => {
  const { svc } = debugOrg({ flags: [], level: false, created: 'nope' });
  await assert.rejects(() => svc.ensureDebugLogging('u@example.com', HOUR), SfCliError);
});

test('getLogIds keys log ids by Cls.method and drops rows whose id is not one', async () => {
  const { svc, calls } = withCalls(() => ({
    status: 0,
    result: {
      records: [
        { ApexClass: { Name: 'AcmeTest' }, MethodName: 'testA', ApexLogId: LOG_ID },
        { ApexClass: { Name: 'AcmeTest' }, MethodName: 'testB', ApexLogId: 'bogus id' },
      ],
    },
  }));
  const ids = await svc.getLogIds(RUN_ID, 'u@example.com');
  assert.deepEqual([...ids], [['AcmeTest.testA', LOG_ID]]);
  assert.match(calls[0][calls[0].indexOf('--query') + 1], /ApexLogId != null$/);
});

test('getApexLog reads the body from the wrapped and the bare envelope shapes', async () => {
  const wrapped = withCalls(() => ({ status: 0, result: [{ log: 'A|B' }] }));
  assert.equal(await wrapped.svc.getApexLog(LOG_ID, 'u@example.com'), 'A|B');
  assert.deepEqual(wrapped.calls[0].slice(0, 5), ['apex', 'get', 'log', '--log-id', LOG_ID]);
  const bare = withCalls(() => ({ status: 0, result: ['A|B'] }));
  assert.equal(await bare.svc.getApexLog(LOG_ID, 'u@example.com'), 'A|B');
  await assert.rejects(() => withCalls(() => ({ status: 0, result: [] })).svc.getApexLog(LOG_ID, 'u@example.com'), SfCliError);
  await assert.rejects(() => wrapped.svc.getApexLog('not an id', 'u@example.com'), SfCliError);
});

test('ensureDebugLogging restores the plugin level when someone edited it below DEBUG', async () => {
  const flags = [{ Id: FLAG_ID, ExpirationDate: '2025-07-29T22:29:00.000+0000', DebugLevel: { ApexCode: 'NONE' } }];
  const { svc, calls } = debugOrg({ flags, levelApexCode: 'NONE' });
  await svc.ensureDebugLogging('u@example.com', HOUR);
  const w = writes(calls);
  assert.deepEqual(w[0].slice(0, 10), ['data', 'update', 'record', '--use-tooling-api', '-s', 'DebugLevel', '-i', LEVEL_ID, '-v', 'ApexCode=DEBUG']);
  assert.equal(w[1][5], 'TraceFlag');
});
