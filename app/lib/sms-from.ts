// Which of the org's lines a text goes out from.
//
// One choice for the whole CRM, shown and changeable on every texting box: the
// record composer, the quick text popup, bulk texts and buyer texts. lib/sms
// reads it on every send, so a box that forgets to pass it still honours it.
// Null is "my default line", which Talkr resolves (the rep's default number).
// Remembered per browser, like the rest of a rep's composer preferences.
'use client';

import { useSyncExternalStore } from 'react';
import { talkr, talkrToken, type MeDto } from './talkr';

const KEY = 'clozr.smsFrom';
export type SmsLine = MeDto['org_numbers'][number];

let current: string | null = null;
try { current = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) || null : null; } catch { /* private mode */ }
const listeners = new Set<() => void>();

/** The chosen line's Talkr id, or null for the rep's default. */
export function getSmsFrom(): string | null {
  return current;
}

export function setSmsFrom(id: string | null) {
  current = id || null;
  try {
    if (current) localStorage.setItem(KEY, current);
    else localStorage.removeItem(KEY);
  } catch { /* private mode */ }
  for (const l of listeners) l();
}

export function useSmsFrom(): [string | null, (id: string | null) => void] {
  const v = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
    () => null,
  );
  return [v, setSmsFrom];
}

// ---- the lines ----------------------------------------------------------------

type Lines = { lines: SmsLine[]; defaultId: string | null; error: string | null };
let loaded: Lines | null = null;
let loading: Promise<Lines> | null = null;
const lineListeners = new Set<() => void>();

/** The org's lines, read once per page load from Talkr's /v1/me. */
export function loadSmsLines(force = false): Promise<Lines> {
  if (loaded && !force) return Promise.resolve(loaded);
  if (loading && !force) return loading;
  // Nobody signed in (the /demo sample) has no lines to read: no request, no 401 in the console.
  loading = talkrToken()
    .then((token) => (token ? talkr.me() : null))
    .then((me) => ({ lines: me?.org_numbers ?? [], defaultId: me?.default_phone_number_id ?? null, error: null }))
    .catch((e: unknown) => ({ lines: [], defaultId: null, error: e instanceof Error ? e.message : 'Could not read your lines from Talkr.' }))
    .then((r) => {
      loaded = r;
      // A remembered line the org no longer has falls back to the default.
      if (current && r.lines.length && !r.lines.some((n) => n.id === current)) setSmsFrom(null);
      for (const l of lineListeners) l();
      return r;
    });
  return loading;
}

export function useSmsLines(): Lines | null {
  return useSyncExternalStore(
    (cb) => { lineListeners.add(cb); void loadSmsLines(); return () => lineListeners.delete(cb); },
    () => loaded,
    () => null,
  );
}
