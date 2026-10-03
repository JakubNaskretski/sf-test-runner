/**
 * How many distinct classes and how many selected keys a Tests-view
 * selection represents — "classes" counts a class once no matter how many
 * of its methods (or its one bare whole-class key, when the org never
 * classified them) are ticked; "methods" is simply the number of ticked
 * keys, the same number the view already showed before this split (a bare
 * class key still counts as one).
 *
 * No `vscode` import, and no dependency on the index: the class name is the
 * part of each key before its first `.`, which is all the key convention
 * (see `ui/selection.ts`) ever needs to say which class a key belongs to.
 * Kept dependency-free so the webview bundle (browser, no `vscode`) can
 * import it directly.
 */
export function selectionCounts(selection: readonly string[]): { classes: number; methods: number } {
  const classNames = new Set<string>();
  for (const key of selection) {
    const dot = key.indexOf('.');
    classNames.add(dot === -1 ? key : key.slice(0, dot));
  }
  return { classes: classNames.size, methods: selection.length };
}

/** "1 class · 7 methods" — the compact form for a tab label's parens. */
export function selectionCountsText(selection: readonly string[]): string {
  const { classes, methods } = selectionCounts(selection);
  return (
    `${classes} ${classes === 1 ? 'class' : 'classes'} · ` +
    `${methods} ${methods === 1 ? 'method' : 'methods'}`
  );
}

/** "1 class · 7 methods selected" — the full sentence for the action bar. */
export function selectedSummary(selection: readonly string[]): string {
  return `${selectionCountsText(selection)} selected`;
}
