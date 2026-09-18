/**
 * The Tests view, browser side: org toolbar, tabs, search + source filter, the
 * tri-state checkbox tree, the actions bar and the run progress line.
 *
 * Shape of the thing:
 *  - the host is the only source of truth for what exists and what is selected;
 *    every state post re-renders from `TestsViewState` and nothing is inferred
 *    between posts (the checkbox you tick is repainted from the echo, so the
 *    view can never drift from the store);
 *  - what is purely visual — tab, search text, source filter, which classes are
 *    expanded, the tree's scroll position — lives here and is mirrored into
 *    `setState` so a window reload restores it;
 *  - the chrome is built once and updated in place, so focus and caret position
 *    survive a re-render; only the tree is rebuilt, with its scrollTop and the
 *    focused row restored afterwards.
 *
 * Method rows are created only for expanded classes: a few thousand class rows
 * is a fine DOM, a few thousand classes' worth of methods is not. Everything is
 * built with `el()` and text nodes — no innerHTML with org data anywhere.
 */
import type { TestClassEntry, TestMethodEntry, TestSource } from '../types';
import type { OutcomeEntry, TestsViewState, ViewMessage } from './protocol';
import { appRoot, el, fmtElapsed, fmtMs, glyph, vscodeApi } from './shared';

type Tab = 'all' | 'selected';
type SourceFilter = 'all' | TestSource;

/** View-only state, mirrored into the webview's `setState`. */
interface LocalState {
  tab: Tab;
  query: string;
  source: SourceFilter;
  expanded: string[];
  scrollTop: number;
}

/** A class that survived the filters, with the methods that survived with it. */
interface Row {
  entry: TestClassEntry;
  methods: TestMethodEntry[];
  /** Org-only class whose methods were never classified: one checkbox, no caret. */
  unknown: boolean;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'selected', label: 'Selected' },
];

const SOURCES: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'All sources' },
  { id: 'both', label: 'In both' },
  { id: 'local-only', label: 'Local only' },
  { id: 'org-only', label: 'Org only' },
];

const SAVE_DEBOUNCE_MS = 250;

const api = vscodeApi();
const root = appRoot();

let state: TestsViewState | undefined;
let selected = new Set<string>();
const local = restoreLocal();
const expanded = new Set<string>(local.expanded);

let ui: Ui | undefined;
let saveTimer: number | undefined;
let elapsedTimer: number | undefined;
/** Elapsed is ticked here between posts: `progress.elapsedMs` is only a stamp. */
let elapsedBase = 0;
let elapsedAt = 0;

// ─────────────────────────────── local state ────────────────────────────────

function restoreLocal(): LocalState {
  // Our own data, but it can be from an older bundle — validate it like anything
  // else that was written elsewhere.
  const raw = api.getState<Partial<LocalState>>();
  const storedExpanded = raw?.expanded;
  const storedScroll = raw?.scrollTop;
  return {
    tab: raw?.tab === 'selected' ? 'selected' : 'all',
    query: typeof raw?.query === 'string' ? raw.query : '',
    source: SOURCES.some((s) => s.id === raw?.source) ? (raw?.source as SourceFilter) : 'all',
    expanded: Array.isArray(storedExpanded)
      ? storedExpanded.filter((n): n is string => typeof n === 'string')
      : [],
    scrollTop: typeof storedScroll === 'number' && storedScroll >= 0 ? storedScroll : 0,
  };
}

function saveLocal(): void {
  if (saveTimer !== undefined) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    api.setState<LocalState>({
      tab: local.tab,
      query: local.query,
      source: local.source,
      expanded: [...expanded],
      scrollTop: ui ? ui.tree.scrollTop : local.scrollTop,
    });
  }, SAVE_DEBOUNCE_MS);
}

// ────────────────────────────────── helpers ─────────────────────────────────

function post(message: ViewMessage): void {
  api.post(message);
}

function show(node: HTMLElement, on: boolean): void {
  // Inline display beats the stylesheet's `.prod-note { display: flex }`, which
  // a `hidden` attribute would not.
  node.style.display = on ? '' : 'none';
}

/** Mirrors `keysForEntry` in ui/selection.ts — the host prunes against the same
 *  rule, so the two must agree. */
function keysFor(entry: TestClassEntry): string[] {
  if (isUnknown(entry)) return [entry.name];
  return entry.methods.map((m) => `${entry.name}.${m.name}`);
}

function isUnknown(entry: TestClassEntry): boolean {
  return entry.methodsUnknown === true && entry.methods.length === 0;
}

function classState(entry: TestClassEntry): 'none' | 'some' | 'all' {
  const keys = keysFor(entry);
  if (keys.length === 0) return 'none';
  let hits = 0;
  for (const key of keys) if (selected.has(key)) hits++;
  if (hits === 0) return 'none';
  return hits === keys.length ? 'all' : 'some';
}

function hhmm(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function orgLabel(org: { alias?: string; username: string; badge: string }): string {
  return `${org.alias || org.username} [${org.badge}]`;
}

// ───────────────────────────────── filtering ────────────────────────────────

function viewRows(s: TestsViewState): Row[] {
  const q = local.query.trim().toLowerCase();
  const rows: Row[] = [];
  for (const entry of s.index.classes) {
    if (local.source !== 'all' && entry.source !== local.source) continue;
    const nameHit = q.length > 0 && entry.name.toLowerCase().includes(q);
    if (isUnknown(entry)) {
      // Nothing to search inside, and nothing to expand.
      if (q.length > 0 && !nameHit) continue;
      if (local.tab === 'selected' && !selected.has(entry.name)) continue;
      rows.push({ entry, methods: [], unknown: true });
      continue;
    }
    const methods = entry.methods.filter((m) => {
      if (local.tab === 'selected' && !selected.has(`${entry.name}.${m.name}`)) return false;
      if (q.length > 0 && !nameHit && !m.name.toLowerCase().includes(q)) return false;
      return true;
    });
    if (methods.length === 0) continue;
    rows.push({ entry, methods, unknown: false });
  }
  return rows;
}

// ──────────────────────────────── the shell ─────────────────────────────────

interface Ui {
  nodes: HTMLElement[];
  orgSelect: HTMLSelectElement;
  rescan: HTMLButtonElement;
  rescanSpin: HTMLElement;
  fetchOrg: HTMLButtonElement;
  fetchSpin: HTMLElement;
  stamp: HTMLElement;
  prodNote: HTMLElement;
  prodText: HTMLElement;
  tabs: Record<Tab, HTMLButtonElement>;
  search: HTMLInputElement;
  source: HTMLSelectElement;
  counts: HTMLElement;
  tree: HTMLElement;
  activeFile: HTMLButtonElement;
  selCount: HTMLElement;
  clearSel: HTMLButtonElement;
  covChip: HTMLElement;
  covToggle: HTMLInputElement;
  runSelected: HTMLButtonElement;
  runLocal: HTMLButtonElement;
  cancel: HTMLButtonElement;
  runOrg: HTMLButtonElement;
  progress: HTMLElement;
  progText: HTMLElement;
  progElapsed: HTMLElement;
  progBar: HTMLElement;
}

function button(
  cls: string,
  label: string,
  attrs: Record<string, string> = {},
): HTMLButtonElement {
  return el('button', { type: 'button', class: cls, text: label, ...attrs }) as HTMLButtonElement;
}

/** A secondary button that can show a spinner while the host works. */
function busyButton(
  label: string,
  title: string,
): { node: HTMLButtonElement; spin: HTMLElement } {
  const spin = el('span', { class: 'glyph g-run', text: '◐ ' });
  spin.style.display = 'none';
  const node = el('button', { type: 'button', class: 'sec-btn', title }, [
    spin,
    document.createTextNode(label),
  ]) as HTMLButtonElement;
  return { node, spin };
}

function buildShell(): Ui {
  // ── toolbar ──
  const orgSelect = el('select', {
    class: 'org-select',
    'aria-label': 'Target org',
  }) as HTMLSelectElement;
  orgSelect.addEventListener('change', () => {
    if (orgSelect.value) post({ type: 'tests:selectOrg', username: orgSelect.value });
  });
  const refreshOrgs = button('icon-btn', '⟳', {
    title: 'Refresh the org list (sf org list)',
    'aria-label': 'Refresh org list',
  });
  refreshOrgs.addEventListener('click', () => post({ type: 'tests:refreshOrgs' }));
  const login = button('icon-btn', '＋', {
    title: 'Authenticate a new org (sf org login web)',
    'aria-label': 'Log in to a new org',
  });
  login.addEventListener('click', () => post({ type: 'tests:login' }));

  const rescanBtn = busyButton('Rescan', 'Rescan the workspace for *.cls test classes');
  rescanBtn.node.addEventListener('click', () => post({ type: 'tests:rescan' }));
  const fetchBtn = busyButton(
    'Fetch org tests',
    'List the test classes that exist in the org (Tooling API)',
  );
  fetchBtn.node.addEventListener('click', () => post({ type: 'tests:fetchOrg' }));
  const stamp = el('span', { class: 'stamp' });

  const toolbar = el('div', { class: 'toolbar' }, [
    el('div', { class: 'tb-row' }, [
      el('span', { class: 'lbl', text: 'Org:' }),
      orgSelect,
      refreshOrgs,
      login,
    ]),
    el('div', { class: 'tb-row acts' }, [rescanBtn.node, fetchBtn.node, stamp]),
  ]);

  // ── production warning ──
  const prodText = el('span');
  const prodNote = el('div', { class: 'prod-note' }, [el('span', { text: '⚠' }), prodText]);
  show(prodNote, false);

  // ── tabs ──
  const tabButtons = {} as Record<Tab, HTMLButtonElement>;
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Test list view' });
  for (const t of TABS) {
    const node = button('', t.label, { role: 'tab' });
    node.addEventListener('click', () => {
      if (local.tab === t.id) return;
      local.tab = t.id;
      saveLocal();
      render();
    });
    tabButtons[t.id] = node;
    tabs.append(node);
  }

  // ── filters ──
  const search = el('input', {
    type: 'text',
    placeholder: 'Filter tests…',
    'aria-label': 'Filter tests by class or method name',
  }) as HTMLInputElement;
  search.value = local.query;
  search.addEventListener('input', () => {
    local.query = search.value;
    saveLocal();
    render();
  });
  const source = el('select', { 'aria-label': 'Source filter' }) as HTMLSelectElement;
  for (const s of SOURCES) source.append(el('option', { value: s.id, text: s.label }));
  source.value = local.source;
  source.addEventListener('change', () => {
    local.source = (SOURCES.some((s) => s.id === source.value)
      ? source.value
      : 'all') as SourceFilter;
    saveLocal();
    render();
  });
  const counts = el('span', { class: 'stamp' });
  const selCount = el('span', { class: 'selcount', text: '0 selected' });
  const clearSel = button('subtle-btn', '✕', {
    title: 'Clear the selection',
    'aria-label': 'Clear the selection',
  });
  clearSel.addEventListener('click', () => post({ type: 'tests:clearSelection' }));
  const filters = el('div', { class: 'filters' }, [
    search,
    el('div', { class: 'frow' }, [source, counts, selCount, clearSel]),
  ]);

  // ── tree ──
  const tree = el('div', { class: 'tree' });
  tree.addEventListener('click', onTreeClick);
  tree.addEventListener('change', onTreeChange);
  tree.addEventListener('scroll', () => saveLocal(), { passive: true });

  // ── actions ──
  const activeFile = button('sec-btn', 'Select tests for active class', {
    title: 'Tick the tests for the class open in the editor',
  });
  activeFile.addEventListener('click', () => post({ type: 'tests:activeFile' }));
  const covToggle = el('input', {
    type: 'checkbox',
    'aria-label': 'Collect code coverage with the run',
  }) as HTMLInputElement;
  covToggle.addEventListener('change', () =>
    post({ type: 'tests:setRunWithCoverage', on: covToggle.checked }),
  );
  const covChip = el('label', { class: 'cov-chip' }, [covToggle, document.createTextNode(' with coverage')]);
  const runSelected = button('prim-btn', 'Run Selected', {
    title: 'Run the ticked tests (--tests)',
  });
  runSelected.addEventListener('click', () => post({ type: 'tests:run', scope: 'selected' }));
  const runLocal = button('sec-btn', 'All Local', {
    title: 'Run every local test in the org — RunLocalTests',
  });
  runLocal.addEventListener('click', () => post({ type: 'tests:run', scope: 'allLocal' }));
  const runOrg = button('sec-btn', 'All in Org', {
    title: 'Run every test in the org, managed packages included — RunAllTestsInOrg',
  });
  runOrg.addEventListener('click', () => post({ type: 'tests:run', scope: 'allInOrg' }));
  const cancel = button('danger-btn', 'Cancel', { title: 'Cancel the run in flight' });
  cancel.addEventListener('click', () => post({ type: 'tests:cancel' }));
  show(cancel, false);

  const actions = el('div', { class: 'actions stack' }, [
    el('div', { class: 'arow' }, [activeFile, covChip]),
    el('div', { class: 'arow run' }, [runSelected, runLocal, runOrg, cancel]),
  ]);

  // ── progress ──
  const progText = el('span');
  // Ticks once a second; announcing that would drown the counts, so it is left
  // out of the live region.
  const progElapsed = el('span', { class: 'el', text: '00:00', 'aria-hidden': 'true' });
  const progBar = el('i');
  const progress = el('div', { class: 'progress', role: 'status' }, [
    el('div', { class: 'ptext' }, [glyph('running'), progText, progElapsed]),
    el('div', { class: 'pbar' }, [progBar]),
  ]);
  show(progress, false);

  return {
    nodes: [toolbar, prodNote, tabs, filters, tree, actions, progress],
    orgSelect,
    rescan: rescanBtn.node,
    rescanSpin: rescanBtn.spin,
    fetchOrg: fetchBtn.node,
    fetchSpin: fetchBtn.spin,
    stamp,
    prodNote,
    prodText,
    tabs: tabButtons,
    search,
    source,
    counts,
    tree,
    activeFile,
    selCount,
    clearSel,
    covChip,
    covToggle,
    runSelected,
    runLocal,
    cancel,
    runOrg,
    progress,
    progText,
    progElapsed,
    progBar,
  };
}


// ──────────────────────────────── tree events ───────────────────────────────

function toggleExpand(name: string): void {
  if (!expanded.delete(name)) expanded.add(name);
  saveLocal();
  render();
}

/**
 * One delegated click handler for the whole tree: thousands of rows must not
 * mean thousands of closures. A second click (`detail >= 2`) on a name opens the
 * file; the expand the first click did is undone so a double-click leaves the
 * tree where it was.
 */
function onTreeClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  const openable = target.closest('[data-open]');
  if (openable && ev.detail >= 2) {
    const name = openable.getAttribute('data-open');
    if (!name) return;
    const method = openable.getAttribute('data-open-method') ?? undefined;
    post({ type: 'tests:open', name, method });
    if (!method) toggleExpand(name);
    return;
  }

  const caret = target.closest('[data-toggle]');
  if (caret) {
    const name = caret.getAttribute('data-toggle');
    if (name) toggleExpand(name);
    return;
  }
  if (target.closest('input[type="checkbox"]')) return;

  const row = target.closest('.trow');
  if (row?.classList.contains('cls')) {
    const name = row.getAttribute('data-cls');
    if (name) toggleExpand(name);
  }
}

/** Checkbox changes are posted, never applied locally: the next state echo is
 *  what repaints them, so the view cannot drift from the store. */
function onTreeChange(ev: Event): void {
  const box = ev.target as HTMLElement | null;
  if (!box) return;
  const key = box.getAttribute('data-box');
  if (key !== null) {
    post({ type: 'tests:toggleMethod', key });
    return;
  }
  const name = box.getAttribute('data-clsbox');
  if (name !== null) {
    post({ type: 'tests:setClass', name, on: (box as HTMLInputElement).checked });
  }
}

// ───────────────────────────────── rendering ────────────────────────────────

function render(): void {
  const s = state;
  if (!s || !ui) return;
  renderToolbar(s, ui);
  renderTabs(s, ui);
  renderTree(s, ui);
  renderActions(s, ui);
  renderProgress(s, ui);
}

function renderToolbar(s: TestsViewState, u: Ui): void {
  // Rebuild the options only when the list really changed: doing it on every
  // post would close an open dropdown mid-choice.
  const current = s.org?.username ?? '';
  const signature = [current, ...s.orgs.map((o) => `${o.username}\u0000${o.alias}\u0000${o.badge}`)].join('\u0001');
  if (u.orgSelect.dataset.sig !== signature) {
    u.orgSelect.dataset.sig = signature;
    const options: HTMLElement[] = [];
    if (s.orgs.length === 0 && !s.org) {
      options.push(el('option', { value: '', text: 'No orgs — use ＋ to log in' }));
    }
    let seen = false;
    for (const org of s.orgs) {
      if (org.username === current) seen = true;
      options.push(
        el('option', { value: org.username, title: org.username, text: orgLabel(org) }),
      );
    }
    // The store's org can predate the list (first run, or a refresh that failed).
    if (s.org && !seen) {
      options.unshift(
        el('option', { value: s.org.username, title: s.org.username, text: orgLabel(s.org) }),
      );
    }
    u.orgSelect.replaceChildren(...options);
  }
  u.orgSelect.value = current;
  u.orgSelect.disabled = s.orgs.length === 0 && !s.org;

  const prod = s.org?.kind === 'prod';
  show(u.prodNote, prod);
  if (prod && s.org) {
    u.prodText.replaceChildren(
      el('b', { text: s.org.alias || s.org.username }),
      document.createTextNode(' is a production org — every run asks for confirmation first.'),
    );
  }

  const fetchedAt = s.index.orgFetchedAt;
  if (fetchedAt) {
    u.stamp.textContent = `org tests as of ${hhmm(fetchedAt)}`;
    u.stamp.title = s.index.orgUsername
      ? `Fetched from ${s.index.orgUsername} at ${new Date(fetchedAt).toLocaleString()}`
      : new Date(fetchedAt).toLocaleString();
  } else {
    u.stamp.textContent = '';
    u.stamp.title = '';
  }

  setBusy(u.rescan, u.rescanSpin, s.busy.scanning);
  setBusy(u.fetchOrg, u.fetchSpin, s.busy.fetchingOrg);
}

function setBusy(node: HTMLButtonElement, spin: HTMLElement, busy: boolean): void {
  node.disabled = busy;
  node.setAttribute('aria-busy', busy ? 'true' : 'false');
  show(spin, busy);
}

function renderTabs(s: TestsViewState, u: Ui): void {
  const n = s.selection.length;
  for (const t of TABS) {
    const node = u.tabs[t.id];
    const active = local.tab === t.id;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
    node.textContent = t.id === 'selected' && n > 0 ? `Selected (${n})` : t.label;
  }
  if (u.search.value !== local.query) u.search.value = local.query;
  if (u.source.value !== local.source) u.source.value = local.source;
}

function renderTree(s: TestsViewState, u: Ui): void {
  const rows = viewRows(s);
  let methodCount = 0;
  for (const row of rows) methodCount += row.unknown ? 1 : row.methods.length;
  u.counts.textContent = `${rows.length} ${rows.length === 1 ? 'class' : 'classes'} · ${methodCount} ${methodCount === 1 ? 'test' : 'tests'}`;

  const scrollTop = u.tree.scrollTop;
  const focused = focusedFid(u.tree);

  if (rows.length === 0) {
    const empty =
      s.index.classes.length === 0
        ? 'No test classes yet. Rescan the workspace, or Fetch org tests.'
        : 'No tests match this filter.';
    u.tree.replaceChildren(el('div', { class: 'empty', text: empty }));
    return;
  }

  // The org half of the index only exists after an explicit fetch, and that is
  // opt-in. Without it every local class is stamped `local-only` by default, so
  // the "not deployed" badge would be claiming a check that never ran.
  const orgKnown = s.index.orgUsername !== undefined;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    frag.append(classRow(row, orgKnown));
    if (row.unknown || !expanded.has(row.entry.name)) continue;
    for (const method of row.methods) frag.append(methodRow(row.entry, method, s.outcomes));
  }
  u.tree.replaceChildren(frag);
  u.tree.scrollTop = scrollTop;
  if (focused) restoreFocus(u.tree, focused);
}

function classRow(row: Row, orgKnown: boolean): HTMLElement {
  const { entry } = row;
  const open = expanded.has(entry.name);
  const st = classState(entry);
  const node = el('div', {
    class: `trow cls${entry.source === 'org-only' ? ' org-only' : ''}`,
    'data-cls': entry.name,
  });

  if (row.unknown) {
    // No methods to show — keep the caret's width so names stay aligned.
    node.append(el('span', { class: 'caret', 'aria-hidden': 'true' }));
  } else {
    node.append(
      el('button', {
        type: 'button',
        class: 'subtle-btn caret',
        'data-toggle': entry.name,
        'data-fid': `caret:${entry.name}`,
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': `${open ? 'Collapse' : 'Expand'} ${entry.name}`,
        text: open ? '▾' : '▸',
      }),
    );
  }

  const box = el('input', {
    type: 'checkbox',
    'data-clsbox': entry.name,
    'data-fid': `cbox:${entry.name}`,
    'aria-label': row.unknown
      ? `Select ${entry.name}`
      : `Select every test in ${entry.name}`,
  }) as HTMLInputElement;
  box.checked = st === 'all';
  box.indeterminate = st === 'some';
  node.append(box);

  node.append(
    el('span', {
      class: 'name',
      'data-open': entry.name,
      title: entry.source === 'org-only' ? `${entry.name} — org only` : entry.name,
      text: entry.name,
    }),
  );

  if (entry.source === 'org-only') {
    node.append(el('span', { class: 'badge b-org', text: 'org-only' }));
  } else if (orgKnown && entry.source === 'local-only') {
    node.append(
      el('span', {
        class: 'badge b-warn',
        title: 'Not deployed to this org — a run would fail',
        text: 'not deployed',
      }),
    );
  }
  if (row.unknown) {
    // Plain `.badge` is the muted one: this is a note, not a warning.
    node.append(
      el('span', {
        class: 'badge',
        title: 'The org returned no body for this class, so its methods were never listed',
        text: 'unknown methods',
      }),
    );
  }
  node.append(
    el('span', {
      class: 'mcount',
      title: row.unknown ? 'Method list unknown — the class can only be run whole' : 'Test methods',
      text: row.unknown ? '?' : String(entry.methods.length),
    }),
  );
  return node;
}

function methodRow(
  entry: TestClassEntry,
  method: TestMethodEntry,
  outcomes: Record<string, OutcomeEntry>,
): HTMLElement {
  const key = `${entry.name}.${method.name}`;
  const node = el('div', { class: 'trow method', 'data-key': key });
  const box = el('input', {
    type: 'checkbox',
    'data-box': key,
    'data-fid': `mbox:${key}`,
    'aria-label': `${method.name} in ${entry.name}`,
  }) as HTMLInputElement;
  box.checked = selected.has(key);
  node.append(box);
  node.append(
    el('span', {
      class: 'name',
      'data-open': entry.name,
      'data-open-method': method.name,
      title: key,
      text: method.name,
    }),
  );

  const outcome = outcomes[key];
  if (outcome) {
    node.append(glyph(outcome.o));
    if (outcome.o === 'running') node.append(el('span', { class: 'ms', text: '…' }));
    else if (outcome.o !== 'skip') {
      node.append(el('span', { class: 'ms', text: outcome.ms ? fmtMs(outcome.ms) : '—' }));
    }
  }
  return node;
}

function renderActions(s: TestsViewState, u: Ui): void {
  const n = s.selection.length;
  const running = s.busy.running;
  u.selCount.textContent = `${n} selected`;
  show(u.clearSel, n > 0);
  show(u.runSelected, !running);
  show(u.runLocal, !running);
  show(u.runOrg, !running);
  show(u.cancel, running);
  u.runSelected.disabled = n === 0 || running;
  u.activeFile.disabled = running;
  u.runOrg.disabled = running;
  u.covToggle.checked = s.runWithCoverage;
  u.covChip.classList.toggle('on', s.runWithCoverage);
}

function renderProgress(s: TestsViewState, u: Ui): void {
  show(u.progress, s.busy.running);
  if (!s.busy.running) {
    stopElapsed();
    return;
  }
  const org = s.org?.alias || s.org?.username || 'the org';
  const p = s.progress;
  if (!p) {
    // A blocking run reports nothing until it returns. Say so plainly rather
    // than inventing counters or an elapsed time we do not have.
    u.progText.textContent = `Running tests on ${org}…`;
    u.progBar.style.width = '0%';
    show(u.progElapsed, false);
    stopElapsed();
    return;
  }
  const failed = p.failed > 0 ? ` · ${p.failed} failed` : '';
  // The label already names the org ("7 tests on acme-dev").
  u.progText.textContent = `Running ${p.label} · ${p.done}/${p.total}${failed}`;
  u.progBar.style.width = p.total > 0 ? `${Math.round((p.done / p.total) * 100)}%` : '0%';
  show(u.progElapsed, true);
  elapsedBase = p.elapsedMs;
  elapsedAt = Date.now();
  tickElapsed();
  startElapsed();
}

// ──────────────────────────────── elapsed tick ──────────────────────────────

function tickElapsed(): void {
  if (!ui) return;
  ui.progElapsed.textContent = fmtElapsed(elapsedBase + (Date.now() - elapsedAt));
}

function startElapsed(): void {
  if (elapsedTimer !== undefined) return;
  elapsedTimer = window.setInterval(tickElapsed, 1000);
}

function stopElapsed(): void {
  if (elapsedTimer === undefined) return;
  window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}

// ─────────────────────────────── focus keeping ──────────────────────────────

function focusedFid(tree: HTMLElement): string | undefined {
  const active = document.activeElement;
  if (!active || !tree.contains(active)) return undefined;
  return active.getAttribute('data-fid') ?? undefined;
}

function restoreFocus(tree: HTMLElement, fid: string): void {
  // Attribute values are org-supplied names; comparing rather than building a
  // selector keeps the escaping question from arising at all.
  const nodes = tree.querySelectorAll('[data-fid]');
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.getAttribute('data-fid') === fid) {
      (node as HTMLElement).focus({ preventScroll: true });
      return;
    }
  }
}

// ──────────────────────────────────── boot ──────────────────────────────────

function onState(next: TestsViewState): void {
  state = next;
  selected = new Set(next.selection);
  if (!ui) {
    ui = buildShell();
    root.replaceChildren(...ui.nodes);
    render();
    ui.tree.scrollTop = local.scrollTop;
    return;
  }
  render();
}

window.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as { type?: unknown; state?: unknown } | null;
  if (!data || data.type !== 'tests:state' || typeof data.state !== 'object' || !data.state) return;
  onState(data.state as TestsViewState);
});

root.replaceChildren(el('div', { class: 'empty', text: 'Loading tests…' }));
post({ type: 'tests:ready' });
