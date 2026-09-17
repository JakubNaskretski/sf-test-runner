/**
 * Name → file → editor, for every "click this and show me the source" path in
 * the panel: a failed test's stack frame, a results row, a coverage row, a
 * CodeLens jump.
 *
 * One resolver instance is shared by the views so the workspace glob for a class
 * is paid once per session. Only HITS are cached: a miss can become a hit when
 * the class is retrieved from the org later in the same window.
 */
import * as vscode from 'vscode';
import { findClassDecl, findTestMethods } from '../salesforce/testMethods';

export interface OpenApexOptions {
  /** Jump to this method's declaration. Ignored when `line` is given. */
  method?: string;
  /** 1-based source line, as Apex stack traces report it. */
  line?: number;
  /** Open a `.trigger` instead of a `.cls`. */
  isTrigger?: boolean;
}

export class ApexFileResolver {
  /** `cls:name` / `trigger:name` (lower-cased) → the file we found. */
  private readonly cache = new Map<string, vscode.Uri>();

  /**
   * Find the workspace file declaring `name`, or undefined when there is none
   * (a managed-package class, or one that only exists in the org).
   */
  async resolve(name: string, isTrigger = false): Promise<vscode.Uri | undefined> {
    // Names arrive from CLI output as well as from our own scan, and they are
    // spliced into a search glob. Apex identifiers are word characters only, so
    // anything else is neither a name we could match nor one we will glob with.
    if (!/^\w+$/.test(name)) return undefined;
    const ext = isTrigger ? 'trigger' : 'cls';
    const key = `${ext}:${name.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const matches = await vscode.workspace.findFiles(`**/${name}.${ext}`, '**/node_modules/**', 1);
    if (matches[0]) this.cache.set(key, matches[0]);
    return matches[0];
  }

  /**
   * Open the file and put the cursor on the interesting line: an explicit stack
   * line, else the named method's declaration, else the class declaration. A
   * name with no local file says so rather than failing silently — that is the
   * normal state for org-only and managed classes.
   */
  async open(name: string, opts: OpenApexOptions = {}): Promise<void> {
    const uri = await this.resolve(name, opts.isTrigger);
    if (!uri) {
      void vscode.window.showWarningMessage(
        `No local source for ${name}. It may exist only in the org or in a managed package.`,
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const line = targetLine(doc, opts);
    if (line === undefined) return;
    // Land on the first real character, not column 0 — the selection is what the
    // user sees blink, and the indentation is not it.
    const text = doc.lineAt(line).text;
    const column = Math.max(0, text.search(/\S/));
    const position = new vscode.Position(line, column);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  /** Forget resolved files — after a rescan, or when the workspace changed. */
  invalidate(): void {
    this.cache.clear();
  }
}

/** Zero-based line to reveal, or undefined to leave the cursor where it is. */
function targetLine(doc: vscode.TextDocument, opts: OpenApexOptions): number | undefined {
  const lastLine = Math.max(0, doc.lineCount - 1);
  if (typeof opts.line === 'number' && Number.isFinite(opts.line)) {
    // Stack traces are 1-based; a frame pointing past the end of an edited file
    // still opens it, at the last line.
    return Math.min(Math.max(0, Math.trunc(opts.line) - 1), lastLine);
  }

  const lines = doc.getText().split(/\r?\n/);
  const cls = findClassDecl(lines);
  if (opts.method && /^\w+$/.test(opts.method)) {
    const declared = findTestMethods(lines, cls?.className).find(
      (m) => m.methodName === opts.method,
    );
    if (declared) return Math.min(declared.line, lastLine);
    // The scanner is a heuristic and misses unconventional signatures; a plain
    // search for the call-shaped name is a good enough second try.
    const re = new RegExp(`\\b${opts.method}\\s*\\(`);
    const index = lines.findIndex((l) => re.test(l));
    if (index >= 0) return Math.min(index, lastLine);
  }
  return cls ? Math.min(cls.classLine, lastLine) : undefined;
}
