'use client';

// Collapsible left/right rails on seller and buyer records. Preference
// persists in localStorage like other CLOZR UI prefs.

import { useCallback, useEffect, useState } from 'react';

export type RailPrefs = { left: boolean; right: boolean };

const DEFAULT: RailPrefs = { left: true, right: true };

function read(key: string): RailPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw) as Partial<RailPrefs>;
    return { left: p.left !== false, right: p.right !== false };
  } catch {
    return DEFAULT;
  }
}

function write(key: string, p: RailPrefs) {
  try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* private mode */ }
}

export function useRailPrefs(storageKey = 'clozr.record.rails'): {
  prefs: RailPrefs;
  setRail: (side: 'left' | 'right', open: boolean) => void;
  toggle: (side: 'left' | 'right') => void;
  stretch: (side: 'left' | 'right') => void;
} {
  const [prefs, setPrefs] = useState<RailPrefs>(DEFAULT);
  useEffect(() => {
    const t = setTimeout(() => setPrefs(read(storageKey)), 0);
    return () => clearTimeout(t);
  }, [storageKey]);
  const setRail = useCallback((side: 'left' | 'right', open: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, [side]: open };
      write(storageKey, next);
      return next;
    });
  }, [storageKey]);
  const toggle = useCallback((side: 'left' | 'right') => {
    setPrefs((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      write(storageKey, next);
      return next;
    });
  }, [storageKey]);
  /**
   * Double-click a divider: open that side if it was folded. The other side
   * is never touched; it used to fold, and that stuck in storage, so folding
   * one rail later looked like it took the other with it.
   */
  const stretch = useCallback((side: 'left' | 'right') => {
    setPrefs((prev) => {
      if (prev[side]) return prev;
      const next = { ...prev, [side]: true };
      write(storageKey, next);
      return next;
    });
  }, [storageKey]);
  return { prefs, setRail, toggle, stretch };
}
