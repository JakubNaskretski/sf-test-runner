import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { CommandLogEntry, CoverageInfo, OrgInfo, TestMethodResult, TestRunSummary } from '../types';

interface RunOptions {
  timeoutMs?: number;
  cancellation?: vscode.CancellationToken;
}

/**
 * Wraps the Salesforce CLI (`sf`) so test execution, coverage queries, and
 * org listing all flow through one logged surface.
 */
export class SfCliService {
  private currentOrg: OrgInfo | undefined;
  private nextCommandId = 1;

  private readonly logEmitter = new vscode.EventEmitter<{ level: string; message: string }>();
  readonly onLog = this.logEmitter.event;

  private readonly commandEmitter = new vscode.EventEmitter<CommandLogEntry>();
  readonly onCommand = this.commandEmitter.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  getCurrentOrg(): OrgInfo | undefined {
    return this.currentOrg;
  }

  setCurrentOrg(org: OrgInfo): void {
    this.currentOrg = org;
  }

  async listOrgs(): Promise<OrgInfo[]> {
    const stdout = await this.runCli(['org', 'list', '--json']);
    const parsed = JSON.parse(stdout);
    const raw = [
      ...(parsed.result?.nonScratchOrgs || []),
      ...(parsed.result?.scratchOrgs || []),
      ...(parsed.result?.sandboxes || []),
      ...(parsed.result?.other || []),
    ];
    return raw.map((o: any) => ({
      alias: o.alias || o.username,
      username: o.username,
      instanceUrl: o.instanceUrl || '',
      isDefault:
        o.isDefaultUsername || o.defaultMarker === '(U)' || o.defaultMarker === '(U)' || false,
    }));
  }

  async runApexTests(
    className: string,
    options: RunOptions = {},
  ): Promise<TestRunSummary> {
    const args = [
      'apex',
      'run',
      'test',
      '--class-names',
      className,
      '--code-coverage',
      '--result-format',
      'json',
      '--wait',
      this.waitMinutes().toString(),
      ...this.targetOrgArgs(),
    ];

    let stdout: string;
    try {
      stdout = await this.runCli(args, {
        timeoutMs: options.timeoutMs ?? this.testTimeoutMs(),
        cancellation: options.cancellation,
      });
    } catch (err: any) {
      // `sf apex run test` exits non-zero when tests fail. The JSON body is still on stdout.
      if (typeof err?.stdout === 'string' && err.stdout.trim().startsWith('{')) {
        stdout = err.stdout;
      } else {
        throw err;
      }
    }

    const parsed = JSON.parse(stdout);
    return mapTestResult(parsed.result ?? parsed, className);
  }

  async getCoverageForClass(className: string): Promise<CoverageInfo | null> {
    const escaped = className.replace(/'/g, "\\'");
    const soql =
      "SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered, Coverage " +
      "FROM ApexCodeCoverageAggregate WHERE ApexClassOrTrigger.Name = '" +
      escaped +
      "' LIMIT 1";

    const stdout = await this.runCli([
      'data',
      'query',
      '--query',
      soql,
      '--use-tooling-api',
      '--json',
      ...this.targetOrgArgs(),
    ]);

    const parsed = JSON.parse(stdout);
    const row = parsed.result?.records?.[0];
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

  private targetOrgArgs(): string[] {
    return this.currentOrg ? ['--target-org', this.currentOrg.username] : [];
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

  private runCli(args: string[], options: RunOptions = {}): Promise<string> {
    const id = this.nextCommandId++;
    const startedAt = Date.now();
    const display = `sf ${args.join(' ')}`;
    this.log('cmd', display);

    const inflight: CommandLogEntry = {
      id,
      startedAt,
      durationMs: null,
      command: 'sf',
      args,
      status: 'running',
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stderrSnippet: null,
      errorMessage: null,
    };
    this.commandEmitter.fire(inflight);

    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        'sf',
        args,
        { timeout: options.timeoutMs ?? 60000, maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          const stdoutBytes = Buffer.byteLength(stdout || '', 'utf8');
          const stderrBytes = Buffer.byteLength(stderr || '', 'utf8');
          const stderrSnippet = stderr ? truncate(stderr.trim(), 400) : null;

          if (error) {
            const code = (error as NodeJS.ErrnoException).code ?? null;
            const finished: CommandLogEntry = {
              ...inflight,
              durationMs,
              status: 'error',
              exitCode: typeof (error as any).code === 'number' ? (error as any).code : null,
              stdoutBytes,
              stderrBytes,
              stderrSnippet,
              errorMessage: error.message,
            };
            this.commandEmitter.fire(finished);
            this.log('error', `${display} → ${error.message}`);
            const wrapped: any = new Error(error.message);
            wrapped.stdout = stdout;
            wrapped.stderr = stderr;
            wrapped.code = code;
            reject(wrapped);
            return;
          }

          this.commandEmitter.fire({
            ...inflight,
            durationMs,
            status: 'success',
            exitCode: 0,
            stdoutBytes,
            stderrBytes,
            stderrSnippet,
            errorMessage: null,
          });
          this.log('ok', `${display} → ${durationMs}ms, ${stdoutBytes}B stdout`);
          resolve(stdout);
        },
      );

      options.cancellation?.onCancellationRequested(() => {
        child.kill();
      });
    });
  }

  private log(level: string, message: string): void {
    this.output.appendLine(`[${level}] ${message}`);
    this.logEmitter.fire({ level, message });
  }

  dispose(): void {
    this.logEmitter.dispose();
    this.commandEmitter.dispose();
  }
}

function mapTestResult(result: any, fallbackClassName: string): TestRunSummary {
  const summary = result?.summary ?? {};
  const tests = Array.isArray(result?.tests) ? result.tests : [];

  const results: TestMethodResult[] = tests.map((t: any) => ({
    className: t.ApexClass?.Name ?? t.apexClass?.name ?? fallbackClassName,
    methodName: t.MethodName ?? t.methodName ?? 'unknown',
    outcome: (t.Outcome ?? t.outcome ?? 'Skip') as TestMethodResult['outcome'],
    runTime: t.RunTime ?? t.runTime ?? 0,
    message: t.Message ?? t.message ?? null,
    stackTrace: t.StackTrace ?? t.stackTrace ?? null,
  }));

  return {
    asyncApexJobId: summary.testRunId ?? summary.TestRunId ?? null,
    status: summary.outcome ?? summary.Outcome ?? 'Unknown',
    testsRan: Number(summary.testsRan ?? summary.TestsRan ?? results.length),
    passing: Number(summary.passing ?? summary.Passing ?? results.filter((r) => r.outcome === 'Pass').length),
    failing: Number(summary.failing ?? summary.Failing ?? results.filter((r) => r.outcome !== 'Pass').length),
    skipped: Number(summary.skipped ?? summary.Skipped ?? 0),
    testTotalTime: Number(summary.testTotalTime ?? summary.TestTotalTime ?? 0),
    results,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
