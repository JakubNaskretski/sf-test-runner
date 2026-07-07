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

interface OrgQuickPickItem extends vscode.QuickPickItem {
  org: OrgInfo;
}

/**
 * Target-org selection for the test runner.
 *
 * The chosen org is now stored in the family-shared setting
 * `skrety.salesforce.targetOrg` (machine scope) via the kit helpers, so switching
 * the org in any Skrety SF plugin switches it here too. The
 * legacy private globalState key (`sfTestRunner.lastSelectedOrgUsername`) is used
 * once to seed the shared setting on first run, then only as a read fallback.
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

  /** Last-known org list, so a username from the shared setting can be resolved
   *  to a full OrgInfo for the status-bar label. */
  private knownOrgs: OrgInfo[] = [];

  constructor(private readonly sfCli: SfCliService) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'sfTestRunner.selectOrg';
    this.statusBar.tooltip = 'SF Tests: select target org';
    this.refreshLabel();
    this.statusBar.show();

    // External edits to the shared org (another plugin, or settings.json) route
    // through the same path as our own picks.
    this.watcher = onSharedOrgChange((username) => this.applyUsername(username));
  }

  async showPicker(): Promise<void> {
    let orgs: OrgInfo[];
    try {
      orgs = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SF Tests: loading orgs…' },
        () => this.sfCli.listOrgs(),
      );
    } catch (err: any) {
      void vscode.window.showErrorMessage(`SF Tests: failed to list orgs: ${err?.message ?? err}`);
      return;
    }

    if (orgs.length === 0) {
      void vscode.window.showWarningMessage(
        'No authenticated Salesforce orgs found. Run `sf org login web` first.',
      );
      return;
    }

    this.knownOrgs = orgs;
    const current = getSharedOrg();
    const items: OrgQuickPickItem[] = orgs.map((o) => ({
      label: o.alias,
      description: o.username + (o.username === current ? '  • current' : ''),
      detail: o.instanceUrl,
      picked: o.username === current,
      org: o,
    }));

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Salesforce org for test runs',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!choice) return;

    // Persist to the shared setting; the config watcher fires onOrgChanged, which
    // updates sfCli/status bar and triggers invalidation. Set sfCli synchronously
    // too so a run started immediately after the pick sees the new org.
    this.sfCli.setCurrentOrg(choice.org);
    this.refreshLabel();
    await setSharedOrg(choice.org.username);
    void vscode.window.showInformationMessage(`SF Tests: now targeting ${choice.org.alias}`);
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
      this.knownOrgs = orgs;
      const preferred = effective
        ? orgs.find((o) => o.username.toLowerCase() === effective.toLowerCase())
        : undefined;
      const startup = preferred ?? orgs.find((o) => o.isDefault) ?? orgs[0];
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
    if (!username) {
      this.sfCli.setCurrentOrg(undefined);
      this.refreshLabel();
      this.emitter.fire(undefined);
      return;
    }
    const found = this.knownOrgs.find((o) => o.username.toLowerCase() === username.toLowerCase());
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
        this.knownOrgs = orgs;
        const org = orgs.find((o) => o.username.toLowerCase() === username.toLowerCase());
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
    this.statusBar.dispose();
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
