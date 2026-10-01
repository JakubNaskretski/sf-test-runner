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
import {
  contributesCommand,
  decideAfterDeploy,
  deploySucceeded,
  handoffCapMessage,
  parseDeployResult,
  RunForOutcome,
} from '../handoff';
import { isLikelyProduction } from '../kit/orgs';
import { TRACE_FLAG_MARGIN_MS, debugLogDocument } from '../salesforce/debugLogs';
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
  RunRecord,
  RunStatus,
  TestMethodResult,
  TestRunSummary,
} from '../types';
import { resolveTargets } from '../ui/coverageTargets';
import { ApexFileResolver } from '../ui/openApex';
import { PanelState } from '../ui/panelState';
import type { OutcomeKind } from '../webview/protocol';
import { pollUntilDone } from './pollRun';
import {
  coverageOrgChangedNote,
  dropClasses,
  excludeDeployed,
  handoffCoverageNote,
  handoffLabel,
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
  /** Record that `classNames` are now present (and are tests) in the org
   *  half of the index for `orgUsername` — "Deploy first" just put them
   *  there — then rebuild the index so the same classes don't warn as
   *  not-deployed again this session. Only ever called for the org that was
   *  actually deployed to. */
  markDeployed(orgUsername: string, classNames: readonly string[]): Promise<void>;
}

/**
 * More than this many CLASS selectors and the command line gets long enough to
 * be truncated on Windows (8191 chars). The org already has a word for "every
 * local test", so we point at it instead of building the monster.
 */
const MAX_CLASS_SELECTORS = 100;

const NO_ORG = 'Select a Salesforce org first.';
const BUSY = 'A test run is already in progress. Wait for it to finish.';

/** sf-org-deploy-helper's extension id — gates the "Deploy first" button on
 *  the not-deployed warning and names the command it answers. */
const DEPLOY_HELPER_EXTENSION_ID = 'Skrety.sf-org-deploy-wrapper';
const DEPLOY_HELPER_COMMAND = 'sfOrgDeployWrapper.deployComponents';

export class TestRunner implements vscode.Disposable {
  private readonly guard = new RunGuard();
  /** Cancels the in-flight CLI call. Undefined when nothing is running. */
  private cancellation: vscode.CancellationTokenSource | undefined;
  /** What `cancel()` needs to stop the run in the org. `testRunId` stays
   *  undefined until the start call comes back with one. */
  private active: { orgUsername: string; testRunId?: string } | undefined;
  private sequence = 0;
  /** Log bodies already fetched for the current run, by ApexLogId. */
  private readonly logCache = new Map<string, string>();
  /** The untitled tab each log was opened in, so a second click focuses it
   *  instead of minting another dirty document. */
  private readonly logDocs = new Map<string, vscode.TextDocument>();

  constructor(private readonly deps: TestRunnerDeps) {}

  /** Whether a run currently holds the single-run guard — checked by callers
   *  (the cross-extension test handoff) that must not even attempt a start. */
  get isRunning(): boolean {
    return this.guard.isRunning;
  }

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
    //
    // Captured once, before the modal (whose "Deploy first" can sit waiting on
    // a deploy for a while): the run must land on the org the modal was about,
    // even if the picker moves on to another org while that wait is in flight.
    const target = this.deps.getOrg();
    const confirmed = await this.confirmDeployed(selectors, target);
    if (!confirmed) return;
    selectors = confirmed;

    const coverage = state.runWithCoverage;
    const chosen = selectors;
    await this.start(
      (alias) => runLabel('selected', chosen.length, alias),
      coverage,
      (orgUsername, token) =>
        this.deps.sfCli.runTestSelection(chosen, orgUsername, { cancellation: token, coverage }),
      { org: target },
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

  /**
   * The cross-extension test handoff (`sfTestRunner.runTestsFor`): run
   * `selectors` against `org`, which is the CALLER's target org and may not
   * be the picker's. Same not-deployed warning as `runSelected` (including
   * its own "Deploy first" offer, minus the org-moved question — the caller
   * named its org explicitly, so there is no picker to have moved);
   * `opts.deployed` is the caller's own claim that `selectors` (or the names
   * they were resolved from) are already on `org` — see `excludeDeployed`.
   *
   * More than `MAX_CLASS_SELECTORS` resolved classes refuses outright, no
   * modal: a handoff names classes by convention/declaration, not by hand,
   * so there is no "Run All Local" escape hatch to offer, and the command
   * line would risk the same Windows truncation `runSelected` warns about.
   *
   * `record` is undefined when the run never started: `error` is set only
   * for that refusal; otherwise `busy` distinguishes a guard race (a second
   * handoff raced past the caller's own `isRunning` check) from a declined
   * production confirmation or a dismissed/emptied not-deployed modal, both
   * of which the caller has already been told about via a toast and should
   * read as cancelled.
   */
  async runFor(
    selectors: string[],
    org: OrgInfo,
    opts?: { deployed?: readonly string[] },
  ): Promise<RunForOutcome> {
    const capMessage = handoffCapMessage(selectors.length, MAX_CLASS_SELECTORS);
    if (capMessage) {
      return { record: undefined, ranSelectors: selectors, busy: false, error: capMessage };
    }
    const confirmed = await this.confirmDeployed(selectors, org, {
      deployedNames: opts?.deployed,
      fromHandoff: true,
    });
    if (!confirmed) return { record: undefined, ranSelectors: selectors, busy: false };
    const coverage = this.deps.state.runWithCoverage;
    const { record, busy } = await this.start(
      (alias) => handoffLabel('selected', confirmed.length, alias),
      coverage,
      (orgUsername, token) =>
        this.deps.sfCli.runTestSelection(confirmed, orgUsername, { cancellation: token, coverage }),
      { org, fromHandoff: true },
    );
    return { record, ranSelectors: confirmed, busy };
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
            scope: 'org',
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

  /** Mark each result with its ApexLogId, or say why none came. */
  private async attachLogIds(
    summary: TestRunSummary,
    testRunId: string,
    orgUsername: string,
  ): Promise<void> {
    try {
      const ids = await this.deps.sfCli.getLogIds(testRunId, orgUsername);
      for (const r of summary.results) {
        r.apexLogId = ids.get(`${r.className}.${r.methodName}`) ?? null;
      }
      if (ids.size > 0) {
        this.deps.output.appendLine(`  ${ids.size} debug log(s) kept — "log" next to a method opens it`);
      } else if (summary.results.length > 0) {
        // The output channel is hidden by default, so this cannot live only there.
        const note = 'no debug logs came back with this run — the org keeps none once its log allocation is full, or the trace flag did not cover the run';
        this.deps.output.appendLine(`  ${note}`);
        void vscode.window.showWarningMessage(`SF Tests: ${note}.`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.output.appendLine(`  could not look up debug logs: ${detail}`);
      void vscode.window.showWarningMessage(`SF Tests: the run finished but its debug logs could not be looked up. ${detail}`);
    }
  }

  /** Open one method's debug log in an editor tab: debug lines first, then the whole log. */
  async showLog(className: string, methodName: string): Promise<void> {
    const run = this.deps.state.run;
    const result = run?.summary?.results.find(
      (r) => r.className === className && r.methodName === methodName,
    );
    if (!run || !result?.apexLogId) {
      void vscode.window.showInformationMessage(`No debug log for ${className}.${methodName}.`);
      return;
    }
    const logId = result.apexLogId;
    try {
      let raw = this.logCache.get(logId);
      if (raw === undefined) {
        raw = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Fetching log for ${methodName}…` },
          () => this.deps.sfCli.getApexLog(logId, run.orgUsername),
        );
        this.logCache.set(logId, raw);
      }
      let doc = this.logDocs.get(logId);
      if (!doc || doc.isClosed) {
        doc = await vscode.workspace.openTextDocument({
          content: debugLogDocument(`${className}.${methodName} — ${run.orgAlias} · ${logId}`, raw),
          language: 'log',
        });
        this.logDocs.set(logId, doc);
      }
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      this.handleError(err);
    }
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
   * The not-deployed warning before a run: which selectors are safe to send,
   * or null to not run at all. Split out of `runSelected` so the
   * cross-extension handoff (`runFor`) gets the same warning — against ITS
   * OWN target org, which `localOnlyClasses` already handles (it returns []
   * once the index's org half isn't `target`, so an override org can't be
   * told it's missing classes based on a stale fetch). `opts.deployedNames`
   * is the handoff's own "these are on the org right now" claim (see
   * `excludeDeployed`); `opts.fromHandoff` drops "selected" from the wording
   * — nothing was selected in TR, the caller named the classes. `runSelected`
   * passes neither.
   *
   * "Deploy first…" only offers itself when sf-org-deploy-wrapper is
   * installed (and new enough — see `deployHelperAvailable`) and there is
   * an org to deploy to. Its reply crosses the extension boundary, so it is
   * validated like anything else arriving from outside — a throw or a
   * malformed result counts as "did not deploy", not as a run. What happens
   * next is `decideAfterDeploy`'s table: `markDeployed` is recorded for
   * EITHER of its two success outcomes, so the SAME classes don't warn
   * again next time, whether or not the org turned out to have moved.
   * No re-check of the index afterwards beyond that: the org half it would
   * otherwise check against is stale by design (nothing refetches it here).
   */
  private async confirmDeployed(
    selectors: string[],
    target: OrgInfo | undefined,
    opts?: { deployedNames?: readonly string[]; fromHandoff?: boolean },
  ): Promise<string[] | null> {
    const notDeployed = excludeDeployed(
      localOnlyClasses(this.deps.state.index, selectors, target?.username),
      opts?.deployedNames,
    );
    if (notDeployed.length === 0) return selectors;

    const anyway = 'Run anyway';
    const skip = 'Skip them';
    // The ellipsis says a second dialog can follow (the org-moved question).
    const deployFirstLabel = 'Deploy first…';
    const alias = target?.alias ?? 'the target org';
    const offerDeploy = target !== undefined && deployHelperAvailable();
    const buttons = offerDeploy ? [anyway, skip, deployFirstLabel] : [anyway, skip];
    const classWord = notDeployed.length === 1 ? 'class is' : 'classes are';
    const subject = opts?.fromHandoff
      ? `${notDeployed.length} ${classWord}`
      : `${notDeployed.length} selected ${classWord}`;

    const pick = await vscode.window.showWarningMessage(
      `${subject} not deployed to ${alias}.`,
      {
        modal: true,
        detail: `${notDeployed.join(', ')}\n\nThe org runs tests it has; these would fail the run.`,
      },
      ...buttons,
    );

    if (pick === skip) {
      const left = dropClasses(selectors, notDeployed);
      if (left.length === 0) {
        void vscode.window.showInformationMessage(
          'Nothing left to run once the classes that are not deployed are skipped.',
        );
        return null;
      }
      return left;
    }

    if (pick === deployFirstLabel && target) {
      const result = await this.deployFirst(notDeployed, target.username);
      if (deploySucceeded(result)) await this.deps.markDeployed(target.username, notDeployed);
      const decision = decideAfterDeploy(
        result,
        Boolean(opts?.fromHandoff),
        target,
        this.deps.getOrg(),
      );
      switch (decision) {
        case 'run':
          return selectors;
        case 'confirmMoved':
          return this.confirmRunOnDeployedOrg(target, selectors);
        case 'stopSilent':
          return null;
        case 'stopWithMessage':
          void vscode.window.showInformationMessage(
            result?.message
              ? `SF Tests: deploy did not complete — ${result.message}`
              : 'SF Tests: deploy did not complete.',
          );
          return null;
      }
    }

    return pick === anyway ? selectors : null;
  }

  /**
   * "Deploy first…" succeeded, but the picker has since moved off the org
   * the classes were just deployed to. Asking is the honest answer: silently
   * pinning to the deployed-to org would run tests the user no longer thinks
   * they're targeting, and silently following the picker would test classes
   * that were never deployed there. Dismissing (or anything but the one
   * button) is a plain cancel — no toast, the user just said no.
   */
  private async confirmRunOnDeployedOrg(
    deployedTo: OrgInfo,
    selectors: string[],
  ): Promise<string[] | null> {
    const current = this.deps.getOrg();
    const runOnDeployed = `Run on ${deployedTo.alias}`;
    const pick = await vscode.window.showWarningMessage(
      'The org changed while deploying.',
      {
        modal: true,
        detail:
          `Tests will run on ${deployedTo.alias}, where the classes were just deployed — ` +
          `the picker now shows ${current?.alias ?? 'no org'}.`,
      },
      runOnDeployed,
    );
    return pick === runOnDeployed ? selectors : null;
  }

  /** "Deploy first…": hand the not-deployed classes to sf-org-deploy-wrapper
   *  and wait for its outcome. A throw (command missing, the other side
   *  errored) is logged, not toasted — `decideAfterDeploy` already turns the
   *  resulting undefined into its own message — and a malformed reply is
   *  rejected the same way by `parseDeployResult`. */
  private async deployFirst(classNames: string[], targetOrg: string) {
    try {
      const raw = await vscode.commands.executeCommand(DEPLOY_HELPER_COMMAND, {
        classNames,
        targetOrg,
      });
      return parseDeployResult(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.output.appendLine(`✗ "Deploy first" (${DEPLOY_HELPER_COMMAND}) failed: ${message}`);
      return undefined;
    }
  }

  /**
   * Everything that must be true before a run starts: a target org, the user's
   * consent when that org is production, and the single-run guard. `org`
   * overrides the picker's own org — the cross-extension handoff runs against
   * the CALLER's target, which need not be what the picker shows. `org` is
   * null when the run must not start — in which case the user has already
   * been told why; `busy` is set only for the guard specifically, so a caller
   * that cares (the handoff) can tell "someone else is already running" apart
   * from "declined" or "no org".
   */
  private async acquire(org?: OrgInfo): Promise<{ org: OrgInfo | null; busy: boolean }> {
    const target = org ?? this.deps.getOrg();
    if (!target) {
      void vscode.window.showWarningMessage(NO_ORG);
      return { org: null, busy: false };
    }
    // Ask before anything else happens, so backing out leaves no state behind:
    // no guard held, no output revealed, no run in the panel.
    if (!(await confirmProductionRun(target))) return { org: null, busy: false };
    // tryAcquire is atomic, so of two entry points racing here only one starts a
    // run — the other is told one is already in progress.
    if (!this.guard.tryAcquire()) {
      void vscode.window.showWarningMessage(BUSY);
      return { org: null, busy: true };
    }
    return { org: target, busy: false };
  }

  /** Shared entry point of every run: acquire, execute, hand back the
   *  finished record. `opts.org` is the cross-extension handoff's override —
   *  see `acquire`. `opts.fromHandoff` only changes the wording of the
   *  "target org changed" coverage note if the org ever turns out not to
   *  match the picker's — see `publishCoverage`. `record` is undefined when
   *  the run never started; `busy` mirrors `acquire`'s guard-specific
   *  signal. */
  private async start(
    labelFor: (alias: string) => string,
    coverage: boolean,
    startRun: (
      orgUsername: string,
      token: vscode.CancellationToken,
    ) => Promise<StartedTestRun>,
    opts?: { org?: OrgInfo; fromHandoff?: boolean },
  ): Promise<{ record: RunRecord | undefined; busy: boolean }> {
    const acquired = await this.acquire(opts?.org);
    if (!acquired.org) return { record: undefined, busy: acquired.busy };
    await this.execute(acquired.org, labelFor, coverage, startRun, Boolean(opts?.fromHandoff));
    return { record: this.deps.state.run, busy: false };
  }

  /** Everything `start` does once an org is acquired and the guard is held:
   *  record, start, poll, results, coverage, log. The org does the waiting;
   *  we watch and report. */
  private async execute(
    org: OrgInfo,
    labelFor: (alias: string) => string,
    coverage: boolean,
    startRun: (
      orgUsername: string,
      token: vscode.CancellationToken,
    ) => Promise<StartedTestRun>,
    fromHandoff: boolean,
  ): Promise<void> {
    const state = this.deps.state;
    const id = `run-${++this.sequence}-${Date.now()}`;
    const label = labelFor(org.alias);
    const logs = state.runWithLogs;
    this.logCache.clear();
    this.logDocs.clear();
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

      let logsArmed = false;
      if (logs) {
        // A flag that fails to land is not a reason to lose the run — but it is
        // a reason to say, before the results, that no logs will come with it.
        try {
          const ttl = this.deps.sfCli.testTimeoutMs() + TRACE_FLAG_MARGIN_MS;
          const { note, relevelled } = await this.deps.sfCli.ensureDebugLogging(
            org.username,
            ttl,
            { cancellation: cancellation.token },
          );
          this.deps.output.appendLine(`  debug logs on: ${note}`);
          logsArmed = true;
          if (relevelled) {
            // The user's own flag was repointed at our level: say so where
            // they will see it, since their other log categories went with it.
            void vscode.window.showInformationMessage(
              `SF Tests: your trace flag now logs Apex at DEBUG on the SfTestRunner level so System.debug lands; other categories are off.`,
            );
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.deps.output.appendLine(`  debug logs OFF for this run — trace flag failed: ${detail}`);
          void vscode.window.showWarningMessage(
            `SF Tests: could not set up debug logging, running without logs. ${detail}`,
          );
        }
      }

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
      // Only once the flag landed: a failed setup already warned, and a second
      // "no logs" toast for the same cause would just be noise.
      if (logsArmed) await this.attachLogIds(result.summary, testRunId, org.username);
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
        this.publishCoverage(
          org,
          result.coverage,
          result.summary.asyncApexJobId ?? testRunId,
          result.summary.results.map((r) => r.className),
          'run',
          fromHandoff,
        );
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
    // A loaded run carries no log ids; drop the previous run's tabs and bodies.
    this.logCache.clear();
    this.logDocs.clear();
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
    this.publishCoverage(
      org,
      coverage,
      recent.testRunId,
      summary.results.map((r) => r.className),
      'loaded',
    );
    this.logSummary(summary, org.username, coverage);
  }

  /**
   * Replace the coverage snapshot with this run's. The decorator paints it when
   * the `paintCoverage` setting is on — that is the whole auto-paint mechanism.
   * A run that returned none leaves the previous snapshot (which carries its own
   * provenance) alone and says so in the log.
   *
   * `org` is the org the run STARTED on. If it no longer matches the picker's,
   * the snapshot is not published at all: the run's own results stay (they are
   * labelled with their org), but nothing paints. `fromHandoff` only picks the
   * WORDING for that case — a handoff run's org routinely never matched the
   * picker to begin with, which is not the same thing as changing mid-run.
   */
  private publishCoverage(
    org: OrgInfo,
    coverage: Map<string, CoverageInfo>,
    runId: string,
    ranTestClasses: Iterable<string>,
    scope: 'run' | 'loaded',
    fromHandoff = false,
  ): void {
    const infos = [...coverage.values()];
    if (infos.length === 0) {
      this.deps.output.appendLine('No code coverage came back with this run.');
      return;
    }
    const changed = fromHandoff
      ? handoffCoverageNote(org, this.deps.getOrg())
      : coverageOrgChangedNote(org, this.deps.getOrg());
    if (changed) {
      this.deps.output.appendLine(changed);
      return;
    }
    this.deps.state.setCoverage({
      label: `run ${runId} on ${org.alias}`,
      scope,
      orgUsername: org.username,
      at: Date.now(),
      runId,
      targets: this.targetsFor(ranTestClasses, infos.map((i) => i.className)),
      infos,
    });
  }

  /**
   * What the run was aimed at. The declarations come from the index, which both
   * halves of discovery already parsed out of the class bodies — no extra I/O,
   * and a test class the index has never seen simply declares nothing.
   */
  private targetsFor(ranTestClasses: Iterable<string>, coveredNames: string[]) {
    const byName = new Map<string, readonly string[]>();
    for (const entry of this.deps.state.index.classes) {
      if (entry.testFor?.length) byName.set(entry.name.toLowerCase(), entry.testFor);
    }
    return resolveTargets(
      ranTestClasses,
      (testClass) => byName.get(testClass.toLowerCase()) ?? [],
      coveredNames,
    );
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
 * Whether sf-org-deploy-wrapper is installed AND new enough to answer
 * `deployComponents` — checked fresh every time, since the extension can be
 * installed, removed or upgraded without a reload. The id alone is not
 * enough: an older SF Deploy has the id but predates the handoff command,
 * and calling a command that does not exist would just throw.
 */
function deployHelperAvailable(): boolean {
  const ext = vscode.extensions.getExtension(DEPLOY_HELPER_EXTENSION_ID);
  return ext !== undefined && contributesCommand(ext.packageJSON, DEPLOY_HELPER_COMMAND);
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
