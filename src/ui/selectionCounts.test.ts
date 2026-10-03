import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { selectedSummary, selectionCounts, selectionCountsText } from './selectionCounts';

test('selectionCounts: a bare class key counts as one class, one method', () => {
  assert.deepEqual(selectionCounts(['LegacyQueueTest']), { classes: 1, methods: 1 });
});

test('selectionCounts: several methods of one class are one class, N methods', () => {
  assert.deepEqual(
    selectionCounts([
      'AccountServiceTest.testCreate',
      'AccountServiceTest.testUpdate',
      'AccountServiceTest.testDelete',
    ]),
    { classes: 1, methods: 3 },
  );
});

test('selectionCounts: methods across several classes count every class', () => {
  assert.deepEqual(
    selectionCounts(['AccountServiceTest.testCreate', 'InvoiceCalculatorTest.testNetTotal']),
    { classes: 2, methods: 2 },
  );
});

test('selectionCounts: a mix of bare and method keys for the same class is still one class', () => {
  assert.deepEqual(
    selectionCounts(['LegacyQueueTest', 'AccountServiceTest.testCreate']),
    { classes: 2, methods: 2 },
  );
});

test('selectionCounts: an empty selection is nothing', () => {
  assert.deepEqual(selectionCounts([]), { classes: 0, methods: 0 });
});

test('selectionCountsText: singular class, plural methods', () => {
  assert.equal(
    selectionCountsText([
      'AccountServiceTest.testCreate',
      'AccountServiceTest.testUpdate',
      'AccountServiceTest.testDelete',
      'AccountServiceTest.testArchive',
      'AccountServiceTest.testRestore',
      'AccountServiceTest.testMerge',
      'AccountServiceTest.testSplit',
    ]),
    '1 class · 7 methods',
  );
});

test('selectionCountsText: plural classes, singular method', () => {
  assert.equal(
    selectionCountsText(['AccountServiceTest.testCreate', 'InvoiceCalculatorTest']),
    '2 classes · 2 methods',
  );
});

test('selectionCountsText: singular both ways', () => {
  assert.equal(selectionCountsText(['LegacyQueueTest']), '1 class · 1 method');
});

test('selectedSummary: appends "selected" to the counts text', () => {
  assert.equal(
    selectedSummary([
      'AccountServiceTest.testCreate',
      'AccountServiceTest.testUpdate',
      'AccountServiceTest.testDelete',
      'AccountServiceTest.testArchive',
      'AccountServiceTest.testRestore',
      'AccountServiceTest.testMerge',
      'AccountServiceTest.testSplit',
    ]),
    '1 class · 7 methods selected',
  );
});

test('selectedSummary: nothing selected still reports zero of both', () => {
  assert.equal(selectedSummary([]), '0 classes · 0 methods selected');
});
