import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationGuard } from './generationGuard';

test('the freshly claimed generation is current', () => {
  const g = new GenerationGuard();
  const token = g.next();
  assert.equal(g.isCurrent(token), true);
});

test('a newer generation supersedes an older token', () => {
  const g = new GenerationGuard();
  const first = g.next();
  const second = g.next();
  assert.equal(g.isCurrent(first), false, 'the older token is stale');
  assert.equal(g.isCurrent(second), true, 'the newest token is current');
});

test('latest wins across a rapid A→B→C switch', () => {
  const g = new GenerationGuard();
  // Three switch events fire back-to-back, each claiming a generation at entry.
  const a = g.next();
  const b = g.next();
  const c = g.next();
  // Their async `sf org list` refreshes can resolve in ANY order; only C applies.
  assert.equal(g.isCurrent(a), false);
  assert.equal(g.isCurrent(b), false);
  assert.equal(g.isCurrent(c), true);
});

test('an out-of-order resolution (B lands after C) is rejected', () => {
  const g = new GenerationGuard();
  const b = g.next(); // event B claims its generation
  const c = g.next(); // event C claims a newer one
  // C resolves first and applies…
  assert.equal(g.isCurrent(c), true);
  // …then B's slower resolution finally arrives — it must NOT apply.
  assert.equal(g.isCurrent(b), false);
});
