export interface OrgInfo {
  accessToken: string;
  instanceUrl: string;
  username: string;
  alias?: string;
  apiVersion: string;
}

export interface TestMethodResult {
  id: string;
  className: string;
  methodName: string;
  outcome: 'Pass' | 'Fail' | 'CompileFail' | 'Skip';
  runTime: number;
  message: string | null;
  stackTrace: string | null;
  apexClassId: string;
}

export interface TestRunSummary {
  asyncApexJobId: string;
  status: string;
  classesEnqueued: number;
  methodsEnqueued: number;
  methodsCompleted: number;
  methodsFailed: number;
  testTime: number;
  startTime: string;
  endTime: string | null;
  results: TestMethodResult[];
}

export interface CoverageInfo {
  apexClassId: string;
  className: string;
  numLinesCovered: number;
  numLinesUncovered: number;
  coveredLines: number[];
  uncoveredLines: number[];
}
