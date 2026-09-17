/**
 * The Results view's browser bundle: run bar → All/Failed filter → one tree of
 * class nodes with their methods, failures expanded in place with the message
 * and every parsed stack frame as a clickable button.
 *
 * Two rules shape the code:
 *  - `render(state, ui)` is a pure function of the host state plus the view-local
 *    UI state (collapsed classes, filter, active frame, scroll). Every handler
 *    mutates one of those and calls it again; nothing else touches the DOM.
 *  - Results text (class names, messages, stack traces) comes from the org, so
 *    it is only ever set as `textContent` via `el()` — never as HTML.
 *
 * `parseStackLine` is imported straight from the extension's stack parser: it is
 * pure TypeScript with no `vscode` import, so esbuild bundles it into this file
 * and the host and the panel agree on what a frame is.
 */
import type { RunRecord, TestMethodResult } from '../types';
import { parseStackLine } from '../salesforce/stackParser';
import { liveResultRows } from '../ui/liveOutcomes';
import type { OutcomeKind, ResultsFilter, ResultsHostMessage, ResultsViewState } from './protocol';
import { appRoot, el, fmtElapsed, fmtMs, glyph, vscodeApi } from './shared';

/** View-local state. Survives a webview reload through `getState`/`setState`;
 *  anything the host must know about (the filter) is mirrored to it as well. */
interface UiState {
  filter: ResultsFilter;
  /** Class names the user folded away. */
  collapsed: string[];
  /** `Class.method#index` of the frame last clicked, highlighted in the tree. */
  activeFrame?: string;
  scrollTop: number;
  /** Last nonces acted on — see `applyNonces`. */
  seenExpand?: number;
  seenCollapse?: number;
}

interface ClassGroup {
  name: string;
  methods: TestMethodResult[];
  pass: number;
  fail: number;
  /** Sum of the methods' run times. */
  ms: number;
  compileFail: boolean;
}

const api = vscodeApi();
const root = appRoot();

const ui: UiState = restoreUi();
let current: ResultsViewState = { filter: ui.filter };
/** Live-run elapsed counter: ticks locally so `mm:ss` moves between host posts. */
let ticker: number | undefined;
let elapsedTarget: HTMLElement | undefined;
let scrollSave: number | undefined;

// ────────────────────────────── ui state ──────────────────────────────

function restoreUi(): UiState {
  const stored = api.getState<Partial<UiState>>();
  const collapsed = stored?.collapsed;
  return {
    filter: stored?.filter === 'failed' ? 'failed' : 'all',
    collapsed: Array.isArray(collapsed) ? collapsed.filter(isString) : [],
    activeFrame: typeof stored?.activeFrame === 'string' ? stored.activeFrame : undefined,
    scrollTop: typeof stored?.scrollTop === 'number' ? stored.scrollTop : 0,
    seenExpand: typeof stored?.seenExpand === 'number' ? stored.seenExpand : undefined,
    seenCollapse: typeof stored?.seenCollapse === 'number' ? stored.seenCollapse : undefined,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function saveUi(): void {
  api.setState(ui);
}

/**
 * The expand-all / collapse-all view-title commands travel as counters rather
 * than as a boolean, so a plain state refresh cannot re-collapse what the user
 * just opened: act only when the number differs from the one last seen. The
 * first state to arrive only records the values — it must not fold anything.
 */
function applyNonces(state: ResultsViewState): void {
  const expand = state.expandAllNonce ?? 0;
  const collapse = state.collapseAllNonce ?? 0;
  const first = ui.seenExpand === undefined || ui.seenCollapse === undefined;
  if (!first && expand !== ui.seenExpand) ui.collapsed = [];
  if (!first && collapse !== ui.seenCollapse) {
    ui.collapsed = groupResults(treeResults(state)).map((group) => group.name);
  }
  ui.seenExpand = expand;
  ui.seenCollapse = collapse;
}

// ─────────────────────────────── grouping ───────────────────────────────

function isFailure(result: TestMethodResult): boolean {
  return result.outcome === 'Fail' || result.outcome === 'CompileFail';
}

function outcomeKind(result: TestMethodResult): OutcomeKind {
  if (result.outcome === 'Pass') return 'pass';
  if (result.outcome === 'Skip') return 'skip';
  return 'fail';
}

/**
 * What the tree is built from: the final summary once it exists, and until then
 * the poller's live outcomes, so a run does not sit on an empty view while it
 * executes. A live row carries no message or stack trace — those arrive with the
 * summary, and the render path below is the same either way.
 */
function treeResults(state: ResultsViewState): TestMethodResult[] {
  return state.run?.summary?.results ?? liveResultRows(state.live);
}

/** One node per class, classes in the order the run first reported them. */
function groupResults(results: readonly TestMethodResult[]): ClassGroup[] {
  const groups: ClassGroup[] = [];
  const byName = new Map<string, ClassGroup>();
  for (const result of results) {
    let group = byName.get(result.className);
    if (!group) {
      group = { name: result.className, methods: [], pass: 0, fail: 0, ms: 0, compileFail: false };
      byName.set(result.className, group);
      groups.push(group);
    }
    group.methods.push(result);
    group.ms += Number.isFinite(result.runTime) ? result.runTime : 0;
    if (result.outcome === 'Pass') group.pass++;
    if (isFailure(result)) group.fail++;
    if (result.outcome === 'CompileFail') group.compileFail = true;
  }
  return groups;
}

function countFailed(groups: ClassGroup[]): number {
  return groups.reduce((total, group) => total + group.fail, 0);
}

// ──────────────────────────────── render ────────────────────────────────

function render(state: ResultsViewState, view: UiState): void {
  stopTicker();
  elapsedTarget = undefined;

  const run = state.run;
  if (!run) {
    root.replaceChildren(emptyState());
    return;
  }

  const groups = groupResults(treeResults(state));
  const failed = countFailed(groups);
  // A filter of 'failed' with nothing failing would show an empty view for a
  // green run, so it falls back to 'all' — the button is disabled to match.
  const filter: ResultsFilter = failed > 0 ? state.filter : 'all';

  const list = resultsList(run, groups, filter, view);
  root.replaceChildren(...runBar(run, groups, failed), filterRow(filter, failed > 0), list);

  list.scrollTop = view.scrollTop;
  if (run.status === 'running') startTicker(run);
}

function emptyState(): HTMLElement {
  const load = el('button', {
    type: 'button',
    class: 'subtle-btn',
    text: 'Load recent run…',
  });
  load.addEventListener('click', () => api.post({ type: 'results:loadRecent' }));
  return el('div', { class: 'empty-state' }, [
    el('div', { text: 'No run yet. Pick tests in the Tests view and Run.' }),
    load,
  ]);
}

// ──────────────────────────────── run bar ───────────────────────────────

function runBar(run: RunRecord, groups: ClassGroup[], failed: number): Node[] {
  const bar = el('div', { class: 'runbar' });
  const nodes: Node[] = [bar];

  const summary = run.summary;
  const ran = summary?.testsRan ?? groups.reduce((n, group) => n + group.methods.length, 0);
  const passed = summary?.passing ?? groups.reduce((n, group) => n + group.pass, 0);

  if (run.status === 'running') {
    bar.append(el('span', { class: 'pill run', text: '◐ RUNNING' }));
    const text = el('span', { class: 'rb-text', text: runningText(run) });
    elapsedTarget = text;
    bar.append(text);
    return nodes;
  }

  if (run.status === 'error') {
    bar.append(el('span', { class: 'pill fail', text: 'ERROR' }));
    bar.append(el('span', { class: 'rb-text', text: `${run.label} · ${run.orgAlias}` }));
    nodes.push(
      el('div', { class: 'rdetail' }, [
        el('div', { class: 'rmsg', text: run.error ?? 'The run failed before any test reported.' }),
      ]),
    );
    return nodes;
  }

  if (run.status === 'cancelled') {
    bar.append(el('span', { class: 'pill g-skip', text: 'CANCELLED' }));
    bar.append(
      el('span', {
        class: 'rb-text',
        text: `${passed}/${ran} passed · ${run.orgAlias}${finishedSuffix(run)}`,
      }),
    );
    bar.append(actionButtons(run, failed));
    nodes.push(
      el('div', {
        class: 'empty',
        text: 'Cancelled locally — a job already queued in the org may still finish there.',
      }),
    );
    return nodes;
  }

  const ok = run.status === 'passed';
  bar.append(el('span', { class: `pill ${ok ? 'pass' : 'fail'}`, text: ok ? 'PASS' : 'FAIL' }));
  const parts = [`${passed}/${ran} passed`];
  const failing = summary?.failing ?? failed;
  if (failing > 0) parts.push(`${failing} failed`);
  parts.push(fmtMs(totalMs(run)), run.orgAlias);
  bar.append(el('span', { class: 'rb-text', text: parts.join(' · ') + finishedSuffix(run) }));
  bar.append(actionButtons(run, failed));
  return nodes;
}

function actionButtons(run: RunRecord, failed: number): HTMLElement {
  const holder = el('span', { class: 'ha' });
  if (failed > 0) {
    const rerun = el('button', { type: 'button', class: 'subtle-btn', text: 'Re-run failed' });
    rerun.addEventListener('click', () => api.post({ type: 'results:rerunFailed' }));
    holder.append(rerun);
  }
  if (run.summary) {
    const copy = el('button', { type: 'button', class: 'subtle-btn', text: 'Copy' });
    copy.addEventListener('click', () => api.post({ type: 'results:copySummary' }));
    holder.append(copy);
  }
  return holder;
}

function totalMs(run: RunRecord): number {
  const reported = run.summary?.testTotalTime;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported;
  return run.finishedAt ? run.finishedAt - run.startedAt : 0;
}

function finishedSuffix(run: RunRecord): string {
  return run.finishedAt ? ` · finished ${hhmm(run.finishedAt)}` : '';
}

function hhmm(at: number): string {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

function runningText(run: RunRecord): string {
  const done = run.progress?.done ?? run.summary?.results.length ?? 0;
  const total = run.progress?.total ?? 0;
  const counted = total > 0 ? `${done}/${total} done` : `${done} done`;
  return `${counted} · ${fmtElapsed(Date.now() - run.startedAt)}`;
}

function startTicker(run: RunRecord): void {
  ticker = window.setInterval(() => {
    if (elapsedTarget) elapsedTarget.textContent = runningText(run);
  }, 1000);
}

function stopTicker(): void {
  if (ticker === undefined) return;
  window.clearInterval(ticker);
  ticker = undefined;
}

// ───────────────────────────────  filter  ───────────────────────────────

function filterRow(active: ResultsFilter, hasFailures: boolean): HTMLElement {
  const row = el('div', { class: 'filter-row' });
  row.append(filterButton('all', 'All', active, false));
  row.append(filterButton('failed', 'Failed', active, !hasFailures));
  return row;
}

function filterButton(
  filter: ResultsFilter,
  label: string,
  active: ResultsFilter,
  disabled: boolean,
): HTMLElement {
  const button = el('button', {
    type: 'button',
    class: filter === active ? 'active' : undefined,
    text: label,
    disabled,
    title: disabled ? 'Nothing failed in this run' : undefined,
  });
  if (!disabled) {
    button.addEventListener('click', () => {
      // Repaint at once, then let the host echo the stored filter back.
      ui.filter = filter;
      saveUi();
      api.post({ type: 'results:setFilter', filter });
      current = { ...current, filter };
      render(current, ui);
    });
  }
  return button;
}

// ────────────────────────────────  tree  ────────────────────────────────

function resultsList(
  run: RunRecord,
  groups: ClassGroup[],
  filter: ResultsFilter,
  view: UiState,
): HTMLElement {
  const host = el('div', { class: 'results' });
  host.addEventListener('scroll', () => rememberScroll(host));

  let shown = 0;
  for (const group of groups) {
    const methods = filter === 'failed' ? group.methods.filter(isFailure) : group.methods;
    if (methods.length === 0) continue;
    shown++;
    const open = !view.collapsed.includes(group.name);
    host.append(classRow(group, open, run));
    if (!open) continue;
    for (const result of methods) {
      host.append(methodRow(group, result));
      if (isFailure(result)) {
        const detail = failureDetail(result, view);
        if (detail) host.append(detail);
      }
    }
  }

  if (shown === 0) {
    host.append(
      el('div', {
        class: 'empty-state',
        text:
          run.status === 'running'
            ? 'Waiting for the first results…'
            : groups.length === 0
              ? 'The run reported no test results.'
              : 'No test matches this filter.',
      }),
    );
  }
  return host;
}

function classRow(group: ClassGroup, open: boolean, run: RunRecord): HTMLElement {
  const kind: OutcomeKind =
    group.fail > 0 ? 'fail' : run.status === 'running' ? 'running' : 'pass';
  const children: Node[] = [
    el('span', { class: 'caret', text: open ? '▾' : '▸' }),
    glyph(kind),
    el('span', { class: 'rname', text: group.name }),
  ];
  if (group.compileFail) children.push(el('span', { class: 'badge b-warn', text: 'CompileFail' }));
  children.push(
    el('span', {
      class: group.fail > 0 ? 'rsum bad' : 'rsum',
      text: `${group.pass}/${group.methods.length} passed`,
    }),
    el('span', { class: 'ms', text: group.ms > 0 ? fmtMs(group.ms) : '—' }),
  );

  const row = el(
    'div',
    {
      class: 'rrow rcls',
      role: 'button',
      tabindex: '0',
      'aria-expanded': open ? 'true' : 'false',
      title: open ? `Collapse ${group.name}` : `Expand ${group.name}`,
    },
    children,
  );
  onActivate(row, () => toggleClass(group.name));
  return row;
}

function toggleClass(name: string): void {
  ui.collapsed = ui.collapsed.includes(name)
    ? ui.collapsed.filter((other) => other !== name)
    : [...ui.collapsed, name];
  saveUi();
  render(current, ui);
}

function methodRow(group: ClassGroup, result: TestMethodResult): HTMLElement {
  const children: Node[] = [
    glyph(outcomeKind(result)),
    el('span', { class: 'rname', text: result.methodName }),
  ];
  if (result.outcome === 'CompileFail') {
    children.push(el('span', { class: 'badge b-warn', text: 'CompileFail' }));
  }
  children.push(
    el('span', { class: 'ms', text: result.runTime > 0 ? fmtMs(result.runTime) : '—' }),
  );

  const row = el(
    'div',
    {
      class: 'rrow method',
      role: 'button',
      tabindex: '0',
      title: `Open ${group.name}.cls`,
    },
    children,
  );
  onActivate(row, () =>
    api.post({ type: 'results:open', className: group.name, method: result.methodName }),
  );
  return row;
}

/** Message + every parsed stack frame, in place under the failed method. */
function failureDetail(result: TestMethodResult, view: UiState): HTMLElement | undefined {
  const frames = parseFrames(result.stackTrace);
  if (!result.message && frames.length === 0) return undefined;

  const children: Node[] = [];
  if (result.message) children.push(el('div', { class: 'rmsg', text: result.message }));
  if (frames.length > 0) {
    const holder = el('div', { class: 'frames' });
    frames.forEach((frame, index) => {
      const key = `${result.className}.${result.methodName}#${index}`;
      holder.append(frameButton(frame, key, view.activeFrame === key));
    });
    children.push(holder);
  }
  return el('div', { class: 'rdetail' }, children);
}

interface ParsedFrame {
  className: string;
  method?: string;
  line: number;
  isTrigger: boolean;
  /** The stack line exactly as the org wrote it — shown as the button's title. */
  raw: string;
}

/** Every source frame of the trace, in order, keeping the raw line for the title. */
function parseFrames(stackTrace: string | null): ParsedFrame[] {
  if (!stackTrace) return [];
  const frames: ParsedFrame[] = [];
  for (const raw of stackTrace.split(/\r?\n/)) {
    const frame = parseStackLine(raw);
    if (frame) frames.push({ ...frame, raw: raw.trim() });
  }
  return frames;
}

function frameButton(frame: ParsedFrame, key: string, active: boolean): HTMLElement {
  const label = frame.method
    ? `${frame.className}.${frame.method}:${frame.line}`
    : `${frame.className}:${frame.line}`;
  const button = el('button', {
    type: 'button',
    class: active ? 'frame active' : 'frame',
    'aria-current': active ? 'true' : undefined,
    title: frame.raw,
    text: label,
  });
  button.addEventListener('click', () => {
    ui.activeFrame = key;
    saveUi();
    // Repaint just the highlight: a full render would drop focus mid-click.
    root.querySelectorAll('.frame').forEach((other) => {
      other.classList.remove('active');
      other.removeAttribute('aria-current');
    });
    button.classList.add('active');
    button.setAttribute('aria-current', 'true');
    api.post({
      type: 'results:open',
      className: frame.className,
      method: frame.method,
      line: frame.line,
      isTrigger: frame.isTrigger,
    });
  });
  return button;
}

// ───────────────────────────────  plumbing  ─────────────────────────────

/** Click, plus Enter/Space for the rows that are divs rather than buttons. */
function onActivate(node: HTMLElement, run: () => void): void {
  node.addEventListener('click', run);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    run();
  });
}

function rememberScroll(host: HTMLElement): void {
  if (scrollSave !== undefined) window.clearTimeout(scrollSave);
  scrollSave = window.setTimeout(() => {
    scrollSave = undefined;
    ui.scrollTop = host.scrollTop;
    saveUi();
  }, 150);
}

window.addEventListener('message', (event: MessageEvent<ResultsHostMessage>) => {
  const message = event.data;
  if (!message || message.type !== 'results:state' || !message.state) return;
  applyNonces(message.state);
  current = message.state;
  ui.filter = message.state.filter;
  saveUi();
  render(current, ui);
});

root.replaceChildren(el('div', { class: 'empty', text: 'Loading results…' }));
api.post({ type: 'results:ready' });
