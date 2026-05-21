import * as vscode from 'vscode';
import { SfCliService } from '../salesforce/sfCliService';
import { OrgInfo } from '../types';

interface OrgQuickPickItem extends vscode.QuickPickItem {
  org: OrgInfo;
}

export class OrgPicker implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<OrgInfo>();
  readonly onOrgChanged = this.emitter.event;

  constructor(private readonly sfCli: SfCliService) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'sfTestRunner.selectOrg';
    this.statusBar.tooltip = 'SF Tests: select target org';
    this.refreshLabel();
    this.statusBar.show();
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

    const items: OrgQuickPickItem[] = orgs.map((o) => ({
      label: o.alias,
      description: o.username,
      detail: o.instanceUrl,
      picked: o.isDefault,
      org: o,
    }));

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Salesforce org for test runs',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!choice) return;

    this.sfCli.setCurrentOrg(choice.org);
    this.refreshLabel();
    this.emitter.fire(choice.org);
    void vscode.window.showInformationMessage(`SF Tests: now targeting ${choice.org.alias}`);
  }

  async autoSelectDefault(preferredUsername?: string): Promise<void> {
    try {
      const orgs = await this.sfCli.listOrgs();
      const preferred = preferredUsername
        ? orgs.find((o) => o.username.toLowerCase() === preferredUsername.toLowerCase())
        : undefined;
      const startup = preferred ?? orgs.find((o) => o.isDefault) ?? orgs[0];
      if (startup) {
        this.sfCli.setCurrentOrg(startup);
        this.refreshLabel();
        this.emitter.fire(startup);
      }
    } catch {
      // silent on startup
    }
  }

  private refreshLabel(): void {
    const org = this.sfCli.getCurrentOrg();
    this.statusBar.text = org ? `$(beaker) SF: ${org.alias}` : '$(beaker) SF: (no org)';
  }

  dispose(): void {
    this.statusBar.dispose();
    this.emitter.dispose();
  }
}
