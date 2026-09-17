/**
 * The Tests view provider — org toolbar, tabs, filters, the checkbox tree, the
 * actions bar and the progress line (see `webview/tests.ts` for the rendering).
 *
 * The provider owns nothing: selection and preferences are written straight into
 * `PanelState`, every other message is handed to the `TestsActions` the
 * extension supplies. That is what lets the view be collapsed, hidden or
 * reloaded without losing anything.
 *
 * Nothing that arrives from the webview is trusted. Each message is matched
 * against `TESTS_MESSAGE_SHAPES` with the kit's `validateMessage`, the closed
 * sets get their own guards (`isRunScope`), and the identifiers that end up in
 * the persisted selection — and from there in a `--tests` CLI selector — must
 * look like Apex names. An org username is only accepted when it is one the
 * store already listed, so no value invented by the view can reach `sf
 * --target-org`.
 */
import * as vscode from 'vscode';
import { validateMessage } from '../kit/webviewHtml';
import {
  isRunScope,
  MessageShape,
  RunScope,
  TESTS_MESSAGE_SHAPES,
  TestsHostMessage,
  TestsViewMessage,
} from '../webview/protocol';
import { PanelState } from './panelState';
import { getNonce, getViewHtml } from './viewHtml';

/** Everything the view can ask the extension to do. Selection and prefs are not
 *  here: those go straight into the store. */
export interface TestsActions {
  run(scope: RunScope): void;
  cancel(): void;
  rescan(): void;
  fetchOrg(): void;
  selectOrg(username: string): void;
  refreshOrgs(): void;
  login(): void;
  testsForActiveFile(): void;
  open(name: string, method?: string): void;
  loadRecent(): void;
}

/** State posts are coalesced: a rescan or a run can fire the store's event many
 *  times in a tick, and each post re-renders the whole tree. */
const POST_COALESCE_MS = 30;

/** Apex identifiers, generously bounded. Guards the selection keys and class
 *  names that reach the memento and the CLI. */
const APEX_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

function isApexName(value: string): boolean {
  return APEX_IDENT.test(value);
}

/** `Cls` or `Cls.method` — the selection-key convention from protocol.ts. */
function isSelectionKey(value: string): boolean {
  const dot = value.indexOf('.');
  if (dot === -1) return isApexName(value);
  return isApexName(value.slice(0, dot)) && isApexName(value.slice(dot + 1));
}

export class TestsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sfTestRunner.tests';

  /**
   * Pass as the third argument of `registerWebviewViewProvider`. Retaining the
   * context keeps the tree's scroll position and the open dropdown across a
   * collapse; the view still mirrors its local state into `setState` because a
   * window reload drops the retained context anyway.
   */
  static readonly registerOptions: { webviewOptions: { retainContextWhenHidden: boolean } } = {
    webviewOptions: { retainContextWhenHidden: true },
  };

  private view: vscode.WebviewView | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly deps: {
      state: PanelState;
      extensionUri: vscode.Uri;
      actions: TestsActions;
    },
  ) {
    this.disposables.push(
      // 'coverage' is the only slice `toTestsViewState` does not read.
      deps.state.onDidChange((change) => {
        if (change !== 'coverage') this.schedulePost();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist')],
    };
    // Fresh nonce per resolve — a reused one would let injected markup satisfy
    // the script-src policy.
    view.webview.html = getViewHtml(view.webview, this.deps.extensionUri, 'tests', getNonce());

    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)),
      view.onDidChangeVisibility(() => {
        // Nothing is posted while hidden, so the view is stale on the way back.
        if (view.visible) this.postNow();
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.clearTimer();
        }
      }),
    );
  }

  /** Bring the view forward without stealing focus. A view that was never
   *  resolved (container closed, or never opened this session) has nothing to
   *  show yet — the contributed `.focus` command opens it. */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }
    void vscode.commands.executeCommand(`${TestsViewProvider.viewId}.focus`);
  }

  // ───────────────────────────── host → view ─────────────────────────────

  private schedulePost(): void {
    if (!this.view || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.postNow();
    }, POST_COALESCE_MS);
  }

  private postNow(): void {
    this.clearTimer();
    const view = this.view;
    if (!view) return;
    const message: TestsHostMessage = {
      type: 'tests:state',
      state: this.deps.state.toTestsViewState(),
    };
    void view.webview.postMessage(message);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ───────────────────────────── view → host ─────────────────────────────

  private onMessage(raw: unknown): void {
    const type =
      typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
    const shape =
      typeof type === 'string'
        ? (TESTS_MESSAGE_SHAPES as Record<string, MessageShape | undefined>)[type]
        : undefined;
    if (!shape || !validateMessage<TestsViewMessage>(shape, raw)) {
      this.reject(type);
      return;
    }

    const msg = raw as TestsViewMessage;
    const { actions, state } = this.deps;
    switch (msg.type) {
      case 'tests:ready':
        this.postNow();
        return;
      case 'tests:toggleMethod':
        if (!isSelectionKey(msg.key)) {
          this.reject(msg.type);
          return;
        }
        state.toggleMethod(msg.key);
        return;
      case 'tests:setClass':
        if (!isApexName(msg.name)) {
          this.reject(msg.type);
          return;
        }
        state.setClassSelected(msg.name, msg.on);
        return;
      case 'tests:clearSelection':
        state.clearSelection();
        return;
      case 'tests:setRunWithCoverage':
        void state.setRunWithCoverage(msg.on);
        return;
      case 'tests:run':
        if (!isRunScope(msg.scope)) {
          this.reject(msg.type);
          return;
        }
        actions.run(msg.scope);
        return;
      case 'tests:cancel':
        actions.cancel();
        return;
      case 'tests:rescan':
        actions.rescan();
        return;
      case 'tests:fetchOrg':
        actions.fetchOrg();
        return;
      case 'tests:selectOrg':
        if (!this.isKnownOrg(msg.username)) {
          this.reject(msg.type);
          return;
        }
        actions.selectOrg(msg.username);
        return;
      case 'tests:refreshOrgs':
        actions.refreshOrgs();
        return;
      case 'tests:login':
        actions.login();
        return;
      case 'tests:activeFile':
        actions.testsForActiveFile();
        return;
      case 'tests:open':
        if (!isApexName(msg.name) || (msg.method !== undefined && !isApexName(msg.method))) {
          this.reject(msg.type);
          return;
        }
        actions.open(msg.name, msg.method);
        return;
      case 'tests:loadRecent':
        actions.loadRecent();
        return;
    }
  }

  /** The `<select>` is fed from the store, so a legitimate choice is always one
   *  of these. Anything else would be a username the view made up. */
  private isKnownOrg(username: string): boolean {
    const { state } = this.deps;
    return state.org?.username === username || state.orgs.some((o) => o.username === username);
  }

  /** Once per provider: a view that posts junk must not be able to flood the
   *  developer console. */
  private reject(type: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const label = typeof type === 'string' ? type.slice(0, 40) : 'unknown';
    console.warn(
      `[sf-test-runner] Tests view sent a message that failed validation (${label}); ignored. Further ones are dropped silently.`,
    );
  }

  // ─────────────────────────────── disposal ──────────────────────────────

  private disposeView(): void {
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
  }

  dispose(): void {
    this.clearTimer();
    this.disposeView();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }
}
