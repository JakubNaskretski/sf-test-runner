import * as vscode from 'vscode';
import { CoverageInfo } from '../types';

export class CoverageDecorator implements vscode.Disposable {
  private readonly coveredType: vscode.TextEditorDecorationType;
  private readonly uncoveredType: vscode.TextEditorDecorationType;
  private readonly cache = new Map<string, CoverageInfo>();

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
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyTo(editor);
    }
  }

  applyTo(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const className = classNameFromUri(editor.document.uri);
    if (!className) return;
    const info = this.cache.get(className.toLowerCase());
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
  }

  has(className: string): boolean {
    return this.cache.has(className.toLowerCase());
  }

  dispose(): void {
    this.coveredType.dispose();
    this.uncoveredType.dispose();
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
