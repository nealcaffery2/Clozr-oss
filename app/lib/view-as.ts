// "View as" — an owner or admin sees CLOZR the way a teammate does.
//
// What a teammate can open is decided by their role (lib/team.ts SCREENS), and
// what is "theirs" — My Leads, their tasks, the rep filters — by their user id.
// Rows themselves are workspace-wide under RLS, so rendering the shell with the
// teammate's role and id is what they actually get: the same nav, the same
// screens, the same "my" lists.
//
// It is a preview, so it is read-only: useClozr takes `readOnly` and turns
// every write off, because anything saved here would be stamped with the
// teammate's id rather than the admin's.
//
// Kept in sessionStorage, so it survives a reload and ends with the tab.
'use client';

import { useSyncExternalStore } from 'react';
import type { Role } from './team';

export type ViewAs = { userId: string; role: Role; name: string };

const KEY = 'clozr.viewAs';
const listeners = new Set<() => void>();
let raw: string | null = null;
let snap: ViewAs | null = null;

function read(): ViewAs | null {
  let next: string | null = null;
  try { next = sessionStorage.getItem(KEY); } catch { return snap; }
  if (next === raw) return snap;
  raw = next;
  try { snap = next ? (JSON.parse(next) as ViewAs) : null; } catch { snap = null; }
  return snap;
}

function write(v: ViewAs | null) {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: nothing to remember */ }
  listeners.forEach((l) => l());
}

export const startViewAs = (v: ViewAs) => write(v);
export const stopViewAs = () => write(null);

export function useViewAs(): ViewAs | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => void listeners.delete(cb); },
    read,
    () => null,
  );
}
