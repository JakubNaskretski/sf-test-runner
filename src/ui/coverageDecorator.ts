import * as vscode from 'vscode';
import { CoverageInfo } from '../types';

export class CoverageDecorator implements vscode.Disposable {
  private readonly coveredType: vscode.TextEditorDecorationType;
  private readonly uncoveredType: vscode.TextEditorDecorationType;
  private readonly cache = new Map<string, CoverageInfo>();
  /** Painting can be switched off (the `showInlineCoverage` toggle) without
   *  dropping the cache, so switching back on repaints without re-querying. */
  private enabled = true;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever what the decorator would paint changes (data or enablement) —
   *  the status bar item keys off this. */
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.coveredType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(46, 160, 67, 0.12)',
      overviewRulerColor: 'rgba(46, 160, 67, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: this.makeGutterIcon('#2ea043'),
      gutterIconSize: 'contain',
      isWholeLine: true,
    });
    this.uncoveredType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(248, 81, 73, 0.12)',
      overviewRulerColor: 'rgba(248, 81, 73, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: this.makeGutterIcon('#f85149'),
      gutterIconSize: 'contain',
      isWholeLine: true,
    });
  }

  setCoverage(className: string, info: CoverageInfo): void {
    this.cache.set(className.toLowerCase(), info);
    this.repaintAll();
  }

  /** Bulk insert with a single repaint — a RunLocalTests run can cover hundreds
   *  of classes, and repainting every visible editor per class is O(n·m). */
  setCoverageMany(infos: Iterable<CoverageInfo>): void {
    for (const info of infos) {
      this.cache.set(info.className.toLowerCase(), info);
    }
    this.repaintAll();
  }

  /** Turn painting on/off without touching the cache; repaints (or wipes) all
   *  visible editors immediately. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.repaintAll();
  }

  private repaintAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyTo(editor);
    }
    this.changeEmitter.fire();
  }

  applyTo(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const className = classNameFromUri(editor.document.uri);
    if (!className) return;
    const info = this.enabled ? this.cache.get(className.toLowerCase()) : undefined;
    if (!info) {
      editor.setDecorations(this.coveredType, []);
      editor.setDecorations(this.uncoveredType, []);
      return;
    }
    editor.setDecorations(this.coveredType, info.coveredLines.map(toRange));
    editor.setDecorations(this.uncoveredType, info.uncoveredLines.map(toRange));
  }

  clear(className?: string): void {
    if (className) {
      this.cache.delete(className.toLowerCase());
    } else {
      this.cache.clear();
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.coveredType, []);
      editor.setDecorations(this.uncoveredType, []);
    }
    this.changeEmitter.fire();
  }

  has(className: string): boolean {
    return this.cache.has(className.toLowerCase());
  }

  get(className: string): CoverageInfo | undefined {
    return this.cache.get(className.toLowerCase());
  }

  dispose(): void {
    this.coveredType.dispose();
    this.uncoveredType.dispose();
    this.changeEmitter.dispose();
    this.cache.clear();
  }

  private makeGutterIcon(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="20"><rect width="4" height="20" fill="${color}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }
}

export function classNameFromUri(uri: vscode.Uri): string | null {
  const match = uri.fsPath.match(/([^/\\]+)\.cls$/i);
  return match ? match[1] : null;
}

function toRange(line: number): vscode.Range {
  const zeroBased = Math.max(0, line - 1);
  return new vscode.Range(zeroBased, 0, zeroBased, Number.MAX_SAFE_INTEGER);
}
