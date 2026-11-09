'use client';

// Collapsible, draggable left/right rails on seller and buyer records: open
// or folded, and the width the user dragged each edge to. Preference
// persists in localStorage like other CLOZR UI prefs.

import { useCallback, useEffect, useState } from 'react';

export type Side = 'left' | 'right';
/** `leftW` / `rightW`: px the user dragged to; absent means the CSS default. */
export type RailPrefs = { left: boolean; right: boolean; leftW?: number; rightW?: number };

export const RAIL_MIN = 200;
export const RAIL_MAX = 560;
const DEFAULT: RailPrefs = { left: true, right: true };

const clampW = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(n))) : undefined);

function read(key: string): RailPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw) as Partial<RailPrefs>;
    return { left: p.left !== false, right: p.right !== false, leftW: clampW(p.leftW), rightW: clampW(p.rightW) };
  } catch {
    return DEFAULT;
  }
}

function write(key: string, p: RailPrefs) {
  try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* private mode */ }
}

export function useRailPrefs(storageKey = 'clozr.record.rails'): {
  prefs: RailPrefs;
  setRail: (side: Side, open: boolean) => void;
  toggle: (side: Side) => void;
  /** The width a drag or arrow key set; `persist` false while the pointer is still down. */
  setWidth: (side: Side, px: number, persist?: boolean) => void;
} {
  const [prefs, setPrefs] = useState<RailPrefs>(DEFAULT);
  useEffect(() => {
    const t = setTimeout(() => setPrefs(read(storageKey)), 0);
    return () => clearTimeout(t);
  }, [storageKey]);
  const setRail = useCallback((side: Side, open: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, [side]: open };
      write(storageKey, next);
      return next;
    });
  }, [storageKey]);
  const toggle = useCallback((side: Side) => {
    setPrefs((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      write(storageKey, next);
      return next;
    });
  }, [storageKey]);
  const setWidth = useCallback((side: Side, px: number, persist = true) => {
    setPrefs((prev) => {
      const next = { ...prev, [side === 'left' ? 'leftW' : 'rightW']: clampW(px) };
      if (persist) write(storageKey, next);
      return next;
    });
  }, [storageKey]);
  return { prefs, setRail, toggle, setWidth };
}
