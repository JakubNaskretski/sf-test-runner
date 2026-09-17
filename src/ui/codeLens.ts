/**
 * CodeLens over Apex `.cls` test classes — the in-editor half of the panel,
 * revived from 0.6.0 now that the Test Explorer's gutter icons are gone.
 *
 *  - class declaration: `▶ Run Class` · `Run with Coverage` (+ last outcome)
 *  - each test method:  `▶ Run` · `Run with Coverage` (+ last outcome)
 *
 * The lenses fire `sfTestRunner.runClass` / `sfTestRunner.runMethod` with a
 * single argument object, so the coverage flag travels with the click instead of
 * depending on what the "with coverage" chip happened to be set to.
 */
import * as vscode from 'vscode';
import { findClassDecl, findTestMethods, hasApexTests } from '../salesforce/testMethods';
import { OutcomeEntry } from '../webview/protocol';
import { PanelState } from './panelState';

/** Argument of the two lens commands. */
export interface RunLensArgs {
  className: string;
  method?: string;
  coverage: boolean;
}

export class ApexTestCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly state: PanelState) {
    // A finished run changes the outcome lens on every open test file; nothing
    // else the store holds is visible here, so only 'run' redraws.
    this.subscription = state.onDidChange((change) => {
      if (change === 'run') this.emitter.fire();
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.toLowerCase().endsWith('.cls')) return [];
    const text = document.getText();
    if (!hasApexTests(text)) return [];

    const lines = text.split(/\r?\n/);
    const cls = findClassDecl(lines);
    if (!cls) return [];
    const methods = findTestMethods(lines, cls.className);
    // `@IsTest` alone is not a test class: every SFDX repo has annotated helpers
    // (TestDataFactory, HttpCalloutMock implementations) with no test methods,
    // and a run button on one can only fail.
    if (methods.length === 0) return [];

    const outcomes = this.state.outcomes();
    const lenses: vscode.CodeLens[] = [];

    const classRange = lineRange(lines, cls.classLine);
    lenses.push(
      runLens(classRange, '▶ Run Class', 'sfTestRunner.runClass', {
        className: cls.className,
        coverage: false,
      }),
      runLens(classRange, 'Run with Coverage', 'sfTestRunner.runClass', {
        className: cls.className,
        coverage: true,
      }),
    );
    const classText = classOutcomeText(
      methods.map((m) => outcomes[`${cls.className}.${m.methodName}`]),
    );
    if (classText) lenses.push(textLens(classRange, classText));

    for (const method of methods) {
      const range = lineRange(lines, method.line);
      const args: RunLensArgs = {
        className: cls.className,
        method: method.methodName,
        coverage: false,
      };
      lenses.push(
        runLens(range, '▶ Run', 'sfTestRunner.runMethod', args),
        runLens(range, 'Run with Coverage', 'sfTestRunner.runMethod', { ...args, coverage: true }),
      );
      const text = methodOutcomeText(outcomes[`${cls.className}.${method.methodName}`]);
      if (text) lenses.push(textLens(range, text));
    }

    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function runLens(
  range: vscode.Range,
  title: string,
  command: string,
  args: RunLensArgs,
): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command, arguments: [args] });
}

/** A lens with no command renders as plain, non-clickable text. */
function textLens(range: vscode.Range, title: string): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command: '' });
}

function methodOutcomeText(entry: OutcomeEntry | undefined): string | undefined {
  if (!entry) return undefined;
  switch (entry.o) {
    case 'pass':
      return `✓ passed ${Math.round(entry.ms)} ms`;
    case 'fail':
      return '✗ failed';
    case 'skip':
      return '• skipped';
    default:
      return '… running';
  }
}

/** One line for the whole class: how many of the methods we know about passed,
 *  and how long they took. Nothing at all before the first run that touched it. */
function classOutcomeText(entries: (OutcomeEntry | undefined)[]): string | undefined {
  const known = entries.filter((e): e is OutcomeEntry => !!e);
  if (known.length === 0) return undefined;
  const passed = known.filter((e) => e.o === 'pass').length;
  const ms = Math.round(known.reduce((sum, e) => sum + (e.ms || 0), 0));
  const mark = passed === known.length ? '✓' : '✗';
  const time = ms > 0 ? ` · ${ms} ms` : '';
  return `${mark} ${passed}/${known.length} passed${time}`;
}

function lineRange(lines: string[], index: number): vscode.Range {
  const line = Math.max(0, index);
  return new vscode.Range(line, 0, line, lines[line]?.length ?? 0);
}
