import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestIndexSnapshot } from '../types';
import {
  classNameOf,
  keysForClasses,
  resolveHandoff,
  resolveTestClasses,
  testKeysForActiveFile,
} from './activeFileTests';

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

// ──────────────────── resolveHandoff: the flag, then the semantics ────────────────────

const handoffIndex: TestIndexSnapshot = {
  classes: [
    { name: 'AcmeOrderTest', source: 'both', methods: [{ name: 'testTotals' }] },
    { name: 'AcmeBillingTest', source: 'both', methods: [{ name: 'testInvoice' }] },
  ],
  annotatedOnly: [
    { name: 'AcmeHelper', source: 'both', methods: [], annotatedOnly: true },
    { name: 'AcmeTestDataFactory', source: 'both', methods: [], annotatedOnly: true },
  ],
};

test('resolveHandoff: a deployed @IsTest class with no recognised method runs as its own test', () => {
  const res = resolveHandoff(handoffIndex, ['AcmeHelper']);
  assert.deepEqual(res.testClasses, ['AcmeHelper']);
  assert.deepEqual(res.matches, [{ name: 'AcmeHelper', own: 'annotated', testClasses: ['AcmeHelper'] }]);
  // Case-insensitive, like every other lookup here; the index spelling is sent.
  assert.deepEqual(resolveTestClasses(handoffIndex, ['acmehelper']), ['AcmeHelper']);
});

test('resolveHandoff: flag first is not flag only — an annotated class also brings its testFor tests', () => {
  const idx: TestIndexSnapshot = {
    ...handoffIndex,
    classes: [
      ...handoffIndex.classes,
      { name: 'AcmeHelperTest', source: 'both', methods: [{ name: 't' }] },
      { name: 'AcmeDeclares', source: 'both', methods: [{ name: 't' }], testFor: ['AcmeHelper'] },
    ],
  };
  const res = resolveHandoff(idx, ['AcmeHelper']);
  // Itself first, then the testFor test; testFor wins over the naming convention as before.
  assert.deepEqual(res.testClasses, ['AcmeHelper', 'AcmeDeclares']);
  assert.deepEqual(res.matches, [
    { name: 'AcmeHelper', own: 'annotated', semantic: 'testFor', testClasses: ['AcmeHelper', 'AcmeDeclares'] },
  ]);
});

test('resolveHandoff: an annotated class with no testFor test still brings its naming-convention test', () => {
  const idx: TestIndexSnapshot = {
    ...handoffIndex,
    classes: [...handoffIndex.classes, { name: 'AcmeHelperTest', source: 'both', methods: [{ name: 't' }] }],
  };
  assert.deepEqual(resolveTestClasses(idx, ['AcmeHelper']), ['AcmeHelper', 'AcmeHelperTest']);
});

test('resolveHandoff: a deployed test class is "own", and testFor / naming keep their order for the rest', () => {
  const idx: TestIndexSnapshot = {
    classes: [
      { name: 'AcmeOrderTest', source: 'both', methods: [{ name: 't' }] },
      { name: 'AcmeDeclaresOrder', source: 'both', methods: [{ name: 't' }], testFor: ['AcmeOrder'] },
      { name: 'AcmeLedgerTest', source: 'both', methods: [{ name: 't' }] },
    ],
  };
  const res = resolveHandoff(idx, ['AcmeOrderTest', 'AcmeOrder', 'AcmeLedger']);
  assert.deepEqual(res.matches, [
    { name: 'AcmeOrderTest', own: 'own', testClasses: ['AcmeOrderTest'] },
    { name: 'AcmeOrder', semantic: 'testFor', testClasses: ['AcmeDeclaresOrder'] },
    { name: 'AcmeLedger', semantic: 'naming', testClasses: ['AcmeLedgerTest'] },
  ]);
});

test('resolveHandoff: a deployed test class that another test declares testFor brings that one too', () => {
  const idx: TestIndexSnapshot = {
    classes: [
      { name: 'AcmeOrderTest', source: 'both', methods: [{ name: 't' }] },
      { name: 'AcmeOrderTestAudit', source: 'both', methods: [{ name: 't' }], testFor: ['AcmeOrderTest'] },
    ],
  };
  assert.deepEqual(resolveTestClasses(idx, ['AcmeOrderTest']), ['AcmeOrderTest', 'AcmeOrderTestAudit']);
});

test('resolveHandoff: an unmatched class contributes nothing and says so', () => {
  const res = resolveHandoff(handoffIndex, ['AcmeUtil']);
  assert.deepEqual(res.testClasses, []);
  assert.deepEqual(res.matches, [{ name: 'AcmeUtil', testClasses: [] }]);
});

test('resolveHandoff: one batch mixes every rule and dedupes across them', () => {
  const idx: TestIndexSnapshot = {
    ...handoffIndex,
    classes: [...handoffIndex.classes, { name: 'AcmeHelperTest', source: 'both', methods: [{ name: 't' }] }],
  };
  const res = resolveHandoff(idx, ['AcmeHelper', 'AcmeHelperTest', 'AcmeOrder', 'AcmeNothing']);
  assert.deepEqual(res.testClasses, ['AcmeHelper', 'AcmeHelperTest', 'AcmeOrderTest']);
  assert.deepEqual(
    res.matches.map((m) => [m.own ?? '-', m.semantic ?? '-']),
    [
      ['annotated', 'naming'],
      ['own', '-'],
      ['-', 'naming'],
      ['-', '-'],
    ],
  );
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
