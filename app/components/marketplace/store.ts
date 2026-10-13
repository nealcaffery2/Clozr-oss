'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { SUPABASE_URL } from '@/lib/supabase';
import { streetViewImage } from '@/lib/property-links';
import type { Listing } from '@/lib/marketplace-public';

const BASE = SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/listing';

export const api = {
  feed: (access: string | null) => `${BASE}/market.json${access ? `?access=${encodeURIComponent(access)}` : ''}`,
  async post<T = Record<string, unknown>>(path: 'join' | 'access' | 'inquiry' | 'offer', body: Record<string, unknown>) {
    try {
      const r = await fetch(`${BASE}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({})) as T & { error?: string; join?: boolean };
      return { ok: r.ok, status: r.status, data: j };
    } catch {
      return { ok: false, status: 0, data: { error: 'Could not reach Acme Homes. Check your connection and try again.' } as T & { error?: string; join?: boolean } };
    }
  },
};

export type Access = { token: string; name: string | null; buyerId: number | null };

const ACCESS_KEY = 'hp.market.access';
const SAVED_KEY = 'hp.market.saved';
const listeners = new Set<() => void>();
const ping = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === ACCESS_KEY || e.key === SAVED_KEY) l(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); };
}

const readKey = (key: string) => () => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const writeKey = (key: string, value: string | null) => {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode keeps it for this tab only */ }
  ping();
};

export function useAccess(): Access | null {
  const raw = useSyncExternalStore(subscribe, readKey(ACCESS_KEY), () => '');
  return useMemo(() => {
    try { const a = raw ? JSON.parse(raw) as Access : null; return a?.token ? a : null; } catch { return null; }
  }, [raw]);
}

export const saveAccess = (a: Access | null) => writeKey(ACCESS_KEY, a ? JSON.stringify(a) : null);

export function useSaved(): string[] {
  const raw = useSyncExternalStore(subscribe, readKey(SAVED_KEY), () => '');
  return useMemo(() => {
    try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  }, [raw]);
}

export function toggleSaved(id: string): boolean {
  let list: string[] = [];
  try { list = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]'); } catch { list = []; }
  const on = !list.includes(id);
  writeKey(SAVED_KEY, JSON.stringify(on ? [...list, id] : list.filter((x) => x !== id)));
  return on;
}

/** ?deal= in the address bar is the open listing, so a deal can be linked and Back closes it. */
function subscribeUrl(l: () => void) {
  window.addEventListener('popstate', l);
  window.addEventListener('hp:nav', l);
  return () => { window.removeEventListener('popstate', l); window.removeEventListener('hp:nav', l); };
}

export function useDealParam(): [string | null, (id: string | null) => void] {
  const id = useSyncExternalStore(subscribeUrl, () => new URLSearchParams(window.location.search).get('deal'), () => null);
  const go = (next: string | null) => {
    const u = new URL(window.location.href);
    if (next) u.searchParams.set('deal', next); else u.searchParams.delete('deal');
    window.history.pushState(window.history.state, '', u.pathname + u.search + u.hash);
    window.dispatchEvent(new Event('hp:nav'));
    window.scrollTo({ top: 0 });
  };
  return [id, go];
}

export const dealLink = (id: string) => `${window.location.origin}/marketplace?deal=${encodeURIComponent(id)}`;

const PLACES_KEY = process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY || '';

/**
 * The front of the house from Street View, for an unlocked deal with no photo
 * of its own, the same fallback the CRM's property cards use. Never for a
 * teaser: the address is what a teaser holds back. Null without the Places key.
 */
export function streetPhoto(d: Listing): string | null {
  if (!PLACES_KEY || d.locked || !d.address || d.address === 'Address on request') return null;
  return streetViewImage([d.address, d.city, d.state, d.zip].filter(Boolean).join(', '), PLACES_KEY);
}
