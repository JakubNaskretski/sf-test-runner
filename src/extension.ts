import * as vscode from 'vscode';
import { SfCliService } from './salesforce/sfCliService';
import { OrgPicker } from './ui/orgPicker';
import { ApexTestCodeLensProvider } from './ui/codeLens';
import { CoverageDecorator, classNameFromUri } from './ui/coverageDecorator';
import { TestTreeProvider } from './ui/testTreeProvider';
import { CommandHistoryProvider, copyCommandToClipboard } from './ui/commandHistoryProvider';
import { CommandLogEntry, TestMethodResult, TestRunSummary } from './types';

const LAST_SELECTED_ORG_KEY = 'sfTestRunner.lastSelectedOrgUsername';

let output: vscode.OutputChannel;
let sfCli: SfCliService;
let orgPicker: OrgPicker;
let coverage: CoverageDecorator;
let results: TestTreeProvider;
let commands: CommandHistoryProvider;
let lastClassRun: string | null = null;

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

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfTestRunner.results', results),
    vscode.window.registerTreeDataProvider('sfTestRunner.commands', commands),
  );

  context.subscriptions.push(
    sfCli.onCommand((entry) => commands.record(entry)),
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
    vscode.commands.registerCommand('sfTestRunner.runLast', () => {
      if (lastClassRun) return runForClassName(lastClassRun);
      void vscode.window.showInformationMessage(
        'No previous test class. Open an Apex class and use "Run Tests in Current Class".',
      );
      return undefined;
    }),
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
    vscode.commands.registerCommand('sfTestRunner.openTestResult', (r: TestMethodResult) =>
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
  await runForClassName(className);
}

async function runForClassName(className: string): Promise<void> {
  if (!sfCli.getCurrentOrg()) {
    void vscode.window.showWarningMessage('Select a Salesforce org first (status bar).');
    return;
  }

  lastClassRun = className;
  output.show(true);
  output.appendLine(`▶ Running tests in ${className}…`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SF Tests: ${className}`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        results.setRunning(true);
        progress.report({ message: 'Enqueueing async test run…' });
        const summary = await sfCli.runApexTests(className, { cancellation: token });
        results.setSummary(summary);
        logSummary(summary);

        if (summary.failing > 0) {
          void vscode.window.showWarningMessage(
            `${summary.failing} of ${summary.testsRan} tests failed in ${className}.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `All ${summary.testsRan} tests passed in ${className} (${summary.testTotalTime}ms).`,
          );
        }

        progress.report({ message: 'Fetching coverage…' });
        const targets = new Set<string>();
        for (const r of summary.results) targets.add(r.className);
        targets.add(className);
        for (const name of targets) {
          const cov = await sfCli.getCoverageForClass(name);
          if (cov) coverage.setCoverage(name, cov);
        }
        coverage.applyTo(vscode.window.activeTextEditor);
      } catch (err) {
        results.setRunning(false);
        handleError(err);
      }
    },
  );
}

async function refreshCoverage(uri?: vscode.Uri, explicitName?: string): Promise<void> {
  if (!sfCli.getCurrentOrg()) {
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
        const cov = await sfCli.getCoverageForClass(className);
        if (!cov) {
          void vscode.window.showInformationMessage(
            `No coverage stored in org for ${className}. Run tests to generate it.`,
          );
          return;
        }
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
  if (!sfCli.getCurrentOrg()) return;
  const cfg = vscode.workspace.getConfiguration('sfTestRunner');
  if (!cfg.get<boolean>('showCoverageOnOpen', true)) return;
  const className = classNameFromUri(editor.document.uri);
  if (!className) return;
  if (coverage.has(className)) {
    coverage.applyTo(editor);
    return;
  }
  try {
    const cov = await sfCli.getCoverageForClass(className);
    if (cov) {
      coverage.setCoverage(className, cov);
      coverage.applyTo(editor);
    }
  } catch {
    // best-effort
  }
}

function openTestResult(r: TestMethodResult): void {
  output.show(true);
  output.appendLine('');
  output.appendLine(`── ${r.className}.${r.methodName} ── ${r.outcome}`);
  if (r.message) output.appendLine(r.message);
  if (r.stackTrace) output.appendLine(r.stackTrace);
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
