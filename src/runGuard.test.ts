import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunGuard } from './runGuard';

test('first acquire succeeds, second is rejected while held', () => {
  const g = new RunGuard();
  assert.equal(g.isRunning, false);
  assert.equal(g.tryAcquire(), true);
  assert.equal(g.isRunning, true);
  assert.equal(g.tryAcquire(), false, 'second acquire must fail while running');
  assert.equal(g.isRunning, true);
});

test('release frees the guard for the next run', () => {
  const g = new RunGuard();
  g.tryAcquire();
  g.release();
  assert.equal(g.isRunning, false);
  assert.equal(g.tryAcquire(), true, 'guard is reusable after release');
});

test('release when idle is a no-op', () => {
  const g = new RunGuard();
  g.release();
  assert.equal(g.isRunning, false);
  assert.equal(g.tryAcquire(), true);
});

test('acquire is synchronous — no interleaving window', () => {
  const g = new RunGuard();
  // Simulate two entry points calling tryAcquire back-to-back with no await
  // between them: exactly one wins.
  const a = g.tryAcquire();
  const b = g.tryAcquire();
  assert.equal(a, true);
  assert.equal(b, false);
});
