// The tab list of an agent. A vertical, grouped list beside the pane on a wide
// screen; a scrolling row of pills on a phone. Arrow keys move between tabs and
// select as they go, Home and End jump to the ends.
'use client';

import React, { useEffect, useRef } from 'react';
import type { TabId } from '@/lib/voice-agent-console';
import { GREEN, INK, MUTED } from './kit';
import type { SectionDef } from './sections';

export function SectionNav({ sections, active, onSelect, dirty, errors, vertical }: {
  sections: SectionDef[]; active: TabId; onSelect: (id: TabId) => void; dirty: Set<TabId>; errors: Partial<Record<TabId, number>>; vertical: boolean;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (vertical) return;
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const box = list.current;
    if (el && box) box.scrollTo({ left: el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' });
  }, [active, vertical]);

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const fwd = vertical ? 'ArrowDown' : 'ArrowRight'; const back = vertical ? 'ArrowUp' : 'ArrowLeft';
    let n = -1;
    if (e.key === fwd || e.key === (vertical ? 'ArrowRight' : 'ArrowDown')) n = (i + 1) % sections.length;
    else if (e.key === back || e.key === (vertical ? 'ArrowLeft' : 'ArrowUp')) n = (i - 1 + sections.length) % sections.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = sections.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onSelect(sections[n]!.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[n]?.focus();
  };

  const groups: { name: string; items: { s: SectionDef; i: number }[] }[] = [];
  sections.forEach((s, i) => {
    let g = groups[groups.length - 1];
    if (!g || g.name !== s.group) { g = { name: s.group, items: [] }; groups.push(g); }
    g.items.push({ s, i });
  });

  const tab = (s: SectionDef, i: number) => {
    const on = s.id === active;
    const errs = errors[s.id] ?? 0;
    return (
      <button key={s.id} type="button" role="tab" id={`va-tab-${s.id}`} aria-selected={on} aria-controls={`va-pane-${s.id}`} tabIndex={on ? 0 : -1} className="va-tab va-nav"
        onClick={() => onSelect(s.id)} onKeyDown={(e) => onKey(e, i)}
        style={vertical ? {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 34, padding: '0 10px', border: 0, borderRadius: 8, cursor: 'pointer', textAlign: 'left',
          font: '600 13px/1.2 var(--font-sans)', background: on ? 'var(--surface, #fff)' : 'transparent', color: on ? GREEN : INK,
          boxShadow: on ? `inset 3px 0 0 ${GREEN}, var(--elev-1)` : 'none',
        } : {
          display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', height: 34, padding: '0 13px', border: `1px solid ${on ? GREEN : 'var(--divider, #e4e4e7)'}`, borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
          font: '600 12.5px/1 var(--font-sans)', background: on ? 'var(--ok-bg)' : 'var(--surface, #fff)', color: on ? GREEN : INK,
          boxShadow: on ? '0 0 0 1px var(--ok-line), var(--elev-1)' : 'var(--elev-1)',
        }}>
        <span style={{ flex: vertical ? 1 : undefined }}>{s.label}</span>
        {errs ? <span aria-label={`${errs} ${errs === 1 ? 'problem' : 'problems'}`} style={{ minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 10.5, fontWeight: 700, display: 'grid', placeItems: 'center' }}>{errs}</span> : null}
        {s.settings && dirty.has(s.id) ? <span aria-label="unsaved changes" style={{ width: 7, height: 7, borderRadius: 999, background: '#f59e0b', flex: 'none' }} /> : null}
      </button>
    );
  };

  if (!vertical) {
    return (
      <div ref={list} role="tablist" aria-label="Agent sections" className="va-noscroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 0 4px', margin: '0 -2px' }}>
        {sections.map((s, i) => tab(s, i))}
      </div>
    );
  }
  return (
    <div ref={list} role="tablist" aria-label="Agent sections" aria-orientation="vertical" style={{ display: 'grid', gap: 14, alignContent: 'start', padding: '12px 8px', background: 'var(--rail)', border: '1px solid var(--rail-line)', borderRadius: 12, boxShadow: 'var(--elev-inset)' }}>
      {groups.map((g) => (
        <div key={g.name} role="presentation">
          <div role="presentation" style={{ padding: '0 10px 4px', fontSize: 11, color: MUTED, fontWeight: 600 }}>{g.name}</div>
          <div role="presentation" style={{ display: 'grid', gap: 1 }}>{g.items.map(({ s, i }) => tab(s, i))}</div>
        </div>
      ))}
    </div>
  );
}
