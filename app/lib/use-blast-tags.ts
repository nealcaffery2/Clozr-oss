// The deal blast labels for the threads on screen (lib/inbox-blast-tags,
// migration 437). One cache for the whole Inbox: the All list, the SMS tab
// and the Email tab each ask for the numbers and addresses they show, and
// only the ones nobody asked about in the last ten minutes go to the
// database, 200 of each per call.
//
// A failed read (the migration not applied yet, a dropped connection) shows
// no labels rather than an error: the Inbox works the same without them.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { type BlastRow, type BlastTag, emailCacheKey, emailKeyOf, missingKeys, phoneCacheKey, phoneKeyOf, tagOf, tagsFromRows } from './inbox-blast-tags';
import { demoBlastRows } from './inbox-demo';

const MAX_AGE = 10 * 60_000;
const PAGE = 200;
/** -1 is the sample data. */
const DEMO_WS = -1;

type Store = { tags: Map<string, BlastTag | null>; at: Map<string, number>; asking: Set<string> };
const stores = new Map<number, Store>();
const storeFor = (ws: number): Store => {
  let s = stores.get(ws);
  if (!s) { s = { tags: new Map(), at: new Map(), asking: new Set() }; stores.set(ws, s); }
  return s;
};
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getVersion = () => version;

async function ask(ws: number, keys: string[]) {
  const s = storeFor(ws);
  for (const k of keys) s.asking.add(k);
  const phones = keys.filter((k) => k.startsWith('p:')).map((k) => k.slice(2));
  const emails = keys.filter((k) => k.startsWith('e:')).map((k) => k.slice(2));
  const found = new Map<string, BlastTag>();
  try {
    for (let i = 0; i < Math.max(phones.length, emails.length); i += PAGE) {
      const { data, error } = await supabase!.rpc('inbox_blast_tags' as never, { ws, phones: phones.slice(i, i + PAGE), emails: emails.slice(i, i + PAGE) } as never);
      if (error) break;
      for (const [k, t] of tagsFromRows((data ?? []) as BlastRow[])) found.set(k, t);
    }
  } catch { /* no labels this time; asked again in ten minutes */ }
  const now = Date.now();
  for (const k of keys) { s.tags.set(k, found.get(k) ?? null); s.at.set(k, now); s.asking.delete(k); }
  // A number matched through its address (or the other way) is kept too.
  for (const [k, t] of found) if (!s.tags.get(k)) { s.tags.set(k, t); s.at.set(k, now); }
  bump();
}

/**
 * `tagFor(phone, email)`: the deals blasted to whoever is on a thread, newest
 * first, or null. `ws` null (signed out) reads nothing; `demo` answers from
 * lib/inbox-demo.
 */
export function useBlastTags(ws: number | null, phones: readonly (string | null | undefined)[], emails: readonly (string | null | undefined)[], demo = false) {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  const keys = useMemo(() => [
    ...phones.map(phoneKeyOf).filter((k): k is string => !!k).map(phoneCacheKey),
    ...emails.map(emailKeyOf).filter((k): k is string => !!k).map(emailCacheKey),
  ].sort().join(','), [phones, emails]);
  const id = demo ? DEMO_WS : ws;
  useEffect(() => {
    if (id == null || !keys) return;
    const s = storeFor(id);
    if (id === DEMO_WS) {
      if (s.at.size) return;
      const now = Date.now();
      for (const [k, t] of tagsFromRows(demoBlastRows(now))) { s.tags.set(k, t); s.at.set(k, now); }
      bump();
      return;
    }
    if (!supabase) return;
    const todo = missingKeys(keys.split(','), s.at, Date.now(), MAX_AGE).filter((k) => !s.asking.has(k));
    if (todo.length) void ask(id, todo);
  }, [id, keys]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- v is the store's version: a new answer re-renders the labels.
  const tagFor = useCallback((phone: string | null | undefined, email?: string | null): BlastTag | null => (id == null ? null : tagOf(storeFor(id).tags, phone, email)), [id, v]);
  return tagFor;
}
