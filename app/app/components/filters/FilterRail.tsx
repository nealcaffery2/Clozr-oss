'use client';

// The filter rail: every filter a list has, always on screen beside the
// table, grouped by what it narrows (who owns it, where it is in the
// pipeline, where it came from, when, where, how to reach them). It replaced
// the Filters drawer, where a rep clicked Filters, then "Add a filter", then
// the filter, then the option. Here the option is one click.
//
// It draws the same menus the drawer drew (label, options, picked, go), so
// the filtering is the list's own. A short menu shows its options as chips;
// a long one (owners, sources, tags, markets) gets a type-to-find box over a
// short scrolling list. Each block folds, and the fold is remembered per
// browser. On a phone the same body opens as a bottom sheet (FilterSheet).
//
// ActiveFilters is the row over the table: one chip per filter that is on,
// each with its own remove, and Clear all.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FilterMenu } from './FilterPanel';
import './filter-panel.css';
import './filter-rail.css';

export type { FilterMenu };

/** A heading in the rail and the menu keys it holds, in order. */
export type FilterGroup = { title: string; keys: string[] };

/** A section that is not a pick list (date ranges, stage history, money), drawn as given. */
export type FilterExtra = { title: string; node: React.ReactNode };

const ANY = 'Any';
const LONG = 8;

/** What a menu is set to, in words: its picked options, or nothing when it is off. */
export function menuSummary(menu: FilterMenu): string {
  return menu.options.filter((o) => o.on && o.label !== ANY).map((o) => o.label).join(', ');
}

function readFolded(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : undefined }}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const Check = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
);
const XIcon = ({ size = 12 }: { size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
);

/** One filter: its name and what it is set to, then its options, open unless the rep folded it. */
function Block({ menu, folded, onFold }: { menu: FilterMenu; folded: boolean; onFold: () => void }) {
  const [q, setQ] = useState('');
  const anyOpt = menu.options.find((o) => o.label === ANY);
  const options = menu.options.filter((o) => o.label !== ANY);
  const long = !!menu.searchable || options.length > LONG;
  const needle = q.trim().toLowerCase();
  const shown = long && needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  const summary = menuSummary(menu);
  const id = `cz-fr-${menu.key}`;
  return (
    <div className={'cz-fr-block' + (menu.on ? ' is-on' : '')} role="group" aria-labelledby={id + '-h'}>
      <div className="cz-fr-head">
        <button type="button" id={id + '-h'} className="cz-fr-toggle" aria-expanded={!folded} aria-controls={id} onClick={onFold}>
          <span className="cz-fr-label">{menu.label}</span>
          {menu.on && summary ? <span className="cz-fr-value" title={summary}>{summary}</span> : null}
          <Chevron open={!folded} />
        </button>
        {menu.on && anyOpt ? (
          <button type="button" className="cz-fr-clear" onClick={anyOpt.go} aria-label={`Clear the ${menu.label.toLowerCase()} filter`} title="Clear this filter">
            <XIcon />
          </button>
        ) : null}
      </div>
      {folded ? null : (
        <div id={id} className="cz-fr-body">
          {options.length === 0 ? <span className="cz-fp-none">Nothing to pick yet</span> : long ? (
            <>
              <input type="search" className="cz-fp-search cz-fr-search" value={q} onChange={(e) => setQ(e.target.value)}
                placeholder={`Find ${menu.label.toLowerCase()}…`} aria-label={`Find ${menu.label.toLowerCase()}`} />
              <div className="cz-fp-list cz-fr-list">
                {shown.map((o) => (
                  <button key={o.label} type="button" className="cz-fp-row" aria-pressed={o.on} onClick={o.go}>
                    <span className={'cz-fp-box' + (menu.multi ? '' : ' is-radio')} aria-hidden>{o.on ? <Check /> : null}</span>
                    <span className="cz-fp-grow">{o.label}</span>
                    {o.meta ? <span className="cz-fp-meta">{o.meta}</span> : null}
                  </button>
                ))}
                {shown.length === 0 ? <span className="cz-fp-none">Nothing matches “{q.trim()}”</span> : null}
              </div>
            </>
          ) : (
            <div className="cz-fp-chips">
              {options.map((o) => (
                <button key={o.label} type="button" className="cz-fp-chip" aria-pressed={o.on} onClick={o.go} title={o.meta}>{o.label}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The rail's sections: every menu under its group's heading, in the group's order; menus no group names go last. */
function sectionsOf(menus: FilterMenu[], groups: FilterGroup[]) {
  const placed = new Set<string>();
  const out: { title: string; menus: FilterMenu[] }[] = [];
  for (const g of groups) {
    const ms = g.keys.map((k) => menus.find((m) => m.key === k)).filter((m): m is FilterMenu => !!m);
    ms.forEach((m) => placed.add(m.key));
    if (ms.length) out.push({ title: g.title, menus: ms });
  }
  const rest = menus.filter((m) => !placed.has(m.key));
  if (rest.length) out.push({ title: out.length ? 'Other' : 'Filters', menus: rest });
  return out;
}

/** The body the rail and the phone sheet share. */
function FilterBody({ menus, groups, extras, storageKey }: { menus: FilterMenu[]; groups: FilterGroup[]; extras?: FilterExtra[]; storageKey: string }) {
  const key = `clozr.filters.folded.${storageKey}`;
  const [folded, setFolded] = useState<string[]>(() => (typeof window === 'undefined' ? [] : readFolded(key)));
  const fold = (k: string) => setFolded((cur) => {
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* not remembered, still folds */ }
    return next;
  });
  const sections = useMemo(() => sectionsOf(menus, groups), [menus, groups]);
  return (
    <>
      {sections.map((s) => (
        <section key={s.title} className="cz-fr-group" aria-label={s.title}>
          {/* A group of one named the same as its filter (Deal) needs no heading of its own. */}
          {s.menus.length === 1 && s.menus[0].label === s.title ? null : <h3 className="cz-fr-group-h">{s.title}</h3>}
          {s.menus.map((m) => <Block key={m.key} menu={m} folded={folded.includes(m.key)} onFold={() => fold(m.key)} />)}
        </section>
      ))}
      {(extras || []).map((x) => (
        <section key={x.title} className="cz-fr-group cz-fr-extra" aria-label={x.title}>
          <h3 className="cz-fr-group-h">{x.title}</h3>
          {x.node}
        </section>
      ))}
    </>
  );
}

const PanelIcon = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
    {open ? <path d="m16 15-3-3 3-3" /> : <path d="m14 9 3 3-3 3" />}
  </svg>
);

/** Open until this browser folds it away, like the list rail. */
export function useFilterRailOpen(screen: string, openByDefault = true): [boolean, () => void] {
  const key = `clozr.filterRail.${screen}`;
  // Under 1280px the list rail, this rail and the side menu left the table
  // a third of the window, so there it starts folded; a choice the rep made
  // still wins.
  const wide = typeof window === 'undefined' || window.innerWidth >= 1280;
  const fallback = openByDefault && wide;
  const stored = (): boolean => {
    try {
      const v = typeof window === 'undefined' ? null : window.localStorage.getItem(key);
      return v === null ? fallback : v !== '0';
    } catch { return fallback; }
  };
  // Keyed by screen: Buyers switches key once the workspace's profile is known.
  const [state, setState] = useState(() => ({ key, open: stored() }));
  const open = state.key === key ? state.open : stored();
  const toggle = () => {
    const next = !open;
    try { window.localStorage.setItem(key, next ? '1' : '0'); } catch { /* not remembered, still toggles */ }
    setState({ key, open: next });
  };
  return [open, toggle];
}

/** The desk's filter rail. `onHide` folds it away; FilterRailShow brings it back. */
export function FilterRail({ menus, groups, extras, active, onClearAll, onHide, storageKey }: {
  menus: FilterMenu[];
  groups: FilterGroup[];
  extras?: FilterExtra[];
  /** Filters set, for the count beside the title. */
  active: number;
  onClearAll: () => void;
  onHide: () => void;
  /** Which screen's folds to remember. */
  storageKey: string;
}) {
  return (
    <aside className="cz-fr" aria-label="Filters" data-testid="filter-rail">
      <div className="cz-fr-top">
        <h2 className="cz-fr-title">Filters{active ? <span className="cz-fp-count">{active}</span> : null}</h2>
        <button type="button" className="cz-fr-link" onClick={onClearAll} disabled={!active}>Clear all</button>
        <button type="button" className="cz-fr-hide" onClick={onHide} aria-label="Hide filters" aria-expanded title="Hide filters"><PanelIcon open /></button>
      </div>
      <div className="cz-fr-scroll">
        <FilterBody menus={menus} groups={groups} extras={extras} storageKey={storageKey} />
      </div>
    </aside>
  );
}

/** With the rail folded away: the header's way back to it, with how many filters are on. */
export function FilterRailShow({ active, onShow }: { active: number; onShow: () => void }) {
  return (
    <button type="button" className={'cz-fp-trigger' + (active ? ' is-on' : '')} onClick={onShow} aria-expanded={false} title="Show filters">
      <PanelIcon open={false} />
      Filters
      {active ? <span className="cz-fp-count">{active}</span> : null}
    </button>
  );
}

/** Phone only: the rail's body as a bottom sheet, since a phone has no room for a rail. */
export function FilterSheet({ menus, groups, extras, active, onClearAll, showLabel, storageKey, pill = false }: {
  menus: FilterMenu[];
  groups: FilterGroup[];
  extras?: FilterExtra[];
  active: number;
  onClearAll: () => void;
  /** What Done says: "Show 12 people". */
  showLabel: string;
  storageKey: string;
  /** A round tray button, for the phone's sideways-scrolling strip. */
  pill?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (open) sheet.current?.focus(); }, [open]);
  return (
    <>
      <button ref={trigger} type="button" className={'cz-fp-trigger' + (active ? ' is-on' : '') + (pill ? ' cz-fr-pill' : '')} onClick={() => setOpen(true)}
        aria-haspopup="dialog" aria-expanded={open} data-testid="filters-open">
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" /></svg>
        Filters
        {active ? <span className="cz-fp-count">{active}</span> : null}
      </button>
      {open ? (
        <>
          <div className="cz-fr-scrim" onClick={close} />
          <div ref={sheet} role="dialog" aria-modal="true" aria-label="Filters" tabIndex={-1} className="cz-fr-sheet"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
            <div className="cz-fr-top">
              <h2 className="cz-fr-title">Filters{active ? <span className="cz-fp-count">{active}</span> : null}</h2>
              <button type="button" className="cz-fr-link" onClick={onClearAll} disabled={!active}>Clear all</button>
              <button type="button" className="cz-fr-hide" onClick={close} aria-label="Close filters"><XIcon size={14} /></button>
            </div>
            <div className="cz-fr-scroll">
              <FilterBody menus={menus} groups={groups} extras={extras} storageKey={storageKey} />
            </div>
            <div className="cz-fr-foot">
              <button type="button" className="cz-fp-done" onClick={close}>{showLabel}</button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export type ActiveChip = { key: string; label: string; value: string; clear: () => void };

/** One chip per menu that is on, cleared through its own Any. Menus without an Any (modifiers) never chip. */
export function chipsFromMenus(menus: FilterMenu[]): ActiveChip[] {
  return menus.flatMap((m) => {
    const anyOpt = m.options.find((o) => o.label === ANY);
    const value = menuSummary(m);
    return m.on && anyOpt && value ? [{ key: m.key, label: m.label, value, clear: anyOpt.go }] : [];
  });
}

/** The filters that are on, over the table: each one removable, and Clear all. */
export function ActiveFilters({ chips, onClearAll }: { chips: ActiveChip[]; onClearAll: () => void }) {
  if (!chips.length) return null;
  return (
    <div role="group" aria-label="Filters on" className="cz-af">
      {chips.map((c) => (
        <span key={c.key} className="cz-af-chip" title={`${c.label}: ${c.value}`}>
          <span className="cz-af-text"><span className="cz-af-label">{c.label}</span> {c.value}</span>
          <button type="button" className="cz-af-x" onClick={c.clear} aria-label={`Remove the ${c.label.toLowerCase()} filter`}><XIcon size={11} /></button>
        </span>
      ))}
      <button type="button" className="cz-fr-link" onClick={onClearAll}>Clear all</button>
    </div>
  );
}
