// The Inbox's per-member memory (migration 154): what this person opened,
// pinned and cleared. Talkr owns the SMS threads and calls; this decides how
// they show for one rep. Keys: sms:<E.164>, call:<talkr id>, email:<thread>.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type ItemState = { seen_at: string | null; pinned_at: string | null; cleared_at: string | null };
type Patch = Partial<ItemState>;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** Unread: the source says so and nothing happened after this person opened it. */
export function isUnread(base: boolean, at: string | null | undefined, st: ItemState | undefined): boolean {
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

export const smsKey = (e164: string) => 'sms:' + String(e164 ?? '').replace(/[^\d+]/g, '');

/** The signed-in member's inbox state, with writes that show at once and persist in the background. */
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
    void supabase.from('inbox_item_state' as never).select('item_key, seen_at, pinned_at, cleared_at')
      .eq('workspace_id', workspaceId).eq('user_id', userId).limit(5000)
      .then(({ data }) => {
        if (!live) return;
        const rows = (data ?? []) as unknown as ({ item_key: string } & ItemState)[];
        setState(new Map(rows.map((r) => [r.item_key, { seen_at: r.seen_at, pinned_at: r.pinned_at, cleared_at: r.cleared_at }])));
      });
    return () => { live = false; };
  }, [workspaceId, userId]);

  const write = useCallback((key: string, patch: Patch) => {
    setState((m) => {
      const next = new Map(m);
      next.set(key, { seen_at: null, pinned_at: null, cleared_at: null, ...m.get(key), ...patch });
      return next;
    });
    if (!supabase || !workspaceId || !userId) return;
    void supabase.from('inbox_item_state' as never)
      .upsert({ workspace_id: workspaceId, user_id: userId, item_key: key, ...patch, updated_at: new Date().toISOString() } as never, { onConflict: 'workspace_id,user_id,item_key' })
      .then(({ error }) => { if (error) console.warn('inbox state', error.message); });
  }, [workspaceId, userId]);

  const now = () => new Date().toISOString();
  return {
    state,
    seen: useCallback((key: string) => write(key, { seen_at: now() }), [write]),
    pin: useCallback((key: string, on: boolean) => write(key, { pinned_at: on ? now() : null }), [write]),
    clear: useCallback((key: string) => write(key, { cleared_at: now(), pinned_at: null, seen_at: now() }), [write]),
  };
}
export type InboxState = ReturnType<typeof useInboxState>;
