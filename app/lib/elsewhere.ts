// A number the open workspace has no record for, found in another workspace
// this person belongs to (Acme Homes sellers texting a Compr line, and the
// other way round). For labels only: a composer must never take a record from
// another workspace, so this is kept apart from recordForContact.
//
// Lookups are batched and cached per tab; row-level security limits the read
// to the caller's own workspaces.
'use client';

import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';

export type Elsewhere = { kind: 'seller' | 'buyer'; id: number; name: string; workspaceId: number; workspaceName: string };
type Hit = { kind: 'seller' | 'buyer'; id: number; name: string | null; workspace_id: number; phone_key: string };

/** One record per number: a seller wins over a buyer, then the oldest workspace, then the oldest record. */
export function pickElsewhere(hits: readonly Hit[], names: ReadonlyMap<number, string>): Map<string, Elsewhere> {
  const out = new Map<string, Elsewhere>();
  const rank = (h: Hit) => [h.kind === 'seller' ? 0 : 1, h.workspace_id, h.id];
  const sorted = [...hits].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
  for (const h of sorted) {
    if (out.has(h.phone_key)) continue;
    out.set(h.phone_key, {
      kind: h.kind, id: h.id, name: h.name?.trim() || (h.kind === 'seller' ? 'Seller' : 'Buyer'),
      workspaceId: h.workspace_id, workspaceName: names.get(h.workspace_id) ?? 'another workspace',
    });
  }
  return out;
}

// Keyed `${openWorkspace}|${e164}`: null is a settled miss, absent is not asked yet.
const cache = new Map<string, Elsewhere | null>();
const queue = new Map<string, { open: number; others: { id: number; name: string }[]; keys: Set<string> }>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function changed() {
  version++;
  for (const fn of listeners) fn();
}

async function read(table: 'sellers' | 'buyers', keys: string[], ws: number[]): Promise<Hit[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from(table).select('id, name, workspace_id, phone_key').in('workspace_id', ws).in('phone_key', keys).limit(1000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Omit<Hit, 'kind'>[]).map((r) => ({ ...r, kind: table === 'sellers' ? 'seller' : 'buyer' }));
}

async function flush() {
  timer = null;
  const jobs = [...queue.values()];
  queue.clear();
  for (const job of jobs) {
    const keys = [...job.keys];
    const ws = job.others.map((w) => w.id);
    const names = new Map(job.others.map((w) => [w.id, w.name]));
    for (let i = 0; i < keys.length; i += 100) {
      const part = keys.slice(i, i + 100);
      try {
        const [sellers, buyers] = await Promise.all([read('sellers', part, ws), read('buyers', part, ws)]);
        const found = pickElsewhere([...sellers, ...buyers], names);
        for (const k of part) cache.set(`${job.open}|${k}`, found.get(k) ?? null);
      } catch {
        // A failed read is asked again on the next render that wants it.
        for (const k of part) cache.delete(`${job.open}|${k}`);
      }
    }
  }
  changed();
}

function ask(e164: string, open: number, others: { id: number; name: string }[]) {
  const key = `${open}|${e164}`;
  if (cache.has(key)) return;
  cache.set(key, null);
  const job = queue.get(String(open)) ?? { open, others, keys: new Set<string>() };
  job.keys.add(e164);
  queue.set(String(open), job);
  timer ??= setTimeout(() => { void flush(); }, 60);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The record on `e164` in another of `workspaces`, or null while unknown or when there is none. */
export function useElsewhere(e164: string | null | undefined, open: number | null | undefined, workspaces: readonly { id: number; name: string }[]): Elsewhere | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  const others = workspaces.filter((w) => w.id !== open);
  if (!e164 || !e164.startsWith('+') || open == null || !others.length) return null;
  const key = `${open}|${e164}`;
  if (!cache.has(key)) ask(e164, open, others.map((w) => ({ id: w.id, name: w.name })));
  return cache.get(key) ?? null;
}
