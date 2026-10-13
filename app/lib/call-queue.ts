// The rep's own call queue — who the dialer's Queue tab calls next.
//
// Signed in, it lives in `call_queue_items` (migration 79): one queue per rep,
// one row per seller or buyer, and the unique indexes there turn a second add
// of the same person into a no-op. In the /demo sample, or until 79 is applied
// (migrations here are applied by hand while the code deploys on merge), it is
// kept in memory for the tab instead, with the same no-duplicates rule.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';

export type QueueKind = 'seller' | 'buyer';
export type QueueItem = { id: string; kind: QueueKind; recordId: number };

export type CallQueue = {
  items: QueueItem[];
  /** Adds everyone not already queued; `already` counts the ones skipped. */
  add: (kind: QueueKind, recordIds: number[]) => Promise<{ ok: boolean; added: number; already: number; message?: string }>;
  remove: (itemId: string) => Promise<void>;
  clear: () => Promise<{ ok: boolean; message?: string }>;
};

const isMissingTable = (err: { code?: string; message?: string } | null): boolean =>
  !!err && (err.code === '42P01' || err.code === 'PGRST205' || /call_queue_items/.test(err.message ?? ''));

const col = (kind: QueueKind) => (kind === 'seller' ? 'seller_id' : 'buyer_id');

export function useCallQueue(workspaceId: number | null, userId: string | null): CallQueue {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [store, setStore] = useState<'workspace' | 'memory'>('memory');
  const scope = `${workspaceId ?? ''}:${userId ?? ''}`;
  const [scopeKey, setScopeKey] = useState(scope);
  if (scopeKey !== scope) {
    setScopeKey(scope);
    setItems([]);
    setStore('memory');
  }
  const live = !!supabase && workspaceId != null && !!userId;

  const read = useCallback(async (): Promise<QueueItem[] | null> => {
    if (!live) return null;
    const { data, error } = await supabase!.from('call_queue_items')
      .select('id, seller_id, buyer_id')
      .eq('workspace_id', workspaceId!).eq('user_id', userId!)
      .order('position').order('id');
    if (error) {
      if (!isMissingTable(error)) console.warn('call_queue_items', error.message);
      return null;
    }
    return (data ?? []).map((r) => ({
      id: String(r.id),
      kind: r.seller_id != null ? 'seller' as const : 'buyer' as const,
      recordId: Number(r.seller_id ?? r.buyer_id),
    }));
  }, [live, workspaceId, userId]);

  useEffect(() => {
    let alive = true;
    void read().then((rows) => {
      if (!alive) return;
      setStore(rows ? 'workspace' : 'memory');
      setItems(rows ?? []);
    });
    return () => { alive = false; };
  }, [read]);

  const add = useCallback<CallQueue['add']>(async (kind, recordIds) => {
    const ids = [...new Set(recordIds.filter((n) => Number.isFinite(n)))];
    const have = new Set(items.filter((i) => i.kind === kind).map((i) => i.recordId));
    const fresh = ids.filter((n) => !have.has(n));
    if (!fresh.length) return { ok: true, added: 0, already: ids.length };
    if (store === 'workspace') {
      // Ascending positions keep the selection's order; ignoreDuplicates lets a
      // row another tab queued in the meantime be skipped instead of failing all.
      const base = Date.now();
      const rows = fresh.map((n, i) => (kind === 'seller'
        ? { workspace_id: workspaceId!, seller_id: n, position: base + i }
        : { workspace_id: workspaceId!, buyer_id: n, position: base + i }));
      const { error } = await supabase!.from('call_queue_items')
        .upsert(rows, { onConflict: `user_id,${col(kind)}`, ignoreDuplicates: true });
      if (error) return { ok: false, added: 0, already: 0, message: error.message };
      const next = await read();
      if (next) setItems(next);
      return { ok: true, added: fresh.length, already: ids.length - fresh.length };
    }
    setItems((prev) => [...prev, ...fresh.map((n) => ({ id: `${kind}-${n}`, kind, recordId: n }))]);
    return { ok: true, added: fresh.length, already: ids.length - fresh.length };
  }, [items, store, workspaceId, read]);

  const remove = useCallback<CallQueue['remove']>(async (itemId) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    if (store === 'workspace') {
      const { error } = await supabase!.from('call_queue_items').delete().eq('id', Number(itemId));
      if (error) { const next = await read(); if (next) setItems(next); }
    }
  }, [store, read]);

  const clear = useCallback<CallQueue['clear']>(async () => {
    if (store === 'workspace') {
      const { error } = await supabase!.from('call_queue_items').delete()
        .eq('workspace_id', workspaceId!).eq('user_id', userId!);
      if (error) return { ok: false, message: error.message };
    }
    setItems([]);
    return { ok: true };
  }, [store, workspaceId, userId]);

  return useMemo(() => ({ items, add, remove, clear }), [items, add, remove, clear]);
}
