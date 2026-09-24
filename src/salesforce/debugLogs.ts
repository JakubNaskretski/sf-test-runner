/**
 * Pure helpers behind "with logs": deciding what to do with the user's
 * `TraceFlag` before a run, and turning a fetched `ApexLog` body into the
 * document the user reads. No `vscode` import — both halves are unit-tested.
 *
 * A test method's log exists only while a USER_DEBUG trace flag for the running
 * user is active (verified against a live org on 2026-09-24: `ApexLogId` is null
 * without one, populated per method with one, sync and async alike).
 */
import { parseLogs } from '../kit/apexLogParser';

export interface TraceFlagRow {
  Id: string;
  /** ISO timestamps as the Tooling API returns them. */
  StartDate?: string | null;
  ExpirationDate: string | null;
  /** The level the flag points at; `ApexCode` decides whether `System.debug` lands. */
  DebugLevel?: { ApexCode: string | null } | null;
}

/**
 * A user may hold several USER_DEBUG flags as long as their windows do not
 * overlap, so the caller hands over the LATEST-expiring one and the plan is
 * about that flag: keep it, extend its window, or make one. `relevel` says the
 * flag's level would swallow `System.debug` (Apex below DEBUG), so it must be
 * repointed at the plugin's level — otherwise "logs on" would open empty logs.
 */
export type TraceFlagPlan =
  | { action: 'keep' | 'extend'; id: string; relevel: boolean }
  | { action: 'create' };

/** A flag that outlives the run by this much still covers a slow last class. */
export const TRACE_FLAG_MARGIN_MS = 5 * 60 * 1000;

/** The org refuses a TraceFlag window longer than 24 h. */
export const TRACE_FLAG_MAX_TTL_MS = 23 * 60 * 60 * 1000;

const APEX_LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];

export function planTraceFlag(rows: TraceFlagRow[], nowMs: number, ttlMs: number): TraceFlagPlan {
  const [row] = rows;
  if (!row) return { action: 'create' };
  const expires = row.ExpirationDate ? Date.parse(row.ExpirationDate) : NaN;
  const level = APEX_LEVELS.indexOf(String(row.DebugLevel?.ApexCode ?? 'NONE').toUpperCase());
  const relevel = level < APEX_LEVELS.indexOf('DEBUG');
  // Keep only a flag that reaches past the run's own ceiling (`ttlMs` less the
  // margin, which is slack, not a requirement — otherwise a flag this plugin
  // extended a moment ago would be extended again on every run); a flag that
  // dies mid-run would silently drop the later methods' logs.
  const starts = row.StartDate ? Date.parse(row.StartDate) : NaN;
  const started = !Number.isFinite(starts) || starts <= nowMs;
  if (started && Number.isFinite(expires) && expires >= nowMs + ttlMs - TRACE_FLAG_MARGIN_MS) {
    return { action: 'keep', id: row.Id, relevel };
  }
  // Not started yet, or ending too soon: rewriting the window (start now) covers both.
  return { action: 'extend', id: row.Id, relevel };
}

/** One line per `System.debug`, as `[line] LEVEL message`; exceptions kept too. */
export function debugLines(rawLog: string): string[] {
  return parseLogs(rawLog)
    .filter((e) => e.category === 'USER_DEBUG' || e.category === 'EXCEPTION')
    // Rebuilt from the raw line, not `message`: the parser splits on `|` and
    // rejoins with ` | `, which would pad a pipe inside the user's own text.
    .map((e) => {
      const tail = e.raw.split('|').slice(e.lineRef ? 3 : 2);
      const text = e.category === 'USER_DEBUG' ? `${tail[0]} ${tail.slice(1).join('|')}` : tail.join('|');
      return `${e.lineRef ? `${e.lineRef} ` : ''}${text}`;
    });
}

/**
 * What the "log" button opens: the debug output first, because that is what the
 * user put in the test to read, then the whole log for when it is not enough.
 * Plain text in an editor tab reads well, copies with one Ctrl+A, and saves as
 * a file on demand — the extension never writes to disk on its own.
 */
export function debugLogDocument(title: string, rawLog: string): string {
  const lines = debugLines(rawLog);
  const head = [`${title}`, '='.repeat(title.length), ''];
  const body = lines.length > 0 ? lines : ['(no System.debug output in this test)'];
  return [...head, ...body, '', '-'.repeat(72), 'Full log', '-'.repeat(72), '', rawLog].join('\n');
}
