import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { TestClassEntry } from '../types';

// The scanner is workspace bookkeeping around `findFiles`, `fs.readFile` and a
// file watcher, so a hand-rolled `vscode` stub with real behaviour behind those
// three is enough to drive it outside the extension host — the same Module._load
// trick the other unit tests use.

interface FakeUri {
  scheme: string;
  fsPath: string;
  toString(): string;
}

/** path → file contents. The whole fake workspace. */
const files = new Map<string, string>();
let findFilesImpl: (() => Promise<FakeUri[]>) | undefined;
let findFileCalls = 0;
const watcherHandlers: {
  create: ((uri: FakeUri) => void)[];
  change: ((uri: FakeUri) => void)[];
  delete: ((uri: FakeUri) => void)[];
} = { create: [], change: [], delete: [] };

function fakeUri(path: string): FakeUri {
  const s = `file://${path}`;
  return { scheme: 'file', fsPath: path, toString: () => s };
}

function pathOf(uriString: string): string {
  return uriString.replace(/^file:\/\//, '');
}

const vscodeStub = {
  EventEmitter: class {
    private listeners: ((value: unknown) => void)[] = [];
    event = (listener: (value: unknown) => void): { dispose(): void } => {
      this.listeners.push(listener);
      return { dispose: (): void => undefined };
    };
    fire = (value: unknown): void => {
      for (const listener of [...this.listeners]) listener(value);
    };
    dispose = (): void => {
      this.listeners = [];
    };
  },
  Uri: { parse: (s: string): FakeUri => fakeUri(pathOf(s)) },
  window: { visibleTextEditors: [] as unknown[] },
  workspace: {
    // The real one takes a glob; the scanner now walks classes and triggers in
    // separate calls, so the fake has to honour it or a trigger would come back
    // as a class.
    findFiles: async (glob: string): Promise<FakeUri[]> => {
      findFileCalls++;
      if (findFilesImpl) return findFilesImpl();
      const ext = glob.endsWith('.trigger') ? '.trigger' : '.cls';
      return [...files.keys()].filter((f) => f.endsWith(ext)).map(fakeUri);
    },
    fs: {
      readFile: async (uri: FakeUri): Promise<Uint8Array> => {
        const content = files.get(uri.fsPath);
        if (content === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return Buffer.from(content, 'utf8');
      },
    },
    createFileSystemWatcher: (): unknown => ({
      onDidCreate: (fn: (uri: FakeUri) => void) => {
        watcherHandlers.create.push(fn);
        return { dispose: (): void => undefined };
      },
      onDidChange: (fn: (uri: FakeUri) => void) => {
        watcherHandlers.change.push(fn);
        return { dispose: (): void => undefined };
      },
      onDidDelete: (fn: (uri: FakeUri) => void) => {
        watcherHandlers.delete.push(fn);
        return { dispose: (): void => undefined };
      },
      dispose: (): void => undefined,
    }),
    onDidOpenTextDocument: (): unknown => ({ dispose: (): void => undefined }),
    onDidSaveTextDocument: (): unknown => ({ dispose: (): void => undefined }),
    // Every fake file lives inside the one fake workspace folder, so the
    // stale-drop step at the end of a scan applies to all of them.
    getWorkspaceFolder: (): unknown => ({ uri: fakeUri('/acme') }),
  },
};

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]): unknown {
  if (request !== 'vscode') return realLoad.call(this, request, ...rest);
  return vscodeStub;
};

let mod: typeof import('./localTests');
before(async () => {
  mod = await import('./localTests');
});

const TEST_CLASS = `@IsTest
private class AcmeOrderTest {
    @IsTest
    static void testOrder() {
        System.assert(true);
    }
}`;

const HELPER_CLASS = `@IsTest
public class AcmeTestDataFactory {
    public static Account newAccount() {
        return new Account(Name = 'Acme');
    }
}`;

const PLAIN_CLASS = `public with sharing class AcmeOrderService {
    public static void go() {}
}`;

function named(body: string, className: string): string {
  return body.replace(/class \w+/, `class ${className}`);
}

/** Let queued microtasks (the watcher handlers' async reads) finish. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function newScanner(): InstanceType<typeof mod.LocalTestScanner> {
  return new mod.LocalTestScanner({ appendLine: (): void => undefined } as any);
}

beforeEach(() => {
  files.clear();
  findFilesImpl = undefined;
  findFileCalls = 0;
  watcherHandlers.create.length = 0;
  watcherHandlers.change.length = 0;
  watcherHandlers.delete.length = 0;
});

test('a scan finds test classes and leaves @IsTest helpers out', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  files.set('/acme/classes/AcmeTestDataFactory.cls', HELPER_CLASS);
  files.set('/acme/classes/AcmeOrderService.cls', PLAIN_CLASS);

  const scanner = newScanner();
  const entries = await scanner.ensureDiscovered();
  assert.deepEqual(entries.map((e) => e.name), ['AcmeOrderTest']);
  assert.equal(entries[0].source, 'local-only');
  assert.equal(entries[0].uri, 'file:///acme/classes/AcmeOrderTest.cls');
  assert.equal(entries[0].classLine, 1);
  assert.deepEqual(entries[0].methods, [{ name: 'testOrder', line: 3 }]);
  scanner.dispose();
});

test('localClassNames reports every .cls and .trigger, not only the test classes', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  files.set('/acme/classes/AcmeTestDataFactory.cls', HELPER_CLASS);
  files.set('/acme/classes/AcmeOrderService.cls', PLAIN_CLASS);
  files.set('/acme/triggers/AcmeOrderTrigger.trigger', 'trigger AcmeOrderTrigger on Order {}');

  const scanner = newScanner();
  // Nothing walked yet: "not known", which the coverage table must not read as
  // "this class has no local source".
  assert.deepEqual(scanner.localClassNames(), []);

  await scanner.ensureDiscovered();
  // The class UNDER test is the one coverage is reported for, and it is exactly
  // the one the test-class entries never mention. A run covers triggers too, and
  // they are tagged so the table opens the right file.
  assert.deepEqual(
    scanner
      .localClassNames()
      .map((f) => `${f.name}${f.isTrigger ? ' (trigger)' : ''}`)
      .sort(),
    [
      'AcmeOrderService',
      'AcmeOrderTest',
      'AcmeOrderTrigger (trigger)',
      'AcmeTestDataFactory',
    ],
  );
  // A trigger holds no tests, so it must not become an entry.
  assert.equal(
    scanner.current().some((e) => e.name === 'AcmeOrderTrigger'),
    false,
  );
  scanner.dispose();
});

test('the first scan is memoised and rescan walks the workspace again', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  const scanner = newScanner();
  await scanner.ensureDiscovered();
  await scanner.ensureDiscovered();
  // One walk, two globs: classes and triggers.
  assert.equal(findFileCalls, 2);
  await scanner.rescan();
  assert.equal(findFileCalls, 4);
  scanner.dispose();
});

test('a failed scan is not memoised, so the next ask retries', async () => {
  findFilesImpl = async (): Promise<FakeUri[]> => {
    throw new Error('workspace not ready');
  };
  const logged: string[] = [];
  const scanner = new mod.LocalTestScanner({
    appendLine: (v: string): void => {
      logged.push(v);
    },
  } as any);

  assert.deepEqual(await scanner.ensureDiscovered(), []);
  assert.equal(logged.some((l) => l.includes('workspace not ready')), true);

  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  findFilesImpl = undefined;
  const entries = await scanner.ensureDiscovered();
  assert.deepEqual(entries.map((e) => e.name), ['AcmeOrderTest']);
  scanner.dispose();
});

test('a full scan fires one change event, later edits fire per file', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  files.set('/acme/classes/AcmeBillingTest.cls', named(TEST_CLASS, 'AcmeBillingTest'));
  const scanner = newScanner();
  const fired: TestClassEntry[][] = [];
  scanner.onDidChange((entries) => fired.push(entries));

  await scanner.ensureDiscovered();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].length, 2);

  files.set('/acme/classes/AcmeRefundTest.cls', named(TEST_CLASS, 'AcmeRefundTest'));
  for (const fn of watcherHandlers.create) fn(fakeUri('/acme/classes/AcmeRefundTest.cls'));
  await flush();
  assert.equal(fired.length, 2);
  assert.equal(fired[1].length, 3);
  scanner.dispose();
});

test('re-parsing an unchanged file does not fire', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  const scanner = newScanner();
  await scanner.ensureDiscovered();
  let fires = 0;
  scanner.onDidChange(() => fires++);
  for (const fn of watcherHandlers.change) fn(fakeUri('/acme/classes/AcmeOrderTest.cls'));
  await flush();
  assert.equal(fires, 0);
  scanner.dispose();
});

test('deleting a file drops its class', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  const scanner = newScanner();
  await scanner.ensureDiscovered();

  files.delete('/acme/classes/AcmeOrderTest.cls');
  for (const fn of watcherHandlers.delete) fn(fakeUri('/acme/classes/AcmeOrderTest.cls'));
  await flush();
  assert.deepEqual(scanner.current(), []);
  scanner.dispose();
});

test('editing a class name moves the entry', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  const scanner = newScanner();
  await scanner.ensureDiscovered();

  files.set('/acme/classes/AcmeOrderTest.cls', named(TEST_CLASS, 'AcmeOrderRenamedTest'));
  for (const fn of watcherHandlers.change) fn(fakeUri('/acme/classes/AcmeOrderTest.cls'));
  await flush();
  assert.deepEqual(scanner.current().map((e) => e.name), ['AcmeOrderRenamedTest']);
  scanner.dispose();
});

test('with two files declaring one class, only the owner can remove it', async () => {
  // A retrieved copy beside force-app: both files declare AcmeOrderTest.
  const copy = '/acme/retrieved/AcmeOrderTest.cls';
  const real = '/acme/force-app/AcmeOrderTest.cls';
  files.set(copy, TEST_CLASS);
  files.set(real, TEST_CLASS);

  const scanner = newScanner();
  await scanner.ensureDiscovered();
  assert.deepEqual(scanner.current().map((e) => e.name), ['AcmeOrderTest']);

  // Make `real` the owner explicitly, so the assertions do not depend on the
  // order the batch happened to finish its reads in.
  for (const fn of watcherHandlers.change) fn(fakeUri(real));
  await flush();
  assert.equal(scanner.current()[0].uri, `file://${real}`);

  // Editing the copy into a different class must not delete the real one's entry.
  files.set(copy, named(TEST_CLASS, 'AcmeCopyTest'));
  for (const fn of watcherHandlers.change) fn(fakeUri(copy));
  await flush();
  const names = scanner.current().map((e) => e.name);
  assert.deepEqual(names.sort(), ['AcmeCopyTest', 'AcmeOrderTest']);
  assert.equal(scanner.current().find((e) => e.name === 'AcmeOrderTest')!.uri, `file://${real}`);

  // Deleting the owner does drop it.
  files.delete(real);
  for (const fn of watcherHandlers.delete) fn(fakeUri(real));
  await flush();
  assert.deepEqual(scanner.current().map((e) => e.name), ['AcmeCopyTest']);
  scanner.dispose();
});

test('a rescan drops classes whose files disappeared behind the watcher', async () => {
  files.set('/acme/classes/AcmeOrderTest.cls', TEST_CLASS);
  files.set('/acme/classes/AcmeBillingTest.cls', named(TEST_CLASS, 'AcmeBillingTest'));
  const scanner = newScanner();
  await scanner.ensureDiscovered();
  assert.equal(scanner.current().length, 2);

  // A bulk checkout removed one file and the watcher never told us.
  files.delete('/acme/classes/AcmeBillingTest.cls');
  const entries = await scanner.rescan();
  assert.deepEqual(entries.map((e) => e.name), ['AcmeOrderTest']);
  scanner.dispose();
});
