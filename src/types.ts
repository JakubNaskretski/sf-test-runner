export interface OrgInfo {
  alias: string;
  username: string;
  instanceUrl: string;
  isDefault: boolean;
  /** From `sf org list` buckets — drive the status-bar PROD/SBX/SCR badge. */
  isSandbox?: boolean;
  isScratch?: boolean;
  /** Edition string from the `sf org list` row (e.g. "Developer Edition"). Must
   *  survive the mapping in `doListOrgs`, or `kindOf` badges a dev org PROD and
   *  the production confirmation fires on every run against it. */
  orgEdition?: string;
}

export interface TestMethodResult {
  className: string;
  methodName: string;
  outcome: 'Pass' | 'Fail' | 'CompileFail' | 'Skip';
  runTime: number;
  message: string | null;
  stackTrace: string | null;
}

export interface TestRunSummary {
  asyncApexJobId: string | null;
  status: string;
  testsRan: number;
  passing: number;
  failing: number;
  skipped: number;
  testTotalTime: number;
  results: TestMethodResult[];
}

export interface CoverageInfo {
  className: string;
  numLinesCovered: number;
  numLinesUncovered: number;
  coveredLines: number[];
  uncoveredLines: number[];
}

export type CommandStatus = 'running' | 'success' | 'error';

export interface CommandLogEntry {
  id: number;
  startedAt: number;
  durationMs: number | null;
  command: string;
  args: string[];
  status: CommandStatus;
  /** Real exit code when known; null otherwise (the kit hides it behind parsed
   *  results, and inventing 0 for a run that exited 100 was worse than none). */
  exitCode: number | null;
  stderrSnippet: string | null;
  errorMessage: string | null;
}

// ───────────────────────── panel rework (0.9.0) ─────────────────────────
// The test index is the union of what the workspace has on disk and what the
// org reports, so a class can exist in one, the other, or both.

export type TestSource = 'both' | 'local-only' | 'org-only';

export interface TestMethodEntry {
  name: string;
  /** Zero-based line of the method declaration. Local classes only — an
   *  org-only class has no file to jump to. */
  line?: number;
}

export interface TestClassEntry {
  name: string;
  source: TestSource;
  /** `Uri.toString()` of the local .cls, when there is one. String, not Uri:
   *  this crosses the webview boundary. */
  uri?: string;
  /** Zero-based line of the class declaration (local only). */
  classLine?: number;
  /** ApexClass Id, when the class was seen in the org. */
  orgId?: string;
  namespace?: string;
  methods: TestMethodEntry[];
  /** True when the org listed the class but its methods were never classified.
   *  Such a class can only be selected whole (selection key is the bare name). */
  methodsUnknown?: boolean;
}

export interface TestIndexSnapshot {
  classes: TestClassEntry[];
  /** Org the org-side half of the index came from, and when it was fetched. */
  orgUsername?: string;
  orgFetchedAt?: number;
}

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'error';

export interface RunProgress {
  done: number;
  total: number;
  failed: number;
}

export interface RunRecord {
  id: string;
  /** Human label for the run bar, e.g. "7 tests" or "All local tests". */
  label: string;
  orgUsername: string;
  orgAlias: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  withCoverage: boolean;
  summary?: TestRunSummary;
  /** Live counters while the run is in flight (async path). */
  progress?: RunProgress;
  error?: string;
  /** Salesforce test run id, when the CLI reported one. */
  testRunId?: string;
}

export interface CoverageSnapshot {
  /** Provenance, shown in the table header and the decorator tooltip. */
  label: string;
  orgUsername: string;
  at: number;
  runId?: string;
  /**
   * Lower-cased names of the classes the run was aimed at (see
   * `classesUnderTest`). The coverage table leads with these and folds the rest
   * away. Empty or absent ⇒ nothing to lead with, so every row is shown.
   */
  focus?: string[];
  infos: CoverageInfo[];
}
