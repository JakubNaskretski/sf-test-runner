import * as vscode from 'vscode';
import { SfCliCancelledError, SfCliService, TestRunResult } from './salesforce/sfCliService';
import { OrgPicker } from './ui/orgPicker';
import { ApexTestCodeLensProvider } from './ui/codeLens';
import { CoverageDecorator, classNameFromUri } from './ui/coverageDecorator';
import { TestTreeProvider, classNameFromNode, methodFromNode } from './ui/testTreeProvider';
import { CommandHistoryProvider, copyCommandToClipboard } from './ui/commandHistoryProvider';
import { CommandLogEntry, CoverageInfo, OrgInfo, TestMethodResult, TestRunSummary } from './types';
import { RunGuard } from './runGuard';
import { primaryFrame } from './salesforce/stackParser';
import { overallCoveragePercent } from './salesforce/coverageMapping';
import { hasApexTests } from './salesforce/testMethods';
import { isLikelyProduction } from './kit/orgs';
import { sameOrg } from './orgMatch';

/** Gates the editor-title run button: an Apex file with no tests in it gets no
 *  button, so the toolbar isn't offering a run that can only fail. */
const HAS_TESTS_CONTEXT_KEY = 'sfTestRunner.activeFileHasTests';

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
/** The org `lastSummary` was produced against. "Re-run failed" refuses to
 *  replay a run's failures against a DIFFERENT org, and a run finishing after an
 *  org switch is labelled (not silently attributed to the current org) with it. */
let lastRunOrg: string | null = null;
/** Classes known to have no stored coverage, plus in-flight lookups — without
 *  this, every tab focus of an uncovered class spawns another `sf data query`. */
const coverageKnownAbsent = new Set<string>();
const coverageLoading = new Set<string>();
/** Classes whose background coverage lookup FAILED (as opposed to "no coverage
 *  stored"). Without this, a persistent CLI failure (expired auth, org gone)
 *  re-spawns `sf data query` on every tab focus. Cleared by anything that could
 *  change the answer: a run, an explicit refresh, an org switch. */
const coverageLoadFailed = new Set<string>();
let coverageStatusItem: vscode.StatusBarItem;
/** "Clear Coverage Decorations" is meant to stay cleared: without this, the next
 *  tab focus auto-loads the coverage straight back. Reset by anything that means
 *  the user wants coverage again (a run, an explicit refresh, an org switch). */
let coverageCleared = false;

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

  coverage = new CoverageDecorator();
  context.subscriptions.push(coverage);

  results = new TestTreeProvider();
  commands = new CommandHistoryProvider();
  runGuard = new RunGuard();

  diagnostics = vscode.languages.createDiagnosticCollection('sfTestRunner');
  context.subscriptions.push(diagnostics);

  // A TreeView (not just a data provider) so the results can carry a subtitle
  // naming the org they came from — kept in sync on every tree change.
  const resultsView = vscode.window.createTreeView('sfTestRunner.results', {
    treeDataProvider: results,
  });
  context.subscriptions.push(
    resultsView,
    results.onDidChangeTreeData(() => {
      resultsView.message = results.headerMessage;
    }),
    vscode.window.registerTreeDataProvider('sfTestRunner.commands', commands),
  );

  context.subscriptions.push(
    sfCli.onCommand((entry) => commands.record(entry)),
  );

  // Org switch (our own pick, or an adopted family switch when
  // `sfTestRunner.syncOrgWithFamily` is on) invalidates all
  // org-scoped state: cached coverage, the results tree, decorations, and test
  // failure diagnostics.
  context.subscriptions.push(
    orgPicker.onOrgChanged(() => {
      coverage.clear();
      results.reset();
      diagnostics.clear();
      lastSummary = null;
      lastRunOrg = null;
      lastClassRun = null;
      coverageKnownAbsent.clear();
      coverageLoadFailed.clear();
      coverageCleared = false;
      coverage.applyTo(vscode.window.activeTextEditor);
    }),
  );

  // One-click coverage visibility next to the org picker: `$(eye) 78%` for the
  // active class when data is loaded, `$(eye-closed)` when painting is off.
  coverageStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  coverageStatusItem.command = 'sfTestRunner.toggleInlineCoverage';
  context.subscriptions.push(
    coverageStatusItem,
    coverage.onDidChange(() => updateCoverageStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('sfTestRunner.showInlineCoverage')) return;
      // The toggle (or a hand edit of the setting) takes effect immediately:
      // painting off wipes decorations but keeps the cache, on repaints from it.
      const enabled = inlineCoverageEnabled();
      coverage.setEnabled(enabled);
      // Turning painting on is a request to see coverage — re-arm the auto-load
      // for the file in front of the user (no-op when it's already cached).
      if (enabled) void maybeAutoLoadCoverage(vscode.window.activeTextEditor);
      updateCoverageStatus();
    }),
  );
  coverage.setEnabled(inlineCoverageEnabled());
  updateCoverageStatus();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'apex' }, { pattern: '**/*.cls' }],
      new ApexTestCodeLensProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      coverage.applyTo(editor);
      updateCoverageStatus();
      void updateHasTestsContext(editor);
      void maybeAutoLoadCoverage(editor);
    }),
    // A file becomes (or stops being) a test class as it is edited; the save is
    // the point where re-scanning is cheap and the answer is stable.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && doc === editor.document) void updateHasTestsContext(editor);
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
    vscode.commands.registerCommand('sfTestRunner.runAllLocal', () => runAllLocalTests()),
    vscode.commands.registerCommand('sfTestRunner.runClassFromTree', (node?: any) => {
      const className = classNameFromNode(node);
      if (!className) {
        void vscode.window.showInformationMessage(
          'Run a class from the Test Results tree, not the Command Palette.',
        );
        return undefined;
      }
      if (refuseCrossOrgRerun()) return undefined;
      return runForClass(className);
    }),
    vscode.commands.registerCommand('sfTestRunner.rerunMethodFromTree', (node?: any) => {
      const method = methodFromNode(node);
      if (!method) {
        void vscode.window.showInformationMessage(
          'Run a test method from the Test Results tree, not the Command Palette.',
        );
        return undefined;
      }
      if (refuseCrossOrgRerun()) return undefined;
      return runTestMethod(method.className, method.methodName);
    }),
    vscode.commands.registerCommand('sfTestRunner.loadRecentRuns', () => loadRecentRuns()),
    vscode.commands.registerCommand(
      'sfTestRunner.refreshCoverage',
      (uri?: vscode.Uri, className?: string) => refreshCoverage(uri, className),
    ),
    vscode.commands.registerCommand('sfTestRunner.clearCoverage', () => {
      coverageCleared = true;
      coverage.clear();
    }),
    vscode.commands.registerCommand('sfTestRunner.toggleInlineCoverage', async () => {
      const cfg = vscode.workspace.getConfiguration('sfTestRunner');
      const next = !cfg.get<boolean>('showInlineCoverage', true);
      // Write to the scope that currently defines the value — a Global write
      // under a workspace-level setting would be shadowed and the button dead.
      const info = cfg.inspect<boolean>('showInlineCoverage');
      const target =
        info?.workspaceFolderValue !== undefined
          ? vscode.ConfigurationTarget.WorkspaceFolder
          : info?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
      // The onDidChangeConfiguration listener does the repaint + status refresh.
      await cfg.update('showInlineCoverage', next, target);
    }),
    // The picker owns the remembered-org key: it writes it on every applied
    // change (pick, family follow, startup), so there's nothing to persist here.
    vscode.commands.registerCommand('sfTestRunner.selectOrg', () => orgPicker.showPicker()),
    vscode.commands.registerCommand('sfTestRunner.refreshOrgs', () => orgPicker.refreshOrgs()),
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

  void updateHasTestsContext(vscode.window.activeTextEditor);

  // The auto-load needs the org, which autoSelectDefault only settles
  // asynchronously — chained, not fired alongside, or it always no-ops. Still
  // non-blocking: activation returns while this runs.
  void orgPicker
    .autoSelectDefault()
    .then(() => maybeAutoLoadCoverage(vscode.window.activeTextEditor))
    .catch(() => undefined);
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

async function runAllLocalTests(): Promise<void> {
  await runTests(
    'all local tests',
    (orgUsername, token) => sfCli.runAllLocalTests(orgUsername, { cancellation: token }),
    // lastClassRun stays put: "Re-run Last Class" means the last CLASS, and a
    // whole-org run is not one.
    () => undefined,
  );
}

async function rerunFailed(): Promise<void> {
  if (!lastSummary) {
    void vscode.window.showInformationMessage('No previous run to re-run failures from.');
    return;
  }
  if (refuseCrossOrgRerun()) return;
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
 * Shared run pipeline for every entry point. Confirms a production target,
 * claims the single-run guard (rejecting overlapping runs), captures the org
 * username at start and threads it into the run, decorates the classes under
 * test from the run's INLINE coverage, and publishes failure diagnostics.
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
  // Ask before anything else happens, so backing out leaves no state behind: no
  // guard held, no output revealed, no toast.
  if (!(await confirmProductionRun(org))) return;
  // tryAcquire is atomic, so of two entry points racing here only one starts a
  // run — the other is told one is already in progress.
  if (!runGuard.tryAcquire()) {
    void vscode.window.showWarningMessage('A test run is already in progress. Wait for it to finish.');
    return;
  }

  // Capture the org at run start; every follow-up call of this run uses it, so a
  // mid-run org switch can't retarget the run.
  const orgUsername = org.username;
  onStart();
  maybeShowOutput();
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
        await applyRunOutcome(summary, runCoverage, orgUsername);

        const pct = overallCoveragePercent(runCoverage);
        const covered = pct === null ? '' : ` · coverage ${pct}%`;
        if (summary.failing > 0) {
          void vscode.window.showWarningMessage(
            `${summary.failing} of ${summary.testsRan} tests failed (${label})${covered}.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `All ${summary.testsRan} tests passed (${label}, ${summary.testTotalTime}ms)${covered}.`,
          );
        }

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

/**
 * The displayed results may target a different org than the current one (a run
 * can finish after an org switch). Re-running anything FROM those results —
 * failed set, a tree class, a tree method — would replay one org's outcome
 * against another; refuse, naming both, instead of silently running cross-org.
 */
function refuseCrossOrgRerun(): boolean {
  const currentOrg = sfCli.getCurrentOrg()?.username;
  if (!lastRunOrg || sameOrg(lastRunOrg, currentOrg)) return false;
  void vscode.window.showWarningMessage(
    `Last run targeted ${lastRunOrg}, but the current org is ${currentOrg ?? '(none)'}. ` +
      `Switch back to ${lastRunOrg} to re-run from its results.`,
  );
  return true;
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
 * Shared tail of every result-producing path (live run or loaded run): tree,
 * last-summary state, log, Problems diagnostics, and gutter coverage straight
 * from the run's own --code-coverage block (fresh org coverage also invalidates
 * cached "no coverage" answers).
 *
 * `runOrgUsername` is the org the run actually targeted. Results, diagnostics
 * and the log are surfaced regardless (a finished run is valuable, and the tree
 * is labelled with its org), but the coverage cache/decorations are org-scoped
 * and class-keyed only — so when the run's org is no longer current (it landed
 * after an org switch), those writes are skipped rather than decorate the wrong
 * org's files. `lastRunOrg` lets `rerunFailed` refuse a cross-org replay.
 */
async function applyRunOutcome(
  summary: TestRunSummary,
  runCoverage: Map<string, CoverageInfo>,
  runOrgUsername: string,
): Promise<void> {
  results.setSummary(summary, runOrgUsername, overallCoveragePercent(runCoverage));
  lastSummary = summary;
  lastRunOrg = runOrgUsername;
  logSummary(summary, runOrgUsername, runCoverage);
  await publishDiagnostics(summary);
  if (sameOrg(runOrgUsername, sfCli.getCurrentOrg()?.username)) {
    // Org-gated like the caches below: a cross-org run landing late must not
    // undo a "Clear Coverage Decorations" the user did under the current org.
    coverageCleared = false;
    // Cache the run's coverage even while painting is off — the decorator's
    // enabled flag decides what shows, and toggling back on must paint THIS
    // run's data, not whatever was cached before the toggle.
    coverage.setCoverageMany(runCoverage.values());
    coverageKnownAbsent.clear();
    coverageLoadFailed.clear();
    coverage.applyTo(vscode.window.activeTextEditor);
  }
}

/**
 * Surface runs this extension did NOT start (terminal, CI, another tool — or a
 * run lost to a window reload): list the org's recent async runs, load the
 * picked one through the normal result pipeline.
 */
async function loadRecentRuns(): Promise<void> {
  const org = sfCli.getCurrentOrg();
  if (!org) {
    void vscode.window.showWarningMessage('Select a Salesforce org first (status bar).');
    return;
  }
  if (!runGuard.tryAcquire()) {
    void vscode.window.showWarningMessage('A test run is already in progress. Wait for it to finish.');
    return;
  }
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
    maybeShowOutput();
    output.appendLine(`▶ Loading test run ${pick.run.testRunId}…`);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SF Tests: loading run ${pick.run.testRunId}`,
        cancellable: true,
      },
      async (_progress, token) => {
        const { summary, coverage: runCoverage } = await sfCli.getTestRun(
          pick.run.testRunId,
          org.username,
          { cancellation: token },
        );
        await applyRunOutcome(summary, runCoverage, org.username);
      },
    );
  } catch (err) {
    if (!(err instanceof SfCliCancelledError)) handleError(err);
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
  // Asking for coverage undoes an earlier "Clear Coverage Decorations", and an
  // explicit ask is the retry signal for a class whose background load failed.
  coverageCleared = false;
  coverageLoadFailed.delete(className.toLowerCase());

  // Join the auto-loader's in-flight bookkeeping: if it is already fetching this
  // class (editor just opened), don't run a second concurrent coverage query.
  const loadKey = className.toLowerCase();
  if (coverageLoading.has(loadKey)) return;
  coverageLoading.add(loadKey);
  try {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Coverage: ${className}` },
    async () => {
      try {
        const cov = await sfCli.getCoverageForClass(className, org.username);
        // Discard silently if the org switched while this query was in flight:
        // the coverage cache is class-keyed only, so landing org-A coverage (or a
        // false "known absent") under org B would decorate the wrong files.
        if (!sameOrg(org.username, sfCli.getCurrentOrg()?.username)) return;
        if (!cov) {
          coverageKnownAbsent.add(className.toLowerCase());
          void vscode.window.showInformationMessage(
            `No coverage stored in org for ${className}. Run tests to generate it.`,
          );
          return;
        }
        coverageKnownAbsent.delete(className.toLowerCase());
        const total = cov.numLinesCovered + cov.numLinesUncovered;
        const pct = total === 0 ? 0 : Math.round((cov.numLinesCovered * 100) / total);
        coverage.setCoverage(className, cov);
        coverage.applyTo(vscode.window.activeTextEditor);
        if (!inlineCoverageEnabled()) {
          // Nothing to look at in the gutter, so report the figure the user asked for.
          void vscode.window.showInformationMessage(
            `${className}: ${pct}% covered (${cov.numLinesCovered}/${total} lines).`,
          );
        }
        output.appendLine(
          `Coverage for ${className}: ${pct}% covered (${cov.numLinesCovered}/${total} lines)`,
        );
      } catch (err) {
        // A failed query says nothing about whether the class has coverage — it
        // must not feed the known-absent cache, and it is an error, not the
        // "no coverage stored" note.
        handleError(err);
      }
    },
  );
  } finally {
    coverageLoading.delete(loadKey);
  }
}

async function maybeAutoLoadCoverage(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor) return;
  if (!editor.document.fileName.toLowerCase().endsWith('.cls')) return;
  const org = sfCli.getCurrentOrg();
  if (!org) return;
  const cfg = vscode.workspace.getConfiguration('sfTestRunner');
  if (!cfg.get<boolean>('showCoverageOnOpen', true)) return;
  if (!inlineCoverageEnabled()) return;
  // The user cleared the decorations on purpose; don't pull them back in.
  if (coverageCleared) return;
  const className = classNameFromUri(editor.document.uri);
  if (!className) return;
  if (coverage.has(className)) {
    coverage.applyTo(editor);
    return;
  }
  const key = className.toLowerCase();
  if (coverageKnownAbsent.has(key) || coverageLoadFailed.has(key) || coverageLoading.has(key)) {
    return;
  }
  coverageLoading.add(key);
  try {
    const cov = await sfCli.getCoverageForClass(className, org.username);
    // Best-effort background load: if the org switched while it was in flight,
    // drop the result rather than decorate the new org's files with the old
    // org's coverage or poison the known-absent set (cache is class-keyed only).
    if (!sameOrg(org.username, sfCli.getCurrentOrg()?.username)) return;
    if (cov) {
      coverage.setCoverage(className, cov);
      coverage.applyTo(editor);
    } else {
      coverageKnownAbsent.add(key);
    }
  } catch (err) {
    // Background load nobody asked for: log it, no toast. A failed query is not
    // a "no coverage" answer, so it must not reach coverageKnownAbsent — but it
    // does back off further auto-attempts until a run/refresh/org switch.
    coverageLoadFailed.add(key);
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Coverage lookup for ${className} failed: ${message}`);
  } finally {
    coverageLoading.delete(key);
  }
}

/** Status bar: current class's coverage when loaded, eye/eye-closed for the
 *  painting toggle state. Clicking flips `showInlineCoverage`. */
function updateCoverageStatus(): void {
  if (!inlineCoverageEnabled()) {
    coverageStatusItem.text = '$(eye-closed) Coverage';
    coverageStatusItem.tooltip = 'Inline coverage is hidden — click to show';
    coverageStatusItem.show();
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const className = editor ? classNameFromUri(editor.document.uri) : null;
  const info = className ? coverage.get(className) : undefined;
  if (info) {
    const total = info.numLinesCovered + info.numLinesUncovered;
    const pct = total === 0 ? 0 : Math.round((info.numLinesCovered * 100) / total);
    coverageStatusItem.text = `$(eye) ${pct}%`;
    coverageStatusItem.tooltip =
      `${info.className}: ${pct}% covered (${info.numLinesCovered}/${total} lines) — ` +
      'click to hide inline coverage';
  } else {
    coverageStatusItem.text = '$(eye) Coverage';
    coverageStatusItem.tooltip = 'Inline coverage is shown — click to hide';
  }
  coverageStatusItem.show();
}

/** Keep `sfTestRunner.activeFileHasTests` in step with the active editor: true
 *  only for a `.cls` whose source actually declares tests. */
async function updateHasTestsContext(editor: vscode.TextEditor | undefined): Promise<void> {
  const doc = editor?.document;
  const hasTests =
    !!doc && doc.fileName.toLowerCase().endsWith('.cls') && hasApexTests(doc.getText());
  await vscode.commands.executeCommand('setContext', HAS_TESTS_CONTEXT_KEY, hasTests);
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

function logSummary(
  summary: TestRunSummary,
  orgUsername: string,
  runCoverage: Map<string, CoverageInfo>,
): void {
  output.appendLine('');
  output.appendLine(
    `Result: ${summary.status} · ${summary.passing}/${summary.testsRan} passed · ${summary.testTotalTime}ms · org ${orgUsername}`,
  );
  for (const r of summary.results) {
    const mark = r.outcome === 'Pass' ? '✓' : '✗';
    output.appendLine(`  ${mark} ${r.className}.${r.methodName} (${r.runTime}ms)`);
    if (r.outcome !== 'Pass' && r.message) {
      output.appendLine(`     ${r.message}`);
    }
  }

  const covered = [...runCoverage.values()].sort((a, b) => a.className.localeCompare(b.className));
  if (covered.length > 0) {
    const overall = overallCoveragePercent(runCoverage);
    output.appendLine(`Coverage${overall === null ? '' : ` (${overall}% overall)`}:`);
    for (const info of covered) {
      const total = info.numLinesCovered + info.numLinesUncovered;
      const pct = total === 0 ? 0 : Math.round((info.numLinesCovered * 100) / total);
      output.appendLine(
        `  ${info.className}: ${pct}% covered (${info.numLinesCovered}/${total} lines)`,
      );
    }
  }
}

/** Gutter/line painting is opt-out; the numbers are reported either way. */
function inlineCoverageEnabled(): boolean {
  return vscode.workspace.getConfiguration('sfTestRunner').get<boolean>('showInlineCoverage', true);
}

/** Reveal the output channel for work the user started, unless they turned the
 *  auto-reveal off. Opening a test result reveals it regardless. */
function maybeShowOutput(): void {
  const cfg = vscode.workspace.getConfiguration('sfTestRunner');
  if (cfg.get<boolean>('autoShowOutput', true)) output.show(true);
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
