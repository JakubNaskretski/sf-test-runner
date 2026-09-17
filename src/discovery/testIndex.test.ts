import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './testIndex';
import type { OrgTestClasses } from './orgTests';
import type { TestClassEntry } from '../types';

function localEntry(name: string, methods: string[]): TestClassEntry {
  return {
    name,
    source: 'local-only',
    uri: `file:///acme/force-app/main/default/classes/${name}.cls`,
    classLine: 1,
    methods: methods.map((m, i) => ({ name: m, line: 3 + i })),
  };
}

function orgClasses(classes: OrgTestClasses['classes']): OrgTestClasses {
  return { orgUsername: 'acme-dev@example.com', fetchedAt: 1_700_000_000_000, classes };
}

test('a class on disk with no org half is local-only', () => {
  const index = buildIndex([localEntry('AcmeOrderTest', ['testOrder'])]);
  assert.equal(index.classes.length, 1);
  assert.equal(index.classes[0].source, 'local-only');
  assert.equal(index.classes[0].orgId, undefined);
  assert.equal(index.orgUsername, undefined);
});

test('a class in both keeps the local file and gains the org id', () => {
  const index = buildIndex(
    [localEntry('AcmeOrderTest', ['testOrder', 'testRefund'])],
    orgClasses([
      { name: 'AcmeOrderTest', orgId: '01p000000000001AAA', isTest: true, methods: [] },
    ]),
  );
  const [entry] = index.classes;
  assert.equal(entry.source, 'both');
  assert.equal(entry.orgId, '01p000000000001AAA');
  assert.match(entry.uri!, /AcmeOrderTest\.cls$/);
  assert.deepEqual(entry.methods.map((m) => m.name), ['testOrder', 'testRefund']);
  // Local methods keep their lines — they point at a file that can be opened.
  assert.equal(entry.methods[0].line, 3);
  assert.equal(index.orgUsername, 'acme-dev@example.com');
  assert.equal(index.orgFetchedAt, 1_700_000_000_000);
});

test('matching is case-insensitive and the local spelling wins', () => {
  const index = buildIndex(
    [localEntry('AcmeOrderTest', ['testOrder'])],
    orgClasses([
      { name: 'ACMEORDERTEST', orgId: '01p000000000001AAA', isTest: true, methods: [] },
    ]),
  );
  assert.equal(index.classes.length, 1);
  assert.equal(index.classes[0].name, 'AcmeOrderTest');
  assert.equal(index.classes[0].source, 'both');
});

test('an org-only test class carries the org methods and no uri', () => {
  const index = buildIndex(
    [],
    orgClasses([
      {
        name: 'AcmeLegacyTest',
        orgId: '01p000000000002AAA',
        namespace: 'acme',
        isTest: true,
        methods: [{ name: 'testLegacy' }],
      },
    ]),
  );
  const [entry] = index.classes;
  assert.equal(entry.source, 'org-only');
  assert.equal(entry.uri, undefined);
  assert.equal(entry.namespace, 'acme');
  assert.deepEqual(entry.methods, [{ name: 'testLegacy' }]);
});

test('org classes that are not tests are dropped from the index', () => {
  const index = buildIndex(
    [],
    orgClasses([
      { name: 'AcmeOrderService', orgId: '01p000000000003AAA', isTest: false, methods: [] },
      { name: 'AcmeOrderTest', orgId: '01p000000000004AAA', isTest: true, methods: [{ name: 't' }] },
    ]),
  );
  assert.deepEqual(index.classes.map((c) => c.name), ['AcmeOrderTest']);
});

test('an unclassified org class is kept selectable-as-a-whole, not guessed', () => {
  const index = buildIndex(
    [],
    orgClasses([
      {
        // Exactly what the fetcher produces when the org returns no Body: not
        // classified as a test, and honest about not knowing its methods.
        name: 'AcmeMysteryTest',
        orgId: '01p000000000005AAA',
        isTest: false,
        methods: [],
        methodsUnknown: true,
      },
    ]),
  );
  assert.equal(index.classes.length, 1);
  assert.equal(index.classes[0].source, 'org-only');
  assert.equal(index.classes[0].methodsUnknown, true);
  assert.deepEqual(index.classes[0].methods, []);
});

test('a classified non-test is dropped even though it too has no methods', () => {
  const index = buildIndex(
    [],
    orgClasses([
      { name: 'AcmeOrderService', orgId: '01p000000000007AAA', isTest: false, methods: [] },
    ]),
  );
  assert.deepEqual(index.classes, []);
});

test('the union is sorted by name', () => {
  const index = buildIndex(
    [localEntry('ZetaAcmeTest', ['t']), localEntry('AlphaAcmeTest', ['t'])],
    orgClasses([
      { name: 'MidAcmeTest', orgId: '01p000000000006AAA', isTest: true, methods: [{ name: 't' }] },
    ]),
  );
  assert.deepEqual(index.classes.map((c) => c.name), [
    'AlphaAcmeTest',
    'MidAcmeTest',
    'ZetaAcmeTest',
  ]);
});
