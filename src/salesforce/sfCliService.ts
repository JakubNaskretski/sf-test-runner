import * as vscode from 'vscode';
import {
  SfCliService as KitSfCliService,
  SfCliCancelledError,
  SfCliError,
  envelopeError,
  isErrorEnvelope,
} from '../kit/sfCli';
import { CommandLogEntry, CoverageInfo, OrgInfo, TestRunSummary } from '../types';
import { mapRunCoverage } from './coverageMapping';
import { mapTestResult } from './resultMapping';

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
   * Run a selection of tests against `orgUsername`. Each selector is either a
   * bare `ClassName` (every test in the class) or `ClassName.methodName` — the
   * two forms `--tests` accepts, and exactly the ids the test controller gives
   * its class and method items. Passing the org explicitly (rather than reading
   * `this.currentOrg`) is what keeps a run anchored to the org it started on.
   */
  async runTestSelection(
    selectors: string[],
    orgUsername: string,
    options: RunOptions = {},
  ): Promise<TestRunResult> {
    const testArgs: string[] = [];
    for (const selector of selectors) {
      testArgs.push('--tests', selector);
    }
    return this.runTests(testArgs, orgUsername, options);
  }

  /**
   * Run the org's whole local suite (`RunLocalTests` — every test in the org
   * except managed-package ones) against `orgUsername`. Same flags, logging and
   * cancellation as a class run; only the selector differs.
   */
  async runAllLocalTests(orgUsername: string, options: RunOptions = {}): Promise<TestRunResult> {
    return this.runTests(['--test-level', 'RunLocalTests'], orgUsername, options);
  }

  private async runTests(
    selectorArgs: string[],
    orgUsername: string,
    options: RunOptions,
  ): Promise<TestRunResult> {
    const waitMinutes = this.waitMinutes();
    const args = [
      'apex',
      'run',
      'test',
      ...selectorArgs,
      ...(options.coverage ? ['--code-coverage'] : []),
      '--result-format',
      'json',
      '--wait',
      waitMinutes.toString(),
      '--target-org',
      orgUsername,
    ];

    // `sf apex run test` exits non-zero when tests fail, but the kit still
    // resolves a normal (non-zero) exit and parses the JSON envelope on stdout —
    // so failing tests come back as a parsed result here, not an exception. A
    // genuine throw (bad project, expired auth, timeout, killed run) is a real
    // error and propagates; the kit already refuses to parse partial output from
    // a killed run, so there's no partial-JSON coercion to do.
    // Give the local process a minute beyond the CLI's own server-side --wait,
    // so the CLI's graceful "run still in progress" envelope wins over a hard
    // kill when a run brushes the ceiling.
    const parsed = await this.logged(args, options, () =>
      this.kit.runJson<any>(args, {
        timeoutMs: options.timeoutMs ?? waitMinutes * 60_000 + 60_000,
        signal: toSignal(options.cancellation),
      }),
    );

    // Failing tests exit 100 but still carry a complete `result`, so status is NOT
    // the signal here — a MISSING result is. Without this, a CLI-level refusal
    // ("this class name's value is invalid", expired auth) parsed into an empty
    // summary and the run finished silently with every test marked skipped.
    if (!parsed || parsed.result == null) throw envelopeError(parsed ?? {}, 'apex run test');
    const result = parsed.result;
    const summary = mapTestResult(result);
    const coverage = mapRunCoverage(result?.coverage);
    return { summary, coverage };
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
    const escaped = className.replace(/'/g, "\\'");
    const soql =
      'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered, Coverage ' +
      "FROM ApexCodeCoverageAggregate WHERE ApexClassOrTrigger.Name = '" +
      escaped +
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

  private waitMinutes(): number {
    const totalMs = this.testTimeoutMs();
    return Math.max(1, Math.ceil(totalMs / 60000));
  }

  private testTimeoutMs(): number {
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
  ): Promise<T> {
    const id = this.nextCommandId++;
    const startedAt = Date.now();
    const display = `sf ${args.join(' ')}`;
    this.output.appendLine(`[cmd] ${display}`);

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
      this.output.appendLine(`[ok] ${display} → ${durationMs}ms`);
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

/** Adapt a VS Code CancellationToken to an AbortSignal for the kit's run API. */
function toSignal(token: vscode.CancellationToken | undefined): AbortSignal | undefined {
  if (!token) return undefined;
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
