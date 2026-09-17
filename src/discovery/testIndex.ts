/**
 * The union of the two discovery halves.
 *
 * A class can be on disk, in the org, or both, and the panel's badges (`org-only`,
 * `not deployed`) and source filter are read straight off `source`. The rules:
 *
 *  - match by name, case-insensitively — Apex is case-insensitive, and a local
 *    `AcmeOrderTest.cls` must pair with an org row spelled `AcmeORDERTest`;
 *  - the LOCAL spelling wins, because that is the one the user sees in the
 *    editor and in a stack trace;
 *  - a class in both keeps the local uri, lines and methods (they can be opened)
 *    and gains the org's id and namespace;
 *  - an org row CLASSIFIED as a non-test is dropped — the fetcher keeps it so
 *    its cache is complete, but there is nothing to run in it;
 *  - a row the fetcher could not classify (no `Body` came back: `isTest: false`
 *    with `methodsUnknown`) is NOT a non-test, it is an unknown. It stays, and
 *    the panel offers it as a whole class — dropping it would hide a class the
 *    org really has.
 *
 * No `vscode` import: this is the shape the whole panel renders from, so it
 * stays a pure function over plain data.
 */
import { TestClassEntry, TestIndexSnapshot } from '../types';
import { OrgTestClasses } from './orgTests';

export function buildIndex(local: TestClassEntry[], org?: OrgTestClasses): TestIndexSnapshot {
  const byName = new Map<string, TestClassEntry>();
  for (const entry of local) {
    byName.set(entry.name.toLowerCase(), { ...entry, source: 'local-only' });
  }

  for (const record of org?.classes ?? []) {
    const key = record.name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      // Deployed. Local methods and lines stay — they point at a real file.
      byName.set(key, {
        ...existing,
        source: 'both',
        orgId: record.orgId,
        ...(record.namespace ? { namespace: record.namespace } : {}),
      });
      continue;
    }
    if (!record.isTest && !record.methodsUnknown) continue;
    byName.set(key, {
      name: record.name,
      source: 'org-only',
      orgId: record.orgId,
      ...(record.namespace ? { namespace: record.namespace } : {}),
      methods: record.methods,
      ...(record.methodsUnknown ? { methodsUnknown: true } : {}),
    });
  }

  const classes = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    classes,
    ...(org ? { orgUsername: org.orgUsername, orgFetchedAt: org.fetchedAt } : {}),
  };
}
