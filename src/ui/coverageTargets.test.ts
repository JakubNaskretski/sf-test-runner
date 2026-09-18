import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveTargets } from './coverageTargets';

const none = (): readonly string[] => [];

test('a declared testFor target wins, and keeps the row spelling', () => {
  const targets = resolveTargets(
    ['OrderServiceTest'],
    () => ['orderservice', 'OrderTrigger'],
    ['OrderService', 'OrderTrigger', 'AccountService'],
  );
  assert.deepEqual(
    targets.map((t) => [t.name, t.tier, t.by.join(','), t.unexercised === true]),
    [
      ['OrderService', 'declared', 'OrderServiceTest', false],
      ['OrderTrigger', 'declared', 'OrderServiceTest', false],
    ],
  );
});

test('a declared target the run never touched is kept, flagged unexercised', () => {
  const targets = resolveTargets(['OrderServiceTest'], () => ['OrderSelector'], ['OrderService']);
  assert.deepEqual(targets, [
    { name: 'OrderSelector', tier: 'declared', by: ['OrderServiceTest'], unexercised: true },
  ]);
});

test('the name tier only fires for a class the run actually covered', () => {
  assert.deepEqual(
    resolveTargets(['OrderServiceTest'], none, ['OrderService', 'Other']).map((t) => t.name),
    ['OrderService'],
  );
  assert.deepEqual(resolveTargets(['OrderServiceTest'], none, ['AccountService']), []);
  // `Contest` never yields a base at all, and would be rejected here even if it did.
  assert.deepEqual(resolveTargets(['Contest'], none, ['Con', 'Other']), []);
});

test('a truncated test class name resolves to the long class it was chopped from', () => {
  const long = 'AccountRelationshipRollupServiceHandler';
  const targets = resolveTargets([`${long.slice(0, 36)}Test`], none, [long, 'Short']);
  assert.deepEqual(
    targets.map((t) => [t.name, t.tier]),
    [[long, 'truncated']],
  );
});

test('the truncated tier declines a tie rather than guessing', () => {
  // 35 characters, so the test class below is 39 and clears the length gate —
  // this has to reach the tie branch, not short-circuit before it.
  const stem = 'AccountRelationshipRollupSvcHandler';
  const testClass = `${stem}Test`;
  const one = `${stem}One`;
  const two = `${stem}Two`;
  // One candidate: resolved. Two that the stem cannot choose between: declined.
  assert.deepEqual(
    resolveTargets([testClass], none, [one]).map((t) => [t.name, t.tier]),
    [[one, 'truncated']],
  );
  assert.deepEqual(resolveTargets([testClass], none, [one, two]), []);
});

test('the truncated tier will not guess at a class that could have been named properly', () => {
  // `Short` is well under 40 characters, so `ShortTest` would have fitted.
  assert.deepEqual(resolveTargets(['ShortlistBuilderTest'], none, ['ShortlistBuilderX']), []);
});

test('an ordinary test class name is never treated as truncated', () => {
  // `AccountServiceTest` fits in 40 characters, so nothing about it was chopped
  // — its real target simply was not in this run, and a long class sharing the
  // prefix must not be promoted in its place.
  assert.deepEqual(
    resolveTargets(['AccountServiceTest'], none, ['AccountServiceLegacyBatchSchedulerImpl']),
    [],
  );
});

test('a declaration upgrades a target another test class only guessed at', () => {
  const targets = resolveTargets(
    ['OrderServiceTest', 'BillingFlowTest'],
    (t) => (t === 'BillingFlowTest' ? ['OrderService'] : []),
    ['OrderService'],
  );
  assert.deepEqual(
    targets.map((t) => [t.tier, t.by.join(',')]),
    [['declared', 'OrderServiceTest,BillingFlowTest']],
  );
});

test('two test classes pointing at one class are both credited', () => {
  const targets = resolveTargets(
    ['OrderServiceTest', 'OrderFlowTest'],
    () => ['OrderService'],
    ['OrderService'],
  );
  assert.deepEqual(targets[0].by, ['OrderServiceTest', 'OrderFlowTest']);
});
