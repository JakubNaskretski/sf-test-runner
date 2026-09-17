/**
 * The panel's test selection: a flat set of keys over a `TestIndexSnapshot`.
 *
 * Key convention (also documented in webview/protocol.ts): `Cls.method` per
 * method, and a bare `Cls` only for a class whose methods are unknown
 * (org-only, `methodsUnknown`). Keeping one flat string set is what lets the
 * selection survive a webview reload as plain JSON.
 *
 * No `vscode` import — this is the piece that decides what actually runs against
 * a live org, so it stays unit-testable.
 */
import { TestClassEntry, TestIndexSnapshot } from '../types';
import { SelectableTest, selectorsFor } from '../salesforce/testSelection';

export type ClassState = 'none' | 'some' | 'all';

const EMPTY_INDEX: TestIndexSnapshot = { classes: [] };

/** Selection keys for a class: one per method, or the bare name when the org
 *  listed the class but we never classified its methods. */
export function keysForEntry(entry: TestClassEntry): string[] {
  if (entry.methodsUnknown && entry.methods.length === 0) return [entry.name];
  return entry.methods.map((m) => `${entry.name}.${m.name}`);
}

export class SelectionSet {
  private readonly keys = new Set<string>();
  private index: TestIndexSnapshot;

  constructor(index: TestIndexSnapshot = EMPTY_INDEX, keys: Iterable<string> = []) {
    this.index = index;
    for (const key of keys) this.keys.add(key);
  }

  count(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Sorted so persisted state and posted state are stable between renders. */
  toArray(): string[] {
    return [...this.keys].sort();
  }

  toggleMethod(key: string): void {
    if (!this.keys.delete(key)) this.keys.add(key);
  }

  setClass(name: string, on: boolean): void {
    for (const key of this.keysForClass(name)) {
      if (on) this.keys.add(key);
      else this.keys.delete(key);
    }
  }

  clear(): void {
    this.keys.clear();
  }

  keysForClass(name: string): string[] {
    const entry = this.index.classes.find((c) => c.name === name);
    return entry ? keysForEntry(entry) : [];
  }

  classState(name: string): ClassState {
    const keys = this.keysForClass(name);
    if (keys.length === 0) return 'none';
    let selected = 0;
    for (const key of keys) if (this.keys.has(key)) selected++;
    if (selected === 0) return 'none';
    return selected === keys.length ? 'all' : 'some';
  }

  /** Adopt a new index and drop keys it no longer knows about (a class deleted
   *  on disk, a method renamed, a stale key restored from workspaceState).
   *  Returns true when something was dropped. */
  prune(index: TestIndexSnapshot): boolean {
    this.index = index;
    const valid = new Set<string>();
    for (const entry of index.classes) for (const key of keysForEntry(entry)) valid.add(key);
    let dropped = false;
    for (const key of [...this.keys]) {
      if (!valid.has(key)) {
        this.keys.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  /**
   * The `--tests` selectors this selection turns into. A fully selected class
   * collapses to `Cls`; a partially selected one stays a list of `Cls.method`.
   * Keys the index does not know are ignored — `prune` is the only place a
   * stale key is allowed to matter.
   */
  toSelectors(index: TestIndexSnapshot = this.index): string[] {
    const items: SelectableTest[] = [];
    for (const entry of index.classes) {
      const keys = keysForEntry(entry);
      const selected = keys.filter((key) => this.keys.has(key));
      if (selected.length === 0) continue;
      // Methods unknown: the only key IS the class selector.
      if (keys.length === 1 && keys[0] === entry.name) {
        items.push({ id: entry.name });
        continue;
      }
      const classItem: SelectableTest = { id: entry.name };
      if (selected.length === keys.length) items.push(classItem);
      for (const key of selected) items.push({ id: key, parent: classItem });
    }
    return selectorsFor(items);
  }
}
