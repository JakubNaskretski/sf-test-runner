import * as vscode from 'vscode';
import { TestMethodResult, TestRunSummary } from '../types';

type Node = ClassNode | MethodNode | EmptyNode;

class ClassNode {
  readonly kind = 'class' as const;
  constructor(
    public readonly className: string,
    public readonly methods: TestMethodResult[],
  ) {}
}

class MethodNode {
  readonly kind = 'method' as const;
  constructor(public readonly result: TestMethodResult) {}
}

class EmptyNode {
  readonly kind = 'empty' as const;
  constructor(public readonly message: string) {}
}

export class TestTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private summary: TestRunSummary | null = null;
  private running = false;

  setRunning(running: boolean): void {
    this.running = running;
    this.emitter.fire(undefined);
  }

  setSummary(summary: TestRunSummary): void {
    this.summary = summary;
    this.running = false;
    this.emitter.fire(undefined);
  }

  /** Clear all results (used on org switch so stale results don't linger). */
  reset(): void {
    this.summary = null;
    this.running = false;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(node.message);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    if (node.kind === 'class') {
      // Skip is not a failure — count only genuine failures for the class badge.
      const failed = node.methods.filter(
        (m) => m.outcome === 'Fail' || m.outcome === 'CompileFail',
      ).length;
      const item = new vscode.TreeItem(
        `${node.className} (${node.methods.length - failed}/${node.methods.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(failed > 0 ? 'error' : 'pass');
      item.contextValue = 'class';
      return item;
    }

    const m = node.result;
    const item = new vscode.TreeItem(
      `${m.methodName}  ·  ${m.runTime}ms`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(iconForOutcome(m.outcome));
    item.tooltip = m.message
      ? `${m.outcome}: ${m.message}\n\n${m.stackTrace ?? ''}`
      : m.outcome;
    item.description = m.outcome === 'Pass' ? undefined : m.outcome;
    item.contextValue = 'method';
    item.command = {
      command: 'sfTestRunner.openTestResult',
      title: 'Open Test Result',
      arguments: [m],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node === undefined) {
      if (this.running) {
        return [new EmptyNode('Running tests...')];
      }
      if (!this.summary || this.summary.results.length === 0) {
        return [new EmptyNode('No test results yet. Run tests from an Apex class.')];
      }
      const byClass = new Map<string, TestMethodResult[]>();
      for (const r of this.summary.results) {
        const arr = byClass.get(r.className) ?? [];
        arr.push(r);
        byClass.set(r.className, arr);
      }
      return [...byClass.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, methods]) => new ClassNode(name, methods));
    }

    if (node.kind === 'class') {
      return node.methods.map((m) => new MethodNode(m));
    }
    return [];
  }
}

function iconForOutcome(outcome: TestMethodResult['outcome']): string {
  switch (outcome) {
    case 'Pass':
      return 'pass';
    case 'Fail':
    case 'CompileFail':
      return 'error';
    case 'Skip':
      return 'debug-step-over';
    default:
      return 'circle-outline';
  }
}
