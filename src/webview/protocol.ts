/**
 * The one place the panel's message shapes live. Both sides import from here:
 * the extension host (`src/ui/*View.ts`) and the browser bundles
 * (`src/webview/{tests,results,coverage}.ts`).
 *
 * Everything crossing the boundary is plain JSON — no Map, Set, Date or
 * `vscode.Uri`. Selections travel as `string[]`, uris as strings.
 *
 * SELECTION KEY CONVENTION
 * ------------------------
 * A key is `Cls.method` for a method, and a bare `Cls` ONLY for a class whose
 * methods are unknown (org-only entry with `methodsUnknown`). That keeps one
 * flat string set for the whole tree. `selectorsFor` (salesforce/testSelection)
 * collapses a fully-selected class back to a single `Cls` CLI selector; the
 * bridge from keys to selectors is `SelectionSet.toSelectors` in ui/selection.ts.
 *
 * VALIDATION
 * ----------
 * Every view→host message has a `MessageShape` entry below. Providers validate
 * untrusted webview input with the kit's `validateMessage(shape, msg)` — the
 * shape tables are imported here as types only, so this module stays free of
 * `vscode` and can be bundled for the browser.
 */
import type { OrgInfo, RunProgress, RunRecord, TestIndexSnapshot } from '../types';

/**
 * Mirrors `MessageShape` from kit/webviewHtml — structurally identical, so the
 * tables below can be handed straight to the kit's `validateMessage`. It is
 * re-declared rather than imported because that kit module pulls in `vscode`
 * and `crypto`, neither of which may enter the browser program.
 */
type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type MessageShape = Record<string, FieldType | `${FieldType}?`>;

/** An org row in the panel's `<select>`; `badge` is `kit/orgs.orgBadge`. */
export interface OrgOption extends OrgInfo {
  badge: string;
}

/** The selected org, plus `kit/orgs.kindOf` so the view can tint PROD. */
export interface SelectedOrg extends OrgInfo {
  badge: string;
  kind: string;
}

export type RunScope = 'selected' | 'allLocal' | 'allInOrg';
export type ResultsFilter = 'all' | 'failed';
export type OutcomeKind = 'pass' | 'fail' | 'skip' | 'running';

/** Per-method outcome shown as a small glyph + duration on the tests tree. */
export interface OutcomeEntry {
  o: OutcomeKind;
  ms: number;
}

// ────────────────────────────── tests view ──────────────────────────────

export interface TestsBusy {
  scanning: boolean;
  fetchingOrg: boolean;
  running: boolean;
}

export interface TestsProgress extends RunProgress {
  label: string;
  elapsedMs: number;
}

export interface TestsViewState {
  index: TestIndexSnapshot;
  /** Selection keys — see the key convention above. */
  selection: string[];
  org?: SelectedOrg;
  orgs: OrgOption[];
  busy: TestsBusy;
  runWithCoverage: boolean;
  progress?: TestsProgress;
  /** Selection key → last known outcome. Empty before the first run. */
  outcomes: Record<string, OutcomeEntry>;
}

export type TestsHostMessage = { type: 'tests:state'; state: TestsViewState };

export type TestsViewMessage =
  | { type: 'tests:toggleMethod'; key: string }
  | { type: 'tests:setClass'; name: string; on: boolean }
  | { type: 'tests:clearSelection' }
  | { type: 'tests:run'; scope: RunScope }
  | { type: 'tests:cancel' }
  | { type: 'tests:rescan' }
  | { type: 'tests:fetchOrg' }
  | { type: 'tests:selectOrg'; username: string }
  | { type: 'tests:refreshOrgs' }
  | { type: 'tests:login' }
  | { type: 'tests:activeFile' }
  | { type: 'tests:open'; name: string; method?: string }
  | { type: 'tests:setRunWithCoverage'; on: boolean }
  | { type: 'tests:loadRecent' }
  | { type: 'tests:ready' };

// ───────────────────────────── results view ─────────────────────────────

export interface ResultsViewState {
  run?: RunRecord;
  filter: ResultsFilter;
  /** Per-method outcomes the poller has seen so far, keyed `Cls.method`. Sent
   *  ONLY while the run is in flight and has no summary yet — that is what the
   *  tree renders from until the final results arrive (see ui/liveOutcomes). */
  live?: Record<string, OutcomeEntry>;
  /** Bumped by the expand-all / collapse-all view-title commands. The view acts
   *  only when the nonce differs from the one it last saw, so a plain state
   *  refresh never re-collapses what the user opened. */
  expandAllNonce?: number;
  collapseAllNonce?: number;
}

export type ResultsHostMessage = { type: 'results:state'; state: ResultsViewState };

export type ResultsViewMessage =
  | { type: 'results:open'; className: string; method?: string; line?: number; isTrigger?: boolean }
  | { type: 'results:setFilter'; filter: ResultsFilter }
  | { type: 'results:rerunFailed' }
  | { type: 'results:copySummary' }
  | { type: 'results:loadRecent' }
  | { type: 'results:ready' };

// ───────────────────────────── coverage view ────────────────────────────

export interface CoverageRow {
  className: string;
  pct: number;
  covered: number;
  total: number;
  /** False for a class with no local file — the row is greyed and does not open. */
  hasSource: boolean;
  /** True for a class the run was aimed at; those rows lead the table. */
  focus: boolean;
}

/** The view's flattened read of a `CoverageSnapshot` (src/types.ts). */
export interface CoverageViewSnapshot {
  label: string;
  /**
   * Where the numbers came from: 'run' is coverage the run itself measured,
   * 'org' is the org's stored aggregate for one class (last run, any user).
   * The header says which in words — an overall percentage with no provenance
   * reads as the org's official coverage, which neither of these is.
   */
  scope: 'run' | 'org';
  at: number;
  orgUsername: string;
  /** null when nothing measurable came back (no lines at all). */
  overall: number | null;
  rows: CoverageRow[];
}

export interface CoverageViewState {
  snapshot?: CoverageViewSnapshot;
  /** Whether coverage is currently painted in the editor. */
  paint: boolean;
}

export type CoverageHostMessage = { type: 'coverage:state'; state: CoverageViewState };

export type CoverageViewMessage =
  | { type: 'coverage:open'; className: string }
  | { type: 'coverage:setPaint'; on: boolean }
  | { type: 'coverage:clear' }
  | { type: 'coverage:fromOrg'; className: string }
  | { type: 'coverage:ready' };

// ─────────────────────────────── unions ─────────────────────────────────

export type HostMessage = TestsHostMessage | ResultsHostMessage | CoverageHostMessage;
export type ViewMessage = TestsViewMessage | ResultsViewMessage | CoverageViewMessage;

export type ViewBundle = 'tests' | 'results' | 'coverage';

// ───────────────────────── validation shape tables ──────────────────────
// Keyed by message type so a provider can do:
//   const shape = TESTS_MESSAGE_SHAPES[msg.type]; if (!shape) return;
//   if (!validateMessage<TestsViewMessage>(shape, msg)) return;

export const TESTS_MESSAGE_SHAPES: Record<TestsViewMessage['type'], MessageShape> = {
  'tests:toggleMethod': { type: 'string', key: 'string' },
  'tests:setClass': { type: 'string', name: 'string', on: 'boolean' },
  'tests:clearSelection': { type: 'string' },
  'tests:run': { type: 'string', scope: 'string' },
  'tests:cancel': { type: 'string' },
  'tests:rescan': { type: 'string' },
  'tests:fetchOrg': { type: 'string' },
  'tests:selectOrg': { type: 'string', username: 'string' },
  'tests:refreshOrgs': { type: 'string' },
  'tests:login': { type: 'string' },
  'tests:activeFile': { type: 'string' },
  'tests:open': { type: 'string', name: 'string', method: 'string?' },
  'tests:setRunWithCoverage': { type: 'string', on: 'boolean' },
  'tests:loadRecent': { type: 'string' },
  'tests:ready': { type: 'string' },
};

export const RESULTS_MESSAGE_SHAPES: Record<ResultsViewMessage['type'], MessageShape> = {
  'results:open': {
    type: 'string',
    className: 'string',
    method: 'string?',
    line: 'number?',
    isTrigger: 'boolean?',
  },
  'results:setFilter': { type: 'string', filter: 'string' },
  'results:rerunFailed': { type: 'string' },
  'results:copySummary': { type: 'string' },
  'results:loadRecent': { type: 'string' },
  'results:ready': { type: 'string' },
};

export const COVERAGE_MESSAGE_SHAPES: Record<CoverageViewMessage['type'], MessageShape> = {
  'coverage:open': { type: 'string', className: 'string' },
  'coverage:setPaint': { type: 'string', on: 'boolean' },
  'coverage:clear': { type: 'string' },
  'coverage:fromOrg': { type: 'string', className: 'string' },
  'coverage:ready': { type: 'string' },
};

/** `validateMessage` only checks primitive types, so the closed sets that reach
 *  a privileged branch (which scope to run, which filter) get their own guards. */
export function isRunScope(value: unknown): value is RunScope {
  return value === 'selected' || value === 'allLocal' || value === 'allInOrg';
}

export function isResultsFilter(value: unknown): value is ResultsFilter {
  return value === 'all' || value === 'failed';
}
