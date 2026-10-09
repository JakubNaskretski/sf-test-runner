/**
 * Activation and wiring for the 0.9.0 panel.
 *
 * Deliberately flat: build the pieces, connect their events, register every
 * contributed command. All the behaviour lives in the modules — the store
 * (`ui/panelState`), the three webview providers, the discovery pair and the
 * runner — so this file stays readable as the map of how they fit together.
 *
 * Two rules the wiring exists to keep:
 *  - the target org is written in exactly ONE place (`OrgPicker`), whether the
 *    user picked it in the QuickPick or in the panel's `<select>`;
 *  - the test index is the union of the local scan and THIS org's cached org
 *    tests, rebuilt whenever either half moves.
 */
import * as vscode from 'vscode';
import { LocalTestScanner } from './discovery/localTests';
import { OrgTestFetcher } from './discovery/orgTests';
import { buildIndex } from './discovery/testIndex';
import {
  explainHandoff,
  FollowOrgResult,
  parseHandoffShape,
  parseTargetOrgShape,
  RunTestsForResult,
  shouldSwitchPicker,
  toRunTestsForResult,
} from './handoff';
import { sameOrg } from './orgMatch';
import { TestRunner } from './runs/testRunner';
import { SfCliService } from './salesforce/sfCliService';
import { CommandLogEntry, OrgInfo, TestClassEntry } from './types';
import { classNameOf, resolveHandoff, testKeysForActiveFile } from './ui/activeFileTests';
import { ApexTestCodeLensProvider, RunLensArgs } from './ui/codeLens';
import { CommandHistoryProvider, copyCommandToClipboard } from './ui/commandHistoryProvider';
import { CoverageDecorator, classNameFromUri } from './ui/coverageDecorator';
import { CoverageStatusBar } from './ui/coverageStatus';
import { CoverageActions, CoverageViewProvider } from './ui/coverageView';
import { ApexFileResolver } from './ui/openApex';
import { OrgPicker } from './ui/orgPicker';
import { PanelState } from './ui/panelState';
import { ResultsActions, ResultsViewProvider } from './ui/resultsView';
import { TestsActions, TestsViewProvider } from './ui/testsView';

const APEX_NAME = /^\w+$/;
const NO_ORG = 'Select a Salesforce org first.';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SF Tests');
  output.appendLine('SF Test Runner activating…');
  context.subscriptions.push(output);

  const sfCli = new SfCliService(output);
  // Selection is per workspace (it names classes in THIS repo) and so is the target
  // org, so two windows on two projects don't retarget each other; the org list and
  // the org-tests cache are per machine.
  const state = new PanelState(context.workspaceState);
  const orgPicker = new OrgPicker(sfCli, context.globalState, context.workspaceState);
  const fetcher = new OrgTestFetcher(sfCli, context.globalState, output);
  const scanner = new LocalTestScanner(output);
  const resolver = new ApexFileResolver();
  const commands = new CommandHistoryProvider();
  context.subscriptions.push(sfCli, state, orgPicker, scanner);

  const runner = new TestRunner({
    sfCli,
    state,
    output,
    getOrg: () => sfCli.getCurrentOrg(),
    resolver,
    revealOutput: () => {
      if (vscode.workspace.getConfiguration('sfTestRunner').get<boolean>('autoShowOutput', false)) {
        output.show(true);
      }
    },
    markDeployed: async (orgUsername, classNames) => {
      await fetcher.markDeployed(orgUsername, classNames);
      rebuildIndex();
    },
    // The exact path a hand pick in the QuickPick or the panel's <select>
    // takes — family sync, the status bar, onOrgChanged's own invalidation —
    // so the handoff moving the picker behaves identically to the user
    // picking the org themselves. The full OrgInfo, not just a username:
    // runTestsFor already resolved it (possibly from a fresher list than
    // the picker's own cache has caught up to yet), so there is nothing to
    // re-look-up.
    matchOrg: (org) => orgPicker.applyExternalPick(org),
  });
  context.subscriptions.push(runner);

  // ───────────────────────────── the test index ─────────────────────────────

  /** Latest local scan. The org half is read from the fetcher's per-org cache,
   *  so switching orgs re-unions without re-scanning the workspace. */
  let localEntries: TestClassEntry[] = [];
  /** Whether the first full scan has finished. Nothing is scanned until
   *  something asks, and the org resolving first would otherwise publish an
   *  EMPTY index — which `setIndex` prunes the restored selection against. */
  let scanned = false;

  function rebuildIndex(): void {
    if (!scanned) return;
    const org = sfCli.getCurrentOrg();
    state.setIndex(buildIndex(localEntries, org ? fetcher.cached(org.username) : undefined));
    // EVERY local class, not just the test ones: this feeds the coverage table's
    // "no local source" greying, and a run measures the classes UNDER test —
    // which are never test classes.
    state.setLocalClassNames(scanner.localClassNames());
  }

  context.subscriptions.push(
    scanner.onDidChange((entries) => {
      localEntries = entries;
      rebuildIndex();
    }),
  );

  /** The first scan, and the one the fetch and the active-file command need. */
  async function ensureScanned(): Promise<TestClassEntry[]> {
    state.setBusy({ scanning: true });
    try {
      localEntries = await scanner.ensureDiscovered();
      scanned = true;
      rebuildIndex();
      return localEntries;
    } finally {
      state.setBusy({ scanning: false });
    }
  }

  async function rescan(): Promise<void> {
    // A class may have been added, moved or deleted since the last resolve.
    resolver.invalidate();
    state.setBusy({ scanning: true });
    try {
      localEntries = await scanner.rescan();
      scanned = true;
      rebuildIndex();
    } finally {
      state.setBusy({ scanning: false });
    }
  }

  async function fetchOrgTests(): Promise<void> {
    const org = sfCli.getCurrentOrg();
    if (!org) {
      void vscode.window.showWarningMessage(NO_ORG);
      return;
    }
    state.setBusy({ fetchingOrg: true });
    try {
      // The local names decide which classes need their Body fetched, so the
      // scan has to have happened first.
      const local = await ensureScanned();
      await fetcher.fetch(
        org.username,
        local.map((entry) => entry.name),
      );
      rebuildIndex();
      const count = state.index.classes.filter((c) => c.source !== 'local-only').length;
      output.appendLine(`Org test discovery: ${count} test classes in ${org.alias}.`);
    } catch (err) {
      handleError(output, err);
    } finally {
      state.setBusy({ fetchingOrg: false });
    }
  }

  // ──────────────────────────────── the org ─────────────────────────────────

  state.setOrgs(orgPicker.knownOrgList());
  context.subscriptions.push(
    orgPicker.onOrgChanged((org) => {
      state.setOrg(org);
      state.setOrgs(orgPicker.knownOrgList());
      // Coverage measured in another org says nothing about this one, and it is
      // painted on the same lines — drop it rather than relabel it.
      if (state.coverage && state.coverage.orgUsername !== org?.username) {
        state.setCoverage(undefined);
      }
      rebuildIndex();
      const onOpen = vscode.workspace
        .getConfiguration('sfTestRunner')
        .get<boolean>('fetchOrgTestsOnOpen', false);
      // The cache above already rendered; this refreshes it for the org we just
      // landed on, which is what the "on open" setting asks for.
      if (org && onOpen) void fetchOrgTests();
    }),
    // The list can be refreshed without the org changing (⟳, a picker
    // revalidate); the panel's <select> must show what the QuickPick shows.
    orgPicker.onOrgsChanged((orgs) => state.setOrgs(orgs)),
  );

  /** `sf org login web`, the family's ＋ button. The CLI opens the browser and
   *  the command finishes when the flow does — so it runs behind a progress
   *  notification, not silently. */
  async function loginOrg(): Promise<void> {
    try {
      const username = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'SF Tests: waiting for the browser login…',
        },
        () => sfCli.loginWeb(),
      );
      await orgPicker.refreshOrgs();
      if (username) orgPicker.selectByUsername(username);
    } catch (err) {
      handleError(output, err);
    }
  }

  // ─────────────────────────────── the views ────────────────────────────────

  const testsActions: TestsActions = {
    run: (scope) => {
      if (scope === 'allLocal') void runner.runAllLocal();
      else if (scope === 'allInOrg') void runner.runAllInOrg();
      else void runner.runSelected();
    },
    cancel: () => runner.cancel(),
    rescan: () => void rescan(),
    fetchOrg: () => void fetchOrgTests(),
    // The picker is the ONLY writer of the target org, whichever surface asked.
    selectOrg: (username) => orgPicker.selectByUsername(username),
    refreshOrgs: () => void orgPicker.refreshOrgs(),
    login: () => void loginOrg(),
    testsForActiveFile: () => void selectTestsForActiveFile(),
    open: (name, method) => void resolver.open(name, { method }),
  };

  const resultsActions: ResultsActions = {
    open: (className, method, line, isTrigger) =>
      void resolver.open(className, { method, line, isTrigger }),
    rerunFailed: () => void runner.rerunFailed(),
    copySummary: () => void runner.copySummary(),
    copyFailure: (className, methodName) => void runner.copyFailure(className, methodName),
    showLog: (className, methodName) => void runner.showLog(className, methodName),
    loadRecent: () => void runner.loadRecent(),
  };

  const coverageActions: CoverageActions = {
    open: (className, isTrigger) => void resolver.open(className, { isTrigger }),
    setPaint: (on) => void state.setPaintCoverage(on),
    clear: () => state.setCoverage(undefined),
    fromOrg: (className) => void runner.loadOrgCoverage(className),
  };

  const testsView = new TestsViewProvider({
    state,
    extensionUri: context.extensionUri,
    actions: testsActions,
  });
  const resultsView = new ResultsViewProvider({
    state,
    extensionUri: context.extensionUri,
    actions: resultsActions,
  });
  const coverageView = new CoverageViewProvider({
    state,
    extensionUri: context.extensionUri,
    actions: coverageActions,
  });

  context.subscriptions.push(
    testsView,
    resultsView,
    coverageView,
    // retainContextWhenHidden (each provider's own registerOptions) is what
    // keeps scroll position and open rows across a collapse.
    vscode.window.registerWebviewViewProvider(
      TestsViewProvider.viewId,
      testsView,
      TestsViewProvider.registerOptions,
    ),
    vscode.window.registerWebviewViewProvider(
      ResultsViewProvider.viewId,
      resultsView,
      ResultsViewProvider.registerOptions,
    ),
    vscode.window.registerWebviewViewProvider(
      CoverageViewProvider.viewId,
      coverageView,
      CoverageViewProvider.registerOptions,
    ),
    vscode.window.registerTreeDataProvider('sfTestRunner.commands', commands),
    sfCli.onCommand((entry) => commands.record(entry)),
  );

  // ─────────────────────────── editor-side surfaces ─────────────────────────

  context.subscriptions.push(
    new CoverageDecorator(state, (name, isTrigger) => resolver.resolve(name, isTrigger)),
    new CoverageStatusBar(state, (name, isTrigger) => resolver.resolve(name, isTrigger)),
  );

  const codeLens = new ApexTestCodeLensProvider(state);
  context.subscriptions.push(
    codeLens,
    // One registration with both selectors: an Apex extension contributes the
    // `apex` language, and the glob covers a workspace where none is installed.
    vscode.languages.registerCodeLensProvider(
      [{ language: 'apex' }, { pattern: '**/*.cls' }],
      codeLens,
    ),
  );

  // ───────────────────────────────── commands ───────────────────────────────

  /** Tick the tests that belong to the file in front of the user. */
  async function selectTestsForActiveFile(): Promise<void> {
    const fileName = vscode.window.activeTextEditor?.document.fileName;
    if (!fileName || !/\.(cls|trigger)$/i.test(fileName)) {
      void vscode.window.showInformationMessage('Open an Apex class to select its tests.');
      return;
    }
    // Nothing is scanned until something asks, and this may be the first ask.
    await ensureScanned();
    const keys = testKeysForActiveFile(state.index, fileName);
    if (keys.length === 0) {
      void vscode.window.showInformationMessage(
        `No test class found for ${classNameOf(fileName)}.`,
      );
      return;
    }
    state.selectOnly(keys);
    testsView.reveal();
  }

  /** Shared body of the two CodeLens commands. The argument comes from a lens,
   *  but any caller can invoke a contributed command — so it is validated like
   *  anything else that ends up in a `--tests` selector. */
  function runFromLens(raw: unknown, needsMethod: boolean): void {
    const args = (raw ?? {}) as Partial<RunLensArgs>;
    const className = typeof args.className === 'string' ? args.className : '';
    const method = typeof args.method === 'string' ? args.method : '';
    if (!APEX_NAME.test(className) || (needsMethod && !APEX_NAME.test(method))) {
      void vscode.window.showWarningMessage('SF Tests: no test class or method to run.');
      return;
    }
    const selector = needsMethod ? `${className}.${method}` : className;
    const alias = sfCli.getCurrentOrg()?.alias;
    void runner.runSelectors([selector], alias ? `${selector} on ${alias}` : selector, {
      coverage: args.coverage === true,
    });
  }

  /**
   * The org lookup shared by `runTestsFor` and `followOrg`: known list
   * first, then — on a miss — one quiet, fresh refresh (no progress
   * notification, no toast; it does not touch the picker's own selection)
   * before concluding the org really is unknown. Matched against whatever
   * list THIS call ends up using, never re-reading `knownOrgList()` after
   * the refresh — a concurrent newer fetch is free to win the shared cache
   * without costing this lookup its own answer.
   */
  async function resolveHandoffOrg(targetOrg: string): Promise<{ org: OrgInfo } | { error: string }> {
    let orgs = orgPicker.knownOrgList();
    let org = orgs.find((o) => sameOrg(o.username, targetOrg));
    if (!org) {
      try {
        orgs = await orgPicker.refreshOrgsQuietly();
      } catch (err: any) {
        const message = `could not list orgs: ${err?.message ?? err}`;
        output.appendLine(`SF Tests: ${message}`);
        return { error: message };
      }
      org = orgs.find((o) => sameOrg(o.username, targetOrg));
    }
    return org ? { org } : { error: `${targetOrg} is not a known org.` };
  }

  /**
   * `sfTestRunner.runTestsFor` — the cross-extension test handoff. A sibling
   * extension (sf-org-deploy-helper, right after a deploy) calls this with
   * the classes it just handled and the org it targeted; this plugin
   * resolves their test classes and runs them. Contributed, so callable by
   * anyone — every argument is validated by `parseHandoffShape` before any
   * of it reaches a CLI selector or an org lookup; the known-org check runs
   * separately here (rather than via `parseHandoffArgs`) so a miss can
   * refresh the list once and retry before it is reported as unknown. The
   * same request arriving again while it is still in progress gets the same
   * run and the same result.
   */
  async function runTestsFor(raw: unknown): Promise<RunTestsForResult> {
    const shape = parseHandoffShape(raw);
    if (!shape.ok) {
      return { status: 'error', testClasses: [], passed: 0, failed: 0, message: shape.message };
    }
    const { classNames, targetOrg, deployed, requestId } = shape.value;

    const resolved = await resolveHandoffOrg(targetOrg);
    if ('error' in resolved) {
      return { status: 'error', testClasses: [], passed: 0, failed: 0, message: resolved.error };
    }
    const { org } = resolved;

    await ensureScanned();
    // The flag (the class is itself a test class, or declared @IsTest), and
    // the semantics (testFor, else the naming conventions) — both, unioned.
    const resolution = resolveHandoff(state.index, classNames);
    const { testClasses } = resolution;
    if (testClasses.length === 0) {
      // No toast here: this is the handoff path, and the caller shows its own
      // card for `noTests` — with this message, which says what was checked.
      // TR's own entry points (Select Tests for Active Class) keep theirs.
      const result = explainHandoff(
        { status: 'noTests', orgAlias: org.alias, testClasses: [], passed: 0, failed: 0 },
        resolution,
      );
      output.appendLine(`SF Tests (from SF Deploy): ${result.message}`);
      return result;
    }

    // A repeat of the request already in progress joins it (see
    // `TestRunner.handoff`); anything else while a run is going is busy.
    const busy = (): RunTestsForResult =>
      explainHandoff(
        toRunTestsForResult({ record: undefined, ranSelectors: [], busy: true }, testClasses),
        resolution,
      );
    return runner.handoff(
      { org, testClasses, requestId },
      async () => {
        testsView.reveal();
        resultsView.reveal();
        const outcome = await runner.runFor(
          testClasses,
          org,
          deployed ? { deployed: classNames } : undefined,
        );
        const result = explainHandoff(
          toRunTestsForResult(outcome, testClasses),
          resolution,
          outcome.record,
        );
        if (result.message && result.message !== outcome.record?.error) {
          output.appendLine(`SF Tests (from SF Deploy): ${result.message}`);
        }
        // An @IsTest class the org found empty is "no tests", not the generic
        // "this run reported no test results" — say it in the Results view too.
        if (result.status === 'noTests' && outcome.record && state.run?.id === outcome.record.id) {
          state.updateRun({ error: result.message });
        }
        return result;
      },
      busy,
    );
  }

  /**
   * `sfTestRunner.followOrg` — SF Deploy calls this after every successful
   * deploy that sent Apex, even one that triggered no test run, so a
   * follow-up Run/CodeLens/re-run in SF Test Runner lands on the org that
   * was just deployed to. Runs nothing and touches no selection: it only
   * ever moves the picker, through the same `applyExternalPick` path
   * `runFor`'s own switch uses — and only when it is not there already.
   */
  async function followOrg(raw: unknown): Promise<FollowOrgResult> {
    const shape = parseTargetOrgShape(raw);
    if (!shape.ok) return { status: 'error', message: shape.message };

    const resolved = await resolveHandoffOrg(shape.value.targetOrg);
    if ('error' in resolved) return { status: 'error', message: resolved.error };
    const { org } = resolved;

    if (!shouldSwitchPicker(sfCli.getCurrentOrg(), org)) return { status: 'unchanged' };
    orgPicker.applyExternalPick(org);
    output.appendLine(`Switched to ${org.alias} to match SF Deploy`);
    return { status: 'ok' };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sfTestRunner.runSelected', () => runner.runSelected()),
    vscode.commands.registerCommand('sfTestRunner.runAllLocal', () => runner.runAllLocal()),
    vscode.commands.registerCommand('sfTestRunner.runAllInOrg', () => runner.runAllInOrg()),
    vscode.commands.registerCommand('sfTestRunner.cancelRun', () => runner.cancel()),
    vscode.commands.registerCommand('sfTestRunner.rescan', () => rescan()),
    vscode.commands.registerCommand('sfTestRunner.fetchOrgTests', () => fetchOrgTests()),
    vscode.commands.registerCommand('sfTestRunner.selectOrg', () => orgPicker.showPicker()),
    vscode.commands.registerCommand('sfTestRunner.refreshOrgs', () => orgPicker.refreshOrgs()),
    vscode.commands.registerCommand('sfTestRunner.loginOrg', () => loginOrg()),
    vscode.commands.registerCommand('sfTestRunner.testsForActiveFile', () =>
      selectTestsForActiveFile(),
    ),
    vscode.commands.registerCommand('sfTestRunner.rerunFailed', () => runner.rerunFailed()),
    vscode.commands.registerCommand('sfTestRunner.copySummary', () => runner.copySummary()),
    vscode.commands.registerCommand('sfTestRunner.loadRecentRuns', () => runner.loadRecent()),
    vscode.commands.registerCommand('sfTestRunner.expandResults', () => state.expandResults()),
    vscode.commands.registerCommand('sfTestRunner.collapseResults', () => state.collapseResults()),
    // Through the store's setter, so the decorator, the status bar and the
    // coverage view all react to the same 'prefs' event.
    vscode.commands.registerCommand('sfTestRunner.toggleCoveragePaint', () =>
      state.setPaintCoverage(!state.paintCoverage),
    ),
    vscode.commands.registerCommand('sfTestRunner.clearCoverage', () =>
      state.setCoverage(undefined),
    ),
    vscode.commands.registerCommand('sfTestRunner.refreshCoverage', (arg?: unknown) =>
      runner.loadOrgCoverage(classNameFromArg(arg)),
    ),
    vscode.commands.registerCommand('sfTestRunner.runClass', (args?: unknown) =>
      runFromLens(args, false),
    ),
    vscode.commands.registerCommand('sfTestRunner.runMethod', (args?: unknown) =>
      runFromLens(args, true),
    ),
    vscode.commands.registerCommand('sfTestRunner.runTestsFor', (args?: unknown) =>
      runTestsFor(args),
    ),
    vscode.commands.registerCommand('sfTestRunner.followOrg', (args?: unknown) =>
      followOrg(args),
    ),
    vscode.commands.registerCommand('sfTestRunner.clearCommandHistory', () => commands.clear()),
    vscode.commands.registerCommand('sfTestRunner.copyCommand', (node?: unknown) => {
      const entry = extractEntry(node);
      if (entry) void copyCommandToClipboard(entry);
    }),
    vscode.commands.registerCommand('sfTestRunner.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('sfTestRunner.help', () => showHelp(context)),
  );

  // Non-blocking: activation returns while the org and the first scan settle.
  void orgPicker.autoSelectDefault().catch(() => undefined);
  void ensureScanned().catch((err) => handleError(output, err));
}

export function deactivate(): void {
  // disposables clean themselves up
}

// The "?" in the Tests view title: a short plain-text guide (a modal's detail renders no markdown).
async function showHelp(context: vscode.ExtensionContext): Promise<void> {
  const HELP = `1. Click the SF Tests icon in the Activity Bar: Tests, Results, Coverage and the Command log.
2. Pick the target org in the dropdown at the top of Tests; ＋ logs in to another org.
3. Tick classes or methods. Rescan re-reads the workspace; Fetch org tests adds org-only classes.
4. Run Selected or Run All Local; the ⋯ menu runs every test in the org.
5. Results fill in as methods finish: click a stack frame to open the line, Re-run failed to retry.
6. Coverage lists the worst classes and paints covered lines; the status-bar eye toggles the paint.
7. ▶ Run Class / ▶ Run and Run with Coverage links sit above each test class and method.
8. Needs the sf CLI on PATH and a logged-in org; runs against production ask for confirmation.`;
  const choice = await vscode.window.showInformationMessage('SF Tests', { modal: true, detail: HELP }, 'Open README');
  if (choice === 'Open README') {
    // vsce ships the file as readme.md while the dev host has README.md: open whichever exists
    for (const name of ['readme.md', 'README.md']) {
      const uri = vscode.Uri.joinPath(context.extensionUri, name);
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.commands.executeCommand('markdown.showPreview', uri);
        return;
      } catch { /* try the other spelling */ }
    }
    void vscode.window.showWarningMessage('README not found in the extension folder.');
  }
}

function handleError(output: vscode.OutputChannel, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  output.appendLine(`✗ Error: ${message}`);
  void vscode.window.showErrorMessage(`SF Tests: ${message}`, 'Show Output').then((pick) => {
    if (pick === 'Show Output') output.show(true);
  });
}

/** `refreshCoverage` is invoked from the palette (nothing), from an editor
 *  context (a Uri) and from code (a class name). Undefined lets the runner fall
 *  back to the active editor. */
function classNameFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof vscode.Uri) return classNameFromUri(arg) ?? undefined;
  return undefined;
}

function extractEntry(node: unknown): CommandLogEntry | null {
  if (!node || typeof node !== 'object') return null;
  const candidate = node as { entry?: CommandLogEntry; command?: unknown; args?: unknown };
  if (candidate.entry) return candidate.entry;
  if (candidate.command && candidate.args) return node as CommandLogEntry;
  return null;
}
