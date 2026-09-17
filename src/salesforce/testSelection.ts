/**
 * Which `--tests` selectors a set of selected test items turns into.
 *
 * Kept free of the `vscode` namespace (a `TestItem` matches `SelectableTest`
 * structurally) so the rule that decides what actually runs against a live org
 * can be unit tested.
 */

export interface SelectableTest {
  /** Doubles as the CLI selector: `MyClassTest` or `MyClassTest.testThing`. */
  readonly id: string;
  readonly parent?: SelectableTest;
}

/**
 * Every selected item whose parent is not itself selected. Selecting a whole
 * class collapses to `MyClassTest` instead of listing each of its methods, so the
 * CLI runs the class once; selecting individual methods keeps them individual.
 */
export function selectorsFor(items: readonly SelectableTest[]): string[] {
  const selected = new Set(items.map((item) => item.id));
  const out = new Set<string>();
  for (const item of items) {
    if (item.parent && selected.has(item.parent.id)) continue;
    out.add(item.id);
  }
  return [...out];
}
