/**
 * Browser-side helpers shared by the three webview bundles. No `vscode` import —
 * this code runs in the webview, where the only bridge to the host is
 * `acquireVsCodeApi()`.
 */
import type { OutcomeKind, ViewMessage } from './protocol';

declare function acquireVsCodeApi(): VsCodeApi;

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface ViewApi {
  /** Post a typed message to the extension host. */
  post(message: ViewMessage): void;
  /** Webview-local state: survives a view reload, unlike the DOM. Use it for
   *  view-only things (tab, search text, collapsed rows) — anything the host
   *  must act on belongs in PanelState. */
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

let api: VsCodeApi | undefined;

/** `acquireVsCodeApi` may be called only once per webview load, so it is cached. */
export function vscodeApi(): ViewApi {
  if (!api) api = acquireVsCodeApi();
  const handle = api;
  return {
    post: (message) => handle.postMessage(message),
    getState: <T>() => handle.getState() as T | undefined,
    setState: (state) => handle.setState(state),
  };
}

/** Durations the way the views show them: `96 ms`, `3.4 s`, `1 m 12 s`. */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** `mm:ss`, for the elapsed counter on the progress line. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export type ElAttrs = Record<string, string | number | boolean | undefined>;

/**
 * Tiny DOM builder. `class`/`title`/`type`… are set as attributes; `text` sets
 * textContent (never innerHTML — results carry org data). A false/undefined
 * value drops the attribute.
 */
export function el(tag: string, attrs: ElAttrs = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'text') {
      node.textContent = String(value);
      continue;
    }
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/** The glyph + class pair the views use for an outcome. */
export const GLYPHS: Record<OutcomeKind, { mark: string; cls: string }> = {
  pass: { mark: '✓', cls: 'g-pass' },
  fail: { mark: '✗', cls: 'g-fail' },
  skip: { mark: '•', cls: 'g-skip' },
  running: { mark: '◍', cls: 'g-run' },
};

export function glyph(kind: OutcomeKind): HTMLElement {
  const { mark, cls } = GLYPHS[kind];
  return el('span', { class: `glyph ${cls}`, text: mark });
}

/** The three coverage bands: ≥75 green, 50–74 amber, <50 red. */
export function covBand(pct: number): 'hi' | 'mid' | 'lo' {
  if (pct >= 75) return 'hi';
  return pct >= 50 ? 'mid' : 'lo';
}

/** The view's root container, created by the HTML shell. */
export function appRoot(): HTMLElement {
  const root = document.getElementById('app');
  if (!root) throw new Error('panel shell missing #app');
  return root;
}
