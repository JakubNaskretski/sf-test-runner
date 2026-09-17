import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestIndexSnapshot } from '../types';
import { classNameOf, testKeysForActiveFile } from './activeFileTests';

const index: TestIndexSnapshot = {
  classes: [
    {
      name: 'AccountServiceTest',
      source: 'both',
      methods: [{ name: 'testCreate', line: 8 }, { name: 'testUpdate', line: 20 }],
    },
    { name: 'TestInvoice', source: 'both', methods: [{ name: 'testNetTotal' }] },
    { name: 'Ledger_Test', source: 'local-only', methods: [{ name: 'testPost' }] },
    { name: 'PricingTests', source: 'both', methods: [{ name: 'testFloor' }] },
    { name: 'LegacyQueueTest', source: 'org-only', methods: [], methodsUnknown: true },
  ],
};

test('a test class selects its own methods', () => {
  assert.deepEqual(testKeysForActiveFile(index, '/src/classes/AccountServiceTest.cls'), [
    'AccountServiceTest.testCreate',
    'AccountServiceTest.testUpdate',
  ]);
});

test('an org-only class with unknown methods selects the bare class key', () => {
  assert.deepEqual(testKeysForActiveFile(index, 'LegacyQueueTest.cls'), ['LegacyQueueTest']);
});

test('production code selects its <Name>Test companion', () => {
  assert.deepEqual(testKeysForActiveFile(index, 'force-app/main/default/classes/AccountService.cls'), [
    'AccountServiceTest.testCreate',
    'AccountServiceTest.testUpdate',
  ]);
});

test('the other three naming conventions are tried too', () => {
  assert.deepEqual(testKeysForActiveFile(index, 'Invoice.cls'), ['TestInvoice.testNetTotal']);
  assert.deepEqual(testKeysForActiveFile(index, 'Ledger.cls'), ['Ledger_Test.testPost']);
  assert.deepEqual(testKeysForActiveFile(index, 'Pricing.cls'), ['PricingTests.testFloor']);
});

test('every matching convention contributes its keys', () => {
  const both: TestIndexSnapshot = {
    classes: [
      { name: 'OrderTest', source: 'both', methods: [{ name: 'testA' }] },
      { name: 'TestOrder', source: 'both', methods: [{ name: 'testB' }] },
    ],
  };
  assert.deepEqual(testKeysForActiveFile(both, 'Order.cls'), ['OrderTest.testA', 'TestOrder.testB']);
});

test('a file with no test class anywhere selects nothing', () => {
  assert.deepEqual(testKeysForActiveFile(index, 'Unrelated.cls'), []);
  assert.deepEqual(testKeysForActiveFile({ classes: [] }, 'AccountService.cls'), []);
});

test('windows paths, triggers and casing are handled', () => {
  assert.deepEqual(
    testKeysForActiveFile(index, 'C:\\repo\\force-app\\classes\\accountservicetest.cls'),
    ['AccountServiceTest.testCreate', 'AccountServiceTest.testUpdate'],
  );
  assert.equal(classNameOf('C:\\repo\\AccountTrigger.trigger'), 'AccountTrigger');
  assert.equal(classNameOf('/src/AccountService.cls'), 'AccountService');
  assert.equal(classNameOf('AccountService'), 'AccountService');
});
