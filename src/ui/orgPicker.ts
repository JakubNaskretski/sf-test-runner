import * as vscode from 'vscode';
import { SfCliService } from '../salesforce/sfCliService';
import { getSharedOrg, setSharedOrg, onSharedOrgChange, orgBadge } from '../kit/orgs';
import { OrgInfo } from '../types';
import { sameOrg } from '../orgMatch';
import { GenerationGuard } from '../generationGuard';

interface OrgQuickPickItem extends vscode.QuickPickItem {
  org: OrgInfo;
}

/** globalState key holding the last successful `sf org list` result, so the
 *  picker opens instantly (even in a fresh window) while a live list loads. */
const ORG_LIST_CACHE_KEY = 'sfTestRunner.cachedOrgList';

/** workspaceState key holding THIS plugin's own target org — the source of truth,
 *  rewritten on every applied org change (pick, family follow, startup). Scoped to
 *  the WINDOW, so two windows on two projects run against two orgs. The key NAME is
 *  unchanged, which is what lets `resolveStartupOrg` port the value older releases
 *  wrote under it in globalState forward into each window once; globalState is a
 *  separate memento, so the two never collide. */
const LAST_SELECTED_ORG_KEY = 'sfTestRunner.lastSelectedOrgUsername';

/** globalState flag for the one-time "adopt the family org into our own store"
 *  migration run when upgrading from the always-shared releases. Install-wide even
 *  though the org is per window: it may only ever run once. */
const ORG_SYNC_MIGRATED_KEY = 'sfTestRunner.orgSyncMigrated.v1';

/** Per-WINDOW marker: this window has had its one shot at the legacy globalState
 *  org (see `resolveStartupOrg`). Lives in workspaceState beside the org it
 *  guards, and is stamped whether or not anything moved. */
const ORG_PORTED_KEY = 'sfTestRunner.orgPortedFromGlobal.v1';

/** Opt-in switch for following/publishing the family-shared org. Default off. */
const SYNC_SETTING = 'sfTestRunner.syncOrgWithFamily';

/**
 * Target-org selection for the test runner.
 *
 * This plugin keeps its OWN org in the private workspaceState key
 * `sfTestRunner.lastSelectedOrgUsername` — per VS Code window, and VS Code never
 * propagates workspaceState between windows; that key is the source of truth and is
 * rewritten on every applied change. Following (and publishing) the
 * family-shared setting `skrety.salesforce.targetOrg` is opt-in per plugin via
 * `sfTestRunner.syncOrgWithFamily` (default OFF):
 *   - off — a switch made in a sibling plugin is ignored, and our own picks stay
 *     local;
 *   - on  — the shared org is adopted whenever it changes, and a pick here is
 *     published to it, i.e. the pre-toggle behaviour. One family-wide carve-out:
 *     an EMPTY shared value is never adopted, so a sibling clearing the family
 *     org can't blank a working target.
 * The flag is read at EVENT time, so flipping it takes effect without a reload,
 * and flipping it ON adopts the shared org straight away.
 *
 * The org list itself is cached (in memory + globalState): opening the picker
 * shows the cached orgs immediately and revalidates via `sf org list` in the
 * background, swapping the items in place when the live list lands. Explicit
 * refresh: the picker's ↻ title button or `SF Tests: Refresh Org List`.
 *
 * `onOrgChanged` fires for BOTH our own picks (applied directly — with sync off
 * nothing else would) and adopted family switches, so the extension's org-switch
 * invalidation (clear coverage cache, results, decorations) runs no matter who
 * flipped the org. A pick under sync-on writes the shared setting, whose watcher
 * then sees the value we already hold and de-dups instead of firing twice.
 *
 * This plugin does NOT contribute the shared setting's schema; sf-org-deploy-helper
 * owns it. The `syncOrgWithFamily` toggle above IS ours.
 */
export class OrgPicker implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<OrgInfo | undefined>();
  readonly onOrgChanged = this.emitter.event;
  /** Fires whenever the cached org LIST moves (a refresh, a picker revalidate),
   *  which happens without the selected org changing. The panel's `<select>`
   *  must offer exactly what the QuickPick offers, so it follows this. */
  private readonly orgsEmitter = new vscode.EventEmitter<OrgInfo[]>();
  readonly onOrgsChanged = this.orgsEmitter.event;
  private readonly watcher: vscode.Disposable;
  private readonly syncWatcher: vscode.Disposable;

  /** Last-known org list (persisted): backs the picker for instant opens and
   *  lets a username from the shared setting resolve to a full OrgInfo for the
   *  status-bar label without a fetch. */
  private knownOrgs: OrgInfo[] = [];

  /** In-memory mirror of the private workspaceState key: what THIS plugin targets.
   *  Read synchronously for the picker's "• current" marker and for the
   *  shared-watcher de-dup, so an adopt can't race the persisted write. */
  private privateOrg: string | undefined;

  /** Orders `applyUsername`'s async list-refresh resolutions: a rapid external
   *  switch A→B→C must not let B's slower resolution land after C's. */
  private readonly applyGen = new GenerationGuard();

  /** Orders org-list fetches (picker revalidate vs. explicit refresh): only the
   *  newest fetch may update the cache and the on-screen items. */
  private readonly listGen = new GenerationGuard();

  /** The QuickPick currently on screen — used to no-op a re-entrant open
   *  (status-bar double-click) and to retarget refresh results. */
  private activePick: vscode.QuickPick<OrgQuickPickItem> | undefined;

  /** `globalState` is machine-wide and holds only what is right to share between
   *  windows — the org-list cache and the one-time migration flag. `workspaceState`
   *  is THIS window's and holds the target org. Both stay optional: without them the
   *  picker still works, just session-only. */
  constructor(
    private readonly sfCli: SfCliService,
    private readonly globalState?: vscode.Memento,
    private readonly workspaceState?: vscode.Memento,
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

    this.privateOrg = workspaceState?.get<string>(LAST_SELECTED_ORG_KEY);

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'sfTestRunner.selectOrg';
    this.statusBar.tooltip = 'SF Tests: select target org';
    this.refreshLabel();
    this.statusBar.show();

    // External edits to the shared org (another plugin, or settings.json) are
    // followed ONLY while sync is on. The flag is read here, at event time, so
    // toggling it takes effect without a window reload.
    this.watcher = onSharedOrgChange((username) => {
      if (!this.syncEnabled()) return;
      this.adoptShared(username);
    });

    // Flipping sync ON adopts the family org immediately; flipping it off just
    // stops the following, leaving our current org alone.
    this.syncWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SYNC_SETTING) || !this.syncEnabled()) return;
      const shared = getSharedOrg();
      if (shared) this.adoptShared(shared);
    });
  }

  /** Opt-in family sync. Read on every use — never cached at registration. */
  private syncEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(SYNC_SETTING, false) === true;
  }

  /** Follow a family org switch. Skipped when it names what we already target —
   *  that de-dup is what stops our own shared write (after a pick under sync-on)
   *  from firing a second onOrgChanged — and when it is EMPTY: a sibling
   *  clearing the family org must never blank our working target. */
  private adoptShared(username: string | undefined): void {
    if (!username) return;
    if (sameOrg(username, this.privateOrg)) return;
    this.applyUsername(username);
  }

  /** Record the plugin's own target org, in THIS window's workspaceState. The
   *  in-memory copy updates synchronously, so the UI paths can ignore the result
   *  and let the write land in its own time (a storage failure only costs the
   *  remembered org on the next start — hence the swallow, so this never rejects).
   *  The returned promise settles once the write is through: the startup path
   *  awaits it, so a crash can't stamp the once-per-install flag while the org it
   *  just adopted is still in flight. */
  private persistPrivateOrg(username: string | undefined): Thenable<void> | undefined {
    this.privateOrg = username;
    return this.workspaceState?.update(LAST_SELECTED_ORG_KEY, username).then(undefined, () => {});
  }

  /** Update the in-memory + persisted org cache (persist is fire-and-forget; a
   *  storage failure only costs the warm start, so it's swallowed). */
  private setKnownOrgs(orgs: OrgInfo[]): void {
    this.knownOrgs = orgs;
    this.globalState?.update(ORG_LIST_CACHE_KEY, orgs).then(undefined, () => {});
    this.orgsEmitter.fire(orgs);
  }

  /** The org list as the picker currently knows it — seeded from globalState in
   *  the constructor, so it is populated before any `sf org list` runs. */
  knownOrgList(): OrgInfo[] {
    return [...this.knownOrgs];
  }

  /**
   * Apply an org the user chose by hand. Both hand-picking surfaces — the
   * QuickPick and the panel's `<select>` — come through here, so the private
   * store write and the family publish happen exactly once, in one place.
   */
  private applyPick(org: OrgInfo): void {
    if (sameOrg(org.username, this.privateOrg)) {
      // Re-picking the org we're already on is not a switch: refresh the
      // details (alias/URL may have moved) but don't make the extension bin
      // its coverage and results for nothing.
      this.sfCli.setCurrentOrg(org);
      this.refreshLabel();
    } else {
      // Apply directly: with sync off nothing else fires onOrgChanged, and the
      // extension's org-switch invalidation hangs off that event. This also sets
      // sfCli synchronously, so a run started right after the pick sees the new
      // org.
      this.applyOrg(org);
    }
    // The ONLY write to the family setting, and only when sync is on. The
    // resulting watcher event de-dups against the value we just stored.
    if (this.syncEnabled()) void setSharedOrg(org.username);
    void vscode.window.showInformationMessage(`SF Tests: now targeting ${org.alias}`);
  }

  /**
   * Pick by username — the panel's org `<select>`. The username must be one we
   * already listed (the view provider rejects anything else); a name the cache
   * has lost means the list is stale, so refresh it rather than target a
   * username we cannot describe.
   */
  selectByUsername(username: string): void {
    const org = this.knownOrgs.find((o) => sameOrg(o.username, username));
    if (!org) {
      void this.refreshOrgs();
      return;
    }
    this.applyPick(org);
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
      this.applyPick(picked.org);
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
      // The CLI's own message, never "no orgs found" — a failed list and an
      // empty list need different fixes.
      void vscode.window.showErrorMessage(
        `SF Tests: could not list orgs: ${err?.message ?? err}`,
      );
    }
  }

  /** Swap the picker's items, keeping the highlight on the org the user had it
   *  on (or the current org for a fresh picker). */
  private renderItems(qp: vscode.QuickPick<OrgQuickPickItem>, orgs: OrgInfo[]): void {
    // Our own org, not the family's — with sync off they can differ.
    const current = this.privateOrg;
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
        void vscode.window.showErrorMessage(
          `SF Tests: could not list orgs: ${err?.message ?? err}`,
        );
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
   * Resolve the startup org: our own remembered org (see `resolveStartupOrg` for
   * the two ways the family setting can feed into it) → CLI default → first org.
   * Sets it on sfCli and fires onOrgChanged so decorations/state start
   * consistent.
   *
   * Cache-first: a remembered org that the persisted list already knows is
   * applied synchronously and revalidated in the background, so activation never
   * waits on `sf org list` and a failed list can't discard a perfectly good org.
   * Only an unrecognised username (or none) has to await a live list.
   */
  async autoSelectDefault(): Promise<void> {
    try {
      const effective = await this.resolveStartupOrg();
      const cached = effective
        ? this.knownOrgs.find((o) => sameOrg(o.username, effective))
        : undefined;
      if (cached) {
        this.applyOrg(cached);
        void this.reconcileStartupOrg(cached.username);
        return;
      }

      const gen = this.listGen.next();
      let orgs: OrgInfo[];
      try {
        orgs = await this.sfCli.listOrgs();
      } catch (err: any) {
        // Nothing cached to fall back on. A named org still targets by username
        // (the list may be broken, not the org); with nothing named there is no
        // target at all, so say why instead of starting silently org-less.
        if (effective) {
          this.applyOrg({
            alias: effective,
            username: effective,
            instanceUrl: '',
            isDefault: false,
          });
        } else {
          void vscode.window.showErrorMessage(
            `SF Tests: could not list orgs: ${err?.message ?? err}`,
          );
        }
        return;
      }
      if (this.listGen.isCurrent(gen)) this.setKnownOrgs(orgs);

      let startup: OrgInfo | undefined;
      if (effective) {
        // We have a remembered org. Prefer its full OrgInfo, but if the list
        // doesn't include it (that one org's auth expired, or a list hiccup)
        // keep targeting the requested username via a minimal OrgInfo rather
        // than silently retargeting to a different org — a run then fails
        // honestly if the auth is really gone. Mirrors the family watcher's
        // fallback in applyUsername.
        startup =
          orgs.find((o) => sameOrg(o.username, effective)) ??
          { alias: effective, username: effective, instanceUrl: '', isDefault: false };
      } else {
        // Nothing remembered yet: start on the CLI default (or first org). This
        // is OUR org only — a startup fallback never writes the family setting.
        startup = orgs.find((o) => o.isDefault) ?? orgs[0];
      }

      if (startup) this.applyOrg(startup);
    } catch {
      // silent on startup
    }
  }

  /**
   * Settle which org this plugin starts on, before any list work.
   *
   * (a0) Port forward the legacy org, at most ONCE per window: releases before
   *     the per-window split kept the target in globalState under the SAME key. A
   *     window whose own store is still empty adopts it, so an upgrade changes
   *     nothing the user can see — without this every window would fall back to
   *     the CLI default org, which may well be production, and say nothing about
   *     it. The hop is stamped in the window store, and stamped even when there
   *     was nothing to port, because "empty" is also what a deliberately cleared
   *     target looks like: once an org's auth expires or it leaves the list, an
   *     unstamped port would drag the dead org back in on every reload. The org is
   *     written BEFORE the stamp, so a crash between the two costs nothing but
   *     another attempt. The global value is only ever READ: other windows of this
   *     install need it too.
   * (a) One-time migration off the always-shared releases: the first activation
   *     that finds the flag unset adopts the family org into our private key, so
   *     an upgrade doesn't silently jump back to a long-frozen private value.
   *     Runs regardless of the sync flag; the flag is then set for good, so a
   *     family org set later is never adopted behind a user who keeps sync off.
   *     The flag is install-wide while the org is per window, so this adoption
   *     lands in the FIRST window that activates; later windows open on the org
   *     (a0) ported forward, or on their own last pick.
   * (b) With sync on, a family org that has moved on since our last run wins.
   */
  private async resolveStartupOrg(): Promise<string | undefined> {
    if (!this.workspaceState?.get<boolean>(ORG_PORTED_KEY)) {
      if (!this.privateOrg) {
        // Read defensively: storage written by an older release, editable by
        // hand, so it may hold anything at all.
        const legacy = this.globalState?.get<unknown>(LAST_SELECTED_ORG_KEY);
        if (typeof legacy === 'string' && legacy.trim()) await this.persistPrivateOrg(legacy.trim());
      }
      // Swallowed like every other persist: a failed stamp only costs another
      // (harmless) port attempt next start, it must not abandon startup.
      await this.workspaceState?.update(ORG_PORTED_KEY, true).then(undefined, () => {});
    }

    const shared = getSharedOrg();
    if (!this.globalState?.get<boolean>(ORG_SYNC_MIGRATED_KEY)) {
      // Awaited, both of them: this runs once per install, so a crash between the
      // two writes would stamp the flag and lose the org it just adopted.
      if (shared) await this.persistPrivateOrg(shared);
      await this.globalState?.update(ORG_SYNC_MIGRATED_KEY, true).then(undefined, () => {});
    }
    if (this.syncEnabled() && shared && !sameOrg(shared, this.privateOrg)) {
      this.persistPrivateOrg(shared);
    }
    return this.privateOrg;
  }

  /** Apply an org everywhere: our private store (the source of truth), sfCli (so
   *  a run started immediately sees it), the status bar, and listeners. */
  private applyOrg(org: OrgInfo): void {
    // Claim a generation so an applyUsername resolution still in flight can't
    // land on top of this newer, already-resolved org.
    this.applyGen.next();
    this.persistPrivateOrg(org.username);
    this.sfCli.setCurrentOrg(org);
    this.refreshLabel();
    this.emitter.fire(org);
  }

  /** Background revalidate behind a cache-resolved startup org: refresh the list
   *  and swap in the live entry for the same username (alias/URL may have moved
   *  on). A failure keeps the cached org — we already have a usable target. No
   *  onOrgChanged: the org didn't change, only its details. */
  private async reconcileStartupOrg(username: string): Promise<void> {
    const gen = this.listGen.next();
    let orgs: OrgInfo[];
    try {
      orgs = await this.sfCli.listOrgs();
    } catch {
      return;
    }
    if (!this.listGen.isCurrent(gen)) return; // superseded by a newer fetch
    this.setKnownOrgs(orgs);
    const live = orgs.find((o) => sameOrg(o.username, username));
    // The user may have switched orgs while this was in flight — only reconcile
    // while the cache-resolved org is still the target.
    if (!live || !sameOrg(this.sfCli.getCurrentOrg()?.username, username)) return;
    this.sfCli.setCurrentOrg(live);
    this.refreshLabel();
  }

  /** Adopt a family org (sync on only): record it as ours, resolve the username
   *  to a known org (refresh the list if we can't), update sfCli + status bar,
   *  fire the event. */
  private applyUsername(username: string | undefined): void {
    // Claim a generation synchronously at handler entry. A newer switch that
    // arrives while our list refresh is in flight bumps this, so the stale
    // resolution below yields to the newer event — the latest event wins.
    const gen = this.applyGen.next();
    // The private store is the source of truth, so it moves as soon as we commit
    // to the switch — the slow OrgInfo resolution below only fills in the label.
    this.persistPrivateOrg(username);
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
    this.syncWatcher.dispose();
    this.emitter.dispose();
    this.orgsEmitter.dispose();
  }
}
