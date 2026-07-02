import * as vscode from 'vscode';
import { findClassDecl, findTestMethods, hasApexTests } from '../salesforce/testMethods';

/**
 * CodeLens over Apex `.cls` test classes:
 *  - On the class declaration: "Run Apex Tests" (whole class) + "Show Coverage".
 *  - On each `@IsTest` method: "Run Test Method" → `sf apex run test --tests
 *    Class.method`.
 */
export class ApexTestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.toLowerCase().endsWith('.cls')) return [];

    const text = document.getText();
    if (!hasApexTests(text)) return [];

    const lines = text.split(/\r?\n/);
    const cls = findClassDecl(lines);
    if (!cls) return [];

    const lenses: vscode.CodeLens[] = [];
    const classRange = new vscode.Range(cls.classLine, 0, cls.classLine, lineLen(lines, cls.classLine));
    lenses.push(
      new vscode.CodeLens(classRange, {
        title: '$(play) Run Apex Tests',
        command: 'sfTestRunner.runCurrentClass',
        arguments: [document.uri],
      }),
    );
    lenses.push(
      new vscode.CodeLens(classRange, {
        title: '$(eye) Show Coverage',
        command: 'sfTestRunner.refreshCoverage',
        arguments: [document.uri, cls.className],
      }),
    );

    for (const method of findTestMethods(lines, cls.className)) {
      const range = new vscode.Range(method.line, 0, method.line, lineLen(lines, method.line));
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) Run Test Method',
          command: 'sfTestRunner.runTestMethod',
          arguments: [cls.className, method.methodName],
        }),
      );
    }

    return lenses;
  }
}

function lineLen(lines: string[], i: number): number {
  return lines[i]?.length ?? 0;
}
