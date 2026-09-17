/**
 * The Coverage webview view: overall bar with the 75% deploy floor marked, and
 * the worst-first table of classes.
 *
 * The provider owns no state. It serialises `PanelState` through
 * `toCoverageViewState()` and hands every inbound message to the `CoverageActions`
 * extension.ts supplies — so a collapsed or reloaded view loses nothing, and
 * the privileged work (opening files, running CLI commands) stays out of here.
 */
import * as vscode from 'vscode';
import { validateMessage } from '../kit/webviewHtml';
import { COVERAGE_MESSAGE_SHAPES, CoverageViewMessage } from '../webview/protocol';
import { getNonce, getViewHtml } from './viewHtml';
import { PanelState } from './panelState';

/** What the view is allowed to ask the host to do. */
export interface CoverageActions {
  /** Open the class's local file (and paint it). */
  open(className: string): void;
  /** Turn editor painting on or off. */
  setPaint(on: boolean): void;
  /** Drop the snapshot — table and decorations both. */
  clear(): void;
  /** Explicit per-class load from `ApexCodeCoverageAggregate` (org's last run). */
  fromOrg(className: string): void;
}

export interface CoverageViewDeps {
  state: PanelState;
  extensionUri: vscode.Uri;
  actions: CoverageActions;
}

/**
 * An Apex class name as it may reach a privileged branch. The 0.8.0 security
 * review turned a CLI-supplied class name into a `findFiles` glob; the same rule
 * applies to anything a webview posts.
 */
const CLASS_NAME = /^\w+$/;

export class CoverageViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sfTestRunner.coverage';

  /** Pass to `registerWebviewViewProvider`: the panel keeps its DOM while the
   *  view is collapsed, which is what makes scroll position and filter survive. */
  static readonly registerOptions = {
    webviewOptions: { retainContextWhenHidden: true },
  } as const;

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Listeners bound to the *current* view. A view container can be closed and
   *  re-opened, which resolves the provider again; without this they would pile
   *  up and every state post would run N times. */
  private viewDisposables: vscode.Disposable[] = [];
  private postTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CoverageViewDeps) {
    this.disposables.push(
      this.deps.state.onDidChange((change) => {
        if (change === 'coverage' || change === 'prefs') this.schedulePost();
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
    // Fresh nonce per render, reused for this render pass only.
    view.webview.html = getViewHtml(view.webview, this.deps.extensionUri, 'coverage', getNonce());

    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((raw) => this.handle(raw)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.post();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.disposeView();
      }),
    );
  }

  /** Bring the Coverage view forward — used after a run finishes with coverage. */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }
    void vscode.commands.executeCommand(`${CoverageViewProvider.viewId}.focus`);
  }

  /** Several store events can land in one tick (a run writes coverage and
   *  prefs together); the view only ever needs the final state. */
  private schedulePost(): void {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.post();
    }, 0);
  }

  private post(): void {
    void this.view?.webview.postMessage({
      type: 'coverage:state',
      state: this.deps.state.toCoverageViewState(),
    });
  }

  /** Webview input is untrusted: shape-checked, then narrowed by hand for the
   *  values that reach an action. */
  private handle(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== 'string') return;
    const shape = COVERAGE_MESSAGE_SHAPES[type as CoverageViewMessage['type']];
    if (!shape) return;
    if (!validateMessage<CoverageViewMessage>(shape, raw)) return;
    const message = raw as CoverageViewMessage;

    switch (message.type) {
      case 'coverage:ready':
        this.post();
        return;
      case 'coverage:setPaint':
        this.deps.actions.setPaint(message.on);
        return;
      case 'coverage:clear':
        this.deps.actions.clear();
        return;
      case 'coverage:open':
        if (CLASS_NAME.test(message.className)) this.deps.actions.open(message.className);
        return;
      case 'coverage:fromOrg':
        if (CLASS_NAME.test(message.className)) this.deps.actions.fromOrg(message.className);
        return;
    }
  }

  private disposeView(): void {
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    this.view = undefined;
  }

  dispose(): void {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = undefined;
    this.disposeView();
    for (const d of this.disposables) d.dispose();
  }
}
