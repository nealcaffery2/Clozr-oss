'use client';

// Read receipts, live, wherever a sent text or email is drawn: the Inbox
// thread, the dialer's texts, the record's Activity feed.
//
//   email  email_tracking (migration 82): opens and clicks of the pixel and
//          the counted links, per sent message.
//   text   the CLOZR link inside it (lib/link-views): a signing link's
//          contract_signers.viewed_at, a buyer deal page's deal_page_views.
//
// Live through one realtime channel per workspace and table, shared by every
// receipt on screen (migration 274 puts email_tracking and contract_signers
// in the publication). A deal page view has no realtime of its own; it is
// re-read when the text is drawn again and when the tab comes back.
//
// Without a workspace (/demo) the sample receipts in lib/inbox-demo answer.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { type LinkView, type TrackedLink, trackedLinks, viewLabel, viewTitle } from '@/lib/link-views';
import { demoEmailReceipts, demoLinkViews } from '@/lib/inbox-demo';

export type Receipt = {
  communication_id: number; opens: number; clicks: number;
  first_opened_at: string | null; last_opened_at: string | null; last_clicked_at: string | null;
};

type Table = 'email_tracking' | 'contract_signers';
const shared = new Map<string, { fns: Set<() => void>; stop: () => void }>();

/** Runs `fn` when a row of `table` in the workspace changes. One channel per workspace and table, however many listen. */
export function onReceiptChange(workspaceId: number | null, table: Table, fn: () => void): () => void {
  const sb = supabase;
  if (!sb || workspaceId == null) return () => undefined;
  const key = `${table}:${workspaceId}`;
  let entry = shared.get(key);
  if (!entry) {
    const fns = new Set<() => void>();
    const ch = sb.channel(`receipts-${key}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` }, () => { for (const f of [...fns]) f(); })
      .subscribe();
    entry = { fns, stop: () => { void sb.removeChannel(ch); } };
    shared.set(key, entry);
  }
  const e = entry;
  e.fns.add(fn);
  return () => {
    e.fns.delete(fn);
    if (!e.fns.size) { e.stop(); shared.delete(key); }
  };
}

/** A counter that moves when a receipt changes (realtime) or the tab comes back. */
function useReceiptTick(workspaceId: number | null, table: Table, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => setTick((n) => n + 1), 400); };
    const stop = onReceiptChange(workspaceId, table, bump);
    const back = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', back);
    return () => { stop(); document.removeEventListener('visibilitychange', back); if (timer) clearTimeout(timer); };
  }, [workspaceId, table, enabled]);
  return tick;
}

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Opens and clicks for sent emails on screen, by communication id. */
export function useEmailReceipts(ids: readonly number[], workspaceId: number | null): Map<number, Receipt> {
  const key = useMemo(() => [...new Set(ids)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b).join(','), [ids]);
  const tick = useReceiptTick(workspaceId, 'email_tracking', !!key && workspaceId != null);
  const [state, setState] = useState<{ key: string; map: Map<number, Receipt> }>({ key: '', map: NO_RECEIPTS });
  const sample = workspaceId == null || !supabase;
  const demo = useMemo(() => {
    if (!sample || !key) return null;
    const all = demoEmailReceipts();
    return new Map(key.split(',').map(Number).flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
  }, [sample, key]);
  useEffect(() => {
    if (!key || sample || !supabase) return;
    const list = key.split(',').map(Number);
    const sb = supabase;
    let alive = true;
    void (async () => {
      const map = new Map<number, Receipt>();
      for (const part of chunks(list, 200)) {
        const { data } = await sb.from('email_tracking')
          .select('communication_id, opens, clicks, first_opened_at, last_opened_at, last_clicked_at').in('communication_id', part);
        for (const r of (data ?? []) as Receipt[]) map.set(r.communication_id, r);
      }
      if (alive) setState({ key, map });
    })();
    return () => { alive = false; };
  }, [key, sample, tick]);
  return demo ?? (state.key === key ? state.map : NO_RECEIPTS);
}

const NO_RECEIPTS = new Map<number, Receipt>();

async function readLinkViews(links: TrackedLink[]): Promise<Map<string, LinkView>> {
  const sb = supabase;
  const out = new Map<string, LinkView>();
  if (!sb) return out;
  const tokens = links.flatMap((l) => (l.kind === 'sign' ? [l.token] : []));
  const listings = links.flatMap((l) => (l.kind === 'listing' ? [l] : []));
  const reads: Promise<void>[] = [];
  if (tokens.length) {
    reads.push(Promise.resolve(sb.from('contract_signers').select('token, viewed_at, view_seconds').in('token', tokens)).then(({ data }) => {
      for (const r of (data ?? []) as unknown as { token: string; viewed_at: string | null; view_seconds: number | null }[]) {
        if (r.viewed_at) out.set(`sign:${r.token}`, { firstAt: r.viewed_at, seconds: r.view_seconds });
      }
    }, () => undefined));
  }
  if (listings.length) {
    const deals = [...new Set(listings.map((l) => l.deal))];
    const buyers = [...new Set(listings.map((l) => l.buyer))];
    // select('*'): the views table's timestamp column is read by whichever name it has.
    reads.push(Promise.resolve(sb.from('deal_page_views' as never).select('*').in('deal_id', deals).in('buyer_id', buyers).limit(500)).then(({ data }) => {
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        const at = String(r.created_at ?? r.first_seen_at ?? r.last_seen_at ?? '');
        if (!at) continue;
        const k = `listing:${r.deal_id}:${r.buyer_id}`;
        const cur = out.get(k);
        const secs = Number(r.seconds ?? 0) || 0;
        out.set(k, cur
          ? { firstAt: Date.parse(at) < Date.parse(cur.firstAt) ? at : cur.firstAt, views: (cur.views ?? 1) + 1, seconds: (cur.seconds ?? 0) + secs }
          : { firstAt: at, views: 1, seconds: secs });
      }
    }, () => undefined));
  }
  await Promise.all(reads);
  return out;
}

/**
 * "Viewed 2:14 PM" for texts that carry a CLOZR link. `label(text)` is null
 * for a text with no tracked link, so a caller can always ask.
 */
export function useLinkViews(texts: readonly (string | null | undefined)[], workspaceId: number | null) {
  const links = useMemo(() => {
    const by = new Map<string, TrackedLink>();
    for (const t of texts) for (const l of trackedLinks(t)) by.set(l.key, l);
    return [...by.values()];
  }, [texts]);
  const key = links.map((l) => l.key).sort().join('|');
  const tick = useReceiptTick(workspaceId, 'contract_signers', !!key && workspaceId != null);
  const [state, setState] = useState<{ key: string; views: Map<string, LinkView> }>({ key: '', views: new Map() });
  const sample = workspaceId == null || !supabase;
  const demo = useMemo(() => (sample && key ? demoLinkViews() : null), [sample, key]);
  useEffect(() => {
    if (!key || sample) return;
    let alive = true;
    void readLinkViews(links).then((views) => { if (alive) setState({ key, views }); });
    return () => { alive = false; };
    // `key` names the links.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sample, tick]);
  const views = demo ?? (state.key === key ? state.views : null);
  return useMemo(() => ({
    /** Null when the text has no tracked link, or before the opens are read. */
    label: (text: string | null | undefined): string | null => {
      const ls = trackedLinks(text);
      return ls.length && views ? viewLabel(ls, views) : null;
    },
    title: (text: string | null | undefined): string => (views ? viewTitle(trackedLinks(text), views) : ''),
    viewed: (text: string | null | undefined): boolean => {
      const ls = trackedLinks(text);
      return !!views && ls.some((l) => views.has(l.key));
    },
  }), [views]);
}

export { emailOpenLabel as emailReceiptLabel } from '@/lib/link-views';
