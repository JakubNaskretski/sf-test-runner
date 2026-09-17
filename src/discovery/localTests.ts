/**
 * The workspace half of the test index: which `.cls` files on disk declare Apex
 * tests, and which methods are in them.
 *
 * Lifted out of 0.8.0's `ui/testController.ts` unchanged in behaviour — the
 * lazy memoised first scan, the batched reads, the watcher, and above all the
 * duplicate-class-name ownership rules, which are the part that is easy to get
 * subtly wrong. What changed is the output: instead of pushing `TestItem`s into
 * a `TestController`, the scanner keeps plain `TestClassEntry` records and fires
 * `onDidChange` with the whole list, so the panel (and anything else) can render
 * them however it likes.
 *
 * Entries always carry `source: 'local-only'`; `buildIndex` in `testIndex.ts`
 * decides the real source once it knows what the org reported.
 */
import * as vscode from 'vscode';
import { findClassDecl, findTestMethods, hasApexTests } from '../salesforce/testMethods';
import { TestClassEntry } from '../types';

const APEX_GLOB = '**/*.cls';
const EXCLUDE_GLOB = '**/node_modules/**';
/** One `readFile` per class with no ceiling means thousands of concurrent reads
 *  and the whole class corpus resident at once. */
const BATCH = 50;

export class LocalTestScanner implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TestClassEntry[]>();
  readonly onDidChange = this.emitter.event;

  /** Class name (which doubles as the entry id) → the entry we discovered. */
  private readonly classes = new Map<string, TestClassEntry>();
  /** File uri → the class name found in it, so a rename drops the old entry. */
  private readonly classIdByUri = new Map<string, string>();
  /** Class name → the uri that currently owns it, for the duplicate case. */
  private readonly ownerByClassId = new Map<string, string>();

  /** Every `.cls` basename the last full scan walked — test class or NOT. The
   *  coverage table asks which measured classes have a file on disk, and the
   *  classes a run measures are the ones UNDER test, so the entries above (test
   *  classes only) can never answer that. */
  private apexClassNames: string[] = [];

  /** The first full scan, memoised: every caller awaits the same promise. */
  private discovery: Promise<TestClassEntry[]> | undefined;
  /** While a full scan runs, per-file changes are coalesced into one event. */
  private scanning = false;

  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly output: vscode.OutputChannel) {
    const watcher = vscode.workspace.createFileSystemWatcher(APEX_GLOB);
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => void this.parseFile(uri)),
      watcher.onDidChange((uri) => void this.parseFile(uri)),
      watcher.onDidDelete((uri) => this.applyChange(this.forgetFile(uri))),
      // The file in front of the user is the one whose entry matters most, and
      // parsing it is cheap — it keeps the panel honest about the file being
      // edited without waiting for a save or a rescan.
      vscode.workspace.onDidOpenTextDocument((doc) => this.parseDocument(doc)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.parseDocument(doc)),
    );
    for (const editor of vscode.window.visibleTextEditors) this.parseDocument(editor.document);
  }

  /** Everything discovered so far, by name. Never blocks. */
  current(): TestClassEntry[] {
    return [...this.classes.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every Apex class the workspace holds a `.cls` for, from the last full scan
   *  — not just the test ones. Empty until a scan has run, which the coverage
   *  table reads as "not known yet" rather than "no local source". */
  localClassNames(): string[] {
    return [...this.apexClassNames];
  }

  /**
   * The first scan, or the one already in flight. Nothing is scanned until
   * something asks: a large SFDX repo has thousands of `.cls` files and reading
   * them all on activation would be a startup tax nobody asked for.
   */
  ensureDiscovered(): Promise<TestClassEntry[]> {
    return (this.discovery ??= this.discoverAll().catch((err) => {
      // Memoising a REJECTED scan would leave the panel permanently empty after
      // one transient failure; forget it so the next ask retries.
      this.discovery = undefined;
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Test discovery failed: ${message}`);
      return this.current();
    }));
  }

  /** Throw away the memoised scan and walk the workspace again. */
  rescan(): Promise<TestClassEntry[]> {
    this.discovery = undefined;
    return this.ensureDiscovered();
  }

  private async discoverAll(): Promise<TestClassEntry[]> {
    this.scanning = true;
    try {
      const files = await vscode.workspace.findFiles(APEX_GLOB, EXCLUDE_GLOB);
      this.apexClassNames = files
        .map((uri) => classNameOfUri(uri))
        .filter((name): name is string => name !== null);
      for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map((uri) => this.parseFile(uri)));
      }
      // Drop entries for files this scan no longer finds — a delete the watcher
      // missed during a bulk checkout, say. Files opened from outside every
      // workspace folder were never in `files` and are left alone.
      const seen = new Set(files.map((f) => f.toString()));
      for (const uriString of [...this.classIdByUri.keys()]) {
        if (seen.has(uriString)) continue;
        const uri = vscode.Uri.parse(uriString);
        if (vscode.workspace.getWorkspaceFolder(uri)) this.forgetFile(uri);
      }
    } finally {
      this.scanning = false;
    }
    // One event for the whole scan, however many files moved inside it.
    const entries = this.current();
    this.emitter.fire(entries);
    return entries;
  }

  private async parseFile(uri: vscode.Uri): Promise<void> {
    let changed: boolean;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      changed = this.upsertFromSource(uri, Buffer.from(bytes).toString('utf8'));
    } catch {
      // Unreadable, or deleted between the watcher event and the read.
      changed = this.forgetFile(uri);
    }
    this.applyChange(changed);
  }

  private parseDocument(doc: vscode.TextDocument): void {
    // `onDidOpenTextDocument` also fires for git diffs and other virtual
    // documents; an entry pointing at one of those is unrunnable noise.
    if (doc.uri.scheme !== 'file') return;
    if (!doc.fileName.toLowerCase().endsWith('.cls')) return;
    this.applyChange(this.upsertFromSource(doc.uri, doc.getText()));
  }

  /** Rebuild the entry for one file, or drop it when the file no longer
   *  declares any tests. Returns true when the set of entries changed. */
  private upsertFromSource(uri: vscode.Uri, text: string): boolean {
    if (!hasApexTests(text)) return this.forgetFile(uri);

    const lines = text.split(/\r?\n/);
    const cls = findClassDecl(lines);
    const methods = cls ? findTestMethods(lines, cls.className) : [];
    // `@IsTest` alone is not a test class: every SFDX repo has annotated helpers
    // (TestDataFactory, HttpCalloutMock implementations) with no test methods in
    // them, and offering a run button that can only fail is worse than not
    // listing them. The cost is that a test class whose methods the heuristic
    // misses entirely stays out of the list.
    if (!cls || methods.length === 0) return this.forgetFile(uri);

    const key = uri.toString();
    const previousId = this.classIdByUri.get(key);
    // Same ownership rule as forgetFile: only drop the old entry if THIS file is
    // the one that put it there, or renaming one of two files that declare the
    // same class name would delete the other's entry.
    let changed = false;
    if (previousId && previousId !== cls.className && this.ownerByClassId.get(previousId) === key) {
      this.classes.delete(previousId);
      this.ownerByClassId.delete(previousId);
      changed = true;
    }

    const entry: TestClassEntry = {
      name: cls.className,
      source: 'local-only',
      uri: key,
      classLine: cls.classLine,
      methods: methods.map((m) => ({ name: m.methodName, line: m.line })),
    };
    const previous = this.classes.get(cls.className);
    if (!previous || !sameEntry(previous, entry)) changed = true;
    this.classes.set(cls.className, entry);
    this.classIdByUri.set(key, cls.className);
    this.ownerByClassId.set(cls.className, key);
    return changed;
  }

  private forgetFile(uri: vscode.Uri): boolean {
    const key = uri.toString();
    const id = this.classIdByUri.get(key);
    if (!id) return false;
    this.classIdByUri.delete(key);
    // Two files can declare the same class name (a retrieved copy beside
    // force-app, or a second package directory). Only the file that currently
    // owns the entry may remove it, or editing the copy makes the real one vanish.
    if (this.ownerByClassId.get(id) !== key) return false;
    this.classes.delete(id);
    this.ownerByClassId.delete(id);
    return true;
  }

  /** Fire for a single-file change — a full scan fires once at its end instead. */
  private applyChange(changed: boolean): void {
    if (!changed || this.scanning) return;
    this.emitter.fire(this.current());
  }

  dispose(): void {
    for (const disposable of this.subscriptions) disposable.dispose();
    this.subscriptions.length = 0;
    this.emitter.dispose();
  }
}

/** The class a `.cls` file declares, by basename — the same rule the coverage
 *  decorator uses to match an open editor to a measured class. */
function classNameOfUri(uri: vscode.Uri): string | null {
  const match = uri.fsPath.match(/([^/\\]+)\.cls$/i);
  return match ? match[1] : null;
}

function sameEntry(a: TestClassEntry, b: TestClassEntry): boolean {
  return (
    a.name === b.name &&
    a.uri === b.uri &&
    a.classLine === b.classLine &&
    a.methods.length === b.methods.length &&
    a.methods.every((m, i) => m.name === b.methods[i].name && m.line === b.methods[i].line)
  );
}
