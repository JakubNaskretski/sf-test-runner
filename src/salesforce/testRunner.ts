import * as jsforce from 'jsforce';
import * as vscode from 'vscode';
import { TestMethodResult, TestRunSummary } from '../types';

interface RunTestsAsyncRequest {
  classNames?: string;
  classids?: string;
  suiteNames?: string;
  maxFailedTests?: number;
  testLevel?: 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg';
  skipCodeCoverage?: boolean;
}

export async function runTestsForClass(
  conn: jsforce.Connection,
  className: string,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken,
): Promise<TestRunSummary> {
  progress?.report({ message: `Enqueueing tests for ${className}...` });

  const enqueueResult = await conn.tooling.request<string>({
    method: 'POST',
    url: `/services/data/v${conn.version}/tooling/runTestsAsynchronous/`,
    body: JSON.stringify({
      classNames: className,
      skipCodeCoverage: false,
    } as RunTestsAsyncRequest),
    headers: { 'Content-Type': 'application/json' },
  });

  const asyncApexJobId = String(enqueueResult).replace(/['"]/g, '').trim();
  return pollTestRun(conn, asyncApexJobId, progress, token);
}

export async function pollTestRun(
  conn: jsforce.Connection,
  asyncApexJobId: string,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken,
): Promise<TestRunSummary> {
  const config = vscode.workspace.getConfiguration('sfTestRunner');
  const intervalMs = config.get<number>('pollIntervalMs', 2000);
  const timeoutMs = config.get<number>('pollTimeoutMs', 600000);
  const startedAt = Date.now();

  while (true) {
    if (token?.isCancellationRequested) {
      throw new Error('Test run cancelled');
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for test run ${asyncApexJobId}`);
    }

    const result = await conn.tooling.query<any>(
      `SELECT Id, Status, StartTime, EndTime, TestTime, ClassesEnqueued, MethodsEnqueued, MethodsCompleted, MethodsFailed
       FROM ApexTestRunResult
       WHERE AsyncApexJobId = '${asyncApexJobId}'`,
    );

    const row = result.records[0];
    if (row) {
      progress?.report({
        message: `${row.MethodsCompleted}/${row.MethodsEnqueued} methods complete (${row.Status})`,
      });

      if (
        row.Status === 'Completed' ||
        row.Status === 'Failed' ||
        row.Status === 'Aborted'
      ) {
        const results = await fetchMethodResults(conn, asyncApexJobId);
        return {
          asyncApexJobId,
          status: row.Status,
          classesEnqueued: row.ClassesEnqueued,
          methodsEnqueued: row.MethodsEnqueued,
          methodsCompleted: row.MethodsCompleted,
          methodsFailed: row.MethodsFailed,
          testTime: row.TestTime,
          startTime: row.StartTime,
          endTime: row.EndTime,
          results,
        };
      }
    }

    await sleep(intervalMs);
  }
}

async function fetchMethodResults(
  conn: jsforce.Connection,
  asyncApexJobId: string,
): Promise<TestMethodResult[]> {
  const result = await conn.tooling.query<any>(
    `SELECT Id, ApexClass.Name, ApexClassId, MethodName, Outcome, RunTime, Message, StackTrace
     FROM ApexTestResult
     WHERE AsyncApexJobId = '${asyncApexJobId}'
     ORDER BY ApexClass.Name, MethodName`,
  );

  return result.records.map((r) => ({
    id: r.Id,
    className: r.ApexClass?.Name ?? 'Unknown',
    methodName: r.MethodName,
    outcome: r.Outcome,
    runTime: r.RunTime ?? 0,
    message: r.Message,
    stackTrace: r.StackTrace,
    apexClassId: r.ApexClassId,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
