import { TestMethodResult, TestRunSummary } from '../types';

/**
 * Parse a CLI summary time field. `sf apex run test --result-format json`
 * reports times as unit-suffixed strings ("81 ms") while counts are plain
 * numbers — `Number()` on those strings is NaN, which used to leak into the
 * "…passed (…, NaNms)" toast.
 */
export function parseMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function mapTestResult(result: any): TestRunSummary {
  const summary = result?.summary ?? {};
  const tests = Array.isArray(result?.tests) ? result.tests : [];

  const results: TestMethodResult[] = tests.map((t: any) => ({
    className: t.ApexClass?.Name ?? t.apexClass?.name ?? 'unknown',
    methodName: t.MethodName ?? t.methodName ?? 'unknown',
    outcome: (t.Outcome ?? t.outcome ?? 'Skip') as TestMethodResult['outcome'],
    runTime: t.RunTime ?? t.runTime ?? 0,
    message: t.Message ?? t.message ?? null,
    stackTrace: t.StackTrace ?? t.stackTrace ?? null,
  }));

  return {
    asyncApexJobId: summary.testRunId ?? summary.TestRunId ?? null,
    status: summary.outcome ?? summary.Outcome ?? 'Unknown',
    testsRan: Number(summary.testsRan ?? summary.TestsRan ?? results.length),
    passing: Number(
      summary.passing ?? summary.Passing ?? results.filter((r) => r.outcome === 'Pass').length,
    ),
    failing: Number(
      summary.failing ??
        summary.Failing ??
        // Skip is not a failure — count only genuine failures in the fallback.
        results.filter((r) => r.outcome === 'Fail' || r.outcome === 'CompileFail').length,
    ),
    skipped: Number(
      summary.skipped ?? summary.Skipped ?? results.filter((r) => r.outcome === 'Skip').length,
    ),
    testTotalTime: parseMs(summary.testTotalTime ?? summary.TestTotalTime),
    results,
  };
}
