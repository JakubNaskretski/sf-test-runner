import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CoverageInfo } from '../types';
import {
  band,
  classesUnderTest,
  indexByClassName,
  overallOf,
  pctOf,
  rowsFor,
  totalLinesOf,
} from './coverageRows';

function info(className: string, covered: number, uncovered: number): CoverageInfo {
  return {
    className,
    numLinesCovered: covered,
    numLinesUncovered: uncovered,
    coveredLines: [],
    uncoveredLines: [],
  };
}

test('band splits at the 75% deploy floor and at 50%', () => {
  assert.equal(band(100), 'hi');
  assert.equal(band(75), 'hi');
  assert.equal(band(74), 'mid');
  assert.equal(band(50), 'mid');
  assert.equal(band(49), 'lo');
  assert.equal(band(0), 'lo');
});

test('pctOf rounds to whole percents', () => {
  assert.equal(pctOf(info('A', 43, 31)), 58); // 43/74 = 58.1
  assert.equal(pctOf(info('B', 117, 27)), 81); // 117/144 = 81.25
  assert.equal(pctOf(info('C', 38, 0)), 100);
});

test('a class with no measurable lines counts as 100%, not 0%', () => {
  assert.equal(totalLinesOf(info('Empty', 0, 0)), 0);
  assert.equal(pctOf(info('Empty', 0, 0)), 100);
});

test('negative or non-finite line counts do not produce a bogus total', () => {
  assert.equal(totalLinesOf(info('Bad', 0, -5)), 0);
  assert.equal(totalLinesOf(info('NaN', Number.NaN, 3)), 0);
  assert.equal(pctOf(info('NaN', Number.NaN, 3)), 100);
});

test('rowsFor sorts worst first and breaks ties by name', () => {
  const rows = rowsFor(
    [
      info('ContactMergeService', 38, 0),
      info('InvoiceCalculator', 43, 31),
      info('AccountService', 117, 27),
      info('OpportunityRollupBatch', 61, 31),
      info('Zeta', 1, 1),
      info('Alpha', 1, 1),
    ],
    () => true,
  );
  assert.deepEqual(
    rows.map((r) => r.className),
    [
      'Alpha',
      'Zeta',
      'InvoiceCalculator',
      'OpportunityRollupBatch',
      'AccountService',
      'ContactMergeService',
    ],
  );
  assert.deepEqual(rows[2], {
    className: 'InvoiceCalculator',
    pct: 58,
    covered: 43,
    total: 74,
    hasSource: true,
    isTrigger: false,
  });
});

test('rowsFor carries the target record onto the rows it belongs to', () => {
  const marked = rowsFor(
    [info('AccountService', 1, 1), info('ContactMergeService', 1, 1)],
    () => true,
    (name) =>
      name === 'AccountService' ? { tier: 'declared', by: ['AccountServiceTest'] } : undefined,
  );
  assert.deepEqual(
    marked.filter((r) => r.target).map((r) => [r.className, r.target?.tier]),
    [['AccountService', 'declared']],
  );
});

test('rowsFor marks classes the workspace does not have', () => {
  const local = new Set(['InvoiceCalculator']);
  const rows = rowsFor([info('LegacyPricing', 89, 31), info('InvoiceCalculator', 43, 31)], (n) =>
    local.has(n),
  );
  const byName = new Map(rows.map((r) => [r.className, r.hasSource]));
  assert.equal(byName.get('LegacyPricing'), false);
  assert.equal(byName.get('InvoiceCalculator'), true);
});

test('rowsFor does not mutate the input order', () => {
  const infos = [info('B', 1, 0), info('A', 0, 1)];
  rowsFor(infos, () => true);
  assert.deepEqual(
    infos.map((i) => i.className),
    ['B', 'A'],
  );
});

test('overallOf aggregates lines, not per-class percentages', () => {
  // Naively averaging the two percentages would give 75; the honest answer
  // weights by line count.
  assert.equal(overallOf([info('Big', 50, 50), info('Tiny', 1, 0)]), 50);
  assert.equal(overallOf([info('A', 43, 31), info('B', 117, 27)]), 73);
});

test('overallOf is null when nothing measurable came back', () => {
  assert.equal(overallOf([]), null);
  assert.equal(overallOf([info('Empty', 0, 0)]), null);
});

test('overallOf keeps duplicate class entries instead of collapsing them', () => {
  assert.equal(overallOf([info('Dup', 1, 0), info('Dup', 0, 1)]), 50);
});

test('indexByClassName keys case-insensitively', () => {
  const index = indexByClassName([info('InvoiceCalculator', 1, 1)]);
  assert.equal(index.get('invoicecalculator')?.className, 'InvoiceCalculator');
  assert.equal(index.get('InvoiceCalculator'), undefined);
});

test('classesUnderTest inverts the four test-naming conventions', () => {
  const found = classesUnderTest(['FooTest', 'TestBar', 'Baz_Test', 'QuxTests']);
  assert.deepEqual([...found].sort(), ['bar', 'baz', 'foo', 'qux']);
});

test('classesUnderTest ignores a test class that matches no convention', () => {
  assert.deepEqual([...classesUnderTest(['NightlyScenarios', ''])], []);
});

test('classesUnderTest does not mistake an ordinary word ending in "test"', () => {
  assert.deepEqual([...classesUnderTest(['Contest', 'Latest', 'Tester', 'Test', 'Tests'])], []);
});

test('classesUnderTest tolerates the underscore spellings', () => {
  assert.deepEqual([...classesUnderTest(['Foo__Test', 'Test_Bar'])].sort(), ['bar', 'foo']);
});
