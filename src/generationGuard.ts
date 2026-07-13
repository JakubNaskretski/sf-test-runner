/**
 * Monotonic "latest wins" guard for async event handlers. Each event calls
 * `next()` SYNCHRONOUSLY at entry to claim a generation; its async continuation
 * then checks `isCurrent(token)` before applying the result. Rapid events (e.g.
 * external org switches A→B→C, each kicking off its own `sf org list`) can
 * resolve out of order — this guard ensures only the newest event's resolution
 * lands, so the latest event always wins and a slow B can't overwrite C.
 *
 * Deliberately tiny and vscode-free so the ordering rule is unit-testable, the
 * same way RunGuard isolates the single-in-flight-run rule.
 */
export class GenerationGuard {
  private latest = 0;

  /**
   * Claim a new generation and return its token. Any token handed out by an
   * earlier call is now stale. Call synchronously at the top of the handler,
   * before the first await.
   */
  next(): number {
    return ++this.latest;
  }

  /**
   * True while `token` is still the most recent generation — i.e. no newer
   * event has claimed one since. Check before applying async work.
   */
  isCurrent(token: number): boolean {
    return token === this.latest;
  }
}
