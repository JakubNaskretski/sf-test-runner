import * as jsforce from 'jsforce';
import { CoverageInfo } from '../types';

export async function getCoverageForClass(
  conn: jsforce.Connection,
  className: string,
): Promise<CoverageInfo | null> {
  const result = await conn.tooling.query<any>(
    `SELECT ApexClassOrTrigger.Name, ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered, Coverage
     FROM ApexCodeCoverageAggregate
     WHERE ApexClassOrTrigger.Name = '${escapeSoql(className)}'
     LIMIT 1`,
  );

  const row = result.records[0];
  if (!row) return null;

  const coverage = row.Coverage ?? { coveredLines: [], uncoveredLines: [] };
  return {
    apexClassId: row.ApexClassOrTriggerId,
    className: row.ApexClassOrTrigger.Name,
    numLinesCovered: row.NumLinesCovered ?? 0,
    numLinesUncovered: row.NumLinesUncovered ?? 0,
    coveredLines: coverage.coveredLines ?? [],
    uncoveredLines: coverage.uncoveredLines ?? [],
  };
}

function escapeSoql(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
