import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { RunTestsForResult } from '../handoff';
import type { OrgInfo } from '../types';

// The handoff's repeat-joins-the-run rule, driven through the real TestRunner
// and the real SfCliService with only the `sf` process faked: every argv the
// service would spawn is recorded and answered here, so "one run" is counted
// as one `sf apex run test`, the way the org would see it.

/** Every warning dialog shown, with the answer the test wants for it. */
let warnings: string[] = [];
let answerWarning: (message: string) => Promise<string | undefined> = async () => undefined;

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]): unknown {
  if (request !== 'vscode') return realLoad.call(this, request, ...rest);
  return {
    EventEmitter: class {
      event = (): { dispose: () => void } => ({ dispose: (): void => {} });
      fire = (): void => {};
      dispose = (): void => {};
    },
    CancellationTokenSource: class {
      token = {
        isCancellationRequested: false,
        onCancellationRequested: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      };
      cancel(): void {
        this.token.isCancellationRequested = true;
      }
      dispose(): void {}
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
        inspect: () => undefined,
      }),
      onDidChangeConfiguration: () => ({ dispose: (): void => {} }),
    },
    window: {
      showWarningMessage: async (message: string): Promise<string | undefined> => {
        warnings.push(message);
        return answerWarning(message);
      },
      showInformationMessage: async (): Promise<undefined> => undefined,
      showErrorMessage: async (): Promise<undefined> => undefined,
    },
    extensions: { getExtension: () => undefined },
  };
};

let runnerMod: typeof import('./testRunner');
let sfMod: typeof import('../salesforce/sfCliService');
let stateMod: typeof import('../ui/panelState');
let handoffMod: typeof import('../handoff');
before(async () => {
  runnerMod = await import('./testRunner');
  sfMod = await import('../salesforce/sfCliService');
  stateMod = await import('../ui/panelState');
  handoffMod = await import('../handoff');
});

const DEV: OrgInfo = {
  alias: 'acme-dev',
  username: 'dev@acme.example',
  instanceUrl: 'https://acme-dev.my.salesforce.com',
  isDefault: true,
  orgEdition: 'Developer Edition',
};
const QA: OrgInfo = {
  alias: 'acme-qa',
  username: 'qa@acme.example',
  instanceUrl: 'https://acme--qa.sandbox.my.salesforce.com',
  isDefault: false,
  isSandbox: true,
};
/** No edition, plain host: classified production, so a run asks first. */
const PROD: OrgInfo = {
  alias: 'acme-prod',
  username: 'prod@acme.example',
  instanceUrl: 'https://acme.my.salesforce.com',
  isDefault: false,
};

const RUN_ID = '707000000000001AAA';
const TEST_CLASS = 'AcmeServiceTest';

function memento(): import('vscode').Memento {
  const store = new Map<string, unknown>();
  return {
    keys: (): readonly string[] => [...store.keys()],
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
  } as unknown as import('vscode').Memento;
}

/** Let every pending callback run, without depending on how many there are. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), `timed out waiting for ${what}`);
}

/**
 * A runner over a fake `sf`. `mode: 'pass'` answers the run the way a passing
 * org does (start → status Completed → one passing method); `'fail'` makes the
 * start itself fail, which ends the run at once (no poll wait). Starts are
 * held until `release()` when `held` is set, so a test can act while the run
 * is in flight.
 */
function harness(opts: { mode: 'pass' | 'fail'; held?: boolean }) {
  const argvs: string[][] = [];
  const output: string[] = [];
  let release!: () => void;
  const gate = opts.held
    ? new Promise<void>((resolve) => (release = resolve))
    : Promise.resolve();

  const channel = {
    appendLine: (line: string): void => {
      output.push(line);
    },
    show: (): void => {},
  } as unknown as import('vscode').OutputChannel;

  const sfCli = new sfMod.SfCliService(channel);
  (sfCli as any).kit = {
    runJson: async (args: string[]): Promise<unknown> => {
      argvs.push(args);
      const line = args.join(' ');
      if (line.startsWith('apex run test')) {
        await gate;
        return opts.mode === 'pass'
          ? { status: 0, result: { testRunId: RUN_ID } }
          : { status: 1, name: 'NoTestsFound', message: 'No tests found for category: Apex' };
      }
      if (line.includes('FROM ApexTestRunResult')) {
        return {
          status: 0,
          result: {
            records: [
              { Status: 'Completed', MethodsEnqueued: 1, MethodsCompleted: 1, MethodsFailed: 0 },
            ],
          },
        };
      }
      if (line.includes('FROM ApexTestResult')) {
        return {
          status: 0,
          result: {
            records: [
              { ApexClass: { Name: TEST_CLASS }, MethodName: 'itWorks', Outcome: 'Pass', RunTime: 5 },
            ],
          },
        };
      }
      if (line.startsWith('apex get test')) {
        return {
          status: 0,
          result: {
            summary: {
              outcome: 'Passed',
              testsRan: 1,
              passing: 1,
              failing: 0,
              skipped: 0,
              testRunId: RUN_ID,
              testTotalTime: '5 ms',
            },
            tests: [
              { ApexClass: { Name: TEST_CLASS }, MethodName: 'itWorks', Outcome: 'Pass', RunTime: 5 },
            ],
          },
        };
      }
      throw new Error(`unexpected sf call: ${line}`);
    },
  };

  let picked: OrgInfo | undefined = DEV;
  const state = new stateMod.PanelState(memento());
  const runner = new runnerMod.TestRunner({
    sfCli,
    state,
    output: channel,
    getOrg: () => picked,
    resolver: {} as any,
    revealOutput: (): void => {},
    markDeployed: async (): Promise<void> => {},
    matchOrg: (org: OrgInfo): void => {
      picked = org;
    },
  });

  /** What `sfTestRunner.runTestsFor` does with a resolved request. */
  function handoff(
    org: OrgInfo,
    testClasses: string[],
    requestId?: string,
  ): Promise<RunTestsForResult> {
    return runner.handoff(
      { org, testClasses, requestId },
      async () =>
        handoffMod.toRunTestsForResult(await runner.runFor(testClasses, org), testClasses),
      () =>
        handoffMod.toRunTestsForResult(
          { record: undefined, ranSelectors: [], busy: true },
          testClasses,
        ),
    );
  }

  return {
    runner,
    handoff,
    output,
    release: (): void => release(),
    /** How many runs reached the org. */
    runStarts: (): number => argvs.filter((a) => a.join(' ').startsWith('apex run test')).length,
  };
}

/** A request joined onto the wrong run would hang the suite instead of failing it. */
const LIMIT = { timeout: 10_000 };

function resetDialogs(answer: (message: string) => Promise<string | undefined>): void {
  warnings = [];
  answerWarning = answer;
}

test('the same tests asked for twice share one run and one result object', LIMIT, async () => {
  resetDialogs(async () => undefined);
  const h = harness({ mode: 'pass', held: true });

  // Back to back, before the first has even reached the org…
  const first = h.handoff(DEV, [TEST_CLASS]);
  const early = h.handoff(DEV, [TEST_CLASS]);
  await until(() => h.runStarts() === 1, 'the first run to start');
  // …and once it is running there.
  const late = h.handoff(DEV, [TEST_CLASS]);
  h.release();
  const [a, b, c] = await Promise.all([first, early, late]);

  assert.equal(a.status, 'passed');
  assert.equal(a.passed, 1);
  assert.equal(b, a, 'the repeat gets the very result the first caller got');
  assert.equal(c, a);
  assert.equal(h.runStarts(), 1, 'one sf apex run test, not two');
  assert.ok(!h.runner.isRunning, 'the guard is released afterwards');
  assert.ok(
    h.output.some((l) => l.includes('joined the run already in progress')),
    'the join is logged',
  );
  assert.deepEqual(warnings, [], 'no "already in progress" warning');
});

test('a different set of test classes while a run is in flight is busy', LIMIT, async () => {
  resetDialogs(async () => undefined);
  const h = harness({ mode: 'fail', held: true });

  const first = h.handoff(DEV, [TEST_CLASS]);
  await until(() => h.runStarts() === 1, 'the first run to start');
  const second = h.handoff(DEV, [TEST_CLASS, 'AcmeOtherTest']);
  h.release();
  const [done, other] = await Promise.all([first, second]);

  assert.equal(other.status, 'busy');
  assert.notEqual(other, done);
  assert.equal(h.runStarts(), 1);
});

test('the same tests on a different org while a run is in flight is busy', LIMIT, async () => {
  resetDialogs(async () => undefined);
  const h = harness({ mode: 'fail', held: true });

  const first = h.handoff(DEV, [TEST_CLASS]);
  await until(() => h.runStarts() === 1, 'the first run to start');
  const second = h.handoff(QA, [TEST_CLASS]);
  h.release();
  const [done, other] = await Promise.all([first, second]);

  assert.equal(other.status, 'busy');
  assert.notEqual(other, done);
  assert.equal(h.runStarts(), 1);
});

test('asking again after the run finished starts a new run', LIMIT, async () => {
  resetDialogs(async () => undefined);
  const h = harness({ mode: 'fail' });

  const first = await h.handoff(DEV, [TEST_CLASS]);
  assert.ok(!h.runner.isRunning);
  const second = await h.handoff(DEV, [TEST_CLASS]);

  assert.notEqual(second, first, 'a retry gets its own result');
  assert.equal(h.runStarts(), 2, 'and its own run');
  assert.ok(!h.output.some((l) => l.includes('joined')));
});

test('the same requestId joins the run in progress', LIMIT, async () => {
  resetDialogs(async () => undefined);
  const h = harness({ mode: 'fail', held: true });

  const first = h.handoff(DEV, [TEST_CLASS], 'deploy-7');
  await until(() => h.runStarts() === 1, 'the first run to start');
  const repeat = h.handoff(DEV, [TEST_CLASS], 'deploy-7');
  h.release();
  const [a, b] = await Promise.all([first, repeat]);

  assert.equal(b, a);
  assert.equal(h.runStarts(), 1);
});

test('the same tests for a newer requestId while a run is in flight is busy', LIMIT, async () => {
  resetDialogs(async () => undefined);
  const h = harness({ mode: 'fail', held: true });

  const first = h.handoff(DEV, [TEST_CLASS], 'deploy-7');
  await until(() => h.runStarts() === 1, 'the first run to start');
  const newer = h.handoff(DEV, [TEST_CLASS], 'deploy-8');
  h.release();
  const [done, other] = await Promise.all([first, newer]);

  assert.equal(other.status, 'busy');
  assert.notEqual(other, done);
  assert.equal(h.runStarts(), 1);
});

test('two different requests waiting at their dialogs can each be joined', LIMIT, async () => {
  const answers: ((pick: string | undefined) => void)[] = [];
  resetDialogs(() => new Promise((resolve) => answers.push(resolve)));
  const h = harness({ mode: 'fail' });

  const a = h.handoff(PROD, [TEST_CLASS]);
  await until(() => warnings.length === 1, 'the first production question');
  const b = h.handoff(PROD, ['AcmeOtherTest']);
  await until(() => warnings.length === 2, 'the second production question');
  const aAgain = h.handoff(PROD, [TEST_CLASS]);
  const bAgain = h.handoff(PROD, ['AcmeOtherTest']);
  for (const answer of answers) answer('Run Tests');
  const [ra, rb, ra2, rb2] = await Promise.all([a, b, aAgain, bAgain]);

  assert.equal(ra2, ra, 'the first request was not pushed out by the second');
  assert.equal(rb2, rb);
  const questions = warnings.filter((w) => w.includes('PRODUCTION'));
  assert.equal(questions.length, 2, 'one question per request, none per repeat');
});

test('a repeat while the first still waits on the production question joins it — one question', LIMIT, async () => {
  let answer!: (pick: string | undefined) => void;
  resetDialogs(() => new Promise((resolve) => (answer = resolve)));
  const h = harness({ mode: 'fail' });

  const first = h.handoff(PROD, [TEST_CLASS]);
  await until(() => warnings.length === 1, 'the production question');
  const repeat = h.handoff(PROD, [TEST_CLASS]);
  answer('Run Tests');
  const [a, b] = await Promise.all([first, repeat]);

  assert.equal(b, a);
  assert.equal(warnings.length, 1, 'asked once, not once per copy');
  assert.equal(h.runStarts(), 1);
});

test('a declined request is asked again by the next one', LIMIT, async () => {
  resetDialogs(async () => undefined); // dismiss the production question
  const h = harness({ mode: 'fail' });

  const declined = await h.handoff(PROD, [TEST_CLASS]);
  assert.equal(declined.status, 'cancelled');
  const again = await h.handoff(PROD, [TEST_CLASS]);

  assert.notEqual(again, declined);
  assert.equal(warnings.length, 2, 'the second request gets its own question');
  assert.equal(h.runStarts(), 0);
});
