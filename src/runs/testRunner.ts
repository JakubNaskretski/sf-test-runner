/**
 * Everything that starts, finishes, cancels or loads a test run.
 *
 * This is the module the panel's buttons, the CodeLens and the command palette
 * all go through, and the only place the single-run guard, the production
 * confirmation and the org capture live. The views never call the CLI: they post
 * a message, the provider calls a method here, and the result lands in the store
 * (`PanelState`) that every view renders.
 *
 * Two invariants worth keeping:
 *  - The org is resolved ONCE, before the run starts, and travels with the
 *    `RunRecord`. A result arriving after the user switched orgs is still
 *    recorded under the org it actually ran on.
 *  - Coverage is only ever published from this plugin's own run or from the
 *    explicit per-class load below, and its label always says which.
 *
 * Runs are ASYNC. `sf apex run test` returns the id the org gave the job and
 * exits; `pollRun` watches `ApexTestRunResult`/`ApexTestResult` and feeds the
 * progress line and the per-method glyphs while the tests execute; cancelling
 * aborts the run's remaining queue items IN THE ORG rather than only killing a
 * local process.
 */
import * as vscode from 'vscode';
import { isLikelyProduction } from '../kit/orgs';
import { RunGuard } from '../runGuard';
import { overallCoveragePercent } from '../salesforce/coverageMapping';
import {
  RecentTestRun,
  SfCliCancelledError,
  SfCliService,
  StartedTestRun,
} from '../salesforce/sfCliService';
import {
  CoverageInfo,
  OrgInfo,
  RunStatus,
  TestMethodResult,
  TestRunSummary,
} from '../types';
import { ApexFileResolver } from '../ui/openApex';
import { PanelState } from '../ui/panelState';
import type { OutcomeKind } from '../webview/protocol';
import { pollUntilDone } from './pollRun';
import {
  coverageOrgChangedNote,
  dropClasses,
  isSelector,
  localOnlyClasses,
  runLabel,
  summaryText,
} from './runLabel';

export interface TestRunnerDeps {
  sfCli: SfCliService;
  state: PanelState;
  output: vscode.OutputChannel;
  /** The plugin's current target org — owned by the org picker, not the store. */
  getOrg(): OrgInfo | undefined;
  /** Shared file resolver, used to show the class an org coverage load was for. */
  resolver: ApexFileResolver;
  /** Reveal the output channel, unless the user turned that off. */
  revealOutput(): void;
}

/**
 * More than this many CLASS selectors and the command line gets long enough to
 * be truncated on Windows (8191 chars). The org already has a word for "every
 * local test", so we point at it instead of building the monster.
 */
const MAX_CLASS_SELECTORS = 100;

const NO_ORG = 'Select a Salesforce org first.';
const BUSY = 'A test run is already in progress. Wait for it to finish.';

export class TestRunner implements vscode.Disposable {
  private readonly guard = new RunGuard();
  /** Cancels the in-flight CLI call. Undefined when nothing is running. */
  private cancellation: vscode.CancellationTokenSource | undefined;
  /** What `cancel()` needs to stop the run in the org. `testRunId` stays
   *  undefined until the start call comes back with one. */
  private active: { orgUsername: string; testRunId?: string } | undefined;
  private sequence = 0;

  constructor(private readonly deps: TestRunnerDeps) {}

  // ────────────────────────────── entry points ─────────────────────────────

  /** Run what is ticked in the Tests view. */
  async runSelected(): Promise<void> {
    const state = this.deps.state;
    const index = state.index;
    let selectors = state.selection.toSelectors(index).filter(isSelector);
    if (selectors.length === 0) {
      void vscode.window.showInformationMessage('No Apex tests selected.');
      return;
    }

    const classSelectors = selectors.filter((s) => !s.includes('.'));
    if (classSelectors.length > MAX_CLASS_SELECTORS) {
      const runAll = 'Run All Local';
      const anyway = 'Run anyway';
      const pick = await vscode.window.showWarningMessage(
        `${classSelectors.length} classes are selected.`,
        {
          modal: true,
          detail:
            'A command line naming this many classes can be truncated on Windows. ' +
            '"Run All Local" asks the org for RunLocalTests instead.',
        },
        runAll,
        anyway,
      );
      if (pick === runAll) return this.runAllLocal();
      if (pick !== anyway) return;
    }

    // Local-only classes do not exist in the org: `--tests` would name something
    // the org has never heard of and the whole run fails, not just that class.
    // Only claimed when the index actually holds this org's class list — see
    // localOnlyClasses; an unfetched org half stamps everything local-only.
    const target = this.deps.getOrg();
    const notDeployed = localOnlyClasses(index, selectors, target?.username);
    if (notDeployed.length > 0) {
      const anyway = 'Run anyway';
      const skip = 'Skip them';
      const alias = target?.alias ?? 'the target org';
      const pick = await vscode.window.showWarningMessage(
        `${notDeployed.length} selected ${notDeployed.length === 1 ? 'class is' : 'classes are'} ` +
          `not deployed to ${alias}.`,
        {
          modal: true,
          detail: `${notDeployed.join(', ')}\n\nThe org runs tests it has; these would fail the run.`,
        },
        anyway,
        skip,
      );
      if (pick === skip) {
        selectors = dropClasses(selectors, notDeployed);
        if (selectors.length === 0) {
          void vscode.window.showInformationMessage(
            'Nothing left to run once the classes that are not deployed are skipped.',
          );
          return;
        }
      } else if (pick !== anyway) {
        return;
      }
    }

    const coverage = state.runWithCoverage;
    const chosen = selectors;
    await this.start(
      (alias) => runLabel('selected', chosen.length, alias),
      coverage,
      (orgUsername, token) =>
        this.deps.sfCli.runTestSelection(chosen, orgUsername, { cancellation: token, coverage }),
    );
  }

  /**
   * Run an explicit list of selectors — the CodeLens lenses and re-run-failed.
   * `opts.coverage` overrides the "with coverage" preference for this run only,
   * which is what makes a "Run with Coverage" lens mean it.
   */
  async runSelectors(
    selectors: string[],
    label: string,
    opts: { coverage?: boolean } = {},
  ): Promise<void> {
    const clean = selectors.filter(isSelector);
    if (clean.length === 0) {
      void vscode.window.showInformationMessage('No Apex tests to run.');
      return;
    }
    const coverage = opts.coverage ?? this.deps.state.runWithCoverage;
    await this.start(
      () => label,
      coverage,
      (orgUsername, token) =>
        this.deps.sfCli.runTestSelection(clean, orgUsername, { cancellation: token, coverage }),
    );
  }

  /** `RunLocalTests`: every test in the org except managed-package ones. */
  async runAllLocal(): Promise<void> {
    const coverage = this.deps.state.runWithCoverage;
    await this.start(
      (alias) => runLabel('allLocal', 0, alias),
      coverage,
      (orgUsername, token) =>
        this.deps.sfCli.runAllLocalTests(orgUsername, { cancellation: token, coverage }),
    );
  }

  /** `RunAllTestsInOrg`: managed-package tests included. Slow, and deliberately
   *  behind the overflow menu. */
  async runAllInOrg(): Promise<void> {
    const coverage = this.deps.state.runWithCoverage;
    await this.start(
      (alias) => runLabel('allInOrg', 0, alias),
      coverage,
      (orgUsername, token) =>
        this.deps.sfCli.runAllTestsInOrg(orgUsername, { cancellation: token, coverage }),
    );
  }

  /** Re-run just the failures of the run currently in the Results view. */
  async rerunFailed(): Promise<void> {
    const run = this.deps.state.run;
    const summary = run?.summary;
    if (!run || !summary) {
      void vscode.window.showInformationMessage('No finished test run to re-run.');
      return;
    }
    const selectors = [
      ...new Set(
        summary.results
          .filter((r) => r.outcome === 'Fail' || r.outcome === 'CompileFail')
          .map((r) => `${r.className}.${r.methodName}`)
          .filter(isSelector),
      ),
    ];
    if (selectors.length === 0) {
      void vscode.window.showInformationMessage('No failed tests in this run.');
      return;
    }
    const org = this.deps.getOrg();
    if (!org) {
      void vscode.window.showWarningMessage(NO_ORG);
      return;
    }
    // Re-running org A's failures against org B would silently test different
    // code and report it under the same failures — say so instead.
    if (org.username !== run.orgUsername) {
      void vscode.window.showWarningMessage(
        `That run was on ${run.orgAlias}, but the current org is ${org.alias}. ` +
          'Switch back to re-run its failures.',
      );
      return;
    }
    await this.runSelectors(
      selectors,
      `${selectors.length} failed ${selectors.length === 1 ? 'test' : 'tests'} on ${org.alias}`,
    );
  }

  /**
   * Stop the run: kill what we are waiting on locally AND tell the org to abort
   * the queue items it has not started. Cancelled before the org reported an id
   * (the start call is still in flight), there is nothing to abort — killing
   * that call is the whole cancellation.
   */
  cancel(): void {
    if (!this.cancellation) {
      void vscode.window.showInformationMessage('No test run is in progress.');
      return;
    }
    const active = this.active;
    this.deps.output.appendLine('… Cancelling the run…');
    // Local first, and the abort below deliberately travels on NO token: it is
    // a fresh call that must outlive the one we just cancelled.
    this.cancellation.cancel();
    if (active?.testRunId) void this.abortInOrg(active.testRunId, active.orgUsername);
  }

  /** Fire-and-forget half of `cancel()`. Everything is caught: the run is
   *  cancelled locally either way, and a modal on top of the cancellation the
   *  user just asked for helps nobody — the output channel says what happened. */
  private async abortInOrg(testRunId: string, orgUsername: string): Promise<void> {
    try {
      const aborted = await this.deps.sfCli.abortTestRun(testRunId, orgUsername);
      this.deps.output.appendLine(
        aborted > 0
          ? `✕ Aborted ${aborted} queued test ${aborted === 1 ? 'class' : 'classes'} of ${testRunId}.`
          : `Nothing left to abort in ${testRunId}: the org had already worked through the queue.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.output.appendLine(`✗ Could not abort ${testRunId} in the org: ${message}`);
    }
  }

  /**
   * Surface a run this extension did NOT start (terminal, CI, another tool — or
   * one lost to a window reload): list the org's recent async runs, load the
   * picked one, and publish it into the panel like any other run.
   */
  async loadRecent(): Promise<void> {
    const org = this.deps.getOrg();
    if (!org) {
      void vscode.window.showWarningMessage(NO_ORG);
      return;
    }
    // The guard is claimed only once a run is actually picked, so it must be
    // released only then too: RunGuard.release() is unconditional, and releasing
    // one we never took would free somebody else's in-flight run.
    let holdsGuard = false;
    try {
      const runs = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'SF Tests: loading recent runs…' },
        () => this.deps.sfCli.listRecentTestRuns(org.username),
      );
      if (runs.length === 0) {
        void vscode.window.showInformationMessage('No async test runs found in the org.');
        return;
      }
      const pick = await vscode.window.showQuickPick(runs.map(recentRunItem), {
        placeHolder: 'Load a recent test run (includes runs started outside VS Code)',
        matchOnDescription: true,
      });
      if (!pick) return;
      // Claimed only now: holding the single-run guard while the picker sat open
      // made every other run refuse with "a test run is already in progress".
      if (!this.guard.tryAcquire()) {
        void vscode.window.showWarningMessage(BUSY);
        return;
      }
      holdsGuard = true;
      this.deps.state.setBusy({ running: true });
      this.deps.revealOutput();
      this.deps.output.appendLine(`▶ Loading test run ${pick.run.testRunId}…`);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `SF Tests: loading run ${pick.run.testRunId}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const { summary, coverage } = await this.deps.sfCli.getTestRun(
            pick.run.testRunId,
            org.username,
            { cancellation: token },
          );
          this.publishLoadedRun(org, pick.run, summary, coverage);
        },
      );
    } catch (err) {
      if (!(err instanceof SfCliCancelledError)) this.handleError(err);
    } finally {
      if (holdsGuard) {
        this.guard.release();
        this.deps.state.setBusy({ running: false });
      }
    }
  }

  /**
   * The one path to coverage that is not a run: the org's stored
   * `ApexCodeCoverageAggregate` for a class — the most recent run that touched
   * it, whoever started it. It REPLACES the coverage snapshot, and its label
   * says exactly where it came from, so it can never be mistaken for the user's
   * own numbers.
   */
  async loadOrgCoverage(className?: string): Promise<void> {
    const org = this.deps.getOrg();
    if (!org) {
      void vscode.window.showWarningMessage(NO_ORG);
      return;
    }
    const name = className ?? activeClassName();
    if (!name || !/^\w+$/.test(name)) {
      void vscode.window.showWarningMessage('No Apex class selected.');
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Coverage: ${name}` },
      async () => {
        try {
          const info = await this.deps.sfCli.getCoverageForClass(name, org.username);
          if (!info) {
            void vscode.window.showInformationMessage(
              `No coverage stored in the org for ${name}. Run tests to generate it.`,
            );
            return;
          }
          this.deps.state.setCoverage({
            label: `${name} · org's last run (any user)`,
            orgUsername: org.username,
            at: Date.now(),
            infos: [info],
          });
          const total = info.numLinesCovered + info.numLinesUncovered;
          const pct = total === 0 ? 0 : Math.round((info.numLinesCovered * 100) / total);
          this.deps.output.appendLine(
            `Coverage for ${name} (org's last run, any user): ${pct}% covered ` +
              `(${info.numLinesCovered}/${total} lines)`,
          );
          // Asked for by name (the coverage table's cloud button) rather than for
          // the file already in front of the user: show the class the numbers are
          // about, so the painted lines are visible immediately.
          if (className) await this.deps.resolver.open(name);
        } catch (err) {
          // A failed query says nothing about whether the class has coverage: it
          // is an error, not the "no coverage stored" note.
          this.handleError(err);
        }
      },
    );
  }

  /** Put the current run's summary on the clipboard. */
  async copySummary(): Promise<void> {
    const run = this.deps.state.run;
    if (!run) {
      void vscode.window.showInformationMessage('No test run to copy yet.');
      return;
    }
    await vscode.env.clipboard.writeText(summaryText(run));
    void vscode.window.showInformationMessage('SF Tests: run summary copied.');
  }

  dispose(): void {
    this.cancellation?.dispose();
    this.cancellation = undefined;
  }

  // ─────────────────────────────── run plumbing ────────────────────────────

  /**
   * Everything that must be true before a run starts: a target org, the user's
   * consent when that org is production, and the single-run guard. Returns the
   * org to run against, or null when the run must not start — in which case the
   * user has already been told why.
   */
  private async acquire(): Promise<OrgInfo | null> {
    const org = this.deps.getOrg();
    if (!org) {
      void vscode.window.showWarningMessage(NO_ORG);
      return null;
    }
    // Ask before anything else happens, so backing out leaves no state behind:
    // no guard held, no output revealed, no run in the panel.
    if (!(await confirmProductionRun(org))) return null;
    // tryAcquire is atomic, so of two entry points racing here only one starts a
    // run — the other is told one is already in progress.
    if (!this.guard.tryAcquire()) {
      void vscode.window.showWarningMessage(BUSY);
      return null;
    }
    return org;
  }

  /** Shared body of every run: guard, record, start, poll, results, coverage,
   *  log. The org does the waiting; we watch and report. */
  private async start(
    labelFor: (alias: string) => string,
    coverage: boolean,
    startRun: (
      orgUsername: string,
      token: vscode.CancellationToken,
    ) => Promise<StartedTestRun>,
  ): Promise<void> {
    const org = await this.acquire();
    if (!org) return;

    const state = this.deps.state;
    const id = `run-${++this.sequence}-${Date.now()}`;
    const label = labelFor(org.alias);
    // Everything after the acquire lives in the try: a throw between claiming
    // the guard and entering it would hold the single-run lock until a reload.
    const cancellation = new vscode.CancellationTokenSource();
    this.cancellation = cancellation;
    this.active = { orgUsername: org.username };
    try {
      state.setRun({
        id,
        label,
        orgUsername: org.username,
        orgAlias: org.alias,
        startedAt: Date.now(),
        status: 'running',
        withCoverage: coverage,
      });
      state.setBusy({ running: true });
      this.deps.revealOutput();
      this.deps.output.appendLine(`▶ Running ${label} (${org.username})…`);

      const { testRunId } = await startRun(org.username, cancellation.token);
      // Recorded before the first poll: this id is what a cancel aborts, and
      // what "Load Recent Test Runs" needs if this window goes away mid-run.
      this.active = { orgUsername: org.username, testRunId };
      state.updateRun({ testRunId });
      this.deps.output.appendLine(`  queued in the org as ${testRunId}`);

      const verdict = await pollUntilDone<TestMethodResult>(
        {
          status: () =>
            this.deps.sfCli.getTestRunStatus(testRunId, org.username, {
              cancellation: cancellation.token,
            }),
          live: () =>
            this.deps.sfCli.getLiveResults(testRunId, org.username, {
              cancellation: cancellation.token,
            }),
          sleep,
          now: () => Date.now(),
          isCancelled: () => cancellation.token.isCancellationRequested,
          onError: (err, consecutive) => {
            const detail = err instanceof Error ? err.message : String(err);
            this.deps.output.appendLine(`  poll ${consecutive} failed, retrying: ${detail}`);
          },
          onTick: (progress, fresh) => {
            state.updateRun({ progress });
            for (const result of fresh) {
              state.setLiveOutcome(`${result.className}.${result.methodName}`, {
                o: liveOutcome(result.outcome),
                ms: result.runTime,
              });
            }
          },
        },
        this.deps.sfCli.testTimeoutMs(),
      );

      if (verdict.outcome === 'cancelled') return this.reportCancelled();
      if (verdict.outcome === 'aborted') {
        return this.reportCancelled('The run was aborted in the org.');
      }
      if (verdict.outcome === 'ceiling') {
        // Not a failure and not a pass: we stopped watching, the org did not
        // stop running. Say exactly that, and where the results will turn up.
        const minutes = Math.round(this.deps.sfCli.testTimeoutMs() / 60000);
        const note =
          `Gave up watching ${testRunId} after ${minutes} min — it is still running in ` +
          'the org. "Load Recent Test Runs" picks it up once it finishes.';
        state.updateRun({ status: 'error', finishedAt: Date.now(), error: note });
        this.deps.output.appendLine(`✗ ${note}`);
        void vscode.window.showWarningMessage(`SF Tests: ${note}`);
        return;
      }

      const result = await this.deps.sfCli.getTestRun(testRunId, org.username, {
        cancellation: cancellation.token,
      });
      const { status, error } = verdictOf(result.summary);
      state.updateRun({
        status,
        error,
        finishedAt: Date.now(),
        summary: result.summary,
        // Keep the id the start call gave us when the finished envelope carries
        // none — losing it would leave the run unfindable in the org's history.
        testRunId: result.summary.asyncApexJobId ?? testRunId,
      });
      if (coverage) {
        this.publishCoverage(org, result.coverage, result.summary.asyncApexJobId ?? testRunId);
      }
      this.logSummary(result.summary, org.username, result.coverage);
    } catch (err) {
      if (err instanceof SfCliCancelledError) {
        this.reportCancelled();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        state.updateRun({ status: 'error', finishedAt: Date.now(), error: message });
        this.handleError(err);
      }
    } finally {
      cancellation.dispose();
      this.cancellation = undefined;
      this.active = undefined;
      this.guard.release();
      state.setBusy({ running: false });
    }
  }

  /** One wording for every way a run stops early, because they all mean the
   *  same thing to the user: we stopped, and the class the org had already
   *  started still runs to its end. */
  private reportCancelled(note = 'Run cancelled.'): void {
    const full = `${note} The test class the org is already executing still finishes.`;
    this.deps.state.updateRun({ status: 'cancelled', finishedAt: Date.now(), error: full });
    this.deps.output.appendLine(`✕ ${full}`);
    void vscode.window.showInformationMessage(`SF Tests: ${full}`);
  }

  /** A run loaded from the org's history, published as a record of its own. */
  private publishLoadedRun(
    org: OrgInfo,
    recent: RecentTestRun,
    summary: TestRunSummary,
    coverage: Map<string, CoverageInfo>,
  ): void {
    const startedAt = Date.parse(recent.startTime);
    const { status, error } = verdictOf(summary);
    this.deps.state.setRun({
      id: recent.testRunId,
      // Named for what it is: a run from the org's history, not one we started.
      label: `Loaded run ${recent.testRunId} on ${org.alias}`,
      orgUsername: org.username,
      orgAlias: org.alias,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      finishedAt: Date.now(),
      status,
      error,
      // `sf apex get test` always asks for coverage, so a loaded run has it.
      withCoverage: true,
      summary,
      testRunId: recent.testRunId,
    });
    this.publishCoverage(org, coverage, recent.testRunId);
    this.logSummary(summary, org.username, coverage);
  }

  /**
   * Replace the coverage snapshot with this run's. The decorator paints it when
   * the `paintCoverage` setting is on — that is the whole auto-paint mechanism.
   * A run that returned none leaves the previous snapshot (which carries its own
   * provenance) alone and says so in the log.
   *
   * `org` is the org the run STARTED on. If the user switched away while it was
   * polling, the snapshot is not published at all: the run's own results stay
   * (they are labelled with their org), but nothing paints.
   */
  private publishCoverage(
    org: OrgInfo,
    coverage: Map<string, CoverageInfo>,
    runId: string,
  ): void {
    const infos = [...coverage.values()];
    if (infos.length === 0) {
      this.deps.output.appendLine('No code coverage came back with this run.');
      return;
    }
    const changed = coverageOrgChangedNote(org, this.deps.getOrg());
    if (changed) {
      this.deps.output.appendLine(changed);
      return;
    }
    this.deps.state.setCoverage({
      label: `run ${runId} on ${org.alias}`,
      orgUsername: org.username,
      at: Date.now(),
      runId,
      infos,
    });
  }

  private logSummary(
    summary: TestRunSummary,
    orgUsername: string,
    coverage: Map<string, CoverageInfo>,
  ): void {
    const output = this.deps.output;
    output.appendLine('');
    output.appendLine(
      `Result: ${summary.status} · ${summary.passing}/${summary.testsRan} passed · ` +
        `${summary.testTotalTime}ms · org ${orgUsername}`,
    );
    for (const result of summary.results) {
      const mark = result.outcome === 'Pass' ? '✓' : result.outcome === 'Skip' ? '•' : '✗';
      output.appendLine(`  ${mark} ${result.className}.${result.methodName} (${result.runTime}ms)`);
      if (result.outcome !== 'Pass' && result.message) output.appendLine(`     ${result.message}`);
    }
    const covered = [...coverage.values()].sort((a, b) => a.className.localeCompare(b.className));
    if (covered.length === 0) return;
    const overall = overallCoveragePercent(coverage);
    output.appendLine(`Coverage${overall === null ? '' : ` (${overall}% overall)`}:`);
    for (const info of covered) {
      const total = info.numLinesCovered + info.numLinesUncovered;
      const pct = total === 0 ? 0 : Math.round((info.numLinesCovered * 100) / total);
      output.appendLine(
        `  ${info.className}: ${pct}% covered (${info.numLinesCovered}/${total} lines)`,
      );
    }
  }

  private handleError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.output.appendLine(`✗ Error: ${message}`);
    void vscode.window.showErrorMessage(`SF Tests: ${message}`, 'Show Output').then((pick) => {
      if (pick === 'Show Output') this.deps.output.show(true);
    });
  }
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
 * What a finished run is worth. A result carrying no tests at all is NOT a pass:
 * the CLI returns that when the org is still running the job past `--wait`, and
 * reporting it as a tidy green run is exactly the silent failure this plugin has
 * had to fix twice.
 */
function verdictOf(summary: TestRunSummary): { status: RunStatus; error?: string } {
  if (summary.results.length === 0) {
    const tail = summary.asyncApexJobId
      ? ` The org may still be running ${summary.asyncApexJobId} — "Load Recent Test Runs" picks ` +
        'it up once it finishes.'
      : '';
    return { status: 'error', error: `This run reported no test results.${tail}` };
  }
  return { status: summary.failing > 0 ? 'failed' : 'passed' };
}

/** A live result's glyph on the tests tree. Anything that is neither a pass nor
 *  a skip is a failure — CompileFail included. */
function liveOutcome(outcome: TestMethodResult['outcome']): OutcomeKind {
  return outcome === 'Pass' ? 'pass' : outcome === 'Skip' ? 'skip' : 'fail';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RecentRunItem extends vscode.QuickPickItem {
  run: RecentTestRun;
}

function recentRunItem(run: RecentTestRun): RecentRunItem {
  return {
    label: `$(beaker) ${run.startTime ? new Date(run.startTime).toLocaleString() : run.testRunId}`,
    description: `${run.status} · ${run.methodsFailed} failed / ${run.methodsCompleted} run · ${run.testRunId}`,
    run,
  };
}

/** The class the user is looking at, for a coverage load with no explicit name. */
function activeClassName(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const match = uri?.fsPath.match(/([^/\\]+)\.cls$/i);
  return match ? match[1] : undefined;
}
