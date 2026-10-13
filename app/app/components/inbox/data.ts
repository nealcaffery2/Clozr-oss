'use client';

// What the inbox's non-SMS tabs read: email threads from the Gmail sync
// (communications, channel 'email') and calls from Talkr's history.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { type GoogleStatus, GOOGLE_SCOPE, granted, googleStatus } from '@/lib/google';
import { type HistoryItemDto, api } from '@/lib/talkr-web/api';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';
import { baseSubject } from '@/lib/email-thread';

export type EmailRow = {
  id: number; seller_id: number | null; buyer_id: number | null; direction: string | null; occurred_at: string;
  /** The deal the Gmail sync filed this under (gmail-match.ts), whoever it was with. */
  deal_id: number | null;
  subject: string | null;
  /**
   * The message, HTML or text. Lists leave it out (null until the thread is
   * opened: useThreadBodies); `preview` is what a list row shows instead.
   */
  body: string | null;
  /** The first 300 characters of the body as plain text (migration 244's body_preview). */
  preview?: string | null;
  from_email: string | null; to_email: string | null; status: string | null;
  /** Migration 82: Cc and Bcc on their own. Older rows carry Cc inside to_email and have neither. */
  cc_email?: string | null; bcc_email?: string | null;
  source: string; source_id: string;
  /** The member a cold reply is assigned to (buyer's assignee, else owner). */
  rep_id?: string | null;
};

export type EmailThread = {
  key: string;
  /** The other party's address; null on an old row that never stored one. */
  counterpart: string | null;
  subject: string;
  /** Oldest first, the way the thread reads. */
  rows: EmailRow[];
  last: EmailRow;
  seller_id: number | null;
  buyer_id: number | null;
  /** The newest deal any message in the thread is filed under. */
  deal_id: number | null;
};

/** The resolver the inbox is handed: a CLOZR seller or buyer by E.164 or email. */
export type RecordFor = (key: string) => ClozrRecord | null;

/** A deal as the inbox names it: its property, its stage, and the record it lives on. */
export type DealRef = { id?: number; label: string; stage?: string | null; sellerId?: number | null; /** The seller's name, to tell two deals on one street apart. */ who?: string | null; open: () => void };
export type DealFor = (dealId: number) => DealRef | null;

const firstAddress = (list: string | null) => (list ?? '').split(',').map((a) => a.trim().toLowerCase()).find((a) => a.includes('@')) ?? null;
export { baseSubject };

/**
 * Gmail's own thread ids differ per mailbox, so threads are grouped the way a
 * reader sees them: the same person and the same subject, Re:/Fwd: aside.
 */
export function groupThreads(rows: EmailRow[]): EmailThread[] {
  const by = new Map<string, EmailThread>();
  for (const r of [...rows].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))) {
    const counterpart = r.direction === 'inbound' ? (r.from_email?.toLowerCase() ?? null) : firstAddress(r.to_email);
    const who = counterpart ?? (r.seller_id ? `seller:${r.seller_id}` : r.buyer_id ? `buyer:${r.buyer_id}` : `row:${r.id}`);
    const key = `${who}|${baseSubject(r.subject).toLowerCase()}`;
    const t = by.get(key);
    if (t) {
      t.rows.push(r);
      t.last = r;
      t.seller_id ??= r.seller_id;
      t.buyer_id ??= r.buyer_id;
      t.deal_id = r.deal_id ?? t.deal_id;
    } else {
      by.set(key, { key, counterpart, subject: baseSubject(r.subject) || '(no subject)', rows: [r], last: r, seller_id: r.seller_id, buyer_id: r.buyer_id, deal_id: r.deal_id });
    }
  }
  return Array.from(by.values()).sort((a, b) => Date.parse(b.last.occurred_at) - Date.parse(a.last.occurred_at));
}

// No body: a list of 500 threads carried 500 HTML bodies, megabytes per load,
// reloaded on every change. body_preview (migration 244) is a computed column;
// until it exists the list reads without a preview rather than failing.
const LIST_COLS = 'id,seller_id,buyer_id,deal_id,direction,occurred_at,subject,from_email,to_email,status,source,source_id,rep_id';
let previewColumn = true;
let ccColumns = true;

/** What a list query adds or narrows by: older than a time (Load more), or matching a search. */
export type EmailPage = { before?: string | null; search?: string | null };

/** Words a search may carry into a PostgREST filter: letters, digits, @ . - _ and spaces. */
export function searchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N}@.\-_ ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Which mail a list shows: the workspace's, one member's mailbox, or one
 * deal's. A deal scope with a userId is that deal's mail in one mailbox, which
 * is all a rep outside TC and admin may read (lib/team.ts seesAllMail).
 */
export type EmailScope = { kind: 'all' } | { kind: 'mailbox'; userId: string } | { kind: 'deal'; dealId: number; userId?: string;
  /** The deal's seller: their mail that was never filed under a deal lands in the folder too. */
  sellerId?: number | null };

/**
 * Email rows for a scope, newest first. cc/bcc (migration 82) are asked for
 * and dropped from the select when this project does not have them yet; a
 * mailbox scope needs migration 82 outright and says so.
 */
export async function loadEmailRows(workspaceId: number, scope: EmailScope, limit = 500, page: EmailPage = {}): Promise<{ rows: EmailRow[]; error: string | null; more: boolean }> {
  if (!supabase) return { rows: [], error: null, more: false };
  const sb = supabase;
  const box = scope.kind === 'all' ? undefined : scope.userId;
  const term = page.search ? searchTerm(page.search) : '';
  const cols = () => [LIST_COLS, ...(ccColumns ? ['cc_email', 'bcc_email'] : []), ...(previewColumn ? ['body_preview'] : [])].join(',');
  const narrow = <Q extends { lt: (c: string, v: string) => Q; or: (f: string) => Q }>(q: Q): Q => {
    let out = q;
    if (page.before) out = out.lt('occurred_at', page.before);
    if (term) {
      const like = `%${term}%`;
      out = out.or(`subject.ilike.${like},from_email.ilike.${like},to_email.ilike.${like}`);
    }
    return out;
  };
  const run = () => {
    const select = box ? `${cols()},communication_mailboxes!inner(user_id)` : cols();
    let q = sb.from('communications').select(select).eq('workspace_id', workspaceId).eq('channel', 'email');
    if (box) q = q.eq('communication_mailboxes.user_id', box);
    if (scope.kind === 'deal') q = scope.sellerId ? q.or(`deal_id.eq.${scope.dealId},and(deal_id.is.null,seller_id.eq.${scope.sellerId})`) : q.eq('deal_id', scope.dealId);
    return narrow(q).order('occurred_at', { ascending: false }).limit(limit);
  };
  // A project missing migration 82 (cc/bcc) or 244 (the preview) drops that column and asks again.
  const retrying = async <T extends { error: { message: string } | null }>(go: () => PromiseLike<T>): Promise<T> => {
    let res = await go();
    for (let i = 0; i < 2 && res.error; i++) {
      if (previewColumn && /body_preview/.test(res.error.message)) previewColumn = false;
      else if (ccColumns && /cc_email|bcc_email/.test(res.error.message)) ccColumns = false;
      else break;
      res = await go();
    }
    return res;
  };
  const res = await retrying(run);
  if (res.error) {
    const missing = /communication_mailboxes/.test(res.error.message);
    return { rows: [], error: missing ? 'Per-mailbox view needs database migration 82 applied.' : res.error.message, more: false };
  }
  // The mailbox embed is only there to filter by; it is not part of the row.
  const rows = ((res.data ?? []) as unknown as (EmailRow & { communication_mailboxes?: unknown; body_preview?: string | null })[]).map(asRow);
  const more = rows.length >= limit;
  // Pool replies and sends are source 'cold' and have no communication_mailboxes
  // row, so a mailbox-scoped join would hide them. Members may read them
  // (can_read_email). A deal folder stays the deal's mail only.
  if (scope.kind === 'mailbox') {
    const cold = await retrying(() => narrow(sb.from('communications').select(cols()).eq('workspace_id', workspaceId).eq('channel', 'email').eq('source', 'cold'))
      .order('occurred_at', { ascending: false }).limit(limit));
    const coldRows = ((cold.data ?? []) as unknown as (EmailRow & { body_preview?: string | null })[]).map(asRow);
    if (coldRows.length) {
      const seen = new Set(rows.map((r) => r.id));
      for (const r of coldRows) if (!seen.has(r.id)) rows.push(r);
      rows.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
      return { rows: rows.slice(0, limit), error: null, more: more || coldRows.length >= limit };
    }
  }
  return { rows, error: null, more };
}

function asRow(r: EmailRow & { communication_mailboxes?: unknown; body_preview?: string | null }): EmailRow {
  const row = { ...r, body: null, preview: r.body_preview ?? null } as EmailRow & { communication_mailboxes?: unknown; body_preview?: string | null };
  delete row.communication_mailboxes;
  delete row.body_preview;
  return row;
}

/** Bodies already read, by communication id, for the session: a thread opened twice is read once. */
const bodyCache = new Map<number, string | null>();

/** The bodies of these messages, from the cache or one read. */
export async function loadEmailBodies(ids: number[]): Promise<Map<number, string | null>> {
  const want = ids.filter((id) => !bodyCache.has(id));
  if (want.length && supabase) {
    for (let i = 0; i < want.length; i += 100) {
      const { data } = await supabase.from('communications').select('id,body').in('id', want.slice(i, i + 100));
      for (const r of (data ?? []) as { id: number; body: string | null }[]) bodyCache.set(r.id, r.body);
    }
  }
  return new Map(ids.map((id) => [id, bodyCache.get(id) ?? null]));
}

/**
 * The thread with every message's body, read when it is opened. Until the
 * read lands each message shows its preview; a thread whose rows already
 * carry bodies (the demo) is returned as it is.
 */
export function useThreadBodies<T extends EmailThread | null>(thread: T): T {
  const ids = thread ? thread.rows.filter((r) => r.body == null).map((r) => r.id) : [];
  const key = ids.join(',');
  const [bodies, setBodies] = useState<Map<number, string | null>>(() => new Map(ids.filter((id) => bodyCache.has(id)).map((id) => [id, bodyCache.get(id) ?? null])));
  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadEmailBodies(key.split(',').map(Number)).then((m) => { if (live) setBodies((cur) => new Map([...cur, ...m])); });
    return () => { live = false; };
  }, [key]);
  if (!thread || !key) return thread;
  const rows = thread.rows.map((r) => (r.body == null && bodies.has(r.id) ? { ...r, body: bodies.get(r.id) ?? r.preview ?? null } : r.body == null ? { ...r, body: r.preview ?? null } : r));
  return { ...thread, rows, last: rows[rows.length - 1]! } as T;
}

/**
 * The workspace's mail for TC, admin and owner; for anyone else only their own
 * mailbox (`ownOnly` is their user id). RLS (migration 106) enforces the same
 * rule on the rows; scoping the query as well keeps it right on a project that
 * has not applied 106 yet.
 */
export function useEmail(workspaceId: number | null, ownOnly: string | null = null) {
  const [rows, setRows] = useState<EmailRow[]>([]);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(Boolean(workspaceId && supabase));
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scope: EmailScope = ownOnly ? { kind: 'mailbox', userId: ownOnly } : { kind: 'all' };
  const scopeKey = JSON.stringify(scope);
  // Kept across live reloads of the newest page: the older pages Load more
  // brought in (contiguous, so `cursor` is where the next one starts) and the
  // hits a search brought in (anywhere in time, so never the cursor).
  const paged = useRef<EmailRow[]>([]);
  const found = useRef<EmailRow[]>([]);
  const cursor = useRef<string | null>(null);

  const merge = (a: EmailRow[], b: EmailRow[]) => {
    const by = new Map<number, EmailRow>();
    for (const r of [...a, ...b]) by.set(r.id, r);
    return [...by.values()].sort((x, y) => Date.parse(y.occurred_at) - Date.parse(x.occurred_at));
  };

  /** The newest page again (a live change). */
  const readNewest = useCallback((): Promise<void> => {
    if (!workspaceId || !supabase) return Promise.resolve();
    return loadEmailRows(workspaceId, JSON.parse(scopeKey) as EmailScope).then((r) => {
      if (r.error) setError(r.error);
      else {
        setError(null);
        setRows(merge(merge(r.rows, paged.current), found.current));
        if (!paged.current.length) {
          setHasMore(r.more);
          cursor.current = r.rows[r.rows.length - 1]?.occurred_at ?? null;
        }
      }
      setLoading(false);
    });
  }, [workspaceId, scopeKey]);

  /** The rows and the connection's status: on open, and when the rep asks. */
  const reload = useCallback((): Promise<void> => {
    if (!workspaceId || !supabase) return Promise.resolve();
    return Promise.all([readNewest(), googleStatus(workspaceId)]).then(([, status]) => {
      if (status.ok) setGoogle(status.data);
    });
  }, [workspaceId, readNewest]);

  useEffect(() => {
    paged.current = [];
    found.current = [];
    cursor.current = null;
    void reload();
  }, [reload]);

  /** The next 500, older than the oldest page loaded (not the oldest search hit). */
  const more = useCallback(async () => {
    if (!workspaceId || loadingMore || !cursor.current) return;
    setLoadingMore(true);
    const r = await loadEmailRows(workspaceId, JSON.parse(scopeKey) as EmailScope, 500, { before: cursor.current });
    setLoadingMore(false);
    if (r.error) return setError(r.error);
    paged.current = merge(paged.current, r.rows);
    cursor.current = r.rows[r.rows.length - 1]?.occurred_at ?? cursor.current;
    setRows((cur) => merge(cur, r.rows));
    setHasMore(r.more);
  }, [workspaceId, scopeKey, loadingMore]);

  /**
   * Older mail matching a search (subject, sender, recipient), from the server,
   * so a search reaches past what is loaded. The hits join the list and the
   * list's own filter shows them.
   */
  const [searching, setSearching] = useState(false);
  const search = useCallback(async (q: string) => {
    if (!workspaceId || searchTerm(q).length < 3) return;
    setSearching(true);
    const r = await loadEmailRows(workspaceId, JSON.parse(scopeKey) as EmailScope, 200, { search: q });
    setSearching(false);
    if (r.error || !r.rows.length) return;
    found.current = merge(found.current, r.rows);
    setRows((cur) => merge(cur, r.rows));
  }, [workspaceId, scopeKey]);

  // Live: a message synced, sent or refiled anywhere re-reads the newest page
  // (and, through `version`, the folder the rep has open). Coming back to the
  // tab catches up on anything the socket missed; nothing runs while hidden.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!workspaceId || !supabase) return;
    const sb = supabase;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let missed = false;
    const bump = () => {
      if (document.visibilityState !== 'visible') { missed = true; return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void readNewest(); setVersion((v) => v + 1); }, 1200);
    };
    const ch = sb.channel(`email-inbox-${workspaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'communications', filter: `workspace_id=eq.${workspaceId}` }, (p) => {
        const row = (p.new ?? p.old) as { channel?: string } | null;
        if (!row?.channel || row.channel === 'email') bump();
      })
      .subscribe();
    const onFocus = () => {
      if (document.visibilityState !== 'visible' || !missed) return;
      missed = false;
      bump();
    };
    document.addEventListener('visibilitychange', onFocus);
    // A socket can drop without saying so: every five minutes while in view.
    const every = setInterval(() => { if (document.visibilityState === 'visible') bump(); }, 300_000);
    return () => { if (timer) clearTimeout(timer); clearInterval(every); document.removeEventListener('visibilitychange', onFocus); void sb.removeChannel(ch); };
  }, [workspaceId, readNewest]);

  const threads = useMemo(() => groupThreads(rows), [rows]);
  const account = google?.account ?? null;
  const canSend = !!account && account.status === 'active' && account.gmail_send && granted(account, GOOGLE_SCOPE.gmailSend);
  return { threads, google, account, canSend, loading, error, reload, version, hasMore, loadingMore, more, search, searching };
}

/** Voicemail, as the dialer has always counted it: inbound, recorded, nobody picked up. */
export const isVoicemail = (h: HistoryItemDto) => h.kind === 'call' && h.direction === 'inbound' && h.has_recording && !h.user_name;

export function useCalls(authed: boolean) {
  const [calls, setCalls] = useState<HistoryItemDto[]>([]);
  const [loading, setLoading] = useState(authed);
  const [error, setError] = useState<string | null>(null);
  const fetchCalls = useCallback(() => {
    if (!authed) return;
    api.history({ type: 'calls', limit: 200 })
      .then((r) => { setCalls(r.items.filter((i) => i.kind === 'call')); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load calls'))
      .finally(() => setLoading(false));
  }, [authed]);
  useEffect(() => { fetchCalls(); }, [fetchCalls]);
  const reload = useCallback(() => { setLoading(true); fetchCalls(); }, [fetchCalls]);
  // A background read (the All tab's 20-second refresh): no loading state, the list stays put.
  return { calls, loading, error, reload, refresh: fetchCalls };
}
