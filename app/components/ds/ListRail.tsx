'use client';

// The smart-list rail beside People and Buyers, and the switch that folds it
// away so the table gets the whole width. Open or shut is remembered per
// screen on this device.

import React, { useState } from 'react';

const KEY = (screen: string) => `clozr.${screen}.rail`;

/** Whether the screen's list rail is open; defaults open. */
export function useRailOpen(screen: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try { return typeof window === 'undefined' || window.localStorage.getItem(KEY(screen)) !== '0'; } catch { return true; }
  });
  const toggle = () => setOpen((was) => {
    const next = !was;
    try { localStorage.setItem(KEY(screen), next ? '1' : '0'); } catch { /* not remembered, still toggles */ }
    return next;
  });
  return [open, toggle];
}

/** Lucide panel-left: the rail's own button hides it, the header's shows it. */
export function RailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? 'Hide lists' : 'Show lists';
  return (
    <button type="button" className="dc2 cz-rail-toggle" onClick={onToggle} aria-label={label} aria-expanded={open} title={label}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
        {open ? <path d="m16 15-3-3 3-3" /> : <path d="m14 9 3 3-3 3" />}
      </svg>
    </button>
  );
}

/** `count` null: not worked out (a saved list counts only while it is open). */
export type RailItem = { id: string; label: string; count: number | null; on: boolean; dot: string; go: () => void; title?: string };

/** One rail row: a dot, the list name and its count; the open list reads as a raised row. */
export function RailRow({ item }: { item: RailItem }) {
  return (
    <button type="button" className="dc2 cz-rail-row" onClick={item.go} aria-current={item.on ? 'page' : undefined} title={item.title}>
      <span className="cz-rail-name">
        <span aria-hidden className="cz-rail-dot" style={{ background: item.dot }} />
        <span className="cz-rail-label">{item.label}</span>
      </span>
      {item.count == null ? null : <span className="cz-rail-count">{item.count.toLocaleString('en-US')}</span>}
    </button>
  );
}
