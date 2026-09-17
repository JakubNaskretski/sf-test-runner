/**
 * Paints the coverage snapshot onto the editor: whole-line tint, gutter bar and
 * overview-ruler mark for every covered and uncovered line of the class in
 * front of the user.
 *
 * Revived from 0.6.0 (`git show 9d2e590:src/ui/coverageDecorator.ts`) with three
 * changes that the 0.9.0 rework asked for:
 *  - the cache is gone. `PanelState.coverage` is the only truth, so what is
 *    painted is always this plugin's own run or an explicit per-class org load —
 *    never a stale leftover from an earlier one.
 *  - every decorated line carries a hover naming the provenance (which run, which
 *    org, when), because coverage that does not say where it came from is exactly
 *    the complaint that started the rework.
 *  - editing a painted file switches it to a dimmed variant that says so. Line
 *    numbers shift on an edit and coverage cannot follow them; dimming is honest,
 *    silently repainting the old line numbers would not be.
 */
import * as vscode from 'vscode';
import { CoverageInfo, CoverageSnapshot } from '../types';
import { indexByClassName } from './coverageRows';
import { PanelState } from './panelState';

/** Resolves a class (or trigger) name to the file that holds it. */
export type ApexFileResolve = (className: string, isTrigger?: boolean) => Promise<vscode.Uri | undefined>;

const COVERED_RGB = '46, 160, 67';
const UNCOVERED_RGB = '248, 81, 73';

/** Which pair of decoration types a document is currently painted with. */
type PaintMode = 'fresh' | 'stale';

interface TypePair {
  covered: vscode.TextEditorDecorationType;
  uncovered: vscode.TextEditorDecorationType;
}

export class CoverageDecorator implements vscode.Disposable {
  private readonly fresh: TypePair;
  private readonly stale: TypePair;
  private readonly disposables: vscode.Disposable[] = [];

  /** Documents edited since the current snapshot was taken, by `uri.toString()`. */
  private readonly edited = new Set<string>();
  /** What each document is painted with right now, so a repaint that stays in
   *  the same mode costs the promised two `setDecorations` calls and only a
   *  fresh⇄stale transition pays for clearing the other pair. */
  private readonly mode = new Map<string, PaintMode>();

  /** Lookup built once per snapshot rather than once per visible editor. */
  private lookup = new Map<string, CoverageInfo>();
  private snapshotAt: number | undefined;

  constructor(
    private readonly state: PanelState,
    /** Unused here — painting matches on the open document's own basename, so
     *  nothing has to be searched for. Part of the constructor signature the
     *  status bar and the view share. */
    _resolve: ApexFileResolve,
  ) {
    this.fresh = {
      covered: lineType(COVERED_RGB, 0.12, 0.8, 1),
      uncovered: lineType(UNCOVERED_RGB, 0.12, 0.8, 1),
    };
    this.stale = {
      covered: lineType(COVERED_RGB, 0.05, 0.3, 0.4),
      uncovered: lineType(UNCOVERED_RGB, 0.05, 0.3, 0.4),
    };

    this.disposables.push(
      this.state.onDidChange((change) => {
        if (change !== 'coverage' && change !== 'prefs') return;
        this.syncSnapshot();
        this.repaintAll();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.repaintAll()),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.applyTo(editor)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onEdit(event)),
    );

    this.syncSnapshot();
    this.repaintAll();
  }

  /** Rebuild the per-snapshot lookup; a *new* snapshot also un-stales every
   *  document, since the fresh run measured the text as it is now. */
  private syncSnapshot(): void {
    const snapshot = this.state.coverage;
    if (snapshot?.at !== this.snapshotAt) {
      this.snapshotAt = snapshot?.at;
      this.edited.clear();
    }
    this.lookup = snapshot ? indexByClassName(snapshot.infos) : new Map();
  }

  private onEdit(event: vscode.TextDocumentChangeEvent): void {
    // Save-only / metadata events carry no edits and must not dim anything.
    if (event.contentChanges.length === 0) return;
    const snapshot = this.state.coverage;
    if (!snapshot) return;
    const key = event.document.uri.toString();
    if (this.edited.has(key)) return;
    // Only an edit made after the run can invalidate that run's line numbers.
    if (Date.now() < snapshot.at) return;
    const className = classNameFromUri(event.document.uri);
    if (!className || !this.lookup.has(className.toLowerCase())) return;
    this.edited.add(key);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) this.applyTo(editor);
    }
  }

  private repaintAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.applyTo(editor);
  }

  private applyTo(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const uri = editor.document.uri;
    // Diffs, git: revisions and untitled buffers get no coverage — the class
    // they show is not the one the run measured.
    if (uri.scheme !== 'file') return;
    const className = classNameFromUri(uri);
    if (!className) return;

    const snapshot = this.state.coverage;
    const info = this.state.paintCoverage && snapshot
      ? this.lookup.get(className.toLowerCase())
      : undefined;
    const key = uri.toString();

    if (!info || !snapshot) {
      this.clearEditor(editor, key);
      return;
    }

    const stale = this.edited.has(key);
    const pair = stale ? this.stale : this.fresh;
    const covered = hover(snapshot, true, stale);
    const uncovered = hover(snapshot, false, stale);

    const previous = this.mode.get(key);
    const next: PaintMode = stale ? 'stale' : 'fresh';
    if (previous && previous !== next) {
      const old = previous === 'stale' ? this.stale : this.fresh;
      editor.setDecorations(old.covered, []);
      editor.setDecorations(old.uncovered, []);
    }

    editor.setDecorations(pair.covered, info.coveredLines.map((line) => decorate(line, covered)));
    editor.setDecorations(
      pair.uncovered,
      info.uncoveredLines.map((line) => decorate(line, uncovered)),
    );
    this.mode.set(key, next);
  }

  private clearEditor(editor: vscode.TextEditor, key: string): void {
    if (!this.mode.has(key)) return;
    for (const pair of [this.fresh, this.stale]) {
      editor.setDecorations(pair.covered, []);
      editor.setDecorations(pair.uncovered, []);
    }
    this.mode.delete(key);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const pair of [this.fresh, this.stale]) {
      pair.covered.dispose();
      pair.uncovered.dispose();
    }
    this.edited.clear();
    this.mode.clear();
    this.lookup.clear();
  }
}

/** The class (or trigger) a file holds, by basename. Null for anything else. */
export function classNameFromUri(uri: vscode.Uri): string | null {
  const match = uri.fsPath.match(/([^/\\]+)\.(?:cls|trigger)$/i);
  return match ? match[1] : null;
}

function lineType(
  rgb: string,
  background: number,
  ruler: number,
  gutter: number,
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    backgroundColor: `rgba(${rgb}, ${background})`,
    overviewRulerColor: `rgba(${rgb}, ${ruler})`,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: gutterIcon(rgb, gutter),
    gutterIconSize: 'contain',
    isWholeLine: true,
  });
}

function gutterIcon(rgb: string, opacity: number): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="20">` +
    `<rect width="4" height="20" fill="rgb(${rgb})" fill-opacity="${opacity}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

/**
 * The provenance hover. Built with `appendText` so a run label or org username
 * carrying markdown characters renders as the text it is.
 */
function hover(snapshot: CoverageSnapshot, covered: boolean, stale: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendText(`${covered ? 'Covered' : 'Not covered'} — ${snapshot.label}`);
  md.appendText(` · ${snapshot.orgUsername} · ${timeOf(snapshot.at)}`);
  if (stale) md.appendText('\n\nedited since this run — re-run for fresh coverage');
  return md;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Salesforce line numbers are 1-based; editor lines are 0-based. */
function decorate(line: number, hoverMessage: vscode.MarkdownString): vscode.DecorationOptions {
  const zeroBased = Math.max(0, Math.floor(line) - 1);
  return {
    range: new vscode.Range(zeroBased, 0, zeroBased, Number.MAX_SAFE_INTEGER),
    hoverMessage,
  };
}
