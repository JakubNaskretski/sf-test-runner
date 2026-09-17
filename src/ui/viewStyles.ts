/**
 * The panel stylesheet — one sheet shared by all three webview bundles.
 *
 * This is the panel's style block with its `--vs-*` design tokens replaced
 * by real `--vscode-*` theme variables, so the views follow the user's theme
 * instead of hand-picked Light/Dark Modern colours. Class names are
 * kept stable (trow, rrow, cov-row, …) so the design reference stays a
 * readable reference for the view code.
 *
 * Every `var(--vscode-…)` carries a fallback: a few of these tokens are missing
 * in older or partial themes, and an unresolved var collapses the rule.
 */
export const VIEW_STYLES = `
:root {
  --sfr-fg: var(--vscode-foreground, #cccccc);
  --sfr-muted: var(--vscode-descriptionForeground, #9d9d9d);
  --sfr-bg: var(--vscode-sideBar-background, transparent);
  --sfr-border: var(--vscode-panel-border, rgba(128, 128, 128, .35));
  --sfr-hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, .15));
  --sfr-sel: var(--vscode-list-activeSelectionBackground, rgba(58, 125, 200, .25));
  --sfr-btn-bg: var(--vscode-button-background, #0078d4);
  --sfr-btn-fg: var(--vscode-button-foreground, #ffffff);
  --sfr-btn-hover: var(--vscode-button-hoverBackground, #026ec1);
  --sfr-input-bg: var(--vscode-input-background, #313131);
  --sfr-input-fg: var(--vscode-input-foreground, #cccccc);
  --sfr-input-border: var(--vscode-input-border, rgba(128, 128, 128, .4));
  --sfr-pass: var(--vscode-testing-iconPassed, #73c991);
  --sfr-fail: var(--vscode-testing-iconFailed, #f14c4c);
  --sfr-skip: var(--vscode-testing-iconSkipped, #848484);
  --sfr-warn: var(--vscode-editorWarning-foreground, #cca700);
  --sfr-info: var(--vscode-textLink-foreground, #3794ff);
  --sfr-band-hi: var(--vscode-charts-green, #2ea043);
  --sfr-band-mid: var(--vscode-charts-yellow, #cca700);
  --sfr-band-lo: var(--vscode-charts-red, #f14c4c);
  --sfr-progress: var(--vscode-progressBar-background, #0078d4);
  --sfr-track: rgba(128, 128, 128, .25);
  --sfr-ui-font: var(--vscode-font-family, sans-serif);
  --sfr-code-font: var(--vscode-editor-font-family, monospace);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  background: var(--sfr-bg);
  color: var(--sfr-fg);
  font-family: var(--sfr-ui-font);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.45;
  overflow: hidden;
}
.app { display: flex; flex-direction: column; min-height: 0; height: 100vh; }
button { font-family: inherit; }
:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
  border-radius: 2px;
}
.js-check { padding: 8px 10px; color: var(--sfr-fail); font-size: 12px; }

/* ------------------------------- toolbar ------------------------------- */
.toolbar {
  flex: none; padding: 6px 8px; border-bottom: 1px solid var(--sfr-border);
  display: flex; flex-direction: column; gap: 6px;
}
.tb-row { display: flex; align-items: center; gap: 6px; }
.tb-row .lbl { color: var(--sfr-muted); flex: none; }
select, input[type="text"] {
  background: var(--sfr-input-bg); color: var(--sfr-input-fg);
  border: 1px solid var(--sfr-input-border); border-radius: 2px;
  padding: 3px 6px; font-family: inherit; font-size: 12px; min-width: 0;
}
.org-select { flex: 1; }
.icon-btn {
  background: var(--sfr-input-bg); color: var(--sfr-fg);
  border: 1px solid var(--sfr-input-border); border-radius: 2px;
  padding: 2px 7px; cursor: pointer; font-size: 12px; line-height: 18px;
}
.icon-btn:hover { background: var(--sfr-hover); }
.sec-btn {
  background: transparent; color: var(--sfr-fg);
  border: 1px solid var(--sfr-border); border-radius: 2px;
  padding: 3px 9px; cursor: pointer; font-size: 12px;
}
.sec-btn:hover:not(:disabled) { background: var(--sfr-hover); }
.sec-btn:disabled, .prim-btn:disabled, .danger-btn:disabled { opacity: .45; cursor: not-allowed; }
.prim-btn {
  background: var(--sfr-btn-bg); color: var(--sfr-btn-fg);
  border: 1px solid transparent; border-radius: 2px;
  padding: 3px 11px; cursor: pointer; font-size: 12px; font-weight: 500;
}
.prim-btn:hover:not(:disabled) { background: var(--sfr-btn-hover); }
.danger-btn {
  background: var(--sfr-fail); color: #ffffff; border: 1px solid transparent;
  border-radius: 2px; padding: 3px 11px; cursor: pointer; font-size: 12px; font-weight: 500;
}
.subtle-btn {
  background: transparent; border: 0; color: var(--sfr-muted); cursor: pointer;
  font-size: 11px; padding: 0 2px;
}
.subtle-btn:hover { color: var(--sfr-fg); text-decoration: underline; }
.stamp { font-size: 10px; color: var(--sfr-muted); white-space: nowrap; }

.kind-badge {
  font-size: 9px; font-weight: 700; letter-spacing: .03em;
  padding: 1px 4px; border-radius: 2px; border: 1px solid currentColor; flex: none;
}
.kind-dev { color: var(--sfr-info); }
.kind-sandbox { color: var(--sfr-muted); }
.kind-scratch { color: var(--sfr-warn); }
.kind-prod, .kind-unknown { color: var(--sfr-fail); background: rgba(229, 20, 0, .12); }

.prod-note {
  flex: none; display: flex; gap: 6px; align-items: flex-start;
  padding: 5px 10px; font-size: 11px;
  background: rgba(229, 20, 0, .10); color: var(--sfr-fail);
  border-bottom: 1px solid var(--sfr-border);
}

/* -------------------------- tabs, filters, menu ------------------------- */
.tabs {
  flex: none; display: flex; gap: 2px; padding: 4px 8px 0;
  border-bottom: 1px solid var(--sfr-border);
}
.tabs button {
  flex: 1; background: transparent; border: 0; border-bottom: 2px solid transparent;
  color: var(--sfr-muted); cursor: pointer; font-size: 12px; padding: 3px 4px 5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tabs button:hover { color: var(--sfr-fg); background: var(--sfr-hover); }
.tabs button.active { color: var(--sfr-fg); border-bottom-color: var(--sfr-btn-bg); font-weight: 600; }

.filters {
  flex: none; padding: 5px 8px; border-bottom: 1px solid var(--sfr-border);
  display: flex; flex-direction: column; gap: 5px;
}
.filters input[type="text"] { width: 100%; }
.filters .frow { display: flex; align-items: center; gap: 6px; }
.filters select { flex: 1; }

.filter-row {
  padding: 3px 10px 5px; display: flex; gap: 10px; font-size: 11px; flex: none;
  border-bottom: 1px solid var(--sfr-border);
}
.filter-row button {
  background: transparent; border: 0; color: var(--sfr-muted);
  cursor: pointer; font-size: 11px; padding: 0;
}
.filter-row button.active { color: var(--sfr-fg); font-weight: 600; text-decoration: underline; }

.menu-wrap { position: relative; }
.menu {
  position: absolute; right: 0; bottom: 26px; z-index: 12; min-width: 210px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
  border: 1px solid var(--sfr-border);
  border-radius: 4px; padding: 4px 0; box-shadow: 0 2px 10px rgba(0, 0, 0, .36);
  display: none;
}
.menu.open { display: block; }
.menu button {
  display: block; width: 100%; text-align: left; background: transparent; border: 0;
  color: var(--sfr-fg); font-size: 12px; padding: 4px 12px; cursor: pointer;
}
.menu button:hover { background: var(--sfr-sel); }
.menu-sep { display: block; height: 1px; margin: 4px 0; background: var(--sfr-border); }

/* ---------------------------- selection tree ---------------------------- */
.tree { flex: 1 1 auto; min-height: 40px; overflow-y: auto; padding: 3px 0; }
.trow {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 8px; min-height: 22px; cursor: pointer; user-select: none;
}
.trow:hover { background: var(--sfr-hover); }
.trow.method { padding-left: 30px; }
.trow input[type="checkbox"] {
  margin: 0; flex: none; width: 13px; height: 13px; accent-color: var(--sfr-btn-bg);
}
.caret { width: 10px; flex: none; font-size: 9px; color: var(--sfr-muted); text-align: center; }
.trow .name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.trow.cls .name { font-weight: 600; }
.trow.org-only .name { font-style: italic; opacity: .82; }
.badge {
  font-size: 9px; padding: 0 4px; border-radius: 2px; border: 1px solid var(--sfr-border);
  color: var(--sfr-muted); flex: none; white-space: nowrap; line-height: 15px;
}
.badge.b-org { color: var(--sfr-muted); }
.badge.b-warn { color: var(--sfr-warn); border-color: var(--sfr-warn); }
.mcount { font-size: 10px; color: var(--sfr-muted); flex: none; }
.ms {
  font-size: 10px; color: var(--sfr-muted); flex: none;
  font-family: var(--sfr-code-font); font-variant-numeric: tabular-nums;
}
.glyph { flex: none; width: 12px; text-align: center; font-size: 11px; }
.g-pass { color: var(--sfr-pass); }
.g-fail { color: var(--sfr-fail); }
.g-skip { color: var(--sfr-skip); }
.g-run { color: var(--sfr-info); }

/* ------------------------------- actions ------------------------------- */
.actions {
  flex: none; display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
  padding: 7px 8px; border-top: 1px solid var(--sfr-border); border-bottom: 1px solid var(--sfr-border);
}
.actions .spacer { flex: 1; }
.selcount { font-size: 11px; color: var(--sfr-muted); }
.cov-chip {
  display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  font-size: 11px; padding: 2px 7px; border-radius: 10px;
  border: 1px solid var(--sfr-border); color: var(--sfr-muted); user-select: none;
}
.cov-chip.on { color: var(--sfr-fg); border-color: var(--sfr-btn-bg); background: var(--sfr-sel); }
.cov-chip input { margin: 0; width: 12px; height: 12px; accent-color: var(--sfr-btn-bg); }

/* ------------------------------ progress ------------------------------- */
.progress { flex: none; padding: 7px 10px; border-bottom: 1px solid var(--sfr-border); }
.progress .ptext { font-size: 12px; display: flex; align-items: center; gap: 6px; }
.progress .ptext .el {
  margin-left: auto; font-family: var(--sfr-code-font);
  font-variant-numeric: tabular-nums; color: var(--sfr-muted);
}
.pbar { height: 3px; margin-top: 6px; background: var(--sfr-track); border-radius: 2px; overflow: hidden; }
.pbar i { display: block; height: 100%; background: var(--sfr-progress); width: 0; transition: width .25s linear; }

/* ------------------------------- results ------------------------------- */
.pill {
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 9px;
  letter-spacing: .03em; border: 1px solid currentColor; flex: none;
}
.pill.pass { color: var(--sfr-pass); background: rgba(56, 138, 52, .10); }
.pill.fail { color: var(--sfr-fail); background: rgba(229, 20, 0, .10); }
.pill.run { color: var(--sfr-info); }
.runbar {
  display: flex; align-items: center; gap: 7px; padding: 5px 10px;
  font-size: 11.5px; flex: none; border-bottom: 1px solid var(--sfr-border);
}
.runbar .rb-text {
  color: var(--sfr-muted); flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.runbar .ha { display: flex; gap: 6px; flex: none; }
.results { flex: 1 1 auto; overflow-y: auto; padding: 3px 0 4px; }
.rrow {
  padding: 2px 10px; display: flex; align-items: center; gap: 7px;
  min-height: 22px; cursor: pointer; user-select: none;
}
.rrow:hover { background: var(--sfr-hover); }
.rrow .rname {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--sfr-code-font); font-size: 12px;
}
.rrow.rcls .rname { font-weight: 600; font-family: var(--sfr-ui-font); font-size: 12.5px; }
.rrow.method { padding-left: 30px; }
.rsum { font-size: 10.5px; color: var(--sfr-muted); flex: none; font-variant-numeric: tabular-nums; }
.rsum.bad { color: var(--sfr-fail); }
.rdetail { padding: 1px 10px 8px 49px; }
.rmsg {
  font-family: var(--sfr-code-font); font-size: 11.5px; color: var(--sfr-fail);
  white-space: pre-wrap; word-break: break-word; margin-bottom: 4px;
}
.frames { display: flex; flex-direction: column; gap: 1px; }
.frame {
  background: transparent; border: 0; padding: 0; text-align: left; cursor: pointer;
  font-family: var(--sfr-code-font); font-size: 11.5px; color: var(--sfr-info);
  width: fit-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.frame:hover { text-decoration: underline; }
/* The frame the user last jumped to, so the tree says where the editor is. */
.frame.active { text-decoration: underline; background: var(--sfr-sel); }
.frame.dead { color: var(--sfr-muted); cursor: default; }
.frame.dead:hover { text-decoration: none; }

/* ------------------------------- coverage ------------------------------ */
.cov-overall { padding: 6px 10px 8px; flex: none; }
.cov-overall .cov-title { font-size: 11.5px; margin-bottom: 5px; }
.cov-bar-wrap {
  position: relative; height: 10px; background: var(--sfr-track);
  border-radius: 2px; overflow: visible;
}
.cov-bar-wrap i { display: block; height: 100%; border-radius: 2px; }
.cov-thresh { position: absolute; top: -3px; bottom: -3px; left: 75%; width: 2px; background: var(--sfr-fg); opacity: .75; }
.cov-thresh-lbl {
  position: absolute; left: 75%; top: 12px; transform: translateX(-50%);
  font-size: 9.5px; color: var(--sfr-muted); white-space: nowrap;
}
.cov-legend { margin-top: 20px; font-size: 10.5px; color: var(--sfr-muted); }
.cov-table { flex: 1 1 auto; overflow-y: auto; }
.cov-row {
  display: flex; align-items: center; gap: 8px; padding: 3px 10px;
  min-height: 24px; cursor: pointer;
}
.cov-row:hover { background: var(--sfr-hover); }
.cov-row .cname {
  width: 126px; flex: none; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 12px;
}
.cov-row.nolocal { cursor: default; }
.cov-row.nolocal .cname { color: var(--sfr-muted); font-style: italic; }
.cov-row .cpct {
  width: 32px; flex: none; text-align: right; font-family: var(--sfr-code-font);
  font-size: 11px; font-variant-numeric: tabular-nums;
}
.cov-row .cbar { flex: 1; min-width: 34px; height: 6px; background: var(--sfr-track); border-radius: 2px; overflow: hidden; }
.cov-row .cbar i { display: block; height: 100%; }
.cov-row .clines {
  width: 98px; flex: none; text-align: right; font-size: 10.5px; color: var(--sfr-muted);
  font-family: var(--sfr-code-font); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.band-hi { background: var(--sfr-band-hi); }
.band-mid { background: var(--sfr-band-mid); }
.band-lo { background: var(--sfr-band-lo); }
.pct-hi { color: var(--sfr-band-hi); }
.pct-mid { color: var(--sfr-band-mid); }
.pct-lo { color: var(--sfr-band-lo); }
.cloud-btn {
  flex: none; background: transparent; border: 0; color: var(--sfr-muted);
  cursor: pointer; padding: 0 2px; line-height: 1;
}
.cloud-btn:hover { color: var(--sfr-fg); }

/* -------------------------------- empty -------------------------------- */
.empty, .empty-state { padding: 9px 12px 11px; font-size: 12px; color: var(--sfr-muted); flex: none; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
