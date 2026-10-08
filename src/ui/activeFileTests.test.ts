import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestIndexSnapshot } from '../types';
import {
  classNameOf,
  keysForClasses,
  MAX_REFERENCING_TESTS,
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

// ─────────────────── resolveHandoff: flag, semantics, references ───────────────────

const handoffIndex: TestIndexSnapshot = {
  classes: [
    { name: 'AcmeOrderTest', source: 'both', methods: [{ name: 'testTotals' }] },
    { name: 'AcmeBillingTest', source: 'both', methods: [{ name: 'testInvoice' }] },
    { name: 'AcmeRefundTest', source: 'local-only', methods: [{ name: 'testRefund' }] },
  ],
  annotatedOnly: [
    { name: 'AcmeHelper', source: 'both', methods: [], annotatedOnly: true },
    { name: 'AcmeTestDataFactory', source: 'both', methods: [], annotatedOnly: true },
  ],
};

test('resolveHandoff: a deployed @IsTest class with no recognised method runs as its own test', () => {
  const res = resolveHandoff(handoffIndex, ['AcmeHelper']);
  assert.deepEqual(res.testClasses, ['AcmeHelper']);
  assert.deepEqual(res.matches, [{ name: 'AcmeHelper', step: 'annotated', testClasses: ['AcmeHelper'] }]);
  // Case-insensitive, like every other lookup here; the index spelling is sent.
  assert.deepEqual(resolveTestClasses(handoffIndex, ['acmehelper']), ['AcmeHelper']);
});

test('resolveHandoff: the flag wins over the semantics — an annotated class is not swapped for its namesake test', () => {
  const idx: TestIndexSnapshot = {
    ...handoffIndex,
    classes: [
      ...handoffIndex.classes,
      { name: 'AcmeHelperTest', source: 'both', methods: [{ name: 't' }] },
      { name: 'AcmeDeclares', source: 'both', methods: [{ name: 't' }], testFor: ['AcmeHelper'] },
    ],
  };
  assert.deepEqual(resolveTestClasses(idx, ['AcmeHelper']), ['AcmeHelper']);
});

test('resolveHandoff: a deployed test class is "own"; testFor and naming keep their order after it', () => {
  const idx: TestIndexSnapshot = {
    classes: [
      { name: 'AcmeOrderTest', source: 'both', methods: [{ name: 't' }] },
      { name: 'AcmeDeclaresOrder', source: 'both', methods: [{ name: 't' }], testFor: ['AcmeOrder'] },
      { name: 'AcmeLedgerTest', source: 'both', methods: [{ name: 't' }] },
    ],
  };
  const res = resolveHandoff(idx, ['AcmeOrderTest', 'AcmeOrder', 'AcmeLedger']);
  assert.deepEqual(
    res.matches.map((m) => [m.name, m.step, m.testClasses]),
    [
      ['AcmeOrderTest', 'own', ['AcmeOrderTest']],
      ['AcmeOrder', 'testFor', ['AcmeDeclaresOrder']],
      ['AcmeLedger', 'naming', ['AcmeLedgerTest']],
    ],
  );
});

test('resolveHandoff: without sources an unmatched class reports none', () => {
  const res = resolveHandoff(handoffIndex, ['AcmeUtil']);
  assert.deepEqual(res.testClasses, []);
  assert.deepEqual(res.matches, [{ name: 'AcmeUtil', step: 'none', testClasses: [] }]);
});

test('resolveHandoff: referencing tests are offered only when nothing else matched, by whole word, sorted', () => {
  const sources = [
    { name: 'AcmeRefundTest', text: 'private class AcmeRefundTest {\n  static void t() { AcmeUtil.round(1); }\n}' },
    { name: 'AcmeOrderTest', text: 'private class AcmeOrderTest {\n  static void t() { new AcmeUtil(); }\n}' },
    { name: 'AcmeBillingTest', text: 'private class AcmeBillingTest { AcmeUtil::class; }' },
  ];
  const res = resolveHandoff(handoffIndex, ['AcmeUtil'], sources);
  assert.deepEqual(res.matches, [
    {
      name: 'AcmeUtil',
      step: 'referencing',
      testClasses: ['AcmeBillingTest', 'AcmeOrderTest', 'AcmeRefundTest'],
    },
  ]);
  // A semantic match is not widened by references.
  const withNaming: TestIndexSnapshot = {
    ...handoffIndex,
    classes: [...handoffIndex.classes, { name: 'AcmeUtilTest', source: 'both', methods: [{ name: 't' }] }],
  };
  assert.deepEqual(resolveTestClasses(withNaming, ['AcmeUtil'], sources), ['AcmeUtilTest']);
});

test('resolveHandoff: a referencing match is a whole word, in code — not a substring, a comment or a string', () => {
  const sources = [
    { name: 'AcmeOrderTest', text: 'class AcmeOrderTest { void t() { AcmeUtilities.go(); MyAcmeUtil.go(); AcmeUtil_Old.go(); } }' },
    { name: 'AcmeBillingTest', text: "class AcmeBillingTest {\n  // AcmeUtil.round()\n  void t() { System.debug('AcmeUtil'); }\n}" },
  ];
  const res = resolveHandoff(handoffIndex, ['AcmeUtil'], sources);
  assert.deepEqual(res.matches, [{ name: 'AcmeUtil', step: 'none', testClasses: [] }]);
  // Apex is case-insensitive: a differently-cased mention is still a mention.
  const cased = resolveHandoff(handoffIndex, ['AcmeUtil'], [
    { name: 'AcmeOrderTest', text: 'class AcmeOrderTest { void t() { acmeutil.go(); } }' },
  ]);
  assert.deepEqual(cased.testClasses, ['AcmeOrderTest']);
});

test('resolveHandoff: a referencing test is never the class itself, nor a class the index does not list', () => {
  const sources = [
    { name: 'AcmeUtil', text: 'public class AcmeUtil { AcmeUtil x; }' },
    { name: 'AcmeGhostTest', text: 'class AcmeGhostTest { AcmeUtil.go(); }' },
    { name: 'AcmeTestDataFactory', text: 'class AcmeTestDataFactory { AcmeUtil.go(); }' },
  ];
  assert.deepEqual(resolveHandoff(handoffIndex, ['AcmeUtil'], sources).matches[0].step, 'none');
});

test(`resolveHandoff: referencing tests are capped at ${MAX_REFERENCING_TESTS}, the rest counted`, () => {
  const names = Array.from({ length: MAX_REFERENCING_TESTS + 3 }, (_, i) => `AcmeRef${String(i).padStart(2, '0')}Test`);
  const idx: TestIndexSnapshot = {
    classes: names.map((name) => ({ name, source: 'local-only' as const, methods: [{ name: 't' }] })),
  };
  const sources = names.map((name) => ({ name, text: `class ${name} { void t() { AcmeUtil.go(); } }` }));
  const [match] = resolveHandoff(idx, ['AcmeUtil'], sources).matches;
  assert.equal(match.step, 'referencing');
  assert.deepEqual(match.testClasses, names.slice(0, MAX_REFERENCING_TESTS));
  assert.equal(match.omitted, 3);
});

test('resolveHandoff: one batch mixes every step and dedupes across them', () => {
  const sources = [{ name: 'AcmeOrderTest', text: 'class AcmeOrderTest { void t() { AcmeUtil.go(); } }' }];
  const res = resolveHandoff(handoffIndex, ['AcmeHelper', 'AcmeOrder', 'AcmeUtil', 'AcmeNothing'], sources);
  assert.deepEqual(res.testClasses, ['AcmeHelper', 'AcmeOrderTest']);
  assert.deepEqual(
    res.matches.map((m) => m.step),
    ['annotated', 'naming', 'referencing', 'none'],
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
