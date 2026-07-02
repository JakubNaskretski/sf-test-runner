/**
 * Single in-flight-run guard. The extension has several entry points that each
 * enqueue an async Apex test run (run current class, re-run last, run one method,
 * re-run failed). Two overlapping runs race on the shared results tree, coverage
 * cache, and `lastRun` state. This guard is claimed
 * SYNCHRONOUSLY — before any `await` — so a second entry point that fires while a
 * run is queuing is rejected deterministically, with no window where both slip
 * through.
 */
export class RunGuard {
  private running = false;

  /** True while a run holds the guard. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Try to claim the guard. Returns true and marks running if free; returns
   * false (and changes nothing) if a run is already in flight. MUST be called
   * synchronously at the top of an entry point, before the first await.
   */
  tryAcquire(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  /** Release the guard. Call in a `finally` so a thrown run still frees it. */
  release(): void {
    this.running = false;
  }
}
