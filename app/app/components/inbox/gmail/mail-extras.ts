'use client';

// What the Email tab reads beside the messages themselves (migration 82):
// the files on them, their read receipts, whose mailbox they sit in, and the
// deal team a deal folder is organised around.
//
// Every read here degrades to empty when the migration has not been applied,
// the way lib/email-state.ts does: the tab still works, it just has nothing
// extra to show.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { type DealPartyWithDeal, loadDealParties } from '@/lib/deal-parties';
import { type Teammate, listTeam } from '@/lib/team';
import { type EmailScope, type EmailThread, groupThreads, loadEmailRows } from '../data';

export type MailFile = {
  id: number; communication_id: number; filename: string; content_type: string | null;
  byte_size: number | null; deal_file_id: number | null;
};

export type Receipt = {
  communication_id: number; opens: number; clicks: number;
  first_opened_at: string | null; last_opened_at: string | null; last_clicked_at: string | null;
};

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Files and receipts for the messages on screen, keyed by communication id. */
export function useMailExtras(ids: number[], tick = 0) {
  const [files, setFiles] = useState<Map<number, MailFile[]>>(new Map());
  const [receipts, setReceipts] = useState<Map<number, Receipt>>(new Map());
  const key = useMemo(() => [...ids].sort((a, b) => a - b).join(','), [ids]);

  useEffect(() => {
    if (!supabase || !key) return;
    const sb = supabase;
    const list = key.split(',').map(Number);
    let alive = true;
    void (async () => {
      const f = new Map<number, MailFile[]>();
      const r = new Map<number, Receipt>();
      for (const part of chunks(list, 200)) {
        const [a, t] = await Promise.all([
          sb.from('email_attachments').select('id, communication_id, filename, content_type, byte_size, deal_file_id').in('communication_id', part).order('id'),
          sb.from('email_tracking').select('communication_id, opens, clicks, first_opened_at, last_opened_at, last_clicked_at').in('communication_id', part),
        ]);
        for (const x of (a.data ?? []) as MailFile[]) f.set(x.communication_id, [...(f.get(x.communication_id) ?? []), x]);
        for (const x of (t.data ?? []) as Receipt[]) r.set(x.communication_id, x);
      }
      if (!alive) return;
      setFiles(f); setReceipts(r);
    })();
    return () => { alive = false; };
  }, [key, tick]);

  return { files, receipts };
}

/**
 * Threads for a scope other than the whole workspace — one member's mailbox,
 * or one deal's folder. Read from the server rather than filtered out of the
 * workspace list, which holds only the newest 500 messages: a deal's older
 * email and a rep's quieter mailbox would fall past it.
 */
export function useScopedThreads(workspaceId: number | null, scope: EmailScope, tick = 0) {
  const [state, setState] = useState<{ key: string; threads: EmailThread[]; error: string | null } | null>(null);
  const key = scope.kind === 'mailbox' ? `m:${scope.userId}` : scope.kind === 'deal' ? `d:${scope.dealId}` : 'all';

  useEffect(() => {
    if (!workspaceId || scope.kind === 'all') return;
    let alive = true;
    void loadEmailRows(workspaceId, scope, 1000).then(({ rows, error }) => {
      if (alive) setState({ key, threads: groupThreads(rows), error });
    });
    return () => { alive = false; };
    // scope is described by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key, tick]);

  if (scope.kind === 'all') return null;
  const fresh = state?.key === key;
  return { threads: fresh ? state!.threads : [], error: fresh ? state!.error : null, loading: !fresh };
}

/** The teammates whose mailboxes an admin can open. */
export function useTeam(workspaceId: number | null, enabled: boolean) {
  const [team, setTeam] = useState<Teammate[]>([]);
  useEffect(() => {
    if (!workspaceId || !enabled) return;
    let alive = true;
    void listTeam(workspaceId).then((t) => { if (alive) setTeam(t); });
    return () => { alive = false; };
  }, [workspaceId, enabled]);
  return team;
}

/** Everyone on a deal, for the deal folder's header. */
export function useDealTeam(dealId: number | null, tick = 0) {
  const [parties, setParties] = useState<{ dealId: number; rows: DealPartyWithDeal[] } | null>(null);
  useEffect(() => {
    if (!dealId) return;
    let alive = true;
    void loadDealParties({ dealId }).then((rows) => { if (alive) setParties({ dealId, rows }); });
    return () => { alive = false; };
  }, [dealId, tick]);
  return parties && parties.dealId === dealId ? parties.rows : [];
}

/**
 * Which folder a deal's stage puts it in. Only the four stages a deal is live
 * in get a folder, in pipeline order; Prospect, Closed, Terminated and the
 * rest stay out of the rail (their mail is still in the inbox and on the deal).
 */
export type DealFolder = 'contract' | 'marketing' | 'buyer' | 'escrow' | 'other';
export const FOLDER_OF: Record<string, DealFolder> = {
  'Under Contract Seller': 'contract',
  'Ready To Market': 'marketing',
  'Buyer Under Contract': 'buyer',
  'In Escrow': 'escrow',
};
export const FOLDERS: { key: DealFolder; label: string }[] = [
  { key: 'contract', label: 'Under contract' },
  { key: 'marketing', label: 'Ready to market' },
  { key: 'buyer', label: 'Buyer under contract' },
  { key: 'escrow', label: 'In escrow' },
];

export const fmtBytes = (n: number | null) =>
  n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** "Opened 3× · last 2h ago", or null when nothing is known. */
export function receiptLabel(r: Receipt | undefined): string | null {
  if (!r) return null;
  if (!r.opens) return 'Not opened yet';
  const ago = (iso: string | null) => {
    if (!iso) return '';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const opens = `Opened${r.opens > 1 ? ` ${r.opens}×` : ''} · ${ago(r.last_opened_at)}`;
  return r.clicks ? `${opens} · ${r.clicks} click${r.clicks === 1 ? '' : 's'}` : opens;
}
