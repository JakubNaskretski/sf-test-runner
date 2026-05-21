import * as vscode from 'vscode';
import { AuthError, createConnection, getOrgInfo } from './salesforce/auth';
import { getCoverageForClass } from './salesforce/coverage';
import { runTestsForClass } from './salesforce/testRunner';
import { ApexTestCodeLensProvider } from './ui/codeLens';
import { CoverageDecorator, classNameFromUri } from './ui/coverageDecorator';
import { TestTreeProvider } from './ui/testTreeProvider';
import { TestMethodResult, TestRunSummary } from './types';

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let coverage: CoverageDecorator;
let treeProvider: TestTreeProvider;
let lastClassRun: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('SF Tests');
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'sfTestRunner.selectOrg';
  statusBar.text = '$(beaker) SF: (no org)';
  statusBar.tooltip = 'Click to choose target org';
  statusBar.show();
  context.subscriptions.push(statusBar);

  coverage = new CoverageDecorator();
  context.subscriptions.push(coverage);

  treeProvider = new TestTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfTestRunner.results', treeProvider),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'apex' },
        { pattern: '**/*.cls' },
      ],
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
    vscode.commands.registerCommand('sfTestRunner.runAll', () => {
      if (lastClassRun) {
        return runForClassName(lastClassRun);
      }
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
    vscode.commands.registerCommand('sfTestRunner.selectOrg', () => selectOrg()),
    vscode.commands.registerCommand(
      'sfTestRunner.openTestResult',
      (result: TestMethodResult) => openTestResult(result),
    ),
  );

  void refreshStatusBar();
  void maybeAutoLoadCoverage(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // disposables handle cleanup
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
  lastClassRun = className;
  output.show(true);
  output.appendLine(`▶ Running tests in ${className}...`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SF Tests: ${className}`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        treeProvider.setRunning(true);
        const org = await getOrgInfo(targetOrgSetting());
        statusBar.text = `$(beaker) SF: ${org.alias ?? org.username}`;
        const conn = createConnection(org);

        const summary = await runTestsForClass(conn, className, progress, token);
        treeProvider.setSummary(summary);
        logSummary(summary);

        if (summary.results.some((r) => r.outcome !== 'Pass')) {
          void vscode.window.showWarningMessage(
            `${summary.methodsFailed} of ${summary.methodsCompleted} tests failed in ${className}.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `All ${summary.methodsCompleted} tests passed in ${className} (${summary.testTime}ms).`,
          );
        }

        progress.report({ message: 'Fetching coverage...' });
        const classesUnderTest = new Set<string>();
        for (const r of summary.results) {
          classesUnderTest.add(r.className);
        }
        for (const name of classesUnderTest) {
          const cov = await getCoverageForClass(conn, name);
          if (cov) coverage.setCoverage(name, cov);
        }
        coverage.applyTo(vscode.window.activeTextEditor);
      } catch (err) {
        treeProvider.setRunning(false);
        handleError(err);
      }
    },
  );
}

async function refreshCoverage(uri?: vscode.Uri, explicitName?: string): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  const className =
    explicitName ?? (target ? classNameFromUri(target) : null);
  if (!className) {
    void vscode.window.showWarningMessage('No Apex class selected.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Coverage: ${className}` },
    async () => {
      try {
        const org = await getOrgInfo(targetOrgSetting());
        const conn = createConnection(org);
        const cov = await getCoverageForClass(conn, className);
        if (!cov) {
          void vscode.window.showInformationMessage(
            `No coverage stored in org for ${className}. Run tests to generate it.`,
          );
          return;
        }
        coverage.setCoverage(className, cov);
        coverage.applyTo(vscode.window.activeTextEditor);
        const pct =
          cov.numLinesCovered + cov.numLinesUncovered === 0
            ? 0
            : Math.round(
                (cov.numLinesCovered * 100) /
                  (cov.numLinesCovered + cov.numLinesUncovered),
              );
        output.appendLine(
          `Coverage for ${className}: ${cov.numLinesCovered}/${
            cov.numLinesCovered + cov.numLinesUncovered
          } lines (${pct}%)`,
        );
      } catch (err) {
        handleError(err);
      }
    },
  );
}

async function selectOrg(): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: 'Target org alias or username (leave blank to use sf default-org)',
    value: targetOrgSetting() ?? '',
  });
  if (input === undefined) return;
  await vscode.workspace
    .getConfiguration('sfTestRunner')
    .update('targetOrg', input, vscode.ConfigurationTarget.Workspace);
  await refreshStatusBar();
}

async function refreshStatusBar(): Promise<void> {
  try {
    const org = await getOrgInfo(targetOrgSetting());
    statusBar.text = `$(beaker) SF: ${org.alias ?? org.username}`;
    statusBar.tooltip = `${org.username}\n${org.instanceUrl}\nClick to change`;
  } catch {
    statusBar.text = '$(beaker) SF: (no org)';
    statusBar.tooltip = 'Click to set target org. Requires sf CLI auth.';
  }
}

async function maybeAutoLoadCoverage(
  editor: vscode.TextEditor | undefined,
): Promise<void> {
  if (!editor) return;
  if (!editor.document.fileName.toLowerCase().endsWith('.cls')) return;
  const cfg = vscode.workspace.getConfiguration('sfTestRunner');
  if (!cfg.get<boolean>('showCoverageOnOpen', true)) return;
  const className = classNameFromUri(editor.document.uri);
  if (!className || coverage.has(className)) {
    coverage.applyTo(editor);
    return;
  }
  try {
    const org = await getOrgInfo(targetOrgSetting());
    const conn = createConnection(org);
    const cov = await getCoverageForClass(conn, className);
    if (cov) {
      coverage.setCoverage(className, cov);
      coverage.applyTo(editor);
    }
  } catch {
    // silent — auto-load best-effort
  }
}

function openTestResult(result: TestMethodResult): void {
  output.show(true);
  output.appendLine('');
  output.appendLine(`── ${result.className}.${result.methodName} ── ${result.outcome}`);
  if (result.message) output.appendLine(result.message);
  if (result.stackTrace) output.appendLine(result.stackTrace);
}

function logSummary(summary: TestRunSummary): void {
  output.appendLine('');
  output.appendLine(
    `Result: ${summary.status} · ${summary.methodsCompleted - summary.methodsFailed}/${
      summary.methodsCompleted
    } passed · ${summary.testTime}ms`,
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
  if (err instanceof AuthError && err.hint) {
    output.appendLine(`  Hint: ${err.hint}`);
    void vscode.window.showErrorMessage(`SF Tests: ${message}`, 'Show Output').then((pick) => {
      if (pick === 'Show Output') output.show(true);
    });
    return;
  }
  void vscode.window.showErrorMessage(`SF Tests: ${message}`);
}

function targetOrgSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration('sfTestRunner').get<string>('targetOrg');
  return v && v.trim() ? v.trim() : undefined;
}
