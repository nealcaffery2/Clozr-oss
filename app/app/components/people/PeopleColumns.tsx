'use client';

// People's Columns menu, the way Follow Up Boss lays it out: groups on the
// left with how many of each are showing, the group's fields on the right as
// checkboxes. Shown fields keep their order (the arrows move them); hidden
// ones join the end when switched on. Name is locked on.

import React, { useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';
import { Chevron, menuPanel } from '@/components/ds/chrome';
import type { ColumnDef } from '@/components/ViewControls';
import './people.css';

const GROUPS: [string, string[]][] = [
  ['Details', ['name', 'stage', 'score', 'source', 'tags', 'created', 'nextTask', 'lastComm']],
  ['Property', ['property', 'city', 'zip', 'market', 'condition', 'occupancy']],
  ['Underwriting', ['uwTriage', 'offer', 'asking', 'arv', 'motivation', 'timeline']],
  ['Assigned', ['assigned']],
  ['Contact', ['phone', 'email']],
  ['Deals', ['subs', 'props', 'stack']],
];

const groupOf = (key: string) => GROUPS.find(([, keys]) => keys.includes(key))?.[0] ?? 'Custom';

export function PeopleColumns({ all, value, onChange, defaults, align = 'right', compact = false }: {
  all: ColumnDef[];
  value: string[];
  onChange: (keys: string[]) => void;
  defaults: string[];
  align?: 'left' | 'right';
  /** The rail's trigger: icon and count only. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState('Details');
  const shown = value.filter((k) => all.some((c) => c.key === k));
  const names = [...GROUPS.map(([g]) => g), 'Custom'].filter((g) => all.some((c) => groupOf(c.key) === g));
  const inGroup = all.filter((c) => groupOf(c.key) === group);
  const toggle = (c: ColumnDef) => {
    if (c.locked) return;
    onChange(shown.includes(c.key) ? shown.filter((k) => k !== c.key) : [...shown, c.key]);
  };
  const move = (k: string, dir: -1 | 1) => {
    const i = shown.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shown.length || all.find((c) => c.key === shown[j])?.locked) return;
    const next = [...shown];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const icon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" className={'pp-btn' + (open ? ' is-on' : '')} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}
        aria-label={compact ? `Columns, ${shown.length} of ${all.length} showing` : undefined} title="Choose and order the columns">
        {icon}
        {compact ? null : 'Columns'}
        <span className="pp-btn-count">{shown.length}/{all.length}</span>
        <Chevron size={11} dir={open ? 'up' : 'down'} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="dialog" aria-label="Columns" className={`cz-menu cz-menu--${align} pp-cols`} style={{ ...menuPanel, [align]: 0 }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
            <div className="pp-cols-groups" role="tablist" aria-label="Column groups">
              {names.map((g) => {
                const n = all.filter((c) => groupOf(c.key) === g && shown.includes(c.key)).length;
                return (
                  <button key={g} type="button" role="tab" aria-selected={group === g} className="pp-cols-group" onClick={() => setGroup(g)}>
                    {g}{n ? <span className="pp-cols-n">{n}</span> : null}
                  </button>
                );
              })}
              <div className="pp-cols-foot">
                <button type="button" className="pp-link" onClick={() => onChange(all.map((c) => c.key))}>All</button>
                <button type="button" className="pp-link" onClick={() => onChange([...defaults])}>Reset</button>
              </div>
            </div>
            <div className="pp-cols-fields" role="tabpanel" aria-label={group}>
              {inGroup.map((c) => {
                const on = !!c.locked || shown.includes(c.key);
                const i = shown.indexOf(c.key);
                return (
                  <label key={c.key} className="pp-cols-field">
                    <input type="checkbox" checked={on} disabled={c.locked} onChange={() => toggle(c)} />
                    <span className="pp-cols-name">{c.label}</span>
                    {on && !c.locked ? (
                      <span className="pp-cols-move">
                        <button type="button" aria-label={`Move ${c.label} left`} onClick={() => move(c.key, -1)} disabled={i <= 0 || !!all.find((x) => x.key === shown[i - 1])?.locked}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
                        </button>
                        <button type="button" aria-label={`Move ${c.label} right`} onClick={() => move(c.key, 1)} disabled={i < 0 || i === shown.length - 1}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
                        </button>
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
