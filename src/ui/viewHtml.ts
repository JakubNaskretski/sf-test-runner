/**
 * The HTML shell the three webview views render into.
 *
 * Deliberately NOT the kit's `getWebviewHtml`: that helper mints its own nonce
 * and links an external stylesheet, while these views share one stylesheet that
 * is generated in TypeScript (viewStyles.ts) and inlined, and each provider
 * mints the nonce per render so it can be reused for the whole render pass. The
 * CSP below is the same strict policy — `default-src 'none'`, scripts only via
 * the nonce — with `'unsafe-inline'` added to `style-src` for that one inline
 * <style>. The nonce still comes from the kit's CSPRNG `getNonce`, re-exported
 * here so providers do not roll their own.
 */
import * as vscode from 'vscode';
import { getNonce } from '../kit/webviewHtml';
import { ViewBundle } from '../webview/protocol';
import { VIEW_STYLES } from './viewStyles';

export { getNonce };

const TITLES: Record<ViewBundle, string> = {
  tests: 'Apex Tests',
  results: 'Test Results',
  coverage: 'Apex Coverage',
};

/**
 * @param nonce per-render nonce from {@link getNonce}; must be fresh for every
 *              call to `resolveWebviewView`/`html =`.
 */
export function getViewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bundle: ViewBundle,
  nonce: string,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', `${bundle}.js`),
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<title>${TITLES[bundle]}</title>
<style>${VIEW_STYLES}</style>
</head>
<body>
<!-- Replaced by the bundle's first render; visible only if the script never boots. -->
<div id="app" class="app"><div class="js-check">Panel script failed to load.</div></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
