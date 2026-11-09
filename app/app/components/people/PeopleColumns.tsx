'use client';

// People's Columns menu. Left: the columns showing, in the order the table
// draws them, dragged to reorder (or moved with the arrow buttons) and hidden
// with ×. Right: every column by group, searchable, a checkbox each; a column
// switched on joins the end. Name is locked on and first.

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

export function PeopleColumns({ all, value, onChange, defaults, align = 'right', compact = false, note }: {
  all: ColumnDef[];
  value: string[];
  onChange: (keys: string[]) => void;
  defaults: string[];
  align?: 'left' | 'right';
  /** The trigger: icon and count only. */
  compact?: boolean;
  /** A line under the menu: where these columns are kept. */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const byKey = new Map(all.map((c) => [c.key, c]));
  const shown = value.filter((k) => byKey.has(k));
  const locked = (k: string) => !!byKey.get(k)?.locked;

  const hide = (k: string) => { if (!locked(k)) onChange(shown.filter((x) => x !== k)); };
  const toggle = (c: ColumnDef) => {
    if (c.locked) return;
    onChange(shown.includes(c.key) ? shown.filter((k) => k !== c.key) : [...shown, c.key]);
  };
  /** Put `k` where `target` is (before it when moving up, after it when moving down). Locked columns stay put. */
  const moveTo = (k: string, target: string) => {
    if (k === target || locked(k) || locked(target)) return;
    const from = shown.indexOf(k), to = shown.indexOf(target);
    if (from < 0 || to < 0) return;
    const next = shown.filter((x) => x !== k);
    next.splice(to, 0, k);
    onChange(next);
  };
  const step = (k: string, dir: -1 | 1) => {
    const j = shown.indexOf(k) + dir;
    if (j >= 0 && j < shown.length) moveTo(k, shown[j]);
  };

  const needle = q.trim().toLowerCase();
  const groups = [...GROUPS.map(([g]) => g), 'Custom']
    .map((g) => [g, all.filter((c) => groupOf(c.key) === g && (!needle || c.label.toLowerCase().includes(needle)))] as const)
    .filter(([, cols]) => cols.length);

  const icon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" className={'pp-btn' + (open ? ' is-on' : '')} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
        aria-label={compact ? `Columns, ${shown.length} of ${all.length} showing` : undefined} title="Choose and order the columns">
        {icon}
        {compact ? null : 'Columns'}
        <span className="pp-btn-count">{shown.length}/{all.length}</span>
        <Chevron size={11} dir={open ? 'up' : 'down'} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} role="dialog" aria-label="Columns" className={`cz-menu cz-menu--${align} pp-cols`} style={{ ...menuPanel, [align]: 0 }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
            <div className="pp-cols-order">
              <div className="pp-cols-h">Showing, in order <span className="pp-cols-n">{shown.length}</span></div>
              <ol className="pp-cols-list" aria-label="Columns showing, in order">
                {shown.map((k, i) => {
                  const c = byKey.get(k)!;
                  const fixed = locked(k);
                  return (
                    <li key={k} className="pp-cols-item" data-over={overKey === k && dragKey !== k ? 'true' : undefined} data-dragging={dragKey === k ? 'true' : undefined}
                      draggable={!fixed}
                      onDragStart={(e) => { setDragKey(k); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); }}
                      onDragOver={(e) => { if (dragKey && !fixed) { e.preventDefault(); setOverKey(k); } }}
                      onDragLeave={() => setOverKey((o) => (o === k ? null : o))}
                      onDrop={(e) => { e.preventDefault(); if (dragKey) moveTo(dragKey, k); setDragKey(null); setOverKey(null); }}
                      onDragEnd={() => { setDragKey(null); setOverKey(null); }}>
                      <span className="pp-cols-grip" aria-hidden>{fixed ? '' : '⋮⋮'}</span>
                      <span className="pp-cols-name">{c.label}{fixed ? <span className="pp-cols-lock"> · always first</span> : null}</span>
                      {fixed ? null : (
                        <span className="pp-cols-move">
                          <button type="button" aria-label={`Move ${c.label} up`} onClick={() => step(k, -1)} disabled={i === 0 || locked(shown[i - 1])}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m18 15-6-6-6 6" /></svg>
                          </button>
                          <button type="button" aria-label={`Move ${c.label} down`} onClick={() => step(k, 1)} disabled={i === shown.length - 1}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
                          </button>
                          <button type="button" aria-label={`Hide ${c.label}`} onClick={() => hide(k)} className="pp-cols-x">×</button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="pp-cols-foot">
                <button type="button" className="pp-link" onClick={() => onChange([...defaults])}>Reset</button>
                <button type="button" className="pp-link" onClick={() => onChange([...shown, ...all.map((c) => c.key).filter((k) => !shown.includes(k))])}>Show all</button>
              </div>
            </div>
            <div className="pp-cols-pick">
              <input className="pp-cols-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a column" aria-label="Find a column" />
              <div className="pp-cols-fields">
                {groups.map(([g, cols]) => (
                  <div key={g} role="group" aria-label={g}>
                    <div className="pp-cols-gh">{g}</div>
                    {cols.map((c) => (
                      <label key={c.key} className="pp-cols-field">
                        <input type="checkbox" checked={!!c.locked || shown.includes(c.key)} disabled={c.locked} onChange={() => toggle(c)} />
                        <span className="pp-cols-name">{c.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
                {groups.length ? null : <div className="pp-cols-empty">No column called “{q}”.</div>}
              </div>
            </div>
            {note ? <p className="pp-cols-note">{note}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
