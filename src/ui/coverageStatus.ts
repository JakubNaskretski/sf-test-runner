/**
 * `$(eye) 58%` in the status bar for the class in front of the user, with the
 * same provenance the decorator's hover carries.
 *
 * Revived from the 0.6.0 status item, with the 0.9.0 rule applied: it appears
 * only when *this* plugin's snapshot actually measured the open class. No
 * snapshot, a file the run never touched, or a file that is not Apex ⇒ hidden,
 * rather than a cheerful percentage that belongs to something else.
 */
import * as vscode from 'vscode';
import { CoverageRow } from '../webview/protocol';
import { ApexFileResolve, classNameFromUri } from './coverageDecorator';
import { overallOf, rowsFor } from './coverageRows';
import { PanelState } from './panelState';

/** Registered by the integrator; the item is only the trigger. */
const TOGGLE_COMMAND = 'sfTestRunner.toggleCoveragePaint';

export class CoverageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  /** Rows built once per snapshot, keyed lowercase — the active editor changes
   *  far more often than the coverage does. */
  private rows = new Map<string, CoverageRow>();
  private overall: number | null = null;
  private snapshotAt: number | undefined;

  constructor(
    private readonly state: PanelState,
    /** Unused: the item follows the active editor, which already names its own
     *  file. Part of the shared coverage-surface signature. */
    _resolve: ApexFileResolve,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = TOGGLE_COMMAND;
    this.item.name = 'Apex Coverage';

    this.disposables.push(
      this.item,
      this.state.onDidChange((change) => {
        if (change !== 'coverage' && change !== 'prefs') return;
        this.syncSnapshot();
        this.render();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
    );

    this.syncSnapshot();
    this.render();
  }

  private syncSnapshot(): void {
    const snapshot = this.state.coverage;
    // `at` identifies the snapshot, so a settings change costs nothing.
    if (snapshot?.at === this.snapshotAt) return;
    this.snapshotAt = snapshot?.at;
    this.rows = new Map();
    this.overall = snapshot ? overallOf(snapshot.infos) : null;
    if (!snapshot) return;
    // Every measured class can be reported on; whether it has a local file is
    // the coverage table's concern, not this item's — the file is open.
    for (const row of rowsFor(snapshot.infos, () => true)) {
      this.rows.set(row.className.toLowerCase(), row);
    }
  }

  private render(): void {
    const snapshot = this.state.coverage;
    const editor = vscode.window.activeTextEditor;
    const className = editor ? classNameFromUri(editor.document.uri) : null;
    const row = className ? this.rows.get(className.toLowerCase()) : undefined;
    if (!snapshot || !row) {
      this.item.hide();
      return;
    }

    const painting = this.state.paintCoverage;
    this.item.text = `$(${painting ? 'eye' : 'eye-closed'}) ${row.pct}%`;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(`${row.className} — ${row.covered}/${row.total} lines covered (${row.pct}%)`);
    if (this.overall !== null) tooltip.appendText(` · ${this.overall}% overall`);
    tooltip.appendText(`\n\n${snapshot.label}`);
    tooltip.appendText(` · ${snapshot.orgUsername}`);
    tooltip.appendText(
      ` · ${new Date(snapshot.at).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    );
    tooltip.appendText(
      `\n\nClick to ${painting ? 'stop painting' : 'paint'} coverage in the editor.`,
    );
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.rows.clear();
  }
}
