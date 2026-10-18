// The two AI entry points that live on screen headers: Lane (the TC assistant)
// and Genius Mode (nearby cash buyers). One look everywhere so they read as
// the same kind of thing.
'use client';

import React, { useState } from 'react';
import { keepInView } from '@/components/ds/keepInView';

const TONE = { lane: '#db2777', genius: '#08694C' } as const;
/** Each one's tint, so the two read as coloured buttons rather than outlines. */
const TINT = { lane: 'var(--c-lane-soft, #fdf2f8)', genius: 'var(--c-genius-soft, #f0faf5)' } as const;

export function AiButton({ kind, onClick, children }: { kind: keyof typeof TONE; onClick: () => void; children?: React.ReactNode }) {
  const c = TONE[kind];
  return (
    <button type="button" className={kind === 'lane' ? 'clozr-lane-chip' : 'dc2'} onClick={onClick} style={{ height: '32px', padding: '0 11px', borderRadius: '8px', border: `1px solid ${c}`, background: TINT[kind], color: c, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px', flex: 'none' }}>
      <span aria-hidden style={{ fontSize: '12px', lineHeight: 1 }}>✦</span>
      {children ?? (kind === 'lane' ? 'Lane' : 'Genius Mode')}
    </button>
  );
}

/** Genius Mode runs on one property, so from a list screen pick it first. */
export function GeniusPicker({ items, label }: { items: { addr: string; city: string; genius: () => void }[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <AiButton kind="genius" onClick={() => setOpen((o) => !o)}>{label}</AiButton>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={keepInView} style={{ position: 'absolute', top: '38px', right: 0, minWidth: '240px', maxHeight: '46vh', overflow: 'auto', background: 'var(--c-menu-bg)', border: '1px solid var(--c-menu-line)', borderRadius: '12px', boxShadow: '0 2px 6px rgba(18,20,28,0.06),0 28px 60px -24px rgba(18,22,45,0.26)', zIndex: 45, padding: '4px' }}>
            <div style={{ padding: '7px 9px 4px', fontSize: '11px', fontWeight: 600, color: 'var(--meta, #71717a)' }}>Find cash buyers near…</div>
            {items.length ? items.map((i, n) => (
              <button key={n} type="button" className="dc2" onClick={() => { setOpen(false); i.genius(); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', border: 0, borderRadius: '7px', background: 'none', cursor: 'pointer', fontSize: '12.5px', color: 'var(--ink-2, #27272a)' }}>
                <span style={{ fontWeight: 600 }}>{i.addr}</span>
                <span style={{ color: 'var(--subtle, #a1a1aa)', marginLeft: '6px' }}>{i.city}</span>
              </button>
            )) : <div style={{ padding: '7px 9px', fontSize: '12.5px', color: 'var(--subtle, #a1a1aa)' }}>No dispo properties yet.</div>}
          </div>
        </>
      ) : null}
    </div>
  );
}
