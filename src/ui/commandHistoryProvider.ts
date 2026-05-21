import * as vscode from 'vscode';
import { CommandLogEntry } from '../types';

const MAX_ENTRIES = 100;

type Node = CommandNode | DetailNode | EmptyNode;

class CommandNode {
  readonly kind = 'command' as const;
  constructor(public readonly entry: CommandLogEntry) {}
}

class DetailNode {
  readonly kind = 'detail' as const;
  constructor(
    public readonly label: string,
    public readonly description?: string,
    public readonly icon?: string,
  ) {}
}

class EmptyNode {
  readonly kind = 'empty' as const;
  constructor(public readonly message: string) {}
}

export class CommandHistoryProvider implements vscode.TreeDataProvider<Node> {
  private readonly entries = new Map<number, CommandLogEntry>();
  private readonly order: number[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  record(entry: CommandLogEntry): void {
    const existing = this.entries.get(entry.id);
    this.entries.set(entry.id, entry);
    if (!existing) {
      this.order.unshift(entry.id);
      while (this.order.length > MAX_ENTRIES) {
        const evicted = this.order.pop()!;
        this.entries.delete(evicted);
      }
    }
    this.changeEmitter.fire(undefined);
  }

  clear(): void {
    this.entries.clear();
    this.order.length = 0;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(node.message);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    if (node.kind === 'detail') {
      const item = new vscode.TreeItem(node.label);
      item.description = node.description;
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }

    const e = node.entry;
    const stamp = new Date(e.startedAt).toLocaleTimeString();
    const item = new vscode.TreeItem(
      `${stamp}  ${e.command} ${shortArgs(e.args)}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon(iconForStatus(e));
    item.description = describe(e);
    item.tooltip = `${e.command} ${e.args.join(' ')}\n\nStatus: ${e.status}\nDuration: ${e.durationMs ?? '…'}ms`;
    item.contextValue = 'sfCommand';
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) {
      if (this.order.length === 0) {
        return [new EmptyNode('No commands run yet.')];
      }
      return this.order.map((id) => new CommandNode(this.entries.get(id)!));
    }
    if (node.kind === 'command') return detailsFor(node.entry);
    return [];
  }
}

function detailsFor(e: CommandLogEntry): DetailNode[] {
  const fullCommand = `${e.command} ${e.args.join(' ')}`;
  const details: DetailNode[] = [
    new DetailNode('Command', fullCommand, 'terminal'),
    new DetailNode('Status', e.status, statusIconName(e.status)),
    new DetailNode('Duration', e.durationMs === null ? 'running…' : `${e.durationMs}ms`, 'clock'),
  ];
  if (e.exitCode !== null) {
    details.push(new DetailNode('Exit code', String(e.exitCode), 'symbol-number'));
  }
  details.push(
    new DetailNode('Stdout bytes', String(e.stdoutBytes), 'output'),
    new DetailNode('Stderr bytes', String(e.stderrBytes), 'output'),
  );
  if (e.stderrSnippet) {
    details.push(new DetailNode('stderr', e.stderrSnippet, 'warning'));
  }
  if (e.errorMessage) {
    details.push(new DetailNode('Error', e.errorMessage, 'error'));
  }
  return details;
}

function shortArgs(args: string[]): string {
  const joined = args.join(' ');
  return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
}

function describe(e: CommandLogEntry): string {
  if (e.status === 'running') return 'running…';
  if (e.status === 'error') return `error · ${e.durationMs ?? 0}ms`;
  return `${e.durationMs ?? 0}ms`;
}

function iconForStatus(e: CommandLogEntry): string {
  if (e.status === 'running') return 'sync~spin';
  if (e.status === 'error') return 'error';
  return 'pass';
}

function statusIconName(status: CommandLogEntry['status']): string {
  if (status === 'running') return 'sync~spin';
  if (status === 'error') return 'error';
  return 'pass';
}

export function copyCommandToClipboard(entry: CommandLogEntry): Thenable<void> {
  return vscode.env.clipboard.writeText(`${entry.command} ${entry.args.join(' ')}`);
}
