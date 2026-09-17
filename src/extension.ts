import * as vscode from 'vscode';
import { SfCliCancelledError, SfCliService } from './salesforce/sfCliService';
import { OrgPicker } from './ui/orgPicker';
import { CommandHistoryProvider, copyCommandToClipboard } from './ui/commandHistoryProvider';
import { ApexTestController, createApexTestController } from './ui/testController';
import { CommandLogEntry, OrgInfo } from './types';
import { RunGuard } from './runGuard';
import { isLikelyProduction } from './kit/orgs';

let output: vscode.OutputChannel;
let sfCli: SfCliService;
let orgPicker: OrgPicker;
let commands: CommandHistoryProvider;
let runGuard: RunGuard;
let testController: ApexTestController;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('SF Tests');
  output.appendLine('SF Test Runner activating…');
  context.subscriptions.push(output);

  sfCli = new SfCliService(output);
  context.subscriptions.push(sfCli);

  // globalState persists the org-list cache so the picker opens instantly in a
  // fresh window.
  orgPicker = new OrgPicker(sfCli, context.globalState);
  context.subscriptions.push(orgPicker);

  commands = new CommandHistoryProvider();
  runGuard = new RunGuard();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfTestRunner.commands', commands),
    sfCli.onCommand((entry) => commands.record(entry)),
  );

  // Test discovery, running and coverage are all VS Code's own UI now; this is
  // the controller behind the Test Explorer, the gutter run icons and the Test
  // Coverage view.
  testController = createApexTestController({
    sfCli,
    output,
    acquireRun,
    releaseRun: () => runGuard.release(),
    revealOutput: maybeShowOutput,
  });
  context.subscriptions.push(testController);

  context.subscriptions.push(
    vscode.commands.registerCommand('sfTestRunner.runAllLocal', () =>
      testController.runAllLocal(true),
    ),
    vscode.commands.registerCommand('sfTestRunner.loadRecentRuns', () => loadRecentRuns()),
    vscode.commands.registerCommand(
      'sfTestRunner.refreshCoverage',
      (uri?: vscode.Uri, className?: string) => loadOrgCoverage(uri, className),
    ),
    // The picker owns the remembered-org key: it writes it on every applied
    // change (pick, family follow, startup), so there's nothing to persist here.
    vscode.commands.registerCommand('sfTestRunner.selectOrg', () => orgPicker.showPicker()),
    vscode.commands.registerCommand('sfTestRunner.refreshOrgs', () => orgPicker.refreshOrgs()),
    vscode.commands.registerCommand('sfTestRunner.clearCommandHistory', () => commands.clear()),
    vscode.commands.registerCommand('sfTestRunner.copyCommand', (node?: unknown) => {
      const entry = extractEntry(node);
      if (entry) void copyCommandToClipboard(entry);
    }),
    vscode.commands.registerCommand('sfTestRunner.showOutput', () => output.show(true)),
  );

  // Non-blocking: activation returns while the org settles.
  void orgPicker.autoSelectDefault().catch(() => undefined);
}

export function deactivate(): void {
  // disposables clean themselves up
}

/**
 * Everything that must be true before a run starts: a target org, the user's
 * consent when that org is production, and the single-run guard. Returns the org
 * username to run against, or null when the run must not start — in which case
 * the user has already been told why.
 *
 * The org is returned (rather than read again later) so a run started against org
 * A finishes against org A even if the user switches orgs while it is running.
 */
async function acquireRun(): Promise<string | null> {
  const org = sfCli.getCurrentOrg();
  if (!org) {
    void vscode.window.showWarningMessage('Select a Salesforce org first (status bar).');
    return null;
  }
  // Ask before anything else happens, so backing out leaves no state behind: no
  // guard held, no output revealed, no run in the Test Explorer.
  if (!(await confirmProductionRun(org))) return null;
  // tryAcquire is atomic, so of two entry points racing here only one starts a
  // run — the other is told one is already in progress.
  if (!runGuard.tryAcquire()) {
    void vscode.window.showWarningMessage(
      'A test run is already in progress. Wait for it to finish.',
    );
    return null;
  }
  return org.username;
}

/**
 * Modal confirmation before any run against production. The kit treats an
 * unknown org as production too (over-warn), so a run fired before the org list
 * has settled still asks. Anything other than the confirm button — Cancel, Esc,
 * dismissal — aborts the run silently; the user knows what they just declined.
 */
async function confirmProductionRun(org: OrgInfo): Promise<boolean> {
  if (!isLikelyProduction(org)) return true;
  const confirm = 'Run Tests';
  const pick = await vscode.window.showWarningMessage(
    `Run tests against PRODUCTION org ${org.alias}?`,
    { modal: true, detail: org.username },
    confirm,
  );
  return pick === confirm;
}

/**
 * Surface runs this extension did NOT start (terminal, CI, another tool — or a
 * run lost to a window reload): list the org's recent async runs, load the picked
 * one, and publish it as a real test run so it lands in the same UI.
 */
async function loadRecentRuns(): Promise<void> {
  const org = sfCli.getCurrentOrg();
  if (!org) {
    void vscode.window.showWarningMessage('Select a Salesforce org first (status bar).');
    return;
  }
  // The guard is claimed only once a run is actually picked, so it must be
  // released only then too: RunGuard.release() is unconditional, and releasing
  // one we never took would free somebody else's in-flight run.
  let holdsGuard = false;
  try {
    const runs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'SF Tests: loading recent runs…' },
      () => sfCli.listRecentTestRuns(org.username),
    );
    if (runs.length === 0) {
      void vscode.window.showInformationMessage('No async test runs found in the org.');
      return;
    }
    const items = runs.map((r) => ({
      label: `$(beaker) ${r.startTime ? new Date(r.startTime).toLocaleString() : r.testRunId}`,
      description: `${r.status} · ${r.methodsFailed} failed / ${r.methodsCompleted} run · ${r.testRunId}`,
      run: r,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Load a recent test run (includes runs started outside VS Code)',
      matchOnDescription: true,
    });
    if (!pick) return;
    // Claimed only now: holding the single-run guard while the picker sat open
    // made every other run refuse with "a test run is already in progress".
    if (!runGuard.tryAcquire()) {
      void vscode.window.showWarningMessage(
        'A test run is already in progress. Wait for it to finish.',
      );
      return;
    }
    holdsGuard = true;
    maybeShowOutput();
    output.appendLine(`▶ Loading test run ${pick.run.testRunId}…`);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SF Tests: loading run ${pick.run.testRunId}`,
        cancellable: true,
      },
      async (_progress, token) => {
        const { summary, coverage } = await sfCli.getTestRun(pick.run.testRunId, org.username, {
          cancellation: token,
        });
        // Named for what it is: a run from the org's history, not one we started.
        await testController.publishLoadedRun(
          `${org.username} · loaded run ${pick.run.testRunId}`,
          summary,
          coverage,
        );
      },
    );
  } catch (err) {
    if (!(err instanceof SfCliCancelledError)) handleError(err);
  } finally {
    if (holdsGuard) runGuard.release();
  }
}

/**
 * The one path to coverage that is not a run: the org's stored
 * `ApexCodeCoverageAggregate` for a class — the most recent run that touched it,
 * whoever started it. Published as a coverage-only run whose name says exactly
 * that, so it can never be mistaken for the user's own numbers.
 */
async function loadOrgCoverage(uri?: vscode.Uri, explicitName?: string): Promise<void> {
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
          void vscode.window.showInformationMessage(
            `No coverage stored in org for ${className}. Run tests to generate it.`,
          );
          return;
        }
        const total = cov.numLinesCovered + cov.numLinesUncovered;
        const pct = total === 0 ? 0 : Math.round((cov.numLinesCovered * 100) / total);
        await testController.publishOrgCoverage(
          `${org.username} · ${className} coverage from org (last run, any user)`,
          [cov],
        );
        output.appendLine(
          `Coverage for ${className} (org's last run, any user): ${pct}% covered ` +
            `(${cov.numLinesCovered}/${total} lines)`,
        );
        void vscode.window.showInformationMessage(
          `${className}: ${pct}% covered in the org (${cov.numLinesCovered}/${total} lines, ` +
            'last run by anyone). Open the Test Coverage view to see it.',
        );
      } catch (err) {
        // A failed query says nothing about whether the class has coverage: it is
        // an error, not the "no coverage stored" note.
        handleError(err);
      }
    },
  );
}

/** Reveal the output channel for work the user started, unless they turned the
 *  auto-reveal off. */
function maybeShowOutput(): void {
  const cfg = vscode.workspace.getConfiguration('sfTestRunner');
  if (cfg.get<boolean>('autoShowOutput', true)) output.show(true);
}

function handleError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  output.appendLine(`✗ Error: ${message}`);
  void vscode.window.showErrorMessage(`SF Tests: ${message}`, 'Show Output').then((pick) => {
    if (pick === 'Show Output') output.show(true);
  });
}

function classNameFromUri(uri: vscode.Uri): string | null {
  const match = uri.fsPath.match(/([^/\\]+)\.cls$/i);
  return match ? match[1] : null;
}

function extractEntry(node: unknown): CommandLogEntry | null {
  if (!node || typeof node !== 'object') return null;
  const candidate = node as { entry?: CommandLogEntry; command?: unknown; args?: unknown };
  if (candidate.entry) return candidate.entry;
  if (candidate.command && candidate.args) return node as CommandLogEntry;
  return null;
}
