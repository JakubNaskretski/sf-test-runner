import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRunCoverage, coverageFromEntry } from './coverageMapping';

test('maps modern lines-map shape to covered/uncovered', () => {
  const block = {
    coverage: [
      {
        name: 'AccountService',
        totalLines: 4,
        totalCovered: 2,
        lines: { '1': 3, '2': 0, '3': 1, '4': 0 },
      },
    ],
  };
  const map = mapRunCoverage(block);
  const info = map.get('accountservice');
  assert.ok(info);
  assert.deepEqual(info!.coveredLines.sort((a, b) => a - b), [1, 3]);
  assert.deepEqual(info!.uncoveredLines.sort((a, b) => a - b), [2, 4]);
  assert.equal(info!.numLinesCovered, 2);
  assert.equal(info!.numLinesUncovered, 2);
});

test('maps explicit coveredLines/uncoveredLines arrays', () => {
  const block = {
    coverage: [
      {
        name: 'Foo',
        numLinesCovered: 2,
        numLinesUncovered: 1,
        coveredLines: [10, 11],
        uncoveredLines: [12],
      },
    ],
  };
  const info = mapRunCoverage(block).get('foo');
  assert.ok(info);
  assert.deepEqual(info!.coveredLines, [10, 11]);
  assert.deepEqual(info!.uncoveredLines, [12]);
  assert.equal(info!.numLinesCovered, 2);
  assert.equal(info!.numLinesUncovered, 1);
});

test('keys the map by lowercased class name and handles multiple classes', () => {
  const block = {
    coverage: [
      { name: 'ClassA', lines: { '1': 1 } },
      { name: 'ClassB', lines: { '2': 0 } },
    ],
  };
  const map = mapRunCoverage(block);
  assert.equal(map.size, 2);
  assert.ok(map.has('classa'));
  assert.ok(map.has('classb'));
});

test('tolerates a bare array (no coverage wrapper)', () => {
  const arr = [{ name: 'Bare', lines: { '5': 1 } }];
  const map = mapRunCoverage(arr);
  assert.ok(map.get('bare'));
});

test('returns empty map for missing/garbage input', () => {
  assert.equal(mapRunCoverage(undefined).size, 0);
  assert.equal(mapRunCoverage(null).size, 0);
  assert.equal(mapRunCoverage({}).size, 0);
  assert.equal(mapRunCoverage({ coverage: 'nope' }).size, 0);
});

test('skips entries with no name', () => {
  const map = mapRunCoverage({ coverage: [{ lines: { '1': 1 } }, { name: '', lines: {} }] });
  assert.equal(map.size, 0);
});

test('coverageFromEntry derives uncovered count from totalLines - totalCovered', () => {
  const info = coverageFromEntry({ name: 'X', totalLines: 10, totalCovered: 7, lines: {} });
  assert.equal(info!.numLinesCovered, 7);
  assert.equal(info!.numLinesUncovered, 3);
});

test('coverageFromEntry ignores non-numeric line keys', () => {
  const info = coverageFromEntry({ name: 'X', lines: { '1': 1, foo: 0 as any } });
  assert.deepEqual(info!.coveredLines, [1]);
  assert.deepEqual(info!.uncoveredLines, []);
});
