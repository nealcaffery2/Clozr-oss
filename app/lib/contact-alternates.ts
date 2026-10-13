// Who owns a number or an address that is not a record's main one.
//
// The Inbox and the dialer name a thread by matching its number against each
// seller's and buyer's own phone and email. A seller texting from their
// second phone, or a buyer replying from an office address, matched nothing
// and showed as "Not in CLOZR". Those live in seller_phones, buyer_phones and
// buyer_emails (22k and 128k rows, too many to load with the workspace), so
// they are asked for only when a lookup misses: the misses of one render are
// one batched read, and each answer, found or not, is kept for the session.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase';

export type AlternateOwner = { kind: 'seller' | 'buyer'; id: number };

const BATCH = 200;

/** E.164 keys and lowercased emails, as recordForContact keys them. */
export function useAlternateOwners(workspaceId: number | null) {
  // Answers are held with the workspace they were asked in, so a switch
  // starts empty without a reset in an effect.
  const [found, setFound] = useState<{ ws: number | null; map: ReadonlyMap<string, AlternateOwner | null> }>({ ws: null, map: new Map() });
  const state = useRef<LookupState>({ ws: workspaceId, asked: new Set(), pending: new Set(), timer: null, dead: false });

  // A workspace switch drops what was asked and the batch waiting to go.
  useEffect(() => {
    const st = state.current;
    if (st.timer) clearTimeout(st.timer);
    st.dead = true;
    state.current = { ws: workspaceId, asked: new Set(), pending: new Set(), timer: null, dead: false };
    return () => { const cur = state.current; if (cur.timer) clearTimeout(cur.timer); cur.timer = null; };
  }, [workspaceId]);

  /** Every key waiting, a batch at a time. */
  const flush = useCallback(async () => {
    const st = state.current;
    st.timer = null;
    while (st.pending.size && !st.dead) await readBatch(st, setFound);
  }, []);

  /** Asks about a key the main index missed; the answer arrives in `found`. */
  const ask = useCallback((key: string) => {
    const st = state.current;
    if (st.ws == null || !key || st.asked.has(key)) return;
    if (!key.startsWith('+') && !key.includes('@')) return;
    st.asked.add(key);
    st.pending.add(key);
    if (!st.timer) st.timer = setTimeout(() => void flush(), 250);
  }, [flush]);

  const map = found.ws === workspaceId ? found.map : EMPTY;
  return useMemo(() => ({ found: map, ask }), [map, ask]);
}

const EMPTY: ReadonlyMap<string, AlternateOwner | null> = new Map();

/** One workspace's lookups; `dead` once the workspace changes, so a late answer is dropped. */
type LookupState = { ws: number | null; asked: Set<string>; pending: Set<string>; timer: ReturnType<typeof setTimeout> | null; dead: boolean };
type Found = { ws: number | null; map: ReadonlyMap<string, AlternateOwner | null> };

async function readBatch(st: LookupState, setFound: (fn: (cur: Found) => Found) => void): Promise<void> {
  const ws = st.ws;
  const keys = [...st.pending];
  if (!keys.length || ws == null || !supabase) { st.pending.clear(); return; }
  const sb = supabase;
  const phones = keys.filter((k) => k.startsWith('+')).slice(0, BATCH);
  const emails = keys.filter((k) => k.includes('@')).slice(0, BATCH);
  const sent = [...phones, ...emails];
  for (const k of sent) st.pending.delete(k);
  const [sp, bp, be] = await Promise.all([
    phones.length ? sb.from('seller_phones').select('seller_id, phone_key').eq('workspace_id', ws).in('phone_key', phones) : null,
    phones.length ? sb.from('buyer_phones').select('buyer_id, phone_key').eq('workspace_id', ws).in('phone_key', phones) : null,
    emails.length ? sb.from('buyer_emails').select('buyer_id, email_key').eq('workspace_id', ws).in('email_key', emails) : null,
  ]);
  if (st.dead) return;
  const failed = [sp, bp, be].some((r) => r?.error);
  if (failed) {
    // Not "nobody": asked again the next time the number is looked up.
    for (const k of sent) st.asked.delete(k);
    return;
  }
  const next = new Map<string, AlternateOwner | null>();
  for (const k of sent) next.set(k, null);
  // A seller wins over a buyer, as on the main phone.
  for (const r of ((be?.data ?? []) as { buyer_id: number; email_key: string | null }[])) {
    const k = r.email_key ?? '';
    if (k && !next.get(k)) next.set(k, { kind: 'buyer', id: r.buyer_id });
  }
  for (const r of ((bp?.data ?? []) as { buyer_id: number; phone_key: string | null }[])) {
    if (r.phone_key && !next.get(r.phone_key)) next.set(r.phone_key, { kind: 'buyer', id: r.buyer_id });
  }
  for (const r of ((sp?.data ?? []) as { seller_id: number; phone_key: string | null }[])) {
    if (r.phone_key) next.set(r.phone_key, { kind: 'seller', id: r.seller_id });
  }
  setFound((cur) => {
    const merged = new Map(cur.ws === ws ? cur.map : []);
    for (const [k, v] of next) merged.set(k, v);
    return { ws, map: merged };
  });
}
