import * as vscode from 'vscode';
import { SfCliCancelledError, SfCliService, TestRunResult } from './salesforce/sfCliService';
import { OrgPicker } from './ui/orgPicker';
import { ApexTestCodeLensProvider } from './ui/codeLens';
import { CoverageDecorator, classNameFromUri } from './ui/coverageDecorator';
import { TestTreeProvider } from './ui/testTreeProvider';
import { CommandHistoryProvider, copyCommandToClipboard } from './ui/commandHistoryProvider';
import { CommandLogEntry, TestMethodResult, TestRunSummary } from './types';
import { RunGuard } from './runGuard';
import { primaryFrame } from './salesforce/stackParser';

const LAST_SELECTED_ORG_KEY = 'sfTestRunner.lastSelectedOrgUsername';

let output: vscode.OutputChannel;
let sfCli: SfCliService;
let orgPicker: OrgPicker;
let coverage: CoverageDecorator;
let results: TestTreeProvider;
let commands: CommandHistoryProvider;
let diagnostics: vscode.DiagnosticCollection;
let runGuard: RunGuard;
let lastClassRun: string | null = null;
/** The most recent run's summary, for "re-run failed only". */
let lastSummary: TestRunSummary | null = null;
/** Classes known to have no stored coverage, plus in-flight lookups — without
 *  this, every tab focus of an uncovered class spawns another `sf data query`. */
const coverageKnownAbsent = new Set<string>();
const coverageLoading = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('SF Tests');
  output.appendLine('SF Test Runner activating…');
  context.subscriptions.push(output);

  sfCli = new SfCliService(output);
  context.subscriptions.push(sfCli);

  orgPicker = new OrgPicker(sfCli);
  context.subscriptions.push(orgPicker);

  coverage = new CoverageDecorator();
  context.subscriptions.push(coverage);

  results = new TestTreeProvider();
  commands = new CommandHistoryProvider();
  runGuard = new RunGuard();

  diagnostics = vscode.languages.createDiagnosticCollection('sfTestRunner');
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfTestRunner.results', results),
    vscode.window.registerTreeDataProvider('sfTestRunner.commands', commands),
  );

  context.subscriptions.push(
    sfCli.onCommand((entry) => commands.record(entry)),
  );

  // Org switch (our pick OR an external shared-setting change) invalidates all
  // org-scoped state: cached coverage, the results tree, decorations, and test
  // failure diagnostics.
  context.subscriptions.push(
    orgPicker.onOrgChanged(() => {
      coverage.clear();
      results.reset();
      diagnostics.clear();
      lastSummary = null;
      lastClassRun = null;
      coverageKnownAbsent.clear();
      coverage.applyTo(vscode.window.activeTextEditor);
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'apex' }, { pattern: '**/*.cls' }],
      new ApexTestCodeLensProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      coverage.applyTo(editor);
      void maybeAutoLoadCoverage(editor);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfTestRunner.runCurrentClass', (uri?: vscode.Uri) =>
      runCurrentClass(uri),
    ),
    vscode.commands.registerCommand('sfTestRunner.runTestMethod', (className?: string, methodName?: string) =>
      runTestMethod(className, methodName),
    ),
    vscode.commands.registerCommand('sfTestRunner.runLast', () => {
      if (lastClassRun) return runForClass(lastClassRun);
      void vscode.window.showInformationMessage(
        'No previous test class. Open an Apex class and use "Run Tests in Current Class".',
      );
      return undefined;
    }),
    vscode.commands.registerCommand('sfTestRunner.rerunFailed', () => rerunFailed()),
    vscode.commands.registerCommand(
      'sfTestRunner.refreshCoverage',
      (uri?: vscode.Uri, className?: string) => refreshCoverage(uri, className),
    ),
    vscode.commands.registerCommand('sfTestRunner.clearCoverage', () => coverage.clear()),
    vscode.commands.registerCommand('sfTestRunner.selectOrg', async () => {
      await orgPicker.showPicker();
      const org = sfCli.getCurrentOrg();
      if (org) {
        await context.globalState.update(LAST_SELECTED_ORG_KEY, org.username);
      }
    }),
    vscode.commands.registerCommand('sfTestRunner.openTestResult', (r?: TestMethodResult) =>
      openTestResult(r),
    ),
    vscode.commands.registerCommand('sfTestRunner.clearCommandHistory', () => commands.clear()),
    vscode.commands.registerCommand('sfTestRunner.copyCommand', (node?: any) => {
      const entry = extractEntry(node);
      if (entry) void copyCommandToClipboard(entry);
    }),
    vscode.commands.registerCommand('sfTestRunner.showOutput', () => output.show(true)),
  );

  const remembered = context.globalState.get<string>(LAST_SELECTED_ORG_KEY);
  void orgPicker.autoSelectDefault(remembered);
  void maybeAutoLoadCoverage(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // disposables clean themselves up
}

async function runCurrentClass(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    void vscode.window.showWarningMessage('Open an Apex .cls file first.');
    return;
  }
  const className = classNameFromUri(target);
  if (!className) {
    void vscode.window.showWarningMessage('Active file is not an Apex .cls class.');
    return;
  }
  await runForClass(className);
}

async function runForClass(className: string): Promise<void> {
  await runTests(
    className,
    (orgUsername, token) => sfCli.runApexTests(className, orgUsername, { cancellation: token }),
    () => {
      lastClassRun = className;
    },
  );
}

async function runTestMethod(className?: string, methodName?: string): Promise<void> {
  if (!className || !methodName) {
    void vscode.window.showWarningMessage('No test method selected.');
    return;
  }
  const label = `${className}.${methodName}`;
  await runTests(
    label,
    (orgUsername, token) =>
      sfCli.runApexTestMethods([label], orgUsername, { cancellation: token }),
    () => {
      lastClassRun = className;
    },
  );
}

async function rerunFailed(): Promise<void> {
  if (!lastSummary) {
    void vscode.window.showInformationMessage('No previous run to re-run failures from.');
    return;
  }
  const failed = lastSummary.results.filter(
    (r) => r.outcome === 'Fail' || r.outcome === 'CompileFail',
  );
  if (failed.length === 0) {
    void vscode.window.showInformationMessage('No failing tests in the last run.');
    return;
  }
  const tests = failed.map((r) => `${r.className}.${r.methodName}`);
  await runTests(
    `${tests.length} failed test${tests.length === 1 ? '' : 's'}`,
    (orgUsername, token) => sfCli.runApexTestMethods(tests, orgUsername, { cancellation: token }),
    () => undefined,
  );
}

/**
 * Shared run pipeline. Claims the single-run guard synchronously (rejecting
 * overlapping runs), captures the org username at start and threads it into the
 * run, decorates the classes under test from the run's INLINE coverage, and
 * publishes failure diagnostics.
 */
async function runTests(
  label: string,
  run: (orgUsername: string, token: vscode.CancellationToken) => Promise<TestRunResult>,
  onStart: () => void,
): Promise<void> {
  const org = sfCli.getCurrentOrg();
  if (!org) {
    void vscode.window.showWarningMessage('Select a Salesforce org first (status bar).');
    return;
  }
  // Claim the guard synchronously, before any await, so two entry points can't
  // both start a run.
  if (!runGuard.tryAcquire()) {
    void vscode.window.showWarningMessage('A test run is already in progress. Wait for it to finish.');
    return;
  }

  // Capture the org at run start; every follow-up call of this run uses it, so a
  // mid-run org switch can't retarget the run.
  const orgUsername = org.username;
  onStart();
  output.show(true);
  output.appendLine(`▶ Running tests: ${label}…`);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SF Tests: ${label}`,
        cancellable: true,
      },
      async (progress, token) => {
        results.setRunning(true);
        progress.report({ message: 'Enqueueing async test run…' });
        const { summary, coverage: runCoverage } = await run(orgUsername, token);
        results.setSummary(summary);
        lastSummary = summary;
        logSummary(summary);
        await publishDiagnostics(summary);

        if (summary.failing > 0) {
          void vscode.window.showWarningMessage(
            `${summary.failing} of ${summary.testsRan} tests failed (${label}).`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `All ${summary.testsRan} tests passed (${label}, ${summary.testTotalTime}ms).`,
          );
        }

        // Decorate the classes UNDER TEST straight from the run's --code-coverage
        // output — no post-run ApexCodeCoverageAggregate query.
        progress.report({ message: 'Applying coverage…' });
        for (const [, info] of runCoverage) {
          coverage.setCoverage(info.className, info);
        }
        // The run wrote fresh coverage org-side — previous "absent" answers are stale.
        coverageKnownAbsent.clear();
        coverage.applyTo(vscode.window.activeTextEditor);
      },
    );
  } catch (err) {
    results.setRunning(false);
    if (err instanceof SfCliCancelledError) {
      output.appendLine('✕ Run cancelled. An already-queued test job may still finish in the org.');
      void vscode.window.showInformationMessage(`SF Tests: run cancelled (${label}).`);
    } else {
      handleError(err);
    }
  } finally {
    runGuard.release();
  }
}

async function refreshCoverage(uri?: vscode.Uri, explicitName?: string): Promise<void> {
  const org = sfCli.getCurrentOrg();
  if (!org) {
    void vscode.window.showWarningMessage('Select a Salesforce org first (status bar).');
    return;
  }
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  const className = explicitName ?? (target ? classNameFromUri(target) : null);
  if (!className) {
    void vscode.window.showWarningMessage('No Apex class selected.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Coverage: ${className}` },
    async () => {
      try {
        const cov = await sfCli.getCoverageForClass(className, org.username);
        if (!cov) {
          coverageKnownAbsent.add(className.toLowerCase());
          void vscode.window.showInformationMessage(
            `No coverage stored in org for ${className}. Run tests to generate it.`,
          );
          return;
        }
        coverageKnownAbsent.delete(className.toLowerCase());
        coverage.setCoverage(className, cov);
        coverage.applyTo(vscode.window.activeTextEditor);
        const total = cov.numLinesCovered + cov.numLinesUncovered;
        const pct = total === 0 ? 0 : Math.round((cov.numLinesCovered * 100) / total);
        output.appendLine(
          `Coverage for ${className}: ${cov.numLinesCovered}/${total} lines (${pct}%)`,
        );
      } catch (err) {
        handleError(err);
      }
    },
  );
}

async function maybeAutoLoadCoverage(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor) return;
  if (!editor.document.fileName.toLowerCase().endsWith('.cls')) return;
  const org = sfCli.getCurrentOrg();
  if (!org) return;
  const cfg = vscode.workspace.getConfiguration('sfTestRunner');
  if (!cfg.get<boolean>('showCoverageOnOpen', true)) return;
  const className = classNameFromUri(editor.document.uri);
  if (!className) return;
  if (coverage.has(className)) {
    coverage.applyTo(editor);
    return;
  }
  const key = className.toLowerCase();
  if (coverageKnownAbsent.has(key) || coverageLoading.has(key)) return;
  coverageLoading.add(key);
  try {
    const cov = await sfCli.getCoverageForClass(className, org.username);
    if (cov) {
      coverage.setCoverage(className, cov);
      coverage.applyTo(editor);
    } else {
      coverageKnownAbsent.add(key);
    }
  } catch {
    // best-effort
  } finally {
    coverageLoading.delete(key);
  }
}

function openTestResult(r?: TestMethodResult): void {
  // Palette-invoked with no argument — guard instead of throwing.
  if (!r) {
    void vscode.window.showInformationMessage(
      'Open a test result from the Test Results tree, not the Command Palette.',
    );
    return;
  }
  output.show(true);
  output.appendLine('');
  output.appendLine(`── ${r.className}.${r.methodName} ── ${r.outcome}`);
  if (r.message) output.appendLine(r.message);
  if (r.stackTrace) output.appendLine(r.stackTrace);
  // Jump to the failure's source line when we can parse the stack.
  void jumpToFailure(r);
}

/**
 * Parse the failure's stack, find the deepest frame in the failing class, open
 * that `.cls`/`.trigger` at the line, and reveal it. Best-effort: silent when the
 * stack has no parseable frame or the file isn't in the workspace.
 */
async function jumpToFailure(r: TestMethodResult): Promise<void> {
  if (r.outcome === 'Pass') return;
  const frame = primaryFrame(r.stackTrace, r.className);
  if (!frame) return;
  const uri = await findApexFile(frame.className, frame.isTrigger);
  if (!uri) return;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const lineIdx = Math.max(0, frame.line - 1);
    const pos = new vscode.Position(lineIdx, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch {
    // best-effort
  }
}

/**
 * Publish a Problems diagnostic per failing test at its stack line, so failures
 * are navigable from the Problems panel. Rebuilt each run; awaited by the run
 * pipeline so a following run's clear() can't interleave with a late publish.
 */
async function publishDiagnostics(summary: TestRunSummary): Promise<void> {
  diagnostics.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  const pending: Promise<void>[] = [];

  for (const r of summary.results) {
    if (r.outcome === 'Pass' || r.outcome === 'Skip') continue;
    const frame = primaryFrame(r.stackTrace, r.className);
    pending.push(
      (async () => {
        const uri = frame
          ? await findApexFile(frame.className, frame.isTrigger)
          : await findApexFile(r.className, false);
        if (!uri) return;
        const line = Math.max(0, (frame?.line ?? 1) - 1);
        const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        const message = r.message
          ? `${r.methodName}: ${r.message}`
          : `${r.methodName}: ${r.outcome}`;
        const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diag.source = 'SF Tests';
        const key = uri.toString();
        const arr = byUri.get(key) ?? [];
        arr.push(diag);
        byUri.set(key, arr);
      })(),
    );
  }

  await Promise.all(pending);
  for (const [key, diags] of byUri) {
    diagnostics.set(vscode.Uri.parse(key), diags);
  }
}

/** Resolve an Apex class/trigger name to its source file in the workspace. */
async function findApexFile(name: string, isTrigger: boolean): Promise<vscode.Uri | undefined> {
  const ext = isTrigger ? 'trigger' : 'cls';
  const matches = await vscode.workspace.findFiles(`**/${name}.${ext}`, '**/node_modules/**', 1);
  return matches[0];
}

function logSummary(summary: TestRunSummary): void {
  output.appendLine('');
  output.appendLine(
    `Result: ${summary.status} · ${summary.passing}/${summary.testsRan} passed · ${summary.testTotalTime}ms`,
  );
  for (const r of summary.results) {
    const mark = r.outcome === 'Pass' ? '✓' : '✗';
    output.appendLine(`  ${mark} ${r.className}.${r.methodName} (${r.runTime}ms)`);
    if (r.outcome !== 'Pass' && r.message) {
      output.appendLine(`     ${r.message}`);
    }
  }
}

function handleError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  output.appendLine(`✗ Error: ${message}`);
  void vscode.window
    .showErrorMessage(`SF Tests: ${message}`, 'Show Output')
    .then((pick) => {
      if (pick === 'Show Output') output.show(true);
    });
}

function extractEntry(node: any): CommandLogEntry | null {
  if (!node) return null;
  if (node.entry) return node.entry as CommandLogEntry;
  if (node.command && node.args) return node as CommandLogEntry;
  return null;
}
