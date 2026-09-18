/**
 * The Coverage view's browser bundle.
 *
 * Renders `CoverageViewState`: the overall bar with the 75% Salesforce deploy
 * floor marked, and the worst-first table of classes. Everything is built with
 * `el()` — no `innerHTML` anywhere near a class name, which arrives from the org.
 *
 * The host owns the data; this file owns only what a reload would otherwise
 * lose: the filter text and the table's scroll position, both in `setState`.
 */
import type { CoverageRow, CoverageViewSnapshot, CoverageViewState } from './protocol';
import { appRoot, covBand, el, vscodeApi } from './shared';

/** Matches `.cov-thresh` / `.cov-thresh-lbl`, which sit at `left: 75%`. */
const FLOOR_TITLE = '75% — Salesforce production deploy floor';
/** Below this many rows a filter box is clutter. */
const FILTER_FROM = 20;

interface LocalState {
  q: string;
  scroll: number;
  /** Whether the "also covered" fold is open; `render()` rebuilds the table on
   *  every state post, and without this a prefs tick would snap it shut. */
  fold: boolean;
}

const api = vscodeApi();
const root = appRoot();

const local: LocalState = normalizeLocal(api.getState<LocalState>());
let current: CoverageViewState = { paint: false };

let filterEl: HTMLInputElement | undefined;
let tableEl: HTMLElement | undefined;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;

function normalizeLocal(stored: LocalState | undefined): LocalState {
  return {
    q: typeof stored?.q === 'string' ? stored.q : '',
    scroll: typeof stored?.scroll === 'number' && stored.scroll >= 0 ? stored.scroll : 0,
    fold: stored?.fold === true,
  };
}

function saveLocal(): void {
  api.setState(local);
}

/** Bar widths are CSS percentages; a malformed percentage must not escape the box. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

function timeOf(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : '';
}

function header(snapshot: CoverageViewSnapshot): HTMLElement {
  // Synthesized "not exercised" rows have no lines, so they must not be counted
  // against `overall`, which is computed over the measured classes only.
  const count = snapshot.rows.filter((r) => !r.unexercised).length;
  const classes = `${count} ${count === 1 ? 'class' : 'classes'}`;
  const fromRun = snapshot.scope !== 'org';
  const source =
    snapshot.scope === 'run'
      ? 'From this run'
      : snapshot.scope === 'loaded'
        ? 'From the run you loaded'
        : 'Stored in the org';
  // The headline is the classes the run was AIMED at, when we know them: the
  // average over everything a run touched is dragged down by call-path classes
  // nobody was asking about. Say where the number is from before saying what it
  // is, too — an unqualified percentage reads as the org's official coverage,
  // which none of these are.
  // A target whose classes have no measurable lines at all leaves `targetOverall`
  // null; there is no headline to make from that, so fall back to the run.
  const targeted =
    snapshot.targetOverall === null
      ? 0
      : snapshot.rows.filter((r) => r.target && !r.unexercised).length;
  const headline =
    targeted > 0
      ? `targets ${snapshot.targetOverall}%` +
        (targeted === 1 ? '' : ` across ${targeted} classes`)
      : snapshot.overall === null
        ? 'no line data'
        : count === 1
          ? `${snapshot.overall}%`
          : `${snapshot.overall}% across ${classes}`;
  const title = el('div', {
    class: 'cov-title',
    text: `${source} · ${headline}`,
    title: `${snapshot.label} · ${snapshot.orgUsername} · ${timeOf(snapshot.at)}`,
  });

  const width = clampPct(
    (targeted > 0 ? snapshot.targetOverall : snapshot.overall) ?? 0,
  );
  const bar = el('div', { class: 'cov-bar-wrap' }, [
    el('i', { class: `band-${covBand(width)}`, style: `width:${width}%` }),
    el('span', { class: 'cov-thresh', title: FLOOR_TITLE }),
    el('span', { class: 'cov-thresh-lbl', title: FLOOR_TITLE, text: '75% deploy floor' }),
  ]);

  const legend = el('div', {
    class: 'cov-legend',
    text: !fromRun
      ? "One class, from whichever run last covered it in the org — any user's, not " +
        'necessarily yours. A production deploy is blocked below 75% org-wide.'
      : targeted > 0
        ? `Whole run: ${snapshot.overall}% across ${classes}. ` +
          'A production deploy is blocked below 75% org-wide.'
        : `Only the ${classes} the run exercised, averaged by line — not the org's ` +
          'overall coverage. Worst first; a production deploy is blocked below 75% org-wide.',
  });

  return el('div', { class: 'cov-overall' }, [title, bar, legend]);
}

function actions(): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = current.paint;
  box.addEventListener('change', () => api.post({ type: 'coverage:setPaint', on: box.checked }));

  const chip = el(
    'label',
    {
      class: `cov-chip${current.paint ? ' on' : ''}`,
      title: 'Paint covered and uncovered lines in the open editor',
    },
    [box, el('span', { text: 'paint in editor' })],
  );

  const clear = el('button', {
    type: 'button',
    class: 'subtle-btn',
    text: 'Clear',
    title: 'Drop this coverage — the table and the painted lines',
  });
  clear.addEventListener('click', () => api.post({ type: 'coverage:clear' }));

  return el('div', { class: 'actions' }, [chip, el('span', { class: 'spacer' }), clear]);
}

function filterBox(): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', {
    type: 'text',
    placeholder: 'Filter classes…',
    'aria-label': 'Filter coverage by class name',
  }) as HTMLInputElement;
  input.value = local.q;
  input.addEventListener('input', () => {
    local.q = input.value;
    saveLocal();
    fillTable();
  });
  return { wrap: el('div', { class: 'filters' }, [input]), input };
}

/** `.cls` or `.trigger` — a run covers triggers, and they open a different file. */
function fileOf(row: CoverageRow): string {
  return `${row.className}.${row.isTrigger ? 'trigger' : 'cls'}`;
}

function rowEl(row: CoverageRow): HTMLElement {
  const band = covBand(row.pct);
  const uncovered = Math.max(0, row.total - row.covered);

  const cloud = el('button', {
    type: 'button',
    class: 'cloud-btn',
    text: '☁',
    title: "Load this class's coverage from the org's last run, any user",
  });
  cloud.addEventListener('click', (event) => {
    // The row itself opens the file; the cloud button must not do both.
    event.stopPropagation();
    api.post({ type: 'coverage:fromOrg', className: row.className });
  });

  const node = el(
    'div',
    {
      class: `cov-row${row.hasSource ? '' : ' nolocal'}${row.unexercised ? ' unexercised' : ''}`,
      title: rowTitle(row),
      role: row.hasSource ? 'button' : undefined,
      tabindex: row.hasSource ? 0 : undefined,
    },
    [
      el('span', { class: 'cname', title: fileOf(row), text: row.className }),
      el('span', { class: `cpct pct-${band}`, text: row.unexercised ? '—' : `${row.pct}%` }),
      el('span', { class: 'cbar' }, [
        el('i', {
          class: `band-${band}`,
          style: `width:${row.unexercised ? 0 : clampPct(row.pct)}%`,
        }),
      ]),
      el('span', {
        class: 'clines',
        text: row.unexercised
          ? 'not exercised'
          : row.hasSource
            ? `${row.covered}/${row.total} · ${uncovered} unc.`
            : 'no local source',
      }),
      cloud,
    ],
  );

  if (row.hasSource) {
    const open = (): void =>
      api.post({
        type: 'coverage:open',
        className: row.className,
        ...(row.isTrigger ? { isTrigger: true } : {}),
      });
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  }
  return node;
}

const TIER_LABEL = {
  declared: 'Declared',
  named: 'By name',
  truncated: 'By truncated name',
} as const;

const TIER_HINT = {
  declared: 'Declared with @IsTest(testFor=…) — the run was meant to cover this.',
  named: 'Inferred from the test class name, and the run did cover it. ' +
    'Add @IsTest(testFor=…) to state it outright.',
  truncated:
    'Inferred from a test class name chopped at 40 characters. ' +
    'Add @IsTest(testFor=…) to state it outright.',
} as const;

function rowTitle(row: CoverageRow): string {
  const where = row.hasSource
    ? `Open ${fileOf(row)}${row.unexercised ? '' : ' with these lines painted'}`
    : 'Org-only — no local source to open';
  if (!row.target) return where;
  const by = `Tested by ${row.target.by.join(', ')}`;
  return `${by}\n${TIER_HINT[row.target.tier]}\n${where}`;
}

/** Refill the table only — keeps the filter box (and its caret) alive while typing. */
function fillTable(): void {
  const table = tableEl;
  const rows = current.snapshot?.rows;
  if (!table || !rows) return;

  const query = local.q.trim().toLowerCase();
  const shown = query ? rows.filter((r) => r.className.toLowerCase().includes(query)) : rows;

  if (shown.length === 0) {
    table.replaceChildren(
      el('div', {
        class: 'empty',
        text: query ? 'No class matches that filter.' : 'This run measured no classes.',
      }),
    );
    return;
  }
  // Lead with what the run was aimed at, grouped by how well we know it, and
  // fold away everything the run merely touched: after running one test class,
  // its class is the answer and the other forty are noise. A filter query
  // searches the whole table, so it renders flat — hiding matches inside a
  // closed fold would look like no match.
  if (query) {
    table.replaceChildren(...shown.map(rowEl));
    table.scrollTop = local.scroll;
    return;
  }
  const rest = shown.filter((r) => !r.target);
  const nodes: HTMLElement[] = [];
  for (const tier of ['declared', 'named', 'truncated'] as const) {
    const band = shown.filter((r) => r.target?.tier === tier);
    if (band.length === 0) continue;
    nodes.push(
      el('div', { class: 'cov-band', title: TIER_HINT[tier] }, [
        el('span', { text: TIER_LABEL[tier] }),
        el('span', { class: 'cov-band-n', text: String(band.length) }),
      ]),
      ...band.map(rowEl),
    );
  }
  if (nodes.length === 0) {
    // Nothing identifiable: the flat worst-first table, exactly as before.
    table.replaceChildren(...rest.map(rowEl));
  } else {
    table.replaceChildren(...nodes, ...(rest.length === 0 ? [] : [fold(rest)]));
  }
  table.scrollTop = local.scroll;
}

/** The collapsed remainder of the table, its open state remembered. The lowest
 *  percentage rides on the summary so a closed fold still warns. */
function fold(rest: CoverageRow[]): HTMLElement {
  const count = rest.length;
  const lowest = Math.min(...rest.map((r) => r.pct));
  const node = el('details', { class: 'cov-rest' }, [
    el('summary', {
      text:
        `Also covered · ${count} ${count === 1 ? 'class' : 'classes'}` +
        (Number.isFinite(lowest) ? ` · lowest ${lowest}%` : ''),
    }),
    ...rest.map(rowEl),
  ]) as HTMLDetailsElement;
  node.open = local.fold;
  node.addEventListener('toggle', () => {
    local.fold = node.open;
    saveLocal();
  });
  return node;
}

function render(): void {
  // A pending scroll save belongs to the table we are about to throw away; its
  // scrollTop would read 0 once detached and clobber the stored position.
  if (scrollTimer) {
    clearTimeout(scrollTimer);
    scrollTimer = undefined;
  }
  const keepFocus = filterEl !== undefined && document.activeElement === filterEl;
  const caret = filterEl?.selectionStart ?? null;
  filterEl = undefined;
  tableEl = undefined;

  const snapshot = current.snapshot;
  if (!snapshot) {
    root.replaceChildren(
      el('div', { class: 'empty', text: 'Run tests with coverage to see it here.' }),
    );
    return;
  }

  const children: HTMLElement[] = [header(snapshot), actions()];
  if (snapshot.rows.length > FILTER_FROM) {
    const filter = filterBox();
    filterEl = filter.input;
    children.push(filter.wrap);
  }

  const table = el('div', { class: 'cov-table' });
  table.addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined;
      local.scroll = table.scrollTop;
      saveLocal();
    }, 150);
  });
  tableEl = table;
  children.push(table);

  root.replaceChildren(...children);
  fillTable();

  if (keepFocus && filterEl) {
    filterEl.focus();
    if (caret !== null) filterEl.setSelectionRange(caret, caret);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: unknown; state?: CoverageViewState } | null;
  if (!message || message.type !== 'coverage:state' || !message.state) return;
  current = message.state;
  render();
});

render();
api.post({ type: 'coverage:ready' });
