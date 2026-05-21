export interface OrgInfo {
  alias: string;
  username: string;
  instanceUrl: string;
  isDefault: boolean;
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
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  stderrSnippet: string | null;
  errorMessage: string | null;
}
