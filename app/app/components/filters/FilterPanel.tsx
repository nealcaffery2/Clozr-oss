'use client';

// The side filter panel: one "Filters" button on the toolbar, and every filter
// the list has in a panel that slides in from the right, instead of a row of
// chips that wraps across the toolbar. It draws the same menus the chips drew
// (label, options, picked, go), so the filtering itself is the list's own.
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

function Section({ menu }: { menu: FilterMenu }) {
  const [q, setQ] = useState('');
  const long = menu.searchable || menu.options.length > 12;
  const needle = q.trim().toLowerCase();
  const options = long && needle ? menu.options.filter((o) => o.label.toLowerCase().includes(needle)) : menu.options;
  return (
    <fieldset className="cz-fp-section">
      <legend className="cz-fp-label">
        {menu.label}
        {menu.multi ? <span className="cz-fp-hint">Pick any</span> : null}
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

export function FilterPanel({ menus, active, onReset, showLabel, children, onClose }: {
  menus: FilterMenu[];
  /** Filters set, for the button's count. */
  active: number;
  onReset: () => void;
  /** What the done button says: "Show 12 people". */
  showLabel: string;
  /** More sections below the menus (People's stage history, money, market). */
  children?: React.ReactNode;
  /** Runs when the panel closes, to shut any menu the list still holds open. */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); onClose?.(); trigger.current?.focus(); };
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
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
            <div className="cz-fp-body">
              {menus.map((m) => <Section key={m.key} menu={m} />)}
              {children}
            </div>
            <div className="cz-fp-foot">
              <button type="button" className="cz-fp-reset" onClick={onReset} disabled={!active}>Reset</button>
              <button type="button" className="cz-fp-done" onClick={close}>{showLabel}</button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
