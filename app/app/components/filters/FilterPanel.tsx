'use client';

// The side filter panel: one "Filters" button on the toolbar, and a panel
// that slides in from the right. It opens the way Follow Up Boss's does: an
// "Add a filter" box at the top, "No filters added yet" underneath, and each
// filter the rep adds stacks as a row they can set and remove. A filter that
// is already narrowing the list is a row from the start. It draws the same
// menus the chips drew (label, options, picked, go), so the filtering itself
// is the list's own.
//
// A menu with a handful of options shows them as chips; a long one (owners,
// submitters, tags) gets a type-to-filter box over a scrolling list.

import React, { useEffect, useRef, useState } from 'react';
import './filter-panel.css';

export type FilterMenu = {
  key: string;
  label: string;
  multi?: boolean;
  searchable?: boolean;
  on: boolean;
  options: { label: string; on: boolean; go: () => void; meta?: string }[];
};

function Section({ menu, onRemove }: { menu: FilterMenu; onRemove: () => void }) {
  const [q, setQ] = useState('');
  const long = menu.searchable || menu.options.length > 12;
  const needle = q.trim().toLowerCase();
  const options = long && needle ? menu.options.filter((o) => o.label.toLowerCase().includes(needle)) : menu.options;
  return (
    <fieldset className="cz-fp-section">
      <legend className="cz-fp-label">
        {menu.label}
        {menu.multi ? <span className="cz-fp-hint">Pick any</span> : null}
        <button type="button" className="cz-fp-remove" onClick={onRemove} aria-label={`Remove the ${menu.label.toLowerCase()} filter`} title="Remove this filter">
          <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </legend>
      {long ? (
        <>
          <input type="search" className="cz-fp-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${menu.label.toLowerCase()}`} aria-label={`Search ${menu.label.toLowerCase()}`} />
          <div className="cz-fp-list">
            {options.map((o) => (
              <button key={o.label} type="button" className="cz-fp-row" aria-pressed={o.on} onClick={o.go}>
                <span className={'cz-fp-box' + (menu.multi ? '' : ' is-radio')} aria-hidden>
                  {o.on ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg> : null}
                </span>
                <span className="cz-fp-grow">{o.label}</span>
                {o.meta ? <span className="cz-fp-meta">{o.meta}</span> : null}
              </button>
            ))}
            {options.length === 0 ? <span className="cz-fp-none">Nothing matches “{q.trim()}”</span> : null}
          </div>
        </>
      ) : (
        <div className="cz-fp-chips">
          {options.map((o) => (
            <button key={o.label} type="button" className="cz-fp-chip" aria-pressed={o.on} onClick={o.go}>{o.label}</button>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function FilterPanel({ menus, active, onReset, showLabel, children, onClose, moreLabel = 'More filters', moreActive = 0 }: {
  menus: FilterMenu[];
  /** Filters set, for the button's count. */
  active: number;
  onReset: () => void;
  /** What the done button says: "Show 12 people". */
  showLabel: string;
  /** More sections below the menus (People's stage history, money, market), under a disclosure. */
  children?: React.ReactNode;
  /** Runs when the panel closes, to shut any menu the list still holds open. */
  onClose?: () => void;
  moreLabel?: string;
  /** How many of the children's filters are set, so the disclosure says so while shut. */
  moreActive?: number;
}) {
  const [open, setOpen] = useState(false);
  // Filters the rep added this session but has not set yet; a set filter is a row on its own.
  const [added, setAdded] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); setQ(''); onClose?.(); trigger.current?.focus(); };
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  const rows = menus.filter((m) => m.on || added.includes(m.key));
  const needle = q.trim().toLowerCase();
  const choices = menus.filter((m) => !rows.includes(m) && (!needle || m.label.toLowerCase().includes(needle)));
  const add = (m: FilterMenu) => { setAdded((a) => [...a, m.key]); setQ(''); };
  const remove = (m: FilterMenu) => {
    setAdded((a) => a.filter((k) => k !== m.key));
    // Putting the filter back to Any is what takes it off the list.
    if (m.on) m.options.find((o) => o.label === 'Any')?.go();
  };
  return (
    <>
      <button ref={trigger} type="button" className={'cz-fp-trigger' + (active ? ' is-on' : '')} onClick={() => setOpen(!open)}
        aria-haspopup="dialog" aria-expanded={open} data-testid="filters-open">
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" /></svg>
        Filters
        {active ? <span className="cz-fp-count">{active}</span> : null}
      </button>
      {open ? (
        <>
          <div className="cz-fp-scrim" onClick={close} />
          <div ref={panel} role="dialog" aria-label="Filters" tabIndex={-1} className="cz-fp"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
            <div className="cz-fp-head">
              <h2>Filters</h2>
              <button type="button" className="cz-fp-x" onClick={close} aria-label="Close filters">
                <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="cz-fp-add">
              <label className="cz-fp-add-label" htmlFor="cz-fp-add">Add a filter</label>
              <input id="cz-fp-add" type="search" className="cz-fp-search" value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Owner, stage, source, heat…" autoComplete="off"
                onKeyDown={(e) => { if (e.key === 'Enter' && choices[0]) { e.preventDefault(); add(choices[0]); } }} />
              {choices.length ? (
                <div className="cz-fp-choices" role="listbox" aria-label="Filters you can add">
                  {choices.map((m) => (
                    <button key={m.key} type="button" role="option" aria-selected={false} className="cz-fp-choice" onClick={() => add(m)}>
                      <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                      {m.label}
                    </button>
                  ))}
                </div>
              ) : needle ? <span className="cz-fp-none">No filter called “{q.trim()}”</span> : null}
            </div>
            <div className="cz-fp-body">
              {rows.length === 0 ? (
                <div className="cz-fp-empty">
                  <svg aria-hidden width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
                  <span>No filters added yet</span>
                  <span className="cz-fp-empty-hint">Pick one above. Every lead shows until you do.</span>
                </div>
              ) : rows.map((m) => <Section key={m.key} menu={m} onRemove={() => remove(m)} />)}
              {children ? (
                <details className="cz-fp-more" open={moreActive > 0}>
                  <summary>
                    {moreLabel}{moreActive ? <span className="cz-fp-count">{moreActive}</span> : null}
                    <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                  </summary>
                  <div className="cz-fp-more-body">{children}</div>
                </details>
              ) : null}
            </div>
            <div className="cz-fp-foot">
              <button type="button" className="cz-fp-reset" onClick={() => { onReset(); setAdded([]); }} disabled={!active}>Reset</button>
              <button type="button" className="cz-fp-done" onClick={close}>{showLabel}</button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
