/**
 * The Results view (`sfTestRunner.results`) — the webview that reads the run
 * held in {@link PanelState} and renders it as the run bar + class→method tree
 * from the approved mock.
 *
 * The provider owns no state of its own: it serialises `state.toResultsViewState()`
 * on every `run` change (which is also the slice that carries the results filter
 * and the expand/collapse nonces), and everything the view asks for is forwarded
 * to {@link ResultsActions} — the only exception is the filter, which is stored
 * back into the panel state so a collapsed or reloaded view keeps it.
 *
 * Messages from the webview are untrusted: each one is matched against its
 * `RESULTS_MESSAGE_SHAPES` entry, the filter against `isResultsFilter`, and the
 * class/method names against `\w+` before they reach an action that opens a file.
 * A test result's class name comes from the org's CLI output, so a name that
 * could escape into a glob or a path is dropped rather than resolved.
 */
import * as vscode from 'vscode';
import { validateMessage } from '../kit/webviewHtml';
import {
  RESULTS_MESSAGE_SHAPES,
  ResultsHostMessage,
  ResultsViewMessage,
  isResultsFilter,
} from '../webview/protocol';
import { PanelState } from './panelState';
import { getNonce, getViewHtml } from './viewHtml';

/** What the view can ask the extension host to do. Wiring lives in extension.ts. */
export interface ResultsActions {
  /** Open a class/trigger source file, optionally revealing a method or line. */
  open(className: string, method?: string, line?: number, isTrigger?: boolean): void;
  rerunFailed(): void;
  copySummary(): void;
  loadRecent(): void;
}

export interface ResultsViewDeps {
  state: PanelState;
  extensionUri: vscode.Uri;
  actions: ResultsActions;
}

/** A run can report many methods at once; one post per state change would make
 *  the view re-render per method. 30 ms is under a frame, so it still looks live. */
const POST_COALESCE_MS = 30;

/** Apex identifiers are `\w+`. Anything else never reaches a file lookup. */
const NAME_RE = /^\w+$/;

export class ResultsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sfTestRunner.results';

  /** Pass to `registerWebviewViewProvider`: the view keeps its DOM (and so its
   *  scroll position and open failures) while collapsed or hidden. */
  static readonly registerOptions: { webviewOptions: { retainContextWhenHidden: boolean } } = {
    webviewOptions: { retainContextWhenHidden: true },
  };

  private view: vscode.WebviewView | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: ResultsViewDeps) {
    this.disposables.push(
      deps.state.onDidChange((change) => {
        // 'run' also fires for the filter and the expand/collapse nonces — see
        // PanelState.setResultsFilter / expandResults / collapseResults.
        if (change === 'run') this.schedulePost();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist')],
    };
    view.webview.html = getViewHtml(view.webview, this.deps.extensionUri, 'results', getNonce());

    const subscriptions: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      view.onDidChangeVisibility(() => {
        // Hidden views are not posted to; catch them up the moment they return.
        if (view.visible) this.schedulePost();
      }),
    ];
    view.onDidDispose(() => {
      for (const d of subscriptions) d.dispose();
      if (this.view === view) this.view = undefined;
      this.cancelPost();
    });
  }

  /** Bring the view into focus — used after a run finishes. */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }
    void vscode.commands.executeCommand(`${ResultsViewProvider.viewId}.focus`);
  }

  // ──────────────────────────── view → host ────────────────────────────

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== 'string') return;
    const shape = RESULTS_MESSAGE_SHAPES[type as ResultsViewMessage['type']];
    if (!shape) return;
    if (!validateMessage<ResultsViewMessage>(shape, raw)) return;
    const message = raw as ResultsViewMessage;

    switch (message.type) {
      case 'results:ready':
        this.postNow();
        return;
      case 'results:setFilter':
        if (!isResultsFilter(message.filter)) return;
        this.deps.state.setResultsFilter(message.filter);
        return;
      case 'results:open': {
        if (!NAME_RE.test(message.className)) return;
        if (message.method !== undefined && !NAME_RE.test(message.method)) return;
        const { line } = message;
        if (line !== undefined && (!Number.isInteger(line) || line < 1)) return;
        this.deps.actions.open(message.className, message.method, line, message.isTrigger === true);
        return;
      }
      case 'results:rerunFailed':
        this.deps.actions.rerunFailed();
        return;
      case 'results:copySummary':
        this.deps.actions.copySummary();
        return;
      case 'results:loadRecent':
        this.deps.actions.loadRecent();
        return;
    }
  }

  // ──────────────────────────── host → view ────────────────────────────

  private schedulePost(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.postNow();
    }, POST_COALESCE_MS);
  }

  private cancelPost(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private postNow(): void {
    this.cancelPost();
    const view = this.view;
    if (!view || !view.visible) return;
    const message: ResultsHostMessage = {
      type: 'results:state',
      state: this.deps.state.toResultsViewState(),
    };
    void view.webview.postMessage(message);
  }

  dispose(): void {
    this.cancelPost();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
