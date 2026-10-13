// What a list screen was showing — the search, the sort, which board columns
// were opened past "Show more", the columns picked — kept for the session
// while the rep is somewhere else. The shell unmounts a screen when the rep
// moves on, so plain useState came back empty every time they returned to
// Deals or Buyers from a record.
//
// Module memory, not localStorage: it lasts as long as the tab, which is what
// "where I left it" means. A reload starts clean; saved views are what carry a
// look from one session to the next.
'use client';

import { useCallback, useState } from 'react';

const memory = new Map<string, unknown>();
const seen = new Set<string>();

/** What was kept under `key` this session, or `fallback` when nothing was. */
export function recall<T>(key: string, fallback: T): T {
  return memory.has(key) ? (memory.get(key) as T) : fallback;
}

export function remember<T>(key: string, value: T): void {
  memory.set(key, value);
}

/**
 * True the first time `key` is asked about this session, false every time
 * after. Saved views use it to put the open view back once, when the screen
 * first opens, rather than over the rep's changes on every return.
 */
export function firstThisSession(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** useState that comes back the way it was left when the screen mounts again this session. */
export function useRemembered<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => recall(key, initial));
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      memory.set(key, v);
      return v;
    });
  }, [key]);
  return [value, set];
}
