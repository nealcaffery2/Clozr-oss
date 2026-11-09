// The Inbox's per-member memory (migrations 154, 357): what this person
// opened, pinned, cleared, marked unread and labelled, and the filters they
// saved. Talkr owns the SMS threads and calls; this decides how they show for
// one rep. Keys: sms:<E.164>, call:<talkr id>, email:<thread>, and
// filter:<id> for a saved filter (its settings in `data`).
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { everyRow } from './every-row';
import { supabase } from './supabase';
import type { InboxFilter, SavedFilter } from './inbox-folders';

export type ItemState = {
  seen_at: string | null; pinned_at: string | null; cleared_at: string | null;
  /** "Mark unread": unread again until seen_at is newer. */
  unread_at?: string | null;
  /** Disposition chips on the thread (lib/inbox-folders DISPOSITIONS). */
  labels?: string[];
  data?: unknown;
};
type Patch = Partial<ItemState>;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** Unread: the source says so and nothing happened after this person opened it, or they marked it unread since. */
export function isUnread(base: boolean, at: string | null | undefined, st: ItemState | undefined): boolean {
  if (st?.unread_at && ms(st.unread_at) > ms(st.seen_at)) return true;
  return base && !(st?.seen_at && ms(st.seen_at) >= ms(at));
}

/** Cleared and nothing newer since: off the list. A new message brings it back. */
export function isCleared(at: string | null | undefined, st: ItemState | undefined): boolean {
  return !!st?.cleared_at && ms(st.cleared_at) >= ms(at);
}

/** Pinned first (latest pin on top), then the given order. */
export function pinnedFirst<T>(items: T[], keyOf: (t: T) => string, state: Map<string, ItemState>): T[] {
  const pin = (t: T) => ms(state.get(keyOf(t))?.pinned_at);
  return items.map((t, i) => ({ t, i })).sort((a, b) => (pin(b.t) - pin(a.t)) || (a.i - b.i)).map((x) => x.t);
}

/**
 * Of these numbers, the ones that have ever texted this workspace
 * (communications, communications_sms_from_idx). Awaiting reply leaves out
 * threads only we have written in. null when the read failed.
 */
export async function numbersThatWrote(workspaceId: number, phones: string[]): Promise<Set<string> | null> {
  if (!supabase || !phones.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < phones.length; i += 100) {
    const rows = await everyRow<{ from_phone: string | null }>(() => supabase!.from('communications').select('from_phone')
      .eq('workspace_id', workspaceId).eq('channel', 'sms').eq('direction', 'inbound').in('from_phone', phones.slice(i, i + 100)).order('id') as never)
      .catch(() => null);
    if (!rows) return null;
    for (const r of rows) if (r.from_phone) out.add(r.from_phone);
  }
  return out;
}

export const smsKey = (e164: string) => 'sms:' + String(e164 ?? '').replace(/[^\d+]/g, '');
const FILTER = 'filter:';

const NEW_COLS = 'item_key, seen_at, pinned_at, cleared_at, unread_at, labels, data';
const OLD_COLS = 'item_key, seen_at, pinned_at, cleared_at';

/** The signed-in member's inbox state, with writes that show at once and persist in the background. */
/** Every mounted useInboxState, so a write in the Inbox moves the nav badge (SideNav) at once. */
const peers = new Set<(scope: string, key: string, patch: Patch | null) => void>();

export function useInboxState(workspaceId: number | null, userId: string | null) {
  const [state, setState] = useState<Map<string, ItemState>>(new Map());
  const scope = `${workspaceId ?? ''}:${userId ?? ''}`;
  const [scopeKey, setScopeKey] = useState(scope);
  if (scopeKey !== scope) {
    setScopeKey(scope);
    setState(new Map());
  }

  useEffect(() => {
    if (!supabase || !workspaceId || !userId) return;
    let live = true;
    // Every page: past 1,000 items the read stopped and the rest showed unread, unpinned and uncleared again.
    const read = (cols: string) => everyRow<{ item_key: string } & ItemState>(() => supabase!.from('inbox_item_state' as never).select(cols)
      .eq('workspace_id', workspaceId).eq('user_id', userId).order('item_key') as never);
    void read(NEW_COLS)
      // Migration 357 not applied yet: the old columns still work.
      .catch((e: Error) => (/column|schema cache/i.test(e.message) ? read(OLD_COLS) : Promise.reject(e)))
      .then((rows) => {
        if (!live) return;
        setState(new Map(rows.map((r) => [r.item_key, { seen_at: r.seen_at, pinned_at: r.pinned_at, cleared_at: r.cleared_at, unread_at: r.unread_at ?? null, labels: r.labels ?? [], data: r.data ?? null }])));
      }, () => undefined);
    return () => { live = false; };
  }, [workspaceId, userId]);

  useEffect(() => {
    const apply = (from: string, key: string, patch: Patch | null) => {
      if (from !== scope) return;
      setState((m) => {
        const next = new Map(m);
        if (patch) next.set(key, { seen_at: null, pinned_at: null, cleared_at: null, ...m.get(key), ...patch });
        else next.delete(key);
        return next;
      });
    };
    peers.add(apply);
    return () => { peers.delete(apply); };
  }, [scope]);

  const write = useCallback((key: string, patch: Patch) => {
    for (const p of peers) p(`${workspaceId ?? ''}:${userId ?? ''}`, key, patch);
    if (!supabase || !workspaceId || !userId) return;
    void supabase.from('inbox_item_state' as never)
      .upsert({ workspace_id: workspaceId, user_id: userId, item_key: key, ...patch, updated_at: new Date().toISOString() } as never, { onConflict: 'workspace_id,user_id,item_key' })
      .then(({ error }) => { if (error) console.warn('inbox state', error.message); });
  }, [workspaceId, userId]);
  const erase = useCallback((key: string) => {
    for (const p of peers) p(`${workspaceId ?? ''}:${userId ?? ''}`, key, null);
    if (!supabase || !workspaceId || !userId) return;
    void supabase.from('inbox_item_state' as never).delete().eq('workspace_id', workspaceId).eq('user_id', userId).eq('item_key', key)
      .then(({ error }) => { if (error) console.warn('inbox state', error.message); });
  }, [workspaceId, userId]);

  const now = () => new Date().toISOString();
  // Saved filters ride on the same rows, keyed filter:<id>.
  const filters = useMemo<SavedFilter[]>(() => [...state.entries()]
    .filter(([k, v]) => k.startsWith(FILTER) && v.data && typeof v.data === 'object')
    .map(([k, v]) => ({ id: k.slice(FILTER.length), ...(v.data as { name: string; filter: InboxFilter }) }))
    .sort((a, b) => a.name.localeCompare(b.name)), [state]);
  return {
    state,
    filters,
    seen: useCallback((key: string) => write(key, { seen_at: now() }), [write]),
    markUnread: useCallback((key: string) => write(key, { unread_at: now() }), [write]),
    pin: useCallback((key: string, on: boolean) => write(key, { pinned_at: on ? now() : null }), [write]),
    clear: useCallback((key: string) => write(key, { cleared_at: now(), pinned_at: null, seen_at: now() }), [write]),
    /** Back on the list: the clear is undone. */
    unclear: useCallback((key: string) => write(key, { cleared_at: null }), [write]),
    label: useCallback((key: string, labels: string[]) => write(key, { labels }), [write]),
    saveFilter: useCallback((name: string, filter: InboxFilter, id = `${Date.now().toString(36)}`) => { write(FILTER + id, { data: { name, filter } }); return id; }, [write]),
    removeFilter: useCallback((id: string) => erase(FILTER + id), [erase]),
  };
}
export type InboxState = ReturnType<typeof useInboxState>;
