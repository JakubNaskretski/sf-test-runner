import * as vscode from 'vscode';
import { SfCliCancelledError, SfCliService } from '../salesforce/sfCliService';
import { overallCoveragePercent } from '../salesforce/coverageMapping';
import { primaryFrame } from '../salesforce/stackParser';
import { selectorsFor } from '../salesforce/testSelection';
import { findClassDecl, findTestMethods, hasApexTests } from '../salesforce/testMethods';
import { CoverageInfo, TestMethodResult, TestRunSummary } from '../types';

/**
 * The extension's whole test UI is VS Code's own: the Test Explorer, the gutter
 * run icons, inline failure messages and the Test Coverage view. This module owns
 * the `TestController` behind them.
 *
 * The important consequence is about coverage. It is no longer state we keep and
 * decide when to paint — it is attached to a specific `TestRun` (`run.addCoverage`)
 * and VS Code shows it, per run, when the user asks. Coverage from somebody else's
 * run cannot appear by accident, because there is nowhere for it to live except a
 * run we created and labelled.
 *
 * Test item ids ARE the CLI selectors: a class item is `MyClassTest`, a method
 * item is `MyClassTest.testThing`, and both are what `--tests` accepts.
 */

export interface ApexTestControllerDeps {
  sfCli: SfCliService;
  output: vscode.OutputChannel;
  /**
   * Claim the right to run: resolve the target org, confirm a production target
   * and take the single-run guard. Returns the org username, or null when the run
   * must not start — the caller has already told the user why.
   */
  acquireRun(): Promise<string | null>;
  /** Release the single-run guard. Always called, including on failure. */
  releaseRun(): void;
  /** Reveal the output channel, unless the user turned that off. */
  revealOutput(): void;
}

export interface ApexTestController extends vscode.Disposable {
  /** `--test-level RunLocalTests`: every test in the org bar managed-package ones. */
  runAllLocal(withCoverage: boolean): Promise<void>;
  /**
   * Surface a run this extension did not execute (loaded from the org's history)
   * as a real test run, so its results and coverage land in the same UI.
   */
  publishLoadedRun(
    label: string,
    summary: TestRunSummary,
    coverage: Map<string, CoverageInfo>,
  ): Promise<void>;
  /**
   * Surface coverage that belongs to no run of ours — the org's stored
   * `ApexCodeCoverageAggregate` — as a clearly labelled coverage-only run.
   */
  publishOrgCoverage(label: string, infos: Iterable<CoverageInfo>): Promise<void>;
}

export function createApexTestController(deps: ApexTestControllerDeps): ApexTestController {
  const controller = vscode.tests.createTestController('sfApexTests', 'Apex Tests');

  /** file uri → the class item id discovered in it, so a rename removes the old item. */
  const classIdByUri = new Map<string, string>();
  /** class item id → the file uri that currently owns it, for the duplicate case. */
  const ownerByClassId = new Map<string, string>();
  /** Detailed line coverage per reported file, handed back by `loadDetailedCoverage`
   *  when the user actually opens a covered file. VS Code passes back the same
   *  `FileCoverage` instance we handed to `addCoverage`, so it is the lookup key. */
  const coverageDetails = new WeakMap<vscode.FileCoverage, vscode.FileCoverageDetail[]>();

  const runProfile = controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request) => executeRequest(request, false),
    true,
  );
  const coverageProfile = controller.createRunProfile(
    'Run with Coverage',
    vscode.TestRunProfileKind.Coverage,
    (request) => executeRequest(request, true),
    true,
  );
  coverageProfile.loadDetailedCoverage = async (_testRun, fileCoverage) =>
    coverageDetails.get(fileCoverage) ?? [];

  /** The first full scan, memoised: every entry point awaits the same promise. */
  let discovery: Promise<void> | undefined;

  // Nothing is scanned until something asks — opening the Testing view, opening
  // an Apex file (below), or a command that needs the tree populated. A large
  // SFDX repo has thousands of `.cls` files and reading them all on activation
  // would be a startup tax nobody asked for.
  controller.resolveHandler = async (item) => {
    if (item) return; // class items are fully populated when they are created
    await ensureDiscovered();
  };
  controller.refreshHandler = async () => {
    discovery = undefined;
    await ensureDiscovered();
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.cls');
  const subscriptions: vscode.Disposable[] = [
    watcher,
    watcher.onDidCreate((uri) => void parseFile(uri)),
    watcher.onDidChange((uri) => void parseFile(uri)),
    watcher.onDidDelete((uri) => forgetFile(uri)),
    // The file in front of the user is the one whose run icons matter; parsing it
    // is cheap and makes the gutter work without opening the Testing view first.
    vscode.workspace.onDidOpenTextDocument((doc) => parseDocument(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => parseDocument(doc)),
  ];
  for (const editor of vscode.window.visibleTextEditors) parseDocument(editor.document);

  function ensureDiscovered(): Promise<void> {
    return (discovery ??= discoverAll().catch((err) => {
      // Memoising a REJECTED scan would leave the Test Explorer permanently
      // empty after one transient failure; forget it so the next ask retries.
      discovery = undefined;
      const message = err instanceof Error ? err.message : String(err);
      deps.output.appendLine(`Test discovery failed: ${message}`);
    }));
  }

  async function discoverAll(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.cls', '**/node_modules/**');
    // In batches: one `readFile` per class with no ceiling means thousands of
    // concurrent reads and the whole class corpus resident at once.
    const BATCH = 50;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map((uri) => parseFile(uri)));
    }
    // Drop items for files this scan no longer finds — a delete the watcher
    // missed during a bulk checkout, say. Files opened from outside every
    // workspace folder were never in `files` and are left alone.
    const seen = new Set(files.map((f) => f.toString()));
    for (const uriString of [...classIdByUri.keys()]) {
      if (seen.has(uriString)) continue;
      const uri = vscode.Uri.parse(uriString);
      if (vscode.workspace.getWorkspaceFolder(uri)) forgetFile(uri);
    }
  }

  async function parseFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      upsertFromSource(uri, Buffer.from(bytes).toString('utf8'));
    } catch {
      // Unreadable or deleted between the watcher event and the read — drop it.
      forgetFile(uri);
    }
  }

  function parseDocument(doc: vscode.TextDocument): void {
    // `onDidOpenTextDocument` also fires for git diffs and other virtual
    // documents; a test item pointing at one of those is unrunnable noise.
    if (doc.uri.scheme !== 'file') return;
    if (!doc.fileName.toLowerCase().endsWith('.cls')) return;
    upsertFromSource(doc.uri, doc.getText());
  }

  /** Rebuild the class item (and its methods) for one file, or drop it when the
   *  file no longer declares any tests. */
  function upsertFromSource(uri: vscode.Uri, text: string): void {
    if (!hasApexTests(text)) {
      forgetFile(uri);
      return;
    }
    const lines = text.split(/\r?\n/);
    const cls = findClassDecl(lines);
    const methods = cls ? findTestMethods(lines, cls.className) : [];
    // `@IsTest` alone is not a test class: every SFDX repo has annotated helpers
    // (TestDataFactory, HttpCalloutMock implementations) with no test methods in
    // them, and offering a run button that can only fail is worse than not
    // listing them. The cost is that a test class whose methods the heuristic
    // misses entirely stays out of the tree.
    if (!cls || methods.length === 0) {
      forgetFile(uri);
      return;
    }

    const previousId = classIdByUri.get(uri.toString());
    // Same ownership rule as forgetFile: only drop the old item if THIS file is
    // the one that put it there, or renaming one of two files that declare the
    // same class name would delete the other's item.
    if (
      previousId &&
      previousId !== cls.className &&
      ownerByClassId.get(previousId) === uri.toString()
    ) {
      controller.items.delete(previousId);
      ownerByClassId.delete(previousId);
    }

    // Adding an item with an existing id replaces it, so a re-parse after an edit
    // simply refreshes the methods.
    const classItem = controller.createTestItem(cls.className, cls.className, uri);
    classItem.range = lineRange(cls.classLine);
    for (const method of methods) {
      const child = controller.createTestItem(
        `${cls.className}.${method.methodName}`,
        method.methodName,
        uri,
      );
      child.range = lineRange(method.line);
      classItem.children.add(child);
    }
    controller.items.add(classItem);
    classIdByUri.set(uri.toString(), cls.className);
    ownerByClassId.set(cls.className, uri.toString());
  }

  function forgetFile(uri: vscode.Uri): void {
    const key = uri.toString();
    const id = classIdByUri.get(key);
    if (!id) return;
    classIdByUri.delete(key);
    // Two files can declare the same class name (a retrieved copy beside
    // force-app, or a second package directory). Only the file that currently
    // owns the item may remove it, or editing the copy makes the real one vanish.
    if (ownerByClassId.get(id) !== key) return;
    controller.items.delete(id);
    ownerByClassId.delete(id);
  }

  /**
   * Flatten a request into the items it covers, honouring `exclude`. A class with
   * an excluded (hidden) test is deliberately left OUT of the result even though
   * its siblings stay in: keeping it would let `selectorsFor` collapse the whole
   * class to one selector and run the very test the user excluded.
   */
  function collectItems(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const out: vscode.TestItem[] = [];
    /** Returns true when this item, or anything under it, was excluded. */
    const visit = (item: vscode.TestItem): boolean => {
      if (excluded.has(item.id)) return true;
      let tainted = false;
      item.children.forEach((child) => {
        if (visit(child)) tainted = true;
      });
      if (!tainted) out.push(item);
      return tainted;
    };
    if (request.include) request.include.forEach(visit);
    else controller.items.forEach(visit);
    return out;
  }

  async function executeRequest(
    request: vscode.TestRunRequest,
    withCoverage: boolean,
  ): Promise<void> {
    // The Testing view's root "Run All Tests" sends no include. Naming every
    // discovered class as its own `--tests` pair would build a command line long
    // enough to be truncated on Windows, and the org already has a word for
    // "every local test": RunLocalTests.
    if (!request.include) return runAllLocal(withCoverage, request);
    const items = collectItems(request);
    const selectors = selectorsFor(items);
    if (selectors.length === 0) {
      void vscode.window.showInformationMessage('No Apex tests selected.');
      return;
    }
    await execute(request, items, withCoverage, (orgUsername, token) =>
      deps.sfCli.runTestSelection(selectors, orgUsername, {
        cancellation: token,
        coverage: withCoverage,
      }),
    );
  }

  async function runAllLocal(
    withCoverage: boolean,
    existing?: vscode.TestRunRequest,
  ): Promise<void> {
    // Without this the Test Explorer can be empty (discovery is lazy), and a run
    // of the whole org would have nothing to report its results onto.
    await ensureDiscovered();
    const request =
      existing ??
      new vscode.TestRunRequest(undefined, undefined, withCoverage ? coverageProfile : runProfile);
    await execute(request, collectItems(request), withCoverage, (orgUsername, token) =>
      deps.sfCli.runAllLocalTests(orgUsername, { cancellation: token, coverage: withCoverage }),
    );
  }

  /** Shared body of every run: guard, progress, results, coverage, output. */
  async function execute(
    request: vscode.TestRunRequest,
    items: vscode.TestItem[],
    withCoverage: boolean,
    invoke: (
      orgUsername: string,
      token: vscode.CancellationToken,
    ) => Promise<{ summary: TestRunSummary; coverage: Map<string, CoverageInfo> }>,
  ): Promise<void> {
    const orgUsername = await deps.acquireRun();
    if (!orgUsername) return;

    // Everything after the acquire lives in the try: a throw between claiming the
    // guard and entering it would hold the single-run lock until a window reload.
    let run: vscode.TestRun | undefined;
    try {
      deps.revealOutput();
      run = controller.createTestRun(request, orgUsername, true);
      for (const item of items) run.enqueued(item);
      const count = items.filter((i) => i.children.size === 0).length;
      deps.output.appendLine(
        `▶ Running ${count || 'all local'} Apex tests on ${orgUsername}…`,
      );
      // run.token is what the Test Explorer's cancel button raises — wiring it
      // here means every entry point is cancellable, not just the run profiles.
      const { summary, coverage } = await invoke(orgUsername, run.token);
      await applyResults(run, summary, items);
      if (withCoverage) await attachCoverage(run, coverage.values());
      logSummary(summary, orgUsername, coverage);
    } catch (err) {
      if (err instanceof SfCliCancelledError) {
        deps.output.appendLine('✕ Run cancelled. An already-queued job may still finish in the org.');
        void vscode.window.showInformationMessage(
          'SF Tests: run cancelled. An already-queued job may still finish in the org.',
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        deps.output.appendLine(`✗ Error: ${message}`);
        // appendOutput renders in a terminal: bare LF stair-steps the next line.
        run?.appendOutput(`Run failed: ${message.replace(/\r?\n/g, '\r\n')}\r\n`);
        void vscode.window.showErrorMessage(`SF Tests: ${message}`);
      }
    } finally {
      run?.end();
      deps.releaseRun();
    }
  }

  async function publishLoadedRun(
    label: string,
    summary: TestRunSummary,
    coverage: Map<string, CoverageInfo>,
  ): Promise<void> {
    await ensureDiscovered();
    // Anchor the run to the items the loaded results name, so the Test Explorer
    // shows this run's tests rather than marking everything else not-run.
    const items = summary.results
      .map((r) => findItem(r.className, r.methodName))
      .filter((i): i is vscode.TestItem => !!i);
    const request = new vscode.TestRunRequest(items, undefined, coverageProfile);
    const run = controller.createTestRun(request, label, true);
    try {
      await applyResults(run, summary, items);
      await attachCoverage(run, coverage.values());
    } finally {
      run.end();
    }
  }

  async function publishOrgCoverage(label: string, infos: Iterable<CoverageInfo>): Promise<void> {
    // An empty include list means "this run is about no tests at all" — the run
    // exists only to carry coverage, and its name says where that came from.
    const request = new vscode.TestRunRequest([], undefined, coverageProfile);
    const run = controller.createTestRun(request, label, true);
    try {
      await attachCoverage(run, infos);
    } finally {
      run.end();
    }
  }

  function findItem(className: string, methodName?: string): vscode.TestItem | undefined {
    const classItem = controller.items.get(className);
    if (!classItem || !methodName) return classItem;
    const child = classItem.children.get(`${className}.${methodName}`);
    if (child) return child;
    // Falling back to the class item is only safe when we discovered no methods
    // at all; otherwise two undiscovered methods would overwrite each other's
    // outcome on the class, and the last one reported would decide it.
    return classItem.children.size === 0 ? classItem : undefined;
  }

  async function applyResults(
    run: vscode.TestRun,
    summary: TestRunSummary,
    items: vscode.TestItem[],
  ): Promise<void> {
    const byId = new Map(items.map((i) => [i.id.toLowerCase(), i]));
    const reported = new Set<string>();

    for (const result of summary.results) {
      const item =
        byId.get(`${result.className}.${result.methodName}`.toLowerCase()) ??
        findItem(result.className, result.methodName);
      if (!item) {
        // A test the CLI ran that we never discovered (our source scan is a
        // regex heuristic, and RunLocalTests reaches the whole org). Keep it
        // visible in the run's output rather than dropping it silently.
        run.appendOutput(`${outcomeMark(result)} ${result.className}.${result.methodName}\r\n`);
        continue;
      }
      reported.add(item.id);
      run.started(item);
      if (result.outcome === 'Pass') {
        run.passed(item, result.runTime);
      } else if (result.outcome === 'Skip') {
        run.skipped(item);
      } else {
        run.failed(item, await failureMessage(result), result.runTime);
      }
    }

    if (summary.results.length === 0) {
      // The CLI can return a result carrying only a testRunId — the org is still
      // running the job past `--wait`. Marking everything skipped would report
      // that as a tidy finished run; say what actually happened instead.
      run.appendOutput(
        'This run reported no test results. If it was just started, the org may still be ' +
          'running it — "SF Tests: Load Recent Test Runs" picks it up once it finishes.\r\n',
      );
      return;
    }
    // Leaves we enqueued that the run never mentioned: not failures, not passes.
    for (const item of items) {
      if (item.children.size === 0 && !reported.has(item.id)) run.skipped(item);
    }
  }

  async function failureMessage(result: TestMethodResult): Promise<vscode.TestMessage> {
    const text =
      [result.message, result.stackTrace].filter(Boolean).join('\n') || `${result.outcome}`;
    const message = new vscode.TestMessage(text);
    const frame = primaryFrame(result.stackTrace, result.className);
    if (frame) {
      const uri = await findApexFile(frame.className, frame.isTrigger);
      if (uri) {
        message.location = new vscode.Location(uri, lineRange(Math.max(0, frame.line - 1)));
      }
    }
    return message;
  }

  /**
   * Turn per-class line coverage into the native shape and attach it to the run.
   * The detailed per-line data is kept for `loadDetailedCoverage`, which VS Code
   * calls only when the user actually opens a covered file.
   */
  async function attachCoverage(
    run: vscode.TestRun,
    infos: Iterable<CoverageInfo>,
  ): Promise<void> {
    // One workspace glob per class, resolved together: a RunLocalTests run comes
    // back with coverage for hundreds of classes, and doing this serially leaves
    // the run spinning in the Test Explorer long after the org has finished.
    const resolved = await Promise.all(
      [...infos].map(async (info) => ({ info, uri: await findApexFile(info.className, false) })),
    );
    for (const { info, uri } of resolved) {
      // Managed-package or otherwise out-of-workspace classes have no file to
      // paint; their numbers still appear in the output channel.
      if (!uri) continue;
      const statements: vscode.FileCoverageDetail[] = [
        ...info.coveredLines.map((line) => new vscode.StatementCoverage(true, lineRange(line - 1))),
        ...info.uncoveredLines.map(
          (line) => new vscode.StatementCoverage(false, lineRange(line - 1)),
        ),
      ];
      if (statements.length === 0) continue;
      const fileCoverage = vscode.FileCoverage.fromDetails(uri, statements);
      coverageDetails.set(fileCoverage, statements);
      run.addCoverage(fileCoverage);
    }
  }

  function logSummary(
    summary: TestRunSummary,
    orgUsername: string,
    coverage: Map<string, CoverageInfo>,
  ): void {
    deps.output.appendLine('');
    deps.output.appendLine(
      `Result: ${summary.status} · ${summary.passing}/${summary.testsRan} passed · ` +
        `${summary.testTotalTime}ms · org ${orgUsername}`,
    );
    for (const result of summary.results) {
      deps.output.appendLine(
        `  ${outcomeMark(result)} ${result.className}.${result.methodName} (${result.runTime}ms)`,
      );
      if (result.outcome !== 'Pass' && result.message) {
        deps.output.appendLine(`     ${result.message}`);
      }
    }
    const covered = [...coverage.values()].sort((a, b) => a.className.localeCompare(b.className));
    if (covered.length === 0) return;
    const overall = overallCoveragePercent(coverage);
    deps.output.appendLine(`Coverage${overall === null ? '' : ` (${overall}% overall)`}:`);
    for (const info of covered) {
      const total = info.numLinesCovered + info.numLinesUncovered;
      const pct = total === 0 ? 0 : Math.round((info.numLinesCovered * 100) / total);
      deps.output.appendLine(
        `  ${info.className}: ${pct}% covered (${info.numLinesCovered}/${total} lines)`,
      );
    }
  }

  /** Resolved class/trigger name → file. Only hits are cached: a miss can become
   *  a hit when the class is retrieved from the org later in the session. */
  const fileCache = new Map<string, vscode.Uri>();

  /** Resolve an Apex class/trigger name to its source file in the workspace. */
  async function findApexFile(name: string, isTrigger: boolean): Promise<vscode.Uri | undefined> {
    // Class names reach this from CLI output as well as from our own scan, and
    // they are spliced into a search glob. Apex identifiers are word characters
    // only, so anything else is not a name we could match anyway.
    if (!/^\w+$/.test(name)) return undefined;
    const key = `${isTrigger ? 'trigger' : 'cls'}:${name.toLowerCase()}`;
    const cached = fileCache.get(key);
    if (cached) return cached;
    const ext = isTrigger ? 'trigger' : 'cls';
    const matches = await vscode.workspace.findFiles(`**/${name}.${ext}`, '**/node_modules/**', 1);
    if (matches[0]) fileCache.set(key, matches[0]);
    return matches[0];
  }

  return {
    runAllLocal,
    publishLoadedRun,
    publishOrgCoverage,
    dispose(): void {
      for (const disposable of subscriptions) disposable.dispose();
      controller.dispose();
    },
  };
}

function lineRange(zeroBasedLine: number): vscode.Range {
  const line = Math.max(0, zeroBasedLine);
  return new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
}

function outcomeMark(result: TestMethodResult): string {
  return result.outcome === 'Pass' ? '✓' : result.outcome === 'Skip' ? '•' : '✗';
}
