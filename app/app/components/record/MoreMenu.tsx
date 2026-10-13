'use client';

// More ▾: everything that moved off the record's page. Each item opens the
// Record details sheet at its section, or goes where the item names (the deal
// sheet, the TC's closing file). Arrow keys move, Escape closes and hands
// focus back to the button.

import React, { useEffect, useRef, useState } from 'react';
import { Chevron, CZ } from '@/components/ds/chrome';
import { ghostBtn, menuPanel } from './ui';

export type MoreItem = { key: string; label: string; note?: string; group?: string; run: () => void };

export function MoreMenu({ items, mobile }: { items: MoreItem[]; mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const els = [...(list.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
      if (!els.length) return;
      e.preventDefault();
      const i = els.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
      els[next].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div style={{ position: 'relative', flex: mobile ? 1 : 'none', display: 'flex' }}>
      <button ref={btn} type="button" className="rec-press rec-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ ...ghostBtn, ...(mobile ? { flex: 1, height: '36px' } : {}), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
        More <Chevron size={11} color={CZ.faint} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={list} role="menu" aria-label="More on this record" className="cz-menu cz-menu--right"
            style={{ ...menuPanel, position: 'absolute', top: mobile ? '40px' : '34px', right: 0, zIndex: 45, minWidth: '248px', maxHeight: 'min(460px, 60vh)', overflow: 'auto' }}>
            {items.map((it, i) => {
              const head = it.group && it.group !== items[i - 1]?.group;
              return (
                <div key={it.key}>
                  {head ? (
                    <div className="cz-menu-head" style={{ paddingTop: i === 0 ? 4 : 10 }}>
                      {it.group}
                    </div>
                  ) : null}
                  <button type="button" role="menuitem" data-more={it.key} className="rec-item cz-menu-item" style={mobile ? { minHeight: '44px' } : undefined}
                    onClick={() => { setOpen(false); btn.current?.focus(); it.run(); }}>
                    <span>{it.label}</span>
                    {it.note ? <span className="cz-menu-meta">{it.note}</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
