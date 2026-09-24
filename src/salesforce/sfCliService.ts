import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  SfCliService as KitSfCliService,
  SfCliCancelledError,
  SfCliError,
  envelopeError,
  isErrorEnvelope,
} from '../kit/sfCli';
import {
  CommandLogEntry,
  CoverageInfo,
  OrgInfo,
  TestMethodResult,
  TestRunSummary,
} from '../types';
import { mapRunCoverage } from './coverageMapping';
import { mapTestResult, parseMs } from './resultMapping';
import { parseStackTrace } from './stackParser';
import { TRACE_FLAG_MAX_TTL_MS, TraceFlagRow, planTraceFlag } from './debugLogs';

interface RunOptions {
  timeoutMs?: number;
  cancellation?: vscode.CancellationToken;
  /** Ask the CLI for `--code-coverage`. Off for a plain run: gathering coverage
   *  makes the org do more work, and the "Run" profile has nothing to show it in. */
  coverage?: boolean;
}

/** A completed test run plus the per-class coverage the `--code-coverage` flag
 *  returned inline. The coverage map is keyed by lowercased class name and
 *  covers every class the run exercised (the classes UNDER TEST, not the test
 *  classes) — so callers no longer need a follow-up ApexCodeCoverageAggregate
 *  query to decorate them. */
export interface TestRunResult {
  summary: TestRunSummary;
  coverage: Map<string, CoverageInfo>;
}

/** One row of the org's recent-async-runs list (`ApexTestRunResult`). */
export interface RecentTestRun {
  testRunId: string;
  status: string;
  startTime: string;
  methodsCompleted: number;
  methodsFailed: number;
}

/** What starting a run returns: the org queued the job, nothing has run yet. */
export interface StartedTestRun {
  testRunId: string;
}

/** A run's counters while it is in flight, from its `ApexTestRunResult` row. */
export interface TestRunStatus {
  /** Holding | Queued | Preparing | Processing | Completed | Failed | Aborted. */
  status: string;
  enqueued: number;
  completed: number;
  failed: number;
}

/** Queue states that can still be stopped. A class already `Processing` runs to
 *  its end whatever we do — Salesforce cannot interrupt executing Apex — so
 *  aborting only skips what comes after it. Picklist checked against a live org
 *  (2026-09-17): Queued, Processing, Aborted, Completed, Failed, Preparing, Holding. */
const ABORTABLE = new Set(['Holding', 'Queued', 'Preparing', 'Processing']);

/** The sObject collections API takes at most 200 records per request. */
const ABORT_BATCH = 200;

/** API version for the REST endpoints we address by hand. Pinned rather than
 *  chasing the org's latest: the collections API shape we depend on has been
 *  stable since long before this, and a pinned path cannot start behaving
 *  differently after an org upgrade. */
const REST_API_VERSION = 'v62.0';

export { SfCliError, SfCliCancelledError };

/**
 * Wraps the Salesforce CLI (`sf`) so test execution, coverage queries, and org
 * listing all flow through one logged surface.
 *
 * The spawn/JSON/cancel core now comes from the shared kit (`src/kit/sfCli.ts`,
 * vendored from sf-kit): it fixes the family-wide bugs this plugin's old
 * `execFile('sf', …)` had — Windows `sf.cmd`/`sf.ps1` shim resolution (Node
 * cannot spawn the shim directly, and the failure used to be misreported as "sf
 * not found"), the partial-JSON-on-timeout guard (a killed run no longer feeds
 * truncated stdout to `JSON.parse`, which surfaced a raw "Unexpected end of JSON
 * input"), a real "timed out after Nms" message, and SIGTERM→SIGKILL escalation.
 *
 * The org is passed EXPLICITLY into every call rather than read from mutable
 * instance state, so a run started against org A always finishes (coverage
 * queries included) against org A even if the user switches orgs mid-run.
 */
export class SfCliService {
  private currentOrg: OrgInfo | undefined;
  private nextCommandId = 1;
  private readonly kit = new KitSfCliService();

  private readonly commandEmitter = new vscode.EventEmitter<CommandLogEntry>();
  readonly onCommand = this.commandEmitter.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  getCurrentOrg(): OrgInfo | undefined {
    return this.currentOrg;
  }

  setCurrentOrg(org: OrgInfo | undefined): void {
    this.currentOrg = org;
  }

  /** Shared in-flight org list — the picker, activation auto-select and the
   *  shared-org config watcher can all ask at the same moment; one `sf org list`
   *  spawn serves every concurrent caller instead of one per caller. */
  private listOrgsInflight?: Promise<OrgInfo[]>;

  listOrgs(): Promise<OrgInfo[]> {
    return (this.listOrgsInflight ??= this.doListOrgs().finally(() => {
      this.listOrgsInflight = undefined;
    }));
  }

  private async doListOrgs(): Promise<OrgInfo[]> {
    const kitOrgs = await this.logged(['org', 'list', '--skip-connection-status', '--json'], {}, () =>
      this.kit.listOrgs(),
    );
    return kitOrgs.map((o) => ({
      alias: o.alias || o.username,
      username: o.username,
      instanceUrl: o.instanceUrl || '',
      isDefault: o.isDefaultUsername || false,
      isSandbox: o.isSandbox,
      isScratch: o.isScratch,
      orgEdition: o.orgEdition,
    }));
  }

  /**
   * Authenticate a new org through the browser (`sf org login web`), the same
   * flow the family's ＋ button runs elsewhere. Resolves with the username the
   * CLI reports, or undefined when it reports none (the org is authenticated
   * either way — the caller just cannot pre-select it).
   *
   * No cancellation and a deliberately long timeout: the command only returns
   * when the user finishes (or abandons) the browser flow, and killing it early
   * would abort a login the user is still completing.
   */
  async loginWeb(): Promise<string | undefined> {
    const args = ['org', 'login', 'web', '--json'];
    const parsed = await this.logged(args, {}, () =>
      this.kit.runJson<any>(args, { timeoutMs: 300_000 }),
    );
    if (isErrorEnvelope(parsed)) throw envelopeError(parsed ?? {}, 'org login web');
    const username = parsed?.result?.username;
    return typeof username === 'string' && username ? username : undefined;
  }

  /**
   * Start a selection of tests against `orgUsername`. Each selector is either a
   * bare `ClassName` (every test in the class) or `ClassName.methodName` — the
   * two forms `--tests` accepts, and exactly the ids the tests tree gives its
   * class and method rows. Passing the org explicitly (rather than reading
   * `this.currentOrg`) is what keeps a run anchored to the org it started on.
   */
  async runTestSelection(
    selectors: string[],
    orgUsername: string,
    options: RunOptions = {},
  ): Promise<StartedTestRun> {
    const testArgs: string[] = [];
    for (const selector of selectors) {
      testArgs.push('--tests', selector);
    }
    return this.startTestRun(testArgs, orgUsername, options);
  }

  /**
   * Start the org's whole local suite (`RunLocalTests` — every test in the org
   * except managed-package ones) against `orgUsername`. Same flags, logging and
   * cancellation as a class run; only the selector differs.
   */
  async runAllLocalTests(orgUsername: string, options: RunOptions = {}): Promise<StartedTestRun> {
    return this.startTestRun(['--test-level', 'RunLocalTests'], orgUsername, options);
  }

  /**
   * Start EVERY test in the org, managed-package tests included
   * (`RunAllTestsInOrg`). The overflow action behind "Run All Local Tests": it
   * can take a very long time and exercises code the workspace does not even
   * contain, so it is never the default.
   */
  async runAllTestsInOrg(orgUsername: string, options: RunOptions = {}): Promise<StartedTestRun> {
    return this.startTestRun(['--test-level', 'RunAllTestsInOrg'], orgUsername, options);
  }

  /**
   * `sf apex run test` WITHOUT `--wait`: the CLI hands back the id the org gave
   * the job and exits, and `runs/pollRun.ts` takes it from there. That is what
   * makes live progress and a real cancel possible — a `--wait` run is one
   * opaque spawn with nothing to report while it lasts and nothing to abort.
   *
   * `--code-coverage` has to be asked for HERE: coverage is collected while the
   * tests execute, so a run started without it has none to fetch afterwards.
   *
   * A start that produced no id is a CLI-level failure and the envelope says
   * why — an org with no test classes at all answers `INVALID_INPUT: No tests
   * found for category: Apex` with no `result` (seen on the thesis org,
   * 2026-09-17). Without this guard that becomes a run with no id to poll.
   */
  async startTestRun(
    selectorArgs: string[],
    orgUsername: string,
    options: RunOptions = {},
  ): Promise<StartedTestRun> {
    const args = [
      'apex',
      'run',
      'test',
      ...selectorArgs,
      ...(options.coverage ? ['--code-coverage'] : []),
      '--result-format',
      'json',
      '--json',
      '--target-org',
      orgUsername,
    ];
    const parsed = await this.logged(args, options, () =>
      this.kit.runJson<any>(args, {
        timeoutMs: options.timeoutMs,
        signal: toSignal(options.cancellation),
      }),
    );
    const testRunId = parsed?.result?.testRunId;
    if (typeof testRunId !== 'string' || !testRunId) {
      throw envelopeError(parsed ?? {}, 'apex run test');
    }
    return { testRunId };
  }

  /**
   * Where a started run is now. Returns null while the org has not written the
   * `ApexTestRunResult` row yet — there is a short window after the start where
   * the job exists and the row does not, and that is not an error.
   */
  async getTestRunStatus(
    testRunId: string,
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken } = {},
  ): Promise<TestRunStatus | null> {
    const id = assertRunId(testRunId);
    const soql =
      'SELECT Status, MethodsEnqueued, MethodsCompleted, MethodsFailed, StartTime, EndTime ' +
      `FROM ApexTestRunResult WHERE AsyncApexJobId = '${id}'`;
    const row = (await this.queryRecords(soql, orgUsername, options))[0];
    if (!row) return null;
    return {
      status: String(row.Status ?? 'Unknown'),
      enqueued: Number(row.MethodsEnqueued ?? 0),
      completed: Number(row.MethodsCompleted ?? 0),
      failed: Number(row.MethodsFailed ?? 0),
    };
  }

  /**
   * The per-method results the org has written SO FAR — the live half of the
   * poll loop. `sf apex get test` cannot answer this: it is built for a finished
   * run (and in 2.137.7 it throws on rows whose class is gone), so the results
   * that arrive DURING a run come straight from the object.
   */
  async getLiveResults(
    testRunId: string,
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken } = {},
  ): Promise<TestMethodResult[]> {
    const id = assertRunId(testRunId);
    const soql =
      'SELECT ApexClass.Name, MethodName, Outcome, RunTime, Message, StackTrace ' +
      `FROM ApexTestResult WHERE AsyncApexJobId = '${id}'`;
    const records = await this.queryRecords(soql, orgUsername, options);
    return records.map(mapLiveResult);
  }

  /**
   * Stop what is left of a run: set every still-abortable `ApexTestQueueItem` to
   * `Aborted` in ONE composite request per 200 rows — never a CLI spawn per row.
   * Returns how many rows the org actually aborted.
   *
   * The endpoint is the STANDARD collections API, not the Tooling one: the
   * Tooling API has no `composite/sobjects` (it answers NOT_FOUND — checked
   * against a live org on 2026-09-17), while `ApexTestQueueItem` is a plain
   * sObject there whose `Status` is updateable.
   */
  async abortTestRun(testRunId: string, orgUsername: string): Promise<number> {
    const id = assertRunId(testRunId);
    const rows = await this.queryRecords(
      `SELECT Id, Status FROM ApexTestQueueItem WHERE ParentJobId = '${id}'`,
      orgUsername,
      {},
      'standard',
    );
    const ids = rows
      .filter((r) => ABORTABLE.has(String(r?.Status ?? '')))
      .map((r) => String(r?.Id ?? ''))
      .filter((rowId) => ID_RE.test(rowId));
    if (ids.length === 0) return 0;

    // `sf api request rest --body` reads a FILE (or stdin, which the kit's spawn
    // never writes to), so the request body has to land on disk first. Its own
    // directory, created 0700, keeps the ids out of reach of other local users.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-test-runner-abort-'));
    try {
      let aborted = 0;
      for (let i = 0; i < ids.length; i += ABORT_BATCH) {
        const file = path.join(dir, `abort-${i}.json`);
        await fs.writeFile(
          file,
          JSON.stringify({
            allOrNone: false,
            records: ids.slice(i, i + ABORT_BATCH).map((rowId) => ({
              attributes: { type: 'ApexTestQueueItem' },
              Id: rowId,
              Status: 'Aborted',
            })),
          }),
          { mode: 0o600, flag: 'wx' },
        );
        const args = [
          'api',
          'request',
          'rest',
          `/services/data/${REST_API_VERSION}/composite/sobjects`,
          '--target-org',
          orgUsername,
          '--method',
          'PATCH',
          '--header',
          'Content-Type:application/json',
          // The '@' prefix is how this flag distinguishes a file from literal
          // body content.
          '--body',
          `@${file}`,
        ];
        // No `--json` here: `api request rest` has no such flag, it prints the
        // REST response body itself — for this endpoint, one entry per record.
        aborted += countAborted(await this.logged(args, {}, () => this.kit.runJson<any>(args)));
      }
      return aborted;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Make sure the running user's USER_DEBUG trace flag covers the next `ttlMs`
   * — keep it, extend it, or create it on a plugin-owned `SfTestRunner` debug
   * level (Apex at DEBUG, everything else NONE, so a test's log stays small).
   * A flag on a level that would swallow `System.debug` is repointed at ours.
   * Returns a one-line note of what it did, for the output channel, and whether
   * the user's own flag was repointed — that one deserves a visible notice.
   */
  async ensureDebugLogging(
    orgUsername: string,
    ttlMs: number,
    options: { cancellation?: vscode.CancellationToken } = {},
  ): Promise<{ note: string; relevelled: boolean }> {
    const user = (
      await this.queryRecords(
        `SELECT Id FROM User WHERE Username = '${soqlString(orgUsername)}'`,
        orgUsername,
        options,
        'standard',
      )
    )[0];
    const userId = String(user?.Id ?? '');
    if (!ID_RE.test(userId)) throw new SfCliError(`No user ${orgUsername} in the org.`);

    // Several flags may coexist with disjoint windows: the latest-expiring one
    // is the one worth keeping or extending, never an arbitrary first row.
    const rows = (await this.queryRecords(
      'SELECT Id, StartDate, ExpirationDate, DebugLevel.ApexCode FROM TraceFlag ' +
        `WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' ` +
        'ORDER BY ExpirationDate DESC NULLS LAST LIMIT 1',
      orgUsername,
      options,
    )) as TraceFlagRow[];
    const now = Date.now();
    const ttl = Math.min(ttlMs, TRACE_FLAG_MAX_TTL_MS);
    const plan = planTraceFlag(rows, now, ttl);
    if (plan.action !== 'create' && !ID_RE.test(plan.id)) {
      throw new SfCliError(`Refusing to update an invalid trace flag id: ${plan.id}`);
    }
    const window = `StartDate=${new Date(now).toISOString()} ExpirationDate=${new Date(now + ttl).toISOString()}`;
    if (plan.action === 'create') {
      await this.toolingWrite(
        [
          'create',
          '-s',
          'TraceFlag',
          '-v',
          `TracedEntityId=${userId} DebugLevelId=${await this.pluginDebugLevel(orgUsername, options)} ` +
            `LogType=USER_DEBUG ${window}`,
        ],
        orgUsername,
        options,
      );
      return { note: 'trace flag created', relevelled: false };
    }
    const values = [
      ...(plan.action === 'extend' ? [window] : []),
      ...(plan.relevel ? [`DebugLevelId=${await this.pluginDebugLevel(orgUsername, options)}`] : []),
    ];
    if (values.length === 0) return { note: 'trace flag already active', relevelled: false };
    await this.toolingWrite(
      ['update', '-s', 'TraceFlag', '-i', plan.id, '-v', values.join(' ')],
      orgUsername,
      options,
    );
    const extended = plan.action === 'extend' ? 'trace flag extended' : 'trace flag kept';
    return {
      note: plan.relevel ? `${extended}, now logging Apex at DEBUG` : extended,
      relevelled: plan.relevel,
    };
  }

  /** Id of the plugin's `SfTestRunner` debug level, created on first use. */
  private async pluginDebugLevel(
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken },
  ): Promise<string> {
    const level = (
      await this.queryRecords(
        "SELECT Id, ApexCode FROM DebugLevel WHERE DeveloperName = 'SfTestRunner'",
        orgUsername,
        options,
      )
    )[0];
    if (typeof level?.Id === 'string' && level.ApexCode !== 'DEBUG') {
      // Someone edited our level: put it back, or every "relevel" would land on
      // a level that swallows System.debug and the user would only ever see empty logs.
      await this.toolingWrite(
        ['update', '-s', 'DebugLevel', '-i', level.Id, '-v', 'ApexCode=DEBUG'],
        orgUsername,
        options,
      );
    }
    const id =
      typeof level?.Id === 'string'
        ? level.Id
        : await this.toolingWrite(
            [
              'create',
              '-s',
              'DebugLevel',
              '-v',
              'DeveloperName=SfTestRunner MasterLabel=SfTestRunner ApexCode=DEBUG ' +
                'ApexProfiling=NONE Callout=NONE Database=NONE System=NONE Validation=NONE ' +
                'Visualforce=NONE Workflow=NONE',
            ],
            orgUsername,
            options,
          );
    if (!ID_RE.test(id)) throw new SfCliError(`The org returned an invalid debug level id: ${id}`);
    return id;
  }

  /** `sf data create|update record --use-tooling-api …`; returns the record id. */
  private async toolingWrite(
    rest: string[],
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken },
  ): Promise<string> {
    const args = [
      'data',
      rest[0],
      'record',
      '--use-tooling-api',
      ...rest.slice(1),
      '--json',
      '--target-org',
      orgUsername,
    ];
    const parsed = await this.logged(args, {}, () =>
      this.kit.runJson<any>(args, { signal: toSignal(options.cancellation) }),
    );
    if (isErrorEnvelope(parsed)) throw envelopeError(parsed, `data ${rest[0]} record`);
    return String(parsed?.result?.id ?? '');
  }

  /** `Cls.method` → ApexLogId for every method of the run that kept a log. */
  async getLogIds(testRunId: string, orgUsername: string): Promise<Map<string, string>> {
    const id = assertRunId(testRunId);
    const rows = await this.queryRecords(
      'SELECT ApexClass.Name, MethodName, ApexLogId FROM ApexTestResult ' +
        `WHERE AsyncApexJobId = '${id}' AND ApexLogId != null`,
      orgUsername,
      {},
    );
    const ids = new Map<string, string>();
    for (const row of rows) {
      const logId = String(row?.ApexLogId ?? '');
      if (ID_RE.test(logId)) ids.set(`${row?.ApexClass?.Name}.${row?.MethodName}`, logId);
    }
    return ids;
  }

  /** The raw body of one debug log. */
  async getApexLog(logId: string, orgUsername: string): Promise<string> {
    if (!ID_RE.test(logId)) throw new SfCliError(`Refusing to fetch an invalid log id: ${logId}`);
    const args = ['apex', 'get', 'log', '--log-id', logId, '--json', '--target-org', orgUsername];
    const parsed = await this.logged(args, {}, () => this.kit.runJson<any>(args));
    if (isErrorEnvelope(parsed)) throw envelopeError(parsed, 'apex get log');
    // 2.137.7 answers `result: [{ log: "<body>" }]`; older builds answered a bare string.
    const first = Array.isArray(parsed?.result) ? parsed.result[0] : parsed?.result;
    const body = typeof first === 'string' ? first : first?.log;
    if (typeof body !== 'string') throw new SfCliError('The CLI returned no log body.');
    return body;
  }

  /** One SOQL query through the CLI, with the error-envelope discipline every
   *  other query here uses: a refusal must never read as an empty result set. */
  private async queryRecords(
    soql: string,
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken },
    api: 'tooling' | 'standard' = 'tooling',
  ): Promise<any[]> {
    const args = [
      'data',
      'query',
      '--query',
      soql,
      ...(api === 'tooling' ? ['--use-tooling-api'] : []),
      '--json',
      '--target-org',
      orgUsername,
    ];
    // Quiet: what comes through here is the poll (two queries every 3 seconds)
    // and the abort's queue lookup. Narrating those in the output channel would
    // bury the run summary the user is reading; the command panel still lists
    // every one of them.
    const parsed = await this.logged(
      args,
      options,
      () => this.kit.runJson<any>(args, { signal: toSignal(options.cancellation) }),
      { quiet: true },
    );
    if (isErrorEnvelope(parsed) || !Array.isArray(parsed.result.records)) {
      throw envelopeError(parsed ?? {}, 'data query');
    }
    return parsed.result.records as any[];
  }

  /** List the org's most recent async test runs (whoever started them). */
  async listRecentTestRuns(orgUsername: string, limit = 10): Promise<RecentTestRun[]> {
    const soql =
      'SELECT AsyncApexJobId, Status, StartTime, MethodsCompleted, MethodsFailed ' +
      `FROM ApexTestRunResult ORDER BY StartTime DESC LIMIT ${limit}`;
    const args = [
      'data',
      'query',
      '--query',
      soql,
      '--use-tooling-api',
      '--json',
      '--target-org',
      orgUsername,
    ];
    const parsed = await this.logged(args, {}, () => this.kit.runJson<any>(args));
    // Same discipline as getCoverageForClass: an error envelope must surface as
    // an error, not read as "the org has no recent runs".
    if (isErrorEnvelope(parsed) || !Array.isArray(parsed.result.records)) {
      throw envelopeError(parsed ?? {}, 'data query');
    }
    const records: any[] = parsed.result.records;
    return records
      .map((r) => ({
        testRunId: String(r.AsyncApexJobId ?? ''),
        status: String(r.Status ?? 'Unknown'),
        startTime: String(r.StartTime ?? ''),
        methodsCompleted: Number(r.MethodsCompleted ?? 0),
        methodsFailed: Number(r.MethodsFailed ?? 0),
      }))
      .filter((r) => r.testRunId);
  }

  /**
   * Every unmanaged Apex class in the org, names only. The cheap first step of
   * org test discovery: one Tooling query, no bodies. `ManageableState =
   * 'unmanaged'` is what keeps managed-package classes out — their `Body` is
   * `(hidden)` anyway, so they could never be classified.
   */
  async listOrgClasses(
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken } = {},
  ): Promise<{ id: string; name: string; namespace?: string }[]> {
    const soql =
      "SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE ManageableState = 'unmanaged'";
    const args = [
      'data',
      'query',
      '--query',
      soql,
      '--use-tooling-api',
      '--json',
      '--target-org',
      orgUsername,
    ];
    const parsed = await this.logged(args, options, () =>
      this.kit.runJson<any>(args, { signal: toSignal(options.cancellation) }),
    );
    // Same discipline as listRecentTestRuns: an error envelope must surface as
    // an error, not read as "this org has no classes" — which would quietly
    // empty the org half of the index.
    if (isErrorEnvelope(parsed) || !Array.isArray(parsed.result.records)) {
      throw envelopeError(parsed ?? {}, 'data query');
    }
    const records: any[] = parsed.result.records;
    return records
      .map((r) => ({
        id: String(r.Id ?? ''),
        name: String(r.Name ?? ''),
        ...(r.NamespacePrefix ? { namespace: String(r.NamespacePrefix) } : {}),
      }))
      .filter((r) => r.id && r.name);
  }

  /**
   * Source bodies for the given ApexClass ids, as `id → Body`. An id the org did
   * not return a body for maps to null — the caller reports that class as
   * unclassified rather than guessing what it is.
   *
   * Batched at 200 ids per query (≈4.6 KB of ids, far under the 20 KB SOQL cap)
   * with two queries in flight, so a few-thousand-class org is a handful of
   * round trips instead of one enormous query or one query per class.
   */
  async getClassBodies(
    ids: string[],
    orgUsername: string,
    options: { cancellation?: vscode.CancellationToken } = {},
  ): Promise<Map<string, string | null>> {
    // These ids are spliced into SOQL. They come from our own listOrgClasses, so
    // anything that is not a Salesforce id is a bug or a tampered response — not
    // something to quote and hope.
    for (const id of ids) {
      if (!/^[A-Za-z0-9]{15,18}$/.test(id)) {
        throw new SfCliError(`Refusing to query an invalid ApexClass id: ${id}`);
      }
    }

    const bodies = new Map<string, string | null>();
    // Seed every requested id: a row the org omits stays null instead of absent.
    for (const id of ids) bodies.set(id, null);

    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 200) batches.push(ids.slice(i, i + 200));

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next++];
        const soql = `SELECT Id, Body FROM ApexClass WHERE Id IN ('${batch.join("','")}')`;
        const args = [
          'data',
          'query',
          '--query',
          soql,
          '--use-tooling-api',
          '--json',
          '--target-org',
          orgUsername,
        ];
        const parsed = await this.logged(args, options, () =>
          this.kit.runJson<any>(args, { signal: toSignal(options.cancellation) }),
        );
        if (isErrorEnvelope(parsed) || !Array.isArray(parsed.result.records)) {
          throw envelopeError(parsed ?? {}, 'data query');
        }
        for (const row of parsed.result.records as any[]) {
          const id = String(row?.Id ?? '');
          if (!id) continue;
          // A managed or otherwise unreadable class answers `(hidden)`, and a
          // missing field answers null: neither is source to classify.
          bodies.set(id, typeof row.Body === 'string' && row.Body !== '(hidden)' ? row.Body : null);
        }
      }
    };

    // Both workers are awaited to completion even when one fails: letting
    // `Promise.all` reject early leaves the other rejection unhandled, which
    // Node reports as a crash-worthy unhandledRejection in the extension host.
    const outcomes = await Promise.all(
      [worker(), worker()].map((p) =>
        p.then(
          () => undefined,
          (err) => (err instanceof Error ? err : new Error(String(err))),
        ),
      ),
    );
    const failure = outcomes.find((err): err is Error => err !== undefined);
    if (failure) throw failure;
    return bodies;
  }

  /**
   * Fetch a finished run's full results + coverage by id — same envelope as a
   * live run, so external/interrupted runs flow through the same mapping.
   */
  async getTestRun(
    testRunId: string,
    orgUsername: string,
    options: RunOptions = {},
  ): Promise<TestRunResult> {
    const args = [
      'apex',
      'get',
      'test',
      '--test-run-id',
      testRunId,
      '--code-coverage',
      '--result-format',
      'json',
      '--target-org',
      orgUsername,
    ];
    const parsed = await this.logged(args, options, () =>
      this.kit.runJson<any>(args, { signal: toSignal(options.cancellation) }),
    );
    if (!parsed || parsed.result == null) throw envelopeError(parsed ?? {}, 'apex get test');
    const result = parsed.result;
    return { summary: mapTestResult(result), coverage: mapRunCoverage(result?.coverage) };
  }

  /**
   * Query the org's stored aggregate coverage for a class: the last run that
   * touched it in the org, whoever started it. Only caller is the explicit
   * "Load Coverage from Org" command — NOT a test run, which returns its own
   * coverage inline.
   */
  async getCoverageForClass(className: string, orgUsername: string): Promise<CoverageInfo | null> {
    // The name is spliced into SOQL. An Apex identifier is `\w+`, so anything
    // else is validated away rather than escaped — the same rule the run-id and
    // ApexClass-id guards below apply.
    if (!/^\w+$/.test(className)) {
      throw new SfCliError(`Refusing to query coverage for an invalid class name: ${className}`);
    }
    const soql =
      'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered, Coverage ' +
      "FROM ApexCodeCoverageAggregate WHERE ApexClassOrTrigger.Name = '" +
      className +
      "' LIMIT 1";

    const args = [
      'data',
      'query',
      '--query',
      soql,
      '--use-tooling-api',
      '--json',
      '--target-org',
      orgUsername,
    ];
    const parsed = await this.logged(args, {}, () => this.kit.runJson<any>(args));
    // An error envelope (expired auth, bad query) carries name/message and no
    // result — reading `records` off it reported the class as "no coverage",
    // which reads as 0% instead of "we could not ask". null means ONLY that the
    // org has no aggregate coverage row for this class.
    if (isErrorEnvelope(parsed) || !Array.isArray(parsed.result.records)) {
      throw envelopeError(parsed ?? {}, 'data query');
    }
    const row = parsed.result.records[0];
    if (!row) return null;

    const coverage = row.Coverage ?? { coveredLines: [], uncoveredLines: [] };
    return {
      className: row.ApexClassOrTrigger?.Name ?? className,
      numLinesCovered: row.NumLinesCovered ?? 0,
      numLinesUncovered: row.NumLinesUncovered ?? 0,
      coveredLines: coverage.coveredLines ?? [],
      uncoveredLines: coverage.uncoveredLines ?? [],
    };
  }

  /**
   * How long a run may take overall, in ms. The CLI no longer waits for the org,
   * so this is the POLLER's ceiling: once it passes, the run is handed back to
   * the org with a "still running" note instead of being reported as finished.
   */
  testTimeoutMs(): number {
    return vscode.workspace
      .getConfiguration('sfTestRunner')
      .get<number>('testTimeoutMs', 600000);
  }

  /**
   * Emit a running/finished CommandLogEntry around a kit call so the "Recent sf
   * Commands" panel still records every invocation, while the actual spawn/parse
   * runs through the kit. `run` returns the already-parsed value.
   */
  private async logged<T>(
    args: string[],
    _options: RunOptions,
    run: () => Promise<T>,
    opts: { quiet?: boolean } = {},
  ): Promise<T> {
    const id = this.nextCommandId++;
    const startedAt = Date.now();
    const display = `sf ${args.join(' ')}`;
    if (!opts.quiet) this.output.appendLine(`[cmd] ${display}`);

    const inflight: CommandLogEntry = {
      id,
      startedAt,
      durationMs: null,
      command: 'sf',
      args,
      status: 'running',
      exitCode: null,
      stderrSnippet: null,
      errorMessage: null,
    };
    this.commandEmitter.fire(inflight);

    try {
      const value = await run();
      const durationMs = Date.now() - startedAt;
      // exitCode stays null: the kit parses the envelope regardless of exit
      // status (failing tests exit 100), so a fabricated 0 here would lie.
      this.commandEmitter.fire({
        ...inflight,
        durationMs,
        status: 'success',
      });
      if (!opts.quiet) this.output.appendLine(`[ok] ${display} → ${durationMs}ms`);
      return value;
    } catch (err: any) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      const stderr = typeof err?.stderr === 'string' ? err.stderr : null;
      this.commandEmitter.fire({
        ...inflight,
        durationMs,
        status: 'error',
        exitCode: null,
        stderrSnippet: stderr ? truncate(stderr.trim(), 400) : null,
        errorMessage: message,
      });
      this.output.appendLine(`[error] ${display} → ${message}`);
      throw err;
    }
  }

  dispose(): void {
    this.commandEmitter.dispose();
  }
}

/** Salesforce ids as they appear in a run envelope: 15 or 18 alphanumerics. */
const ID_RE = /^[A-Za-z0-9]{15,18}$/;

/** Escape a value for a single-quoted SOQL literal. */
function soqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Ids are spliced into SOQL. Ours come from the CLI's own start envelope, so
 *  anything that is not a Salesforce id is a bug or a tampered response — not
 *  something to quote and hope. */
function assertRunId(testRunId: string): string {
  if (!ID_RE.test(testRunId)) {
    throw new SfCliError(`Refusing to query an invalid test run id: ${testRunId}`);
  }
  return testRunId;
}

/**
 * One `ApexTestResult` row as a TestMethodResult. `ApexClass` comes back NULL
 * when the class was deleted after the run (seen on the thesis org, 2026-09-17),
 * so the name falls back to the stack frame for this method — a result keyed
 * `unknown.testThing` matches no row in the tests tree.
 */
export function mapLiveResult(row: any): TestMethodResult {
  const methodName = String(row?.MethodName ?? 'unknown');
  const stackTrace = typeof row?.StackTrace === 'string' ? row.StackTrace : null;
  const fromStack = parseStackTrace(stackTrace).find((f) => f.method === methodName)?.className;
  const outcome = row?.Outcome;
  return {
    className: String(row?.ApexClass?.Name ?? fromStack ?? 'unknown'),
    methodName,
    outcome:
      outcome === 'Pass' || outcome === 'Fail' || outcome === 'CompileFail' || outcome === 'Skip'
        ? outcome
        : 'Skip',
    runTime: parseMs(row?.RunTime),
    message: typeof row?.Message === 'string' ? row.Message : null,
    stackTrace,
  };
}

/**
 * How many records the collections API says it updated. A request the org
 * refused outright comes back as `[{ errorCode, message }]` with no `success`
 * field (that is what a wrong endpoint answers) — that must surface as the
 * error it is, not as "there was nothing left to abort".
 */
export function countAborted(response: unknown): number {
  if (!Array.isArray(response)) {
    throw new SfCliError('Unexpected response from the composite records API.');
  }
  const refusal = response.find((e) => e && typeof e === 'object' && !('success' in e)) as any;
  if (refusal) {
    throw new SfCliError(
      `${refusal.errorCode ?? 'Error'}: ${refusal.message ?? 'the composite request was refused'}`,
    );
  }
  return response.filter((e: any) => e?.success === true).length;
}

/**
 * One signal per token, for the lifetime of that token.
 *
 * The poll loop calls this twice a tick for the SAME token, and the listener a
 * `CancellationToken` hands out cannot be unsubscribed once the token's source
 * is disposed — so minting a fresh controller per call piles up listeners for
 * as long as the run lasts. The token is the key, so the entry dies with it.
 */
const SIGNALS = new WeakMap<vscode.CancellationToken, AbortSignal>();

/** Adapt a VS Code CancellationToken to an AbortSignal for the kit's run API. */
function toSignal(token: vscode.CancellationToken | undefined): AbortSignal | undefined {
  if (!token) return undefined;
  const cached = SIGNALS.get(token);
  if (cached) return cached;
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  SIGNALS.set(token, controller.signal);
  return controller.signal;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
