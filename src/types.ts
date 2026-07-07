export interface OrgInfo {
  alias: string;
  username: string;
  instanceUrl: string;
  isDefault: boolean;
  /** From `sf org list` buckets — drive the status-bar PROD/SBX/SCR badge. */
  isSandbox?: boolean;
  isScratch?: boolean;
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
