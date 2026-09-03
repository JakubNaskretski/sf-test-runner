import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { OrgInfo } from '../types';

// The picker is pure org bookkeeping around VS Code's settings/QuickPick/status
// bar, so a hand-rolled `vscode` stub (settings store + fake QuickPick) is enough
// to drive it outside the extension host — same Module._load trick the other
// tests use, but with real behaviour behind getConfiguration/onDidChangeConfiguration.

const SHARED_KEY = 'skrety.salesforce.targetOrg';
const SYNC_KEY = 'sfTestRunner.syncOrgWithFamily';
const PRIVATE_KEY = 'sfTestRunner.lastSelectedOrgUsername';
const MIGRATED_KEY = 'sfTestRunner.orgSyncMigrated.v1';
const ORG_LIST_CACHE_KEY = 'sfTestRunner.cachedOrgList';

const settings = new Map<string, unknown>();
let configListeners: ((e: { affectsConfiguration: (k: string) => boolean }) => void)[] = [];
let quickPicks: FakeQuickPick[] = [];

/** Notify every registered onDidChangeConfiguration listener about one key —
 *  what VS Code does after a settings write, from us or from a sibling plugin. */
function changeSetting(key: string, value: unknown): void {
  if (value === undefined) settings.delete(key);
  else settings.set(key, value);
  for (const listener of [...configListeners]) {
    listener({ affectsConfiguration: (k: string) => k === key });
  }
}

class FakeQuickPick {
  items: any[] = [];
  activeItems: any[] = [];
  selectedItems: any[] = [];
  buttons: unknown[] = [];
  busy = false;
  placeholder = '';
  matchOnDescription = false;
  matchOnDetail = false;
  private accepted: (() => void) | undefined;
  private hidden: (() => void) | undefined;
  onDidTriggerButton(): void {}
  onDidAccept(fn: () => void): void {
    this.accepted = fn;
  }
  onDidHide(fn: () => void): void {
    this.hidden = fn;
  }
  show(): void {}
  hide(): void {
    this.hidden?.();
  }
  dispose(): void {}
  /** Test driver: pick the item for `username` and accept, as a click would. */
  pick(username: string): void {
    const item = this.items.find((i) => i.org.username === username);
    assert.ok(item, `no picker item for ${username}`);
    this.selectedItems = [item];
    this.accepted?.();
  }
}

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]): unknown {
  if (request !== 'vscode') return realLoad.call(this, request, ...rest);
  return {
    EventEmitter: class {
      private listeners: ((v: unknown) => void)[] = [];
      event = (fn: (v: unknown) => void): { dispose: () => void } => {
        this.listeners.push(fn);
        return { dispose: (): void => {} };
      };
      fire = (v: unknown): void => {
        for (const l of [...this.listeners]) l(v);
      };
      dispose = (): void => {
        this.listeners = [];
      };
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    ThemeIcon: class {
      constructor(public id: string) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    window: {
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: '',
        backgroundColor: undefined,
        show: (): void => {},
        hide: (): void => {},
        dispose: (): void => {},
      }),
      createQuickPick: () => {
        const qp = new FakeQuickPick();
        quickPicks.push(qp);
        return qp;
      },
      showInformationMessage: async (): Promise<undefined> => undefined,
      showWarningMessage: async (): Promise<undefined> => undefined,
      showErrorMessage: async (): Promise<undefined> => undefined,
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) =>
          settings.has(key) ? settings.get(key) : fallback,
        update: async (key: string, value: unknown): Promise<void> => {
          changeSetting(key, value);
        },
      }),
      onDidChangeConfiguration: (fn: (e: any) => void) => {
        configListeners.push(fn);
        return {
          dispose: (): void => {
            configListeners = configListeners.filter((l) => l !== fn);
          },
        };
      },
    },
  };
};

let mod: typeof import('./orgPicker');
before(async () => {
  mod = await import('./orgPicker');
});

const DEV: OrgInfo = {
  alias: 'acme-dev',
  username: 'dev@acme.example',
  instanceUrl: 'https://acme-dev.my.salesforce.com',
  isDefault: true,
  orgEdition: 'Developer Edition',
};
const QA: OrgInfo = {
  alias: 'acme-qa',
  username: 'qa@acme.example',
  instanceUrl: 'https://acme--qa.sandbox.my.salesforce.com',
  isDefault: false,
  isSandbox: true,
};

/** In-memory Memento, seeded with the org-list cache so the picker resolves
 *  usernames to full OrgInfo without waiting on a list. */
function memento(seed: Record<string, unknown> = {}): vscodeMemento {
  const store = new Map<string, unknown>(Object.entries({ [ORG_LIST_CACHE_KEY]: [DEV, QA], ...seed }));
  return {
    keys: (): readonly string[] => [...store.keys()],
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  } as unknown as vscodeMemento;
}
type vscodeMemento = import('vscode').Memento;

/** sfCli stand-in: the picker only sets/reads the current org and lists orgs. */
function fakeCli(orgs: OrgInfo[] = [DEV, QA]): any {
  let current: OrgInfo | undefined;
  return {
    listOrgs: async (): Promise<OrgInfo[]> => orgs,
    setCurrentOrg: (o: OrgInfo | undefined): void => {
      current = o;
    },
    getCurrentOrg: (): OrgInfo | undefined => current,
  };
}

/** Build a picker and collect every onOrgChanged payload it fires. */
function makePicker(state: vscodeMemento, cli: any = fakeCli()) {
  const picker = new mod.OrgPicker(cli, state);
  const fired: (OrgInfo | undefined)[] = [];
  picker.onOrgChanged((o) => fired.push(o));
  return { picker, fired, cli };
}

beforeEach(() => {
  settings.clear();
  configListeners = [];
  quickPicks = [];
});

test('sync off: a pick is private — no family write, but onOrgChanged still fires', async () => {
  const state = memento();
  const { picker, fired, cli } = makePicker(state);

  const closed = picker.showPicker();
  quickPicks[0].pick(QA.username);
  await closed;

  assert.equal(state.get(PRIVATE_KEY), QA.username);
  assert.equal(settings.has(SHARED_KEY), false, 'the family setting must stay untouched');
  assert.deepEqual(fired.map((o) => o?.username), [QA.username]);
  assert.equal(cli.getCurrentOrg()?.username, QA.username);
  picker.dispose();
});

test('re-picking the org we are already on is not an org switch', async () => {
  const state = memento({ [PRIVATE_KEY]: QA.username });
  const { picker, fired, cli } = makePicker(state);

  const closed = picker.showPicker();
  quickPicks[0].pick(QA.username);
  await closed;

  assert.deepEqual(fired, [], 'no invalidation for a no-op pick');
  assert.equal(cli.getCurrentOrg()?.username, QA.username);
  picker.dispose();
});

test('sync off: a family org switch is ignored', () => {
  const state = memento({ [PRIVATE_KEY]: DEV.username });
  const { picker, fired, cli } = makePicker(state);

  changeSetting(SHARED_KEY, QA.username);

  assert.deepEqual(fired, []);
  assert.equal(cli.getCurrentOrg(), undefined);
  assert.equal(state.get(PRIVATE_KEY), DEV.username);
  picker.dispose();
});

test('sync on: a pick publishes to the family setting and fires exactly once', async () => {
  settings.set(SYNC_KEY, true);
  const state = memento();
  const { picker, fired } = makePicker(state);

  const closed = picker.showPicker();
  quickPicks[0].pick(QA.username);
  await closed;

  assert.equal(settings.get(SHARED_KEY), QA.username);
  assert.equal(state.get(PRIVATE_KEY), QA.username);
  // Our own shared write echoes back through the watcher — it must de-dup.
  assert.deepEqual(fired.map((o) => o?.username), [QA.username]);
  picker.dispose();
});

test('sync on: a family org switch is adopted and fires onOrgChanged', () => {
  settings.set(SYNC_KEY, true);
  const state = memento({ [PRIVATE_KEY]: DEV.username });
  const { picker, fired, cli } = makePicker(state);

  changeSetting(SHARED_KEY, QA.username);

  assert.deepEqual(fired.map((o) => o?.username), [QA.username]);
  assert.equal(cli.getCurrentOrg()?.username, QA.username);
  assert.equal(state.get(PRIVATE_KEY), QA.username);
  picker.dispose();
});

test('sync on: clearing the family org leaves our working target alone', () => {
  settings.set(SYNC_KEY, true);
  settings.set(SHARED_KEY, QA.username);
  const state = memento({ [PRIVATE_KEY]: QA.username });
  const { picker, fired, cli } = makePicker(state);
  cli.setCurrentOrg(QA);

  changeSetting(SHARED_KEY, undefined);

  assert.deepEqual(fired, [], 'an empty family value is never adopted');
  assert.equal(cli.getCurrentOrg()?.username, QA.username);
  assert.equal(state.get(PRIVATE_KEY), QA.username);
  picker.dispose();
});

test('sync on: an unknown family org still lands, via a minimal OrgInfo', async () => {
  settings.set(SYNC_KEY, true);
  // Neither the cache nor a fresh list knows the org the sibling switched to
  // (auth held only there, or a list hiccup) — we must target it anyway, not
  // silently stay put.
  const state = memento({ [PRIVATE_KEY]: DEV.username, [ORG_LIST_CACHE_KEY]: [DEV] });
  const { picker, fired, cli } = makePicker(state, fakeCli([DEV]));

  changeSetting(SHARED_KEY, QA.username);
  await new Promise((resolve) => setImmediate(resolve)); // the list round-trip

  assert.deepEqual(fired.map((o) => o?.username), [QA.username]);
  assert.equal(cli.getCurrentOrg()?.alias, QA.username, 'username stands in for the alias');
  assert.equal(state.get(PRIVATE_KEY), QA.username);
  picker.dispose();
});

test('flipping sync on adopts the family org; flipping it off changes nothing', () => {
  settings.set(SHARED_KEY, QA.username);
  const state = memento({ [PRIVATE_KEY]: DEV.username });
  const { picker, fired, cli } = makePicker(state);

  changeSetting(SYNC_KEY, true);
  assert.deepEqual(fired.map((o) => o?.username), [QA.username]);

  changeSetting(SYNC_KEY, false);
  assert.deepEqual(fired.map((o) => o?.username), [QA.username], 'toggle-off must not re-apply');
  assert.equal(cli.getCurrentOrg()?.username, QA.username);
  picker.dispose();
});

test('startup migration adopts the family org once, then never again', async () => {
  settings.set(SHARED_KEY, DEV.username);
  const state = memento();

  const first = makePicker(state);
  await first.picker.autoSelectDefault();
  assert.equal(state.get(PRIVATE_KEY), DEV.username, 'first activation adopts the family org');
  assert.equal(state.get(MIGRATED_KEY), true);
  assert.deepEqual(first.fired.map((o) => o?.username), [DEV.username]);
  first.picker.dispose();

  // A sibling plugin moves the family org while sync stays off.
  settings.set(SHARED_KEY, QA.username);
  const second = makePicker(state);
  await second.picker.autoSelectDefault();
  assert.equal(state.get(PRIVATE_KEY), DEV.username, 'the migration must not run twice');
  assert.deepEqual(second.fired.map((o) => o?.username), [DEV.username]);
  second.picker.dispose();
});

test('the migration flag is stamped even with no family org, and startup never seeds it', async () => {
  const state = memento();

  const first = makePicker(state);
  await first.picker.autoSelectDefault();
  // Fallback to the CLI default org, kept strictly to ourselves.
  assert.equal(state.get(PRIVATE_KEY), DEV.username);
  assert.equal(state.get(MIGRATED_KEY), true);
  assert.equal(settings.has(SHARED_KEY), false, 'the removed reseed must stay removed');
  first.picker.dispose();

  // A sibling sets the family org later: with sync off and the flag stamped,
  // the next activation must stay on our own org.
  settings.set(SHARED_KEY, QA.username);
  const second = makePicker(state);
  await second.picker.autoSelectDefault();
  assert.equal(state.get(PRIVATE_KEY), DEV.username);
  assert.deepEqual(second.fired.map((o) => o?.username), [DEV.username]);
  second.picker.dispose();
});

test('sync on at startup adopts a family org that moved on', async () => {
  settings.set(SYNC_KEY, true);
  settings.set(SHARED_KEY, QA.username);
  const state = memento({ [PRIVATE_KEY]: DEV.username, [MIGRATED_KEY]: true });

  const { picker, fired } = makePicker(state);
  await picker.autoSelectDefault();

  assert.equal(state.get(PRIVATE_KEY), QA.username);
  assert.deepEqual(fired.map((o) => o?.username), [QA.username]);
  picker.dispose();
});
