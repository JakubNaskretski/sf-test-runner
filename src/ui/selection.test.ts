import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TestIndexSnapshot } from '../types';
import { SelectionSet } from './selection';

const index: TestIndexSnapshot = {
  classes: [
    {
      name: 'AccountServiceTest',
      source: 'both',
      methods: [{ name: 'testCreate', line: 8 }, { name: 'testUpdate', line: 20 }],
    },
    {
      name: 'InvoiceCalculatorTest',
      source: 'local-only',
      methods: [{ name: 'testNetTotal' }, { name: 'testTaxRounding' }, { name: 'testFloor' }],
    },
    {
      name: 'LegacyPricingTest',
      source: 'org-only',
      methods: [],
      methodsUnknown: true,
    },
  ],
};

test('toggleMethod adds then removes a key', () => {
  const sel = new SelectionSet(index);
  sel.toggleMethod('AccountServiceTest.testCreate');
  assert.equal(sel.count(), 1);
  assert.ok(sel.has('AccountServiceTest.testCreate'));
  sel.toggleMethod('AccountServiceTest.testCreate');
  assert.equal(sel.count(), 0);
});

test('setClass ticks and unticks every method of the class', () => {
  const sel = new SelectionSet(index);
  sel.setClass('InvoiceCalculatorTest', true);
  assert.deepEqual(sel.toArray(), [
    'InvoiceCalculatorTest.testFloor',
    'InvoiceCalculatorTest.testNetTotal',
    'InvoiceCalculatorTest.testTaxRounding',
  ]);
  sel.setClass('InvoiceCalculatorTest', false);
  assert.equal(sel.count(), 0);
});

test('a methods-unknown class selects as a bare class key', () => {
  const sel = new SelectionSet(index);
  sel.setClass('LegacyPricingTest', true);
  assert.deepEqual(sel.toArray(), ['LegacyPricingTest']);
  assert.equal(sel.classState('LegacyPricingTest'), 'all');
  assert.deepEqual(sel.toSelectors(), ['LegacyPricingTest']);
});

test('classState reports none / some / all', () => {
  const sel = new SelectionSet(index);
  assert.equal(sel.classState('AccountServiceTest'), 'none');
  sel.toggleMethod('AccountServiceTest.testCreate');
  assert.equal(sel.classState('AccountServiceTest'), 'some');
  sel.toggleMethod('AccountServiceTest.testUpdate');
  assert.equal(sel.classState('AccountServiceTest'), 'all');
  assert.equal(sel.classState('NoSuchTest'), 'none');
});

test('toSelectors collapses a full class and keeps partial methods', () => {
  const sel = new SelectionSet(index);
  sel.setClass('AccountServiceTest', true);
  sel.toggleMethod('InvoiceCalculatorTest.testTaxRounding');
  assert.deepEqual(sel.toSelectors().sort(), [
    'AccountServiceTest',
    'InvoiceCalculatorTest.testTaxRounding',
  ]);
});

test('toSelectors ignores keys the index no longer knows', () => {
  const sel = new SelectionSet(index, ['GhostTest.testGone', 'AccountServiceTest.testCreate']);
  assert.deepEqual(sel.toSelectors(), ['AccountServiceTest.testCreate']);
});

test('prune drops unknown keys and reports whether it did', () => {
  const sel = new SelectionSet(undefined, ['GhostTest.testGone', 'AccountServiceTest.testCreate']);
  assert.equal(sel.prune(index), true);
  assert.deepEqual(sel.toArray(), ['AccountServiceTest.testCreate']);
  assert.equal(sel.prune(index), false);
});

test('prune adopts the index so classState works after a rescan', () => {
  const sel = new SelectionSet();
  assert.equal(sel.classState('AccountServiceTest'), 'none');
  sel.prune(index);
  sel.setClass('AccountServiceTest', true);
  assert.equal(sel.classState('AccountServiceTest'), 'all');
});

test('clear empties the set', () => {
  const sel = new SelectionSet(index);
  sel.setClass('AccountServiceTest', true);
  sel.clear();
  assert.equal(sel.count(), 0);
  assert.deepEqual(sel.toSelectors(), []);
});
