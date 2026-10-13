// Keeps an open seller or buyer record's Activity feed level with Gmail and
// the phone, without a reload.
//
// - Realtime: any message filed on this record (a reply synced from Gmail, a
//   text, a call) bumps the feed. Needs `communications` in the realtime
//   publication (migration 205); RLS still decides who receives a row.
// - Opening a record asks Google for new mail straight away, at most every
//   two minutes per workspace, so a reply the seller sent a minute ago is
//   there without waiting for the five-minute pg_cron sweep.
// - A one-minute poll and a refresh on returning to the tab, in case the
//   socket dropped.
//
// Returns a counter: put it in the deps of the effect that loads the feed.
'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { syncGoogle } from '@/lib/google';

const PULL_EVERY_MS = 2 * 60_000;
const POLL_MS = 60_000;
/** When each workspace last asked Google for mail from a record. Module scope: screens remount. */
const pulledAt = new Map<number, number>();

export function useRecordFeedLive(workspaceId: number | null, record: { sellerId?: number | null; buyerId?: number | null }): number {
  const [nonce, setNonce] = useState(0);
  const { sellerId = null, buyerId = null } = record;
  const column = sellerId ? 'seller_id' : buyerId ? 'buyer_id' : null;
  const id = sellerId ?? buyerId;

  useEffect(() => {
    if (workspaceId == null || !column || id == null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const bump = () => {
      if (timer) clearTimeout(timer);
      // Gmail sync writes a thread in a burst; one refresh for the lot.
      timer = setTimeout(() => { if (alive) setNonce((n) => n + 1); }, 800);
    };

    const last = pulledAt.get(workspaceId) ?? 0;
    if (Date.now() - last > PULL_EVERY_MS) {
      pulledAt.set(workspaceId, Date.now());
      void syncGoogle(workspaceId, { ifStale: true }).then((r) => { if (r.ok) bump(); });
    }

    const sb = supabase;
    const ch = sb
      ? sb.channel(`record-feed-${workspaceId}-${column}-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'communications', filter: `${column}=eq.${id}` }, bump)
        .subscribe()
      : null;
    const onVisible = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', onVisible);
    const every = setInterval(() => { if (document.visibilityState === 'visible') bump(); }, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
      if (sb && ch) void sb.removeChannel(ch);
    };
  }, [workspaceId, column, id]);

  return nonce;
}
