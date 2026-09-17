import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrgTestFetcher, classifyBody } from './orgTests';
import type { OrgTestClasses } from './orgTests';

// A fictional Apex test class, written for this test — the same shape the org
// returns in `ApexClass.Body`.
const TEST_CLASS_BODY = `/**
 * Covers the Acme order pipeline. See also class AcmeOrderService.
 */
@IsTest
private class AcmeOrderTest {
    @TestSetup
    static void makeData() {
        insert new Account(Name = 'Acme Holdings');
    }

    @IsTest
    static void testOrderTotals() {
        System.assertEquals(2, 1 + 1, 'totals');
    }

    @IsTest(SeeAllData=false)
    static void testRefundPath() {
        System.assert(true);
    }

    // helper, not a test
    private static Integer bump(Integer n) {
        return n + 1;
    }
}`;

const SERVICE_BODY = `public with sharing class AcmeOrderService {
    public static Integer total(List<Integer> lines) {
        Integer sum = 0;
        for (Integer line : lines) sum += line;
        return sum;
    }
}`;

const HELPER_BODY = `@IsTest
public class AcmeTestDataFactory {
    public static Account newAccount() {
        return new Account(Name = 'Acme');
    }
}`;

test('classifyBody finds the test methods of a test class', () => {
  const { isTest, methods } = classifyBody('AcmeOrderTest', TEST_CLASS_BODY);
  assert.equal(isTest, true);
  assert.deepEqual(methods.map((m) => m.name), ['testOrderTotals', 'testRefundPath']);
  // No lines: they would index the org's copy, and there is no file to open.
  assert.equal(methods.every((m) => m.line === undefined), true);
});

test('classifyBody rejects a plain service class', () => {
  assert.deepEqual(classifyBody('AcmeOrderService', SERVICE_BODY), { isTest: false, methods: [] });
});

test('classifyBody rejects an @IsTest helper with no test methods', () => {
  assert.deepEqual(classifyBody('AcmeTestDataFactory', HELPER_BODY), {
    isTest: false,
    methods: [],
  });
});

/** A memento that behaves like globalState: reads what was written. */
function fakeMemento(): any {
  const store = new Map<string, unknown>();
  return {
    keys: (): string[] => [...store.keys()],
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
  };
}

interface FakeCalls {
  listCalls: number;
  bodyIds: string[][];
}

function fakeCli(
  rows: { id: string; name: string; namespace?: string }[],
  bodies: Record<string, string | null>,
): { cli: any; calls: FakeCalls } {
  const calls: FakeCalls = { listCalls: 0, bodyIds: [] };
  const cli = {
    listOrgClasses: async () => {
      calls.listCalls++;
      return rows;
    },
    getClassBodies: async (ids: string[]) => {
      calls.bodyIds.push(ids);
      return new Map(ids.map((id) => [id, bodies[id] ?? null]));
    },
  };
  return { cli, calls };
}

const ROWS = [
  { id: '01p000000000001AAA', name: 'AcmeOrderTest' },
  { id: '01p000000000002AAA', name: 'AcmeOrderService' },
  { id: '01p000000000003AAA', name: 'AcmeLegacyTest' },
];
const BODIES: Record<string, string | null> = {
  '01p000000000002AAA': SERVICE_BODY,
  '01p000000000003AAA': TEST_CLASS_BODY.replace('AcmeOrderTest', 'AcmeLegacyTest'),
};

test('fetch skips the Body query for names the local scan already classified', async () => {
  const { cli, calls } = fakeCli(ROWS, BODIES);
  const fetcher = new OrgTestFetcher(cli, fakeMemento());
  const result = await fetcher.fetch('acme-dev@example.com', ['acmeordertest']);

  assert.equal(calls.listCalls, 1);
  // Only the two names with no local test file needed a body.
  assert.deepEqual(calls.bodyIds, [['01p000000000002AAA', '01p000000000003AAA']]);

  const local = result.classes.find((c) => c.name === 'AcmeOrderTest')!;
  assert.equal(local.isTest, true);
  assert.deepEqual(local.methods, []);

  const orgOnly = result.classes.find((c) => c.name === 'AcmeLegacyTest')!;
  assert.equal(orgOnly.isTest, true);
  assert.deepEqual(orgOnly.methods.map((m) => m.name), ['testOrderTotals', 'testRefundPath']);

  // The non-test class stays in the record set so the cache is complete.
  assert.equal(result.classes.find((c) => c.name === 'AcmeOrderService')!.isTest, false);
});

test('a class whose Body came back empty is unclassified, never guessed', async () => {
  const lines: string[] = [];
  const { cli } = fakeCli([{ id: '01p000000000009AAA', name: 'AcmeGhostTest' }], {});
  const fetcher = new OrgTestFetcher(cli, fakeMemento(), {
    appendLine: (v: string) => lines.push(v),
  });
  const [record] = (await fetcher.fetch('acme-dev@example.com', [])).classes;
  assert.equal(record.isTest, false);
  assert.equal(record.methodsUnknown, true);
  assert.equal(
    lines.some((l) => l.includes('AcmeGhostTest')),
    true,
  );
});

test('fetch caches per org and cached() reads it back', async () => {
  const memento = fakeMemento();
  const { cli } = fakeCli(ROWS, BODIES);
  const fetcher = new OrgTestFetcher(cli, memento);
  assert.equal(fetcher.cached('acme-dev@example.com'), undefined);

  const fetched = await fetcher.fetch('acme-dev@example.com', []);
  const cached = fetcher.cached('acme-dev@example.com') as OrgTestClasses;
  assert.equal(cached.orgUsername, 'acme-dev@example.com');
  assert.equal(cached.classes.length, fetched.classes.length);
  // A different org has its own cache entry.
  assert.equal(fetcher.cached('acme-sbx@example.com'), undefined);
});

test('two concurrent fetches for one org share a single query pass', async () => {
  const { cli, calls } = fakeCli(ROWS, BODIES);
  const fetcher = new OrgTestFetcher(cli, fakeMemento());
  const [a, b] = await Promise.all([
    fetcher.fetch('acme-dev@example.com', []),
    fetcher.fetch('acme-dev@example.com', []),
  ]);
  assert.equal(calls.listCalls, 1);
  assert.equal(a, b);
  // The single-flight entry is released, so a later fetch really re-queries.
  await fetcher.fetch('acme-dev@example.com', []);
  assert.equal(calls.listCalls, 2);
});
