import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestIndexSnapshot } from '../types';
import { classNameOf, keysForClasses, resolveTestClasses, testKeysForActiveFile } from './activeFileTests';

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

// ───────────────────────────── resolveTestClasses ─────────────────────────

test('resolveTestClasses: an index entry of the given name resolves to itself', () => {
  assert.deepEqual(resolveTestClasses(index, ['AccountServiceTest']), ['AccountServiceTest']);
});

test('resolveTestClasses: the own-name match is case-insensitive', () => {
  assert.deepEqual(resolveTestClasses(index, ['accountservicetest']), ['AccountServiceTest']);
});

test('resolveTestClasses: testFor declarations are used when there is no own-name match, and every declaring class is included', () => {
  const withTestFor: TestIndexSnapshot = {
    classes: [
      { name: 'PaymentTest', source: 'both', methods: [], testFor: ['PaymentGateway'] },
      { name: 'GatewayComplianceTest', source: 'both', methods: [], testFor: ['PaymentGateway', 'Other'] },
      // Would also match the naming convention, but testFor is found first and wins.
      { name: 'PaymentGatewayTest', source: 'both', methods: [] },
    ],
  };
  assert.deepEqual(resolveTestClasses(withTestFor, ['PaymentGateway']), [
    'PaymentTest',
    'GatewayComplianceTest',
  ]);
});

test('resolveTestClasses: the testFor match is case-insensitive', () => {
  const withTestFor: TestIndexSnapshot = {
    classes: [{ name: 'FooTest', source: 'both', methods: [], testFor: ['foo'] }],
  };
  assert.deepEqual(resolveTestClasses(withTestFor, ['FOO']), ['FooTest']);
});

test('resolveTestClasses: falls back to the first naming-convention hit, unlike testKeysForActiveFile', () => {
  const both: TestIndexSnapshot = {
    classes: [
      { name: 'OrderTest', source: 'both', methods: [] },
      { name: 'TestOrder', source: 'both', methods: [] },
    ],
  };
  // testKeysForActiveFile would collect both conventions; resolveTestClasses stops at the first.
  assert.deepEqual(resolveTestClasses(both, ['Order']), ['OrderTest']);
});

test('resolveTestClasses: a name matching nothing contributes nothing, without dropping the others', () => {
  assert.deepEqual(resolveTestClasses(index, ['Unrelated', 'AccountServiceTest']), [
    'AccountServiceTest',
  ]);
  assert.deepEqual(resolveTestClasses(index, ['Unrelated']), []);
});

test('resolveTestClasses: dedupes across inputs and keeps first-seen order', () => {
  const idx: TestIndexSnapshot = {
    classes: [{ name: 'FooTest', source: 'both', methods: [], testFor: ['Foo', 'Bar'] }],
  };
  assert.deepEqual(resolveTestClasses(idx, ['Foo', 'Bar']), ['FooTest']);
});

test('resolveTestClasses: blank names, an empty input and an empty index are all handled', () => {
  assert.deepEqual(resolveTestClasses(index, ['', '   ']), []);
  assert.deepEqual(resolveTestClasses(index, []), []);
  assert.deepEqual(resolveTestClasses({ classes: [] }, ['AccountService']), []);
});

// ───────────────────────────── keysForClasses ──────────────────────────────

test('keysForClasses: returns the method keys for each named class', () => {
  assert.deepEqual(keysForClasses(index, ['AccountServiceTest']), [
    'AccountServiceTest.testCreate',
    'AccountServiceTest.testUpdate',
  ]);
});

test('keysForClasses: an org-only class with unknown methods contributes its bare class key', () => {
  assert.deepEqual(keysForClasses(index, ['LegacyQueueTest']), ['LegacyQueueTest']);
});

test('keysForClasses: several classes concatenate in the order given, case-insensitively', () => {
  assert.deepEqual(keysForClasses(index, ['accountservicetest', 'TestInvoice']), [
    'AccountServiceTest.testCreate',
    'AccountServiceTest.testUpdate',
    'TestInvoice.testNetTotal',
  ]);
});

test('keysForClasses: a name the index does not know contributes nothing, without dropping the others', () => {
  assert.deepEqual(keysForClasses(index, ['Unrelated', 'AccountServiceTest']), [
    'AccountServiceTest.testCreate',
    'AccountServiceTest.testUpdate',
  ]);
  assert.deepEqual(keysForClasses(index, ['Unrelated']), []);
});

test('keysForClasses: duplicate class names do not duplicate their keys', () => {
  assert.deepEqual(keysForClasses(index, ['AccountServiceTest', 'AccountServiceTest']), [
    'AccountServiceTest.testCreate',
    'AccountServiceTest.testUpdate',
  ]);
});

test('keysForClasses: an empty input or an empty index yields nothing', () => {
  assert.deepEqual(keysForClasses(index, []), []);
  assert.deepEqual(keysForClasses({ classes: [] }, ['AccountServiceTest']), []);
});
