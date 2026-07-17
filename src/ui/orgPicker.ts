import * as vscode from 'vscode';
import { SfCliService } from '../salesforce/sfCliService';
import {
  getSharedOrg,
  setSharedOrg,
  onSharedOrgChange,
  migrateToSharedOrg,
  orgBadge,
} from '../kit/orgs';
import { OrgInfo } from '../types';
import { sameOrg } from '../orgMatch';
import { GenerationGuard } from '../generationGuard';

interface OrgQuickPickItem extends vscode.QuickPickItem {
  org: OrgInfo;
}

/** globalState key holding the last successful `sf org list` result, so the
 *  picker opens instantly (even in a fresh window) while a live list loads. */
const ORG_LIST_CACHE_KEY = 'sfTestRunner.cachedOrgList';

/**
 * Target-org selection for the test runner.
 *
 * The chosen org is now stored in the family-shared setting
 * `skrety.salesforce.targetOrg` (machine scope) via the kit helpers, so switching
 * the org in any Skrety SF plugin switches it here too. The
 * legacy private globalState key (`sfTestRunner.lastSelectedOrgUsername`) is used
 * once to seed the shared setting on first run, then only as a read fallback.
 *
 * The org list itself is cached (in memory + globalState): opening the picker
 * shows the cached orgs immediately and revalidates via `sf org list` in the
 * background, swapping the items in place when the live list lands. Explicit
 * refresh: the picker's ↻ title button or `SF Tests: Refresh Org List`.
 *
 * `onOrgChanged` fires for BOTH our own picks and external writes (another plugin
 * or the user editing settings.json) — a config watcher is the single change
 * source — so the extension's org-switch invalidation (clear coverage cache,
 * results, decorations) runs no matter who flipped the org.
 *
 * This plugin does NOT contribute the setting schema; sf-org-deploy-helper owns
 * it.
 */
export class OrgPicker implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<OrgInfo | undefined>();
  readonly onOrgChanged = this.emitter.event;
  private readonly watcher: vscode.Disposable;

  /** Last-known org list (persisted): backs the picker for instant opens and
   *  lets a username from the shared setting resolve to a full OrgInfo for the
   *  status-bar label without a fetch. */
  private knownOrgs: OrgInfo[] = [];

  /** Orders `applyUsername`'s async list-refresh resolutions: a rapid external
   *  switch A→B→C must not let B's slower resolution land after C's. */
  private readonly applyGen = new GenerationGuard();

  /** Orders org-list fetches (picker revalidate vs. explicit refresh): only the
   *  newest fetch may update the cache and the on-screen items. */
  private readonly listGen = new GenerationGuard();

  /** The QuickPick currently on screen — used to no-op a re-entrant open
   *  (status-bar double-click) and to retarget refresh results. */
  private activePick: vscode.QuickPick<OrgQuickPickItem> | undefined;

  constructor(
    private readonly sfCli: SfCliService,
    private readonly globalState?: vscode.Memento,
  ) {
    // Seed from the persisted copy; drop malformed entries rather than let a
    // corrupt cache break the picker (it self-heals on the next fetch).
    const cached = globalState?.get<OrgInfo[]>(ORG_LIST_CACHE_KEY);
    if (Array.isArray(cached)) {
      this.knownOrgs = cached.filter(
        (o) =>
          o &&
          typeof o.username === 'string' &&
          typeof o.alias === 'string' &&
          typeof o.instanceUrl === 'string',
      );
    }

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'sfTestRunner.selectOrg';
    this.statusBar.tooltip = 'SF Tests: select target org';
    this.refreshLabel();
    this.statusBar.show();

    // External edits to the shared org (another plugin, or settings.json) route
    // through the same path as our own picks.
    this.watcher = onSharedOrgChange((username) => this.applyUsername(username));
  }

  /** Update the in-memory + persisted org cache (persist is fire-and-forget; a
   *  storage failure only costs the warm start, so it's swallowed). */
  private setKnownOrgs(orgs: OrgInfo[]): void {
    this.knownOrgs = orgs;
    this.globalState?.update(ORG_LIST_CACHE_KEY, orgs).then(undefined, () => {});
  }

  /**
   * Open the org picker. Resolves when the picker closes (picked or dismissed),
   * so callers can read the applied org afterwards. Cached orgs render
   * instantly; a background `sf org list` refreshes them in place — a just-added
   * org appears without reopening.
   */
  showPicker(): Promise<void> {
    if (this.activePick) return Promise.resolve(); // double-click on the status bar
    const qp = vscode.window.createQuickPick<OrgQuickPickItem>();
    this.activePick = qp;
    qp.placeholder = 'Select a Salesforce org for test runs';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.buttons = [{ iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh org list' }];
    this.renderItems(qp, this.knownOrgs);
    qp.onDidTriggerButton(() => void this.revalidate(qp));
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      qp.hide();
      if (!picked) return;
      // Persist to the shared setting; the config watcher fires onOrgChanged,
      // which updates sfCli/status bar and triggers invalidation. Set sfCli
      // synchronously too so a run started immediately after the pick sees the
      // new org.
      this.sfCli.setCurrentOrg(picked.org);
      this.refreshLabel();
      void setSharedOrg(picked.org.username);
      void vscode.window.showInformationMessage(`SF Tests: now targeting ${picked.org.alias}`);
    });
    const closed = new Promise<void>((resolve) => {
      qp.onDidHide(() => {
        if (this.activePick === qp) this.activePick = undefined;
        qp.dispose();
        resolve();
      });
    });
    qp.show();
    void this.revalidate(qp);
    return closed;
  }

  /** Palette command (`SF Tests: Refresh Org List`): force-refresh the cached
   *  org list so the picker reflects a just-added/removed org. */
  async refreshOrgs(): Promise<void> {
    const gen = this.listGen.next();
    try {
      const orgs = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SF Tests: refreshing org list…' },
        () => this.sfCli.listOrgs(),
      );
      if (!this.listGen.isCurrent(gen)) return; // superseded by a newer fetch
      this.setKnownOrgs(orgs);
      if (this.activePick) {
        // This fetch is now the newest, so it owns the busy spinner too — a
        // revalidate it superseded returns early without clearing it.
        this.activePick.busy = false;
        this.renderItems(this.activePick, orgs);
      }
      if (orgs.length === 0) {
        void vscode.window.showWarningMessage(
          'No authenticated Salesforce orgs found. Run `sf org login web` first.',
        );
      } else {
        void vscode.window.showInformationMessage(
          `SF Tests: org list refreshed — ${orgs.length} org${orgs.length === 1 ? '' : 's'}.`,
        );
      }
    } catch (err: any) {
      // Superseded by a newer fetch → stay silent; that fetch owns the spinner
      // and reports its own outcome (avoids double error toasts).
      if (!this.listGen.isCurrent(gen)) return;
      if (this.activePick) this.activePick.busy = false;
      void vscode.window.showErrorMessage(`SF Tests: failed to refresh org list: ${err?.message ?? err}`);
    }
  }

  /** Swap the picker's items, keeping the highlight on the org the user had it
   *  on (or the current org for a fresh picker). */
  private renderItems(qp: vscode.QuickPick<OrgQuickPickItem>, orgs: OrgInfo[]): void {
    const current = getSharedOrg();
    const active = qp.activeItems[0]?.org.username ?? current;
    qp.items = orgs.map((o) => ({
      label: o.alias,
      description: o.username + (current && sameOrg(o.username, current) ? '  • current' : ''),
      detail: o.instanceUrl,
      org: o,
    }));
    const keep = active ? qp.items.find((i) => sameOrg(i.org.username, active)) : undefined;
    if (keep) qp.activeItems = [keep];
  }

  /** Fetch a live org list; if still the newest fetch, update the cache and the
   *  picker. A failure with cached items on screen keeps serving them (the
   *  service already logged it); a failure with nothing to show keeps the old
   *  loud error path. */
  private async revalidate(qp: vscode.QuickPick<OrgQuickPickItem>): Promise<void> {
    const gen = this.listGen.next();
    qp.busy = true;
    let orgs: OrgInfo[];
    try {
      orgs = await this.sfCli.listOrgs();
    } catch (err: any) {
      if (!this.listGen.isCurrent(gen) || this.activePick !== qp) return;
      qp.busy = false;
      if (qp.items.length === 0) {
        qp.hide();
        void vscode.window.showErrorMessage(`SF Tests: failed to list orgs: ${err?.message ?? err}`);
      }
      return;
    }
    if (!this.listGen.isCurrent(gen)) return; // superseded by a newer fetch
    this.setKnownOrgs(orgs);
    if (this.activePick !== qp) return; // picker closed while loading
    qp.busy = false;
    if (orgs.length === 0) {
      qp.hide();
      void vscode.window.showWarningMessage(
        'No authenticated Salesforce orgs found. Run `sf org login web` first.',
      );
      return;
    }
    this.renderItems(qp, orgs);
  }

  /**
   * Resolve the effective startup org: shared setting (migrated from the legacy
   * key on first run) → CLI default → first org. Sets it on sfCli and fires
   * onOrgChanged so decorations/state start consistent.
   */
  async autoSelectDefault(legacyUsername?: string): Promise<void> {
    try {
      const effective = await migrateToSharedOrg(legacyUsername);
      const orgs = await this.sfCli.listOrgs();
      this.setKnownOrgs(orgs);

      let startup: OrgInfo | undefined;
      if (effective) {
        // The shared setting names an org. Prefer its full OrgInfo, but if the
        // list doesn't include it (that one org's auth expired, or a list
        // hiccup) keep targeting the requested username via a minimal OrgInfo
        // rather than silently retargeting to a different org — every sibling
        // plugin still shows it, and a run fails honestly if the auth is really
        // gone. Mirrors the shared-setting watcher's fallback in applyUsername.
        startup =
          orgs.find((o) => sameOrg(o.username, effective)) ??
          { alias: effective, username: effective, instanceUrl: '', isDefault: false };
      } else {
        // Genuinely-empty shared setting: seed from the CLI default (or first).
        startup = orgs.find((o) => o.isDefault) ?? orgs[0];
      }

      if (startup) {
        // If nothing was persisted yet, adopt the startup pick into the shared
        // setting so the rest of the family sees it.
        if (!getSharedOrg()) await setSharedOrg(startup.username);
        this.sfCli.setCurrentOrg(startup);
        this.refreshLabel();
        this.emitter.fire(startup);
      }
    } catch {
      // silent on startup
    }
  }

  /** React to a shared-setting change: resolve the username to a known org
   *  (refresh the list if we can't), update sfCli + status bar, fire the event. */
  private applyUsername(username: string | undefined): void {
    // Claim a generation synchronously at handler entry. A newer switch that
    // arrives while our list refresh is in flight bumps this, so the stale
    // resolution below yields to the newer event — the latest event wins.
    const gen = this.applyGen.next();
    if (!username) {
      this.sfCli.setCurrentOrg(undefined);
      this.refreshLabel();
      this.emitter.fire(undefined);
      return;
    }
    const found = this.knownOrgs.find((o) => sameOrg(o.username, username));
    if (found) {
      this.sfCli.setCurrentOrg(found);
      this.refreshLabel();
      this.emitter.fire(found);
      return;
    }
    // Not in our cached list — refresh once and resolve, so an org selected in
    // another plugin (that we've never listed) still lands here.
    void this.sfCli
      .listOrgs()
      .then((orgs) => {
        // Superseded by a newer switch while the list loaded — drop this result.
        if (!this.applyGen.isCurrent(gen)) return;
        this.setKnownOrgs(orgs);
        const org = orgs.find((o) => sameOrg(o.username, username));
        // Fall back to a minimal OrgInfo so the target is still usable even if
        // the list doesn't include it (e.g. auth known only to another plugin).
        const resolved: OrgInfo = org ?? {
          alias: username,
          username,
          instanceUrl: '',
          isDefault: false,
        };
        this.sfCli.setCurrentOrg(resolved);
        this.refreshLabel();
        this.emitter.fire(resolved);
      })
      .catch(() => {
        if (!this.applyGen.isCurrent(gen)) return;
        const resolved: OrgInfo = { alias: username, username, instanceUrl: '', isDefault: false };
        this.sfCli.setCurrentOrg(resolved);
        this.refreshLabel();
        this.emitter.fire(resolved);
      });
  }

  /** Family convention: over-warn — a PROD (or unresolvable) org gets the warn
   *  tint so the target is unmistakable before a run. */
  private refreshLabel(): void {
    const org = this.sfCli.getCurrentOrg();
    if (!org) {
      this.statusBar.text = '$(beaker) SF: (no org)';
      this.statusBar.backgroundColor = undefined;
      return;
    }
    const badge = orgBadge(org);
    this.statusBar.text = `$(beaker) SF: ${org.alias} [${badge}]`;
    this.statusBar.backgroundColor =
      badge === 'PROD'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  }

  dispose(): void {
    this.activePick?.dispose();
    this.statusBar.dispose();
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
