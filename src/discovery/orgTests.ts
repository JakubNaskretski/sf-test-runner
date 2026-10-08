/**
 * The org half of the test index: which unmanaged `ApexClass` rows the target
 * org holds, and which of them are test classes.
 *
 * Two steps, both cheap by design:
 *  1. `SELECT Id, Name, NamespacePrefix … WHERE ManageableState = 'unmanaged'` —
 *     one query, every name, no bodies.
 *  2. Only the names we have no local file for get their `Body` fetched (in
 *     batches of 200) and classified by the SAME regex scanner the local scan
 *     uses (`salesforce/testMethods.ts`), so local and org agree by construction.
 *
 * Nothing here imports `vscode` at runtime — only its types — so the
 * classification and the fetch loop are unit-testable outside the extension host.
 */
import type * as vscode from 'vscode';
import type { SfCliService } from '../salesforce/sfCliService';
import {
  findClassDecl,
  findTestForTargets,
  findTestMethods,
  hasApexTests,
} from '../salesforce/testMethods';
import { TestMethodEntry } from '../types';

/** One unmanaged class the org reported, classified if we had to look. */
export interface OrgClassRecord {
  name: string;
  orgId: string;
  namespace?: string;
  isTest: boolean;
  /** Empty for a class we matched to a local file — the local entry owns the
   *  methods, because its lines point at a file the user can actually open. */
  methods: TestMethodEntry[];
  /** Classes and triggers declared with `@IsTest(testFor=…)`, when the body was
   *  read. The local entry wins when the class is on disk too. */
  testFor?: string[];
  /** The org listed the class but its `Body` came back empty, so we never
   *  classified it. Honest "unknown", never guessed from the name. */
  methodsUnknown?: boolean;
  /** `isTest` because the class declaration carries `@IsTest`, though no
   *  method in it was recognised as a test (`methods` is empty). */
  annotatedOnly?: boolean;
}

export interface OrgTestClasses {
  orgUsername: string;
  fetchedAt: number;
  classes: OrgClassRecord[];
}

const CACHE_PREFIX = 'sfTestRunner.orgTests.v1.';

/** Somewhere to say what we could not classify. The output channel in the
 *  extension host; anything with `appendLine` in a test. */
export interface OrgTestLog {
  appendLine(value: string): void;
}

export class OrgTestFetcher {
  /** One fetch per org at a time: the panel button, the on-open setting and an
   *  org switch can all ask at the same moment. A second caller joins the first
   *  fetch — including its `localNames`, which is why the index is rebuilt from
   *  the scanner's entries afterwards rather than from these records. */
  private readonly inflight = new Map<string, Promise<OrgTestClasses>>();

  constructor(
    private readonly sfCli: SfCliService,
    private readonly memento: vscode.Memento,
    private readonly output?: OrgTestLog,
  ) {}

  /** The last fetch for this org, or undefined if we never fetched one. */
  cached(orgUsername: string): OrgTestClasses | undefined {
    const stored = this.memento.get<OrgTestClasses>(cacheKey(orgUsername));
    if (!stored || !Array.isArray(stored.classes)) return undefined;
    return stored;
  }

  /**
   * Patch the ORG half of the cache for `orgUsername`: `classNames` are now
   * present there and classified as tests — "Deploy first" just put them
   * there, so the next not-deployed check for THIS org must not warn about
   * them again. A class already in the cache keeps its own record
   * (methods/testFor/orgId untouched beyond `isTest`); a class the org fetch
   * never saw gets a minimal row — `buildIndex` prefers the local copy for
   * everything but `isTest` anyway, once a local file exists.
   *
   * A no-op when this org has never been fetched: there is nothing to patch,
   * and the not-deployed warning could not have fired for it either (see
   * `localOnlyClasses` — it claims nothing until the org half is known).
   */
  async markDeployed(orgUsername: string, classNames: readonly string[]): Promise<void> {
    const existing = this.cached(orgUsername);
    if (!existing) return;
    const byName = new Map(existing.classes.map((c) => [c.name.toLowerCase(), c] as const));
    let changed = false;
    for (const name of classNames) {
      const key = name.toLowerCase();
      const current = byName.get(key);
      if (current) {
        if (!current.isTest) {
          byName.set(key, { ...current, isTest: true });
          changed = true;
        }
      } else {
        byName.set(key, { name, orgId: '', isTest: true, methods: [] });
        changed = true;
      }
    }
    if (!changed) return;
    await this.memento.update(cacheKey(orgUsername), {
      ...existing,
      classes: [...byName.values()],
    });
  }

  /**
   * Ask the org for its classes. `localNames` are the names the local scan
   * already classified as tests (case-insensitively matched): those skip the
   * `Body` fetch entirely.
   *
   * Non-test classes stay in the returned list — dropping them here would make
   * the cache incomplete, and `buildIndex` is the one place that decides what
   * the user sees.
   */
  fetch(
    orgUsername: string,
    localNames: Iterable<string>,
    cancellation?: vscode.CancellationToken,
  ): Promise<OrgTestClasses> {
    const existing = this.inflight.get(orgUsername);
    if (existing) return existing;
    const promise = this.doFetch(orgUsername, localNames, cancellation).finally(() => {
      this.inflight.delete(orgUsername);
    });
    this.inflight.set(orgUsername, promise);
    return promise;
  }

  private async doFetch(
    orgUsername: string,
    localNames: Iterable<string>,
    cancellation?: vscode.CancellationToken,
  ): Promise<OrgTestClasses> {
    const rows = await this.sfCli.listOrgClasses(orgUsername, { cancellation });
    const local = new Set<string>();
    for (const name of localNames) local.add(name.toLowerCase());

    const classes: OrgClassRecord[] = [];
    const needBody: { id: string; name: string; namespace?: string }[] = [];
    for (const row of rows) {
      if (local.has(row.name.toLowerCase())) {
        classes.push({
          name: row.name,
          orgId: row.id,
          ...(row.namespace ? { namespace: row.namespace } : {}),
          isTest: true,
          methods: [],
        });
      } else {
        needBody.push(row);
      }
    }

    if (needBody.length > 0) {
      const bodies = await this.sfCli.getClassBodies(
        needBody.map((r) => r.id),
        orgUsername,
        { cancellation },
      );
      for (const row of needBody) {
        const body = bodies.get(row.id);
        const base = {
          name: row.name,
          orgId: row.id,
          ...(row.namespace ? { namespace: row.namespace } : {}),
        };
        if (body == null) {
          // No body, no classification. Guessing "it is a test because it is
          // called SomethingTest" would put a class in the tree that may not be
          // runnable; say we do not know instead.
          this.output?.appendLine(
            `Org test discovery: no Body returned for ${row.name} (${row.id}) — left unclassified.`,
          );
          classes.push({ ...base, isTest: false, methods: [], methodsUnknown: true });
          continue;
        }
        const { isTest, methods, testFor, annotatedOnly } = classifyBody(row.name, body);
        classes.push({
          ...base,
          isTest,
          methods,
          ...(testFor ? { testFor } : {}),
          ...(annotatedOnly ? { annotatedOnly } : {}),
        });
      }
    }

    const result: OrgTestClasses = { orgUsername, fetchedAt: Date.now(), classes };
    await this.memento.update(cacheKey(orgUsername), result);
    return result;
  }
}

/**
 * Whether an Apex source body is a test class, and which methods are its tests.
 *
 * Same rules as the local scan, flag first: a class whose declaration carries
 * `@IsTest` IS a test class even when no method in it is recognised — it comes
 * back `annotatedOnly`, which `buildIndex` keeps out of the visible list (a
 * TestDataFactory or an HttpCalloutMock must not become a runnable row) but
 * the cross-extension handoff can still run by name. Without the class-level
 * flag, a body with no recognised test method is not a test class.
 *
 * Methods deliberately carry no `line`: the line would index the org's copy of
 * the source, and an org-only class has no file in the workspace to open at it.
 */
export function classifyBody(
  name: string,
  body: string,
): { isTest: boolean; methods: TestMethodEntry[]; testFor?: string[]; annotatedOnly?: boolean } {
  if (!hasApexTests(body)) return { isTest: false, methods: [] };
  const lines = body.split(/\r?\n/);
  const decl = findClassDecl(lines);
  const methods = findTestMethods(lines, decl?.className ?? name);
  if (methods.length === 0 && !decl?.isTestAnnotated) return { isTest: false, methods: [] };
  const testFor = findTestForTargets(lines);
  return {
    isTest: true,
    methods: methods.map((m) => ({ name: m.methodName })),
    ...(testFor.length > 0 ? { testFor } : {}),
    ...(methods.length === 0 ? { annotatedOnly: true } : {}),
  };
}

function cacheKey(orgUsername: string): string {
  return `${CACHE_PREFIX}${orgUsername}`;
}
