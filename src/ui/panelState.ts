/**
 * The panel's single source of truth in the extension host.
 *
 * The three webviews (tests, results, coverage) each render a slice of this
 * store and post their own messages back; none of them owns state. That is what
 * lets a collapsed or disposed view lose nothing, and it keeps the three views
 * consistent — every provider sends the shape produced by the `to*ViewState`
 * serializers below, so the wire format lives in exactly one place.
 */
import * as vscode from 'vscode';
import { kindOf, orgBadge } from '../kit/orgs';
import {
  CoverageSnapshot,
  OrgInfo,
  RunRecord,
  TestIndexSnapshot,
  TestRunSummary,
} from '../types';
import {
  CoverageRow,
  CoverageViewState,
  OutcomeEntry,
  OrgOption,
  ResultsFilter,
  ResultsViewState,
  TestsBusy,
  TestsViewState,
} from '../webview/protocol';
import { liveForResults } from './liveOutcomes';
import { SelectionSet } from './selection';

/** Which slice changed. Providers subscribe and re-post only what they render. */
export type PanelChange = 'index' | 'selection' | 'run' | 'coverage' | 'org' | 'busy' | 'prefs';

const SELECTION_KEY = 'sfTestRunner.selection.v1';
const CONFIG_SECTION = 'sfTestRunner';
const EMPTY_INDEX: TestIndexSnapshot = { classes: [] };

export class PanelState implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PanelChange>();
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  private _index: TestIndexSnapshot = EMPTY_INDEX;
  private readonly _selection: SelectionSet;
  private _run: RunRecord | undefined;
  private _coverage: CoverageSnapshot | undefined;
  private _org: OrgInfo | undefined;
  private _orgs: OrgInfo[] = [];
  private _busy: TestsBusy = { scanning: false, fetchingOrg: false, running: false };
  private _resultsFilter: ResultsFilter = 'all';
  private _expandNonce = 0;
  private _collapseNonce = 0;
  /** Per-method outcomes reported while a run is still in flight (async path).
   *  Superseded by `run.summary` the moment the run finishes. */
  private _live: Record<string, OutcomeEntry> = {};
  /** Classes that have a file on disk — drives the coverage table's "no local
   *  source" greying. Empty means "not known yet", and rows stay openable. */
  private _localClassNames = new Set<string>();

  constructor(private readonly memento: vscode.Memento) {
    const stored = this.memento.get<string[]>(SELECTION_KEY, []);
    // Restored blind: the index arrives later, and `setIndex` prunes whatever
    // no longer exists.
    this._selection = new SelectionSet(EMPTY_INDEX, Array.isArray(stored) ? stored : []);

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(`${CONFIG_SECTION}.runWithCoverage`) ||
          e.affectsConfiguration(`${CONFIG_SECTION}.paintCoverage`)
        ) {
          this.emitter.fire('prefs');
        }
      }),
    );
  }

  // ─────────────────────────────── index ───────────────────────────────

  get index(): TestIndexSnapshot {
    return this._index;
  }

  setIndex(index: TestIndexSnapshot): void {
    this._index = index;
    const dropped = this._selection.prune(index);
    this.emitter.fire('index');
    if (dropped) {
      this.persistSelection();
      this.emitter.fire('selection');
    }
  }

  setLocalClassNames(names: Iterable<string>): void {
    this._localClassNames = new Set(names);
    this.emitter.fire('coverage');
  }

  // ───────────────────────────── selection ─────────────────────────────

  get selection(): SelectionSet {
    return this._selection;
  }

  toggleMethod(key: string): void {
    this._selection.toggleMethod(key);
    this.afterSelectionChange();
  }

  setClassSelected(name: string, on: boolean): void {
    this._selection.setClass(name, on);
    this.afterSelectionChange();
  }

  /** Replace the selection wholesale — "Tests for active file", re-run failed. */
  selectOnly(keys: Iterable<string>): void {
    this._selection.clear();
    for (const key of keys) if (!this._selection.has(key)) this._selection.toggleMethod(key);
    this.afterSelectionChange();
  }

  clearSelection(): void {
    this._selection.clear();
    this.afterSelectionChange();
  }

  private afterSelectionChange(): void {
    this.persistSelection();
    this.emitter.fire('selection');
  }

  private persistSelection(): void {
    void this.memento.update(SELECTION_KEY, this._selection.toArray());
  }

  // ─────────────────────────────── run ─────────────────────────────────

  get run(): RunRecord | undefined {
    return this._run;
  }

  setRun(run: RunRecord | undefined): void {
    this._run = run;
    this._live = {};
    this.emitter.fire('run');
  }

  updateRun(patch: Partial<RunRecord>): void {
    if (!this._run) return;
    this._run = { ...this._run, ...patch };
    this.emitter.fire('run');
  }

  /** Live per-method outcome during a run; ignored once a summary exists. */
  setLiveOutcome(key: string, outcome: OutcomeEntry): void {
    this._live = { ...this._live, [key]: outcome };
    this.emitter.fire('run');
  }

  get resultsFilter(): ResultsFilter {
    return this._resultsFilter;
  }

  setResultsFilter(filter: ResultsFilter): void {
    if (this._resultsFilter === filter) return;
    this._resultsFilter = filter;
    this.emitter.fire('run');
  }

  expandResults(): void {
    this._expandNonce++;
    this.emitter.fire('run');
  }

  collapseResults(): void {
    this._collapseNonce++;
    this.emitter.fire('run');
  }

  // ───────────────────────────── coverage ──────────────────────────────

  get coverage(): CoverageSnapshot | undefined {
    return this._coverage;
  }

  setCoverage(snapshot: CoverageSnapshot | undefined): void {
    this._coverage = snapshot;
    this.emitter.fire('coverage');
  }

  // ─────────────────────────────── org ─────────────────────────────────

  get org(): OrgInfo | undefined {
    return this._org;
  }

  setOrg(org: OrgInfo | undefined): void {
    this._org = org;
    this.emitter.fire('org');
  }

  get orgs(): OrgInfo[] {
    return this._orgs;
  }

  setOrgs(orgs: OrgInfo[]): void {
    this._orgs = orgs;
    this.emitter.fire('org');
  }

  // ─────────────────────────────── busy ────────────────────────────────

  get busy(): TestsBusy {
    return this._busy;
  }

  setBusy(patch: Partial<TestsBusy>): void {
    this._busy = { ...this._busy, ...patch };
    this.emitter.fire('busy');
  }

  // ──────────────────────────────  prefs  ──────────────────────────────
  // Settings are the truth and are read at decision time, so a change made in
  // the Settings UI is honoured without the store holding a stale copy.

  get runWithCoverage(): boolean {
    return this.config().get<boolean>('runWithCoverage', true);
  }

  async setRunWithCoverage(on: boolean): Promise<void> {
    await this.writeSetting('runWithCoverage', on);
  }

  get paintCoverage(): boolean {
    return this.config().get<boolean>('paintCoverage', true);
  }

  async setPaintCoverage(on: boolean): Promise<void> {
    await this.writeSetting('paintCoverage', on);
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  /** Write back to the narrowest scope the user has actually defined, so a
   *  workspace-level choice is not silently overridden by a global write. */
  private async writeSetting(key: string, value: unknown): Promise<void> {
    const info = this.config().inspect(key);
    const target =
      info?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : info?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await this.config().update(key, value, target);
    this.emitter.fire('prefs');
  }

  // ──────────────────────────── serializers ────────────────────────────

  toTestsViewState(): TestsViewState {
    const run = this._run;
    const progress =
      run && run.status === 'running' && run.progress
        ? { ...run.progress, label: run.label, elapsedMs: Date.now() - run.startedAt }
        : undefined;
    return {
      index: this._index,
      selection: this._selection.toArray(),
      org: this._org
        ? { ...this._org, badge: orgBadge(this._org), kind: kindOf(this._org) }
        : undefined,
      orgs: this._orgs.map((o): OrgOption => ({ ...o, badge: orgBadge(o) })),
      busy: this._busy,
      runWithCoverage: this.runWithCoverage,
      progress,
      outcomes: this.outcomes(),
    };
  }

  toResultsViewState(): ResultsViewState {
    const live = liveForResults(this._run, this._live);
    return {
      run: this._run,
      filter: this._resultsFilter,
      expandAllNonce: this._expandNonce,
      collapseAllNonce: this._collapseNonce,
      ...(live ? { live } : {}),
    };
  }

  toCoverageViewState(): CoverageViewState {
    const snapshot = this._coverage;
    if (!snapshot) return { snapshot: undefined, paint: this.paintCoverage };
    let covered = 0;
    let total = 0;
    const focus = new Set(snapshot.focus ?? []);
    const rows: CoverageRow[] = snapshot.infos.map((info) => {
      const lines = info.numLinesCovered + info.numLinesUncovered;
      covered += info.numLinesCovered;
      total += lines;
      return {
        className: info.className,
        pct: lines === 0 ? 100 : Math.round((info.numLinesCovered / lines) * 100),
        covered: info.numLinesCovered,
        total: lines,
        // Nothing known about local files yet ⇒ assume the row can be opened;
        // the open handler reports it if the file really is missing.
        hasSource: this._localClassNames.size === 0 || this._localClassNames.has(info.className),
        focus: focus.has(info.className.toLowerCase()),
      };
    });
    rows.sort((a, b) => a.pct - b.pct || a.className.localeCompare(b.className));
    return {
      snapshot: {
        label: snapshot.label,
        scope: snapshot.runId === undefined ? 'org' : 'run',
        at: snapshot.at,
        orgUsername: snapshot.orgUsername,
        overall: total === 0 ? null : Math.round((covered / total) * 100),
        rows,
      },
      paint: this.paintCoverage,
    };
  }

  /** Selection key → outcome. A finished run's summary wins; while the run is
   *  in flight the live map (fed by the poller) is all there is. */
  outcomes(): Record<string, OutcomeEntry> {
    const summary = this._run?.summary;
    return summary ? outcomesFromSummary(summary) : this._live;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function outcomesFromSummary(summary: TestRunSummary): Record<string, OutcomeEntry> {
  const out: Record<string, OutcomeEntry> = {};
  for (const result of summary.results) {
    out[`${result.className}.${result.methodName}`] = {
      o: result.outcome === 'Pass' ? 'pass' : result.outcome === 'Skip' ? 'skip' : 'fail',
      ms: result.runTime,
    };
  }
  return out;
}
