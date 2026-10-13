// What this member has read, starred and archived in the Email tab.
//
// CLOZR's own state, not Gmail's. The connection holds `gmail.readonly` and
// `gmail.send` and no `gmail.modify` (supabase/functions/_shared/google.ts), so
// nothing here can mark a message read or star it in the member's real mailbox.
// Reading it the other way — Gmail's own read state — is not available either,
// because the sync stores the message, not its labels.
//
// It degrades on purpose. Migration 73 creates the two tables, and in this repo
// migrations are applied by hand while the code deploys on merge, so there is
// always a window where the table is not there yet. Asking for a missing
// relation is a 42P01 that takes `data` to null with it, and an inbox that
// throws because a migration is pending is worse than one that simply does not
// remember. So state is held in memory first and written through when the
// tables answer; when they do not, the tab still works and `persists` is false,
// which is the one thing the screen says out loud.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase';

export type EmailState = {
  /** communication ids this member has read. */
  read: ReadonlySet<number>;
  starred: ReadonlySet<number>;
  archived: ReadonlySet<number>;
  /** Anything older than this counts as read, state row or not. Null before the first load. */
  seenThrough: string | null;
  /** False when migration 73 has not been applied here: the tab works, nothing is remembered. */
  persists: boolean;
  ready: boolean;
};

const EMPTY: ReadonlySet<number> = new Set<number>();

/** Postgres "relation does not exist" — the migration has not been applied here. */
const isMissingTable = (err: { code?: string; message?: string } | null): boolean =>
  err?.code === '42P01' || /does not exist/i.test(err?.message ?? '');

export function useEmailState(workspaceId: number | null, userId: string | null) {
  const [read, setRead] = useState<ReadonlySet<number>>(EMPTY);
  const [starred, setStarred] = useState<ReadonlySet<number>>(EMPTY);
  const [archived, setArchived] = useState<ReadonlySet<number>>(EMPTY);
  const [seenThrough, setSeenThrough] = useState<string | null>(null);
  const [persists, setPersists] = useState(true);
  // Derived, not set: with no workspace or no Supabase there is nothing to
  // wait for, and setting it from the effect body is a synchronous setState.
  const [loaded, setLoaded] = useState(false);
  // The scope whose first open already wrote a watermark, so a second pass does not mark the backlog read again.
  const watermarkedScope = useRef<string | null>(null);
  const scope = `${workspaceId ?? ''}:${userId ?? ''}`;
  const [scopeKey, setScopeKey] = useState(scope);
  if (scopeKey !== scope) {
    setScopeKey(scope);
    setRead(EMPTY);
    setStarred(EMPTY);
    setArchived(EMPTY);
    setSeenThrough(null);
    setPersists(true);
    setLoaded(false);
  }

  const live = !!supabase && !!workspaceId && !!userId;

  const ready = !live || loaded;

  useEffect(() => {
    if (!live) return;
    let alive = true;
    const scopeNow = `${workspaceId}:${userId}`;

    void (async () => {
      const [state, prefs] = await Promise.all([
        supabase!.from('communication_user_state')
          .select('communication_id, read_at, starred_at, archived_at')
          .eq('workspace_id', workspaceId!).eq('user_id', userId!),
        supabase!.from('inbox_user_prefs')
          .select('email_seen_through')
          .eq('workspace_id', workspaceId!).eq('user_id', userId!).maybeSingle(),
      ]);
      if (!alive) return;

      if (isMissingTable(state.error) || isMissingTable(prefs.error)) {
        setPersists(false);
        setLoaded(true);
        return;
      }

      const r = new Set<number>();
      const s = new Set<number>();
      const a = new Set<number>();
      for (const row of state.data ?? []) {
        const id = Number((row as { communication_id: number }).communication_id);
        const rec = row as { read_at: string | null; starred_at: string | null; archived_at: string | null };
        if (rec.read_at) r.add(id);
        if (rec.starred_at) s.add(id);
        if (rec.archived_at) a.add(id);
      }
      setRead(r); setStarred(s); setArchived(a);

      const mark = (prefs.data as { email_seen_through?: string } | null)?.email_seen_through ?? null;
      if (mark) {
        setSeenThrough(mark);
      } else if (watermarkedScope.current !== scopeNow) {
        // First open of this workspace: everything already synced was read in the
        // member's own Gmail long before CLOZR drew it. Only what lands after now is unread.
        watermarkedScope.current = scopeNow;
        const now = new Date().toISOString();
        setSeenThrough(now);
        await supabase!.from('inbox_user_prefs')
          .upsert({ workspace_id: workspaceId!, user_id: userId!, email_seen_through: now },
                  { onConflict: 'workspace_id,user_id' });
      }
      setLoaded(true);
    })();

    return () => { alive = false; };
  }, [live, workspaceId, userId]);

  /** Optimistic locally, written through when the tables are there. */
  const write = useCallback(async (id: number, patch: Partial<Pick<
    { read_at: string | null; starred_at: string | null; archived_at: string | null },
    'read_at' | 'starred_at' | 'archived_at'
  >>) => {
    if (!live || !persists) return;
    const { error } = await supabase!.from('communication_user_state')
      .upsert({ workspace_id: workspaceId!, user_id: userId!, communication_id: id, ...patch },
              { onConflict: 'user_id,communication_id' });
    if (isMissingTable(error)) setPersists(false);
  }, [live, persists, workspaceId, userId]);

  const markRead = useCallback((ids: number[], isRead = true) => {
    if (!ids.length) return;
    setRead((prev) => {
      const next = new Set(prev);
      for (const id of ids) { if (isRead) next.add(id); else next.delete(id); }
      return next;
    });
    for (const id of ids) void write(id, { read_at: isRead ? new Date().toISOString() : null });
  }, [write]);

  const toggleStar = useCallback((id: number) => {
    let now = false;
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else { next.add(id); now = true; }
      return next;
    });
    void write(id, { starred_at: now ? new Date().toISOString() : null });
  }, [write]);

  const setArchivedIds = useCallback((ids: number[], isArchived = true) => {
    if (!ids.length) return;
    setArchived((prev) => {
      const next = new Set(prev);
      for (const id of ids) { if (isArchived) next.add(id); else next.delete(id); }
      return next;
    });
    for (const id of ids) void write(id, { archived_at: isArchived ? new Date().toISOString() : null });
  }, [write]);

  const state: EmailState = useMemo(
    () => ({ read, starred, archived, seenThrough, persists, ready }),
    [read, starred, archived, seenThrough, persists, ready],
  );

  return { ...state, markRead, toggleStar, setArchived: setArchivedIds };
}

/**
 * Whether a thread should draw bold. Unread means: nothing in it has been read
 * AND something in it arrived after the watermark. Outbound mail is never
 * unread — the member sent it.
 */
export function threadUnread(
  rows: { id: number; occurred_at: string; direction: string | null }[],
  read: ReadonlySet<number>,
  seenThrough: string | null,
): boolean {
  const after = seenThrough ? Date.parse(seenThrough) : Number.POSITIVE_INFINITY;
  return rows.some((r) =>
    r.direction === 'inbound'
    && !read.has(r.id)
    && Date.parse(r.occurred_at) > after);
}
