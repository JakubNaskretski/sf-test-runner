import * as vscode from 'vscode';

const IS_TEST_RE = /@\s*isTest\b/i;
const CLASS_DECL_RE = /\b(?:public|private|global)\s+(?:with\s+sharing\s+|without\s+sharing\s+|inherited\s+sharing\s+)?(?:virtual\s+|abstract\s+)?class\s+(\w+)/i;

export class ApexTestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.toLowerCase().endsWith('.cls')) return [];

    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    if (!IS_TEST_RE.test(text)) return [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const match = line.text.match(CLASS_DECL_RE);
      if (!match) continue;

      const className = match[1];
      const range = new vscode.Range(i, 0, i, line.text.length);
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) Run Apex Tests',
          command: 'sfTestRunner.runCurrentClass',
          arguments: [document.uri],
        }),
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(eye) Show Coverage',
          command: 'sfTestRunner.refreshCoverage',
          arguments: [document.uri, className],
        }),
      );
      break;
    }

    return lenses;
  }
}
