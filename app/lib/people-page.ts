// One page of the People list from the server (people_page, migration 358),
// the way Follow Up Boss reads its lists: 50 rows, offset, sort and the
// filters in one call, instead of every seller in memory.
//
// Two halves. `serverFilters` turns a smart list, the People filters and a
// search into the function's jsonb, or null when something in them has no
// server equivalent (useClozr then keeps the in-memory path). `usePeoplePage`
// reads a page: the previous request aborted when the key changes, a
// two-minute cache per key, the last rows kept on screen while the next page
// loads, and the last page in localStorage so People paints before its read.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Person } from './clozr-types';
import { dateWindowBounds } from './date-window';
import { mapPagedSeller, type PagedSellerRow } from './crm';
import { parseSearch } from './list-search';
import { picksOf } from './multi-filter';
import { SMART_LIST_QUIET_MIN, isDeadLeadStage, isDeadGroup } from './reactivation';
import { SECRET_BLACKLIST_TAG } from './secret-list';
import { SELLER_STAGES, sellerStageGroup } from './stages';
import { supabase } from './supabase';

/** people_page's p_filters. Every key optional; see the migration for each. */
export type PeoplePageFilters = {
  stages?: string[]; stage_prefix?: string; not_stages?: string[];
  owners?: string[]; unassigned?: boolean;
  sources?: string[]; tags?: string[]; not_tags?: string[];
  ids?: number[]; not_ids?: number[];
  phone?: 'has' | 'none'; email?: 'has' | 'none';
  touch?: 'none' | 'any'; touch_within_min?: number; touch_older_min?: number; touch_quiet_min?: number;
  created_from?: string; created_to?: string;
  due_before?: string; closing?: boolean; compr?: 'run' | 'not'; dm?: boolean;
  terms?: string[]; digits?: string;
  archived?: boolean; stage_order?: string[]; ids_only?: boolean;
};
export type PeoplePageSort = 'touch' | 'created' | 'name' | 'stage' | 'score';
export type PeoplePageDir = 'asc' | 'desc';
export type PeoplePageSpec = { filters: PeoplePageFilters; sort: PeoplePageSort; dir: PeoplePageDir };

/** The People sort menu's labels that the server can order by. */
const SORTS: Record<string, [PeoplePageSort, PeoplePageDir]> = {
  Recent: ['touch', 'desc'], 'Date added': ['created', 'desc'], 'Oldest added': ['created', 'asc'],
  'Lead score': ['score', 'desc'], Name: ['name', 'asc'], Stage: ['stage', 'asc'], Oldest: ['touch', 'asc'],
};
/** Filter keys the server has no equivalent for; any of these set means the in-memory path. */
const CLIENT_ONLY = ['heat', 'closeCalls', 'declined', 'submitter', 'history', 'attackGap', 'uwTriage', 'offer', 'arv', 'market', 'subs', 'props', 'stack'] as const;

export type ServerFilterInput = {
  /** The smart list that is open ('My Leads'), a saved list (filters only) when `saved`. */
  list: string; saved: boolean;
  /** useClozr PeopleFilters, read by key so this module does not import the hook. */
  pf: Record<string, string | undefined>;
  /** The search box. */
  q: string;
  /** The signed-in user, for 'My Leads'. */
  me: string | null;
  /** Rep name to user id, for the Owner filter. */
  teamIds: Record<string, string>;
  /** Rows hidden this session (Account › secret list), as 's123' ids. */
  hiddenIds: string[];
  /** The stage labels in menu order, for the Stage sort. */
  stageOrder: string[];
  now?: Date;
};

const startOfTomorrow = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
const startOfToday = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
const stagesWhere = (ok: (label: string) => boolean) => SELLER_STAGES.map((x) => x.label).filter(ok);

/** What a smart list asks the server for; null when the list is not people rows the server can pick. */
function listFilters(list: string, me: string | null, now: Date): PeoplePageFilters | null {
  switch (list) {
    case 'Sellers': return {};
    case 'My Leads': return me ? { owners: [me] } : null;
    case 'New Leads': return { stages: stagesWhere((l) => sellerStageGroup(l) === 'lead') };
    case 'DM Prospects': return { dm: true };
    case 'Follow Up Today': return { due_before: startOfTomorrow(now) };
    case 'No Contact': return { touch: 'none' };
    case 'Offers Out': return { stages: stagesWhere((l) => sellerStageGroup(l) === 'offer') };
    case 'Appointments': return { stage_prefix: 'Appointment' };
    case 'Long-Term Follow-Up': return { tags: ['Long-term'] };
    case 'Dead Leads': return { stages: stagesWhere(isDeadLeadStage) };
    case 'Reactivation': return { touch_quiet_min: SMART_LIST_QUIET_MIN, not_stages: stagesWhere((l) => isDeadGroup(sellerStageGroup(l)) || sellerStageGroup(l) === 'closed') };
    case 'Unassigned': return { unassigned: true };
    case 'Recently Active': return { touch_within_min: 200 };
    // Hot Leads (Talkr's temperature), submission and UW triage lists (deal
    // rows), View imported and the vendor lists stay in memory.
    default: return null;
  }
}

/**
 * The server's filters for the open list, the People filters and the search,
 * or null when any of them needs the in-memory path. Pure, so
 * tools/people-page.test.ts can run it.
 */
export function serverFilters(input: ServerFilterInput): PeoplePageSpec | null {
  const now = input.now ?? new Date();
  const { pf } = input;
  const base = input.saved ? {} : listFilters(input.list, input.me, now);
  if (!base) return null;
  const f: PeoplePageFilters = { ...base, not_tags: [SECRET_BLACKLIST_TAG], stage_order: input.stageOrder };
  if (CLIENT_ONLY.some((k) => pf[k] && pf[k] !== 'Any')) return null;
  const sort = SORTS[pf.sort ?? 'Recent'];
  if (!sort) return null;

  const owners = picksOf(pf.owner);
  if (owners.length) {
    const ids = owners.filter((o) => o !== 'Unassigned').map((o) => input.teamIds[o]);
    if (ids.some((id) => !id)) return null;
    if (f.owners) {
      // 'My Leads' and an Owner pick: both must hold, so the list's owner has to be among the picks.
      const keep = f.owners.filter((id) => ids.includes(id));
      if (!keep.length && !owners.includes('Unassigned')) return { filters: { ...f, ids: [] }, sort: sort[0], dir: sort[1] };
      f.owners = keep;
    } else if (ids.length) f.owners = ids;
    if (owners.includes('Unassigned')) f.unassigned = true;
    if (f.owners && !f.owners.length) delete f.owners;
  }
  const stages = picksOf(pf.stage);
  if (stages.length) {
    let keep = stages;
    if (f.stages) keep = keep.filter((x) => f.stages!.includes(x));
    if (f.stage_prefix) keep = keep.filter((x) => x.startsWith(f.stage_prefix!));
    if (f.not_stages) keep = keep.filter((x) => !f.not_stages!.includes(x));
    f.stages = keep;
    delete f.stage_prefix;
  }
  const sources = picksOf(pf.source);
  if (sources.length) f.sources = sources;
  const tags = picksOf(pf.tag);
  if (tags.length) {
    if (f.tags) return null;
    f.tags = tags;
  }
  const dates = picksOf(pf.date);
  if (dates.length > 1) return null;
  if (dates.length === 1) {
    switch (dates[0]) {
      case 'Created today': f.created_from = startOfToday(now); break;
      case 'Contacted today': f.touch_within_min = 600; break;
      case 'No contact 7 days': f.touch_older_min = 10_000; break;
      case 'Closing this month': f.closing = true; break;
      default: return null;
    }
  }
  const phones = picksOf(pf.phone);
  if (phones.length === 1) f.phone = phones[0] === 'Has phone' ? 'has' : 'none';
  const emails = picksOf(pf.email);
  if (emails.length === 1) f.email = emails[0] === 'Has email' ? 'has' : 'none';
  const comprs = picksOf(pf.compr);
  if (comprs.length === 1) {
    if (comprs[0] === 'Run') f.compr = 'run';
    else if (comprs[0] === 'Not run') f.compr = 'not';
    else return null;
  } else if (comprs.length > 1) return null;
  if (pf.addedWhen && pf.addedWhen !== 'Any') {
    const w = dateWindowBounds(pf.addedWhen, pf.addedFrom, pf.addedTo, now);
    if (w) {
      if (Number.isFinite(w.lo)) f.created_from = new Date(Math.max(w.lo, Date.parse(f.created_from ?? '') || -Infinity)).toISOString();
      if (Number.isFinite(w.hi)) f.created_to = new Date(w.hi).toISOString();
    }
  }
  const search = parseSearch(input.q);
  if (search) {
    f.terms = search.terms;
    if (search.digits) f.digits = search.digits;
  }
  const hidden = input.hiddenIds.map((id) => Number(id.replace(/^s/, ''))).filter((n) => Number.isFinite(n));
  if (hidden.length) f.not_ids = hidden;
  return { filters: f, sort: sort[0], dir: sort[1] };
}

// ---- the read ---------------------------------------------------------------

export type PeoplePageArgs = {
  /** Null (demo, or a list the server cannot page) reads nothing. */
  workspaceId: number | null;
  filters: PeoplePageFilters;
  sort?: PeoplePageSort;
  dir?: PeoplePageDir;
  /** Zero-based. */
  page: number;
  pageSize?: number;
};

export type PeoplePage = {
  rows: Person[];
  total: number;
  /** A read is in flight; `rows` are the previous page's until it lands. */
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Every id the filters match, in list order, for "select all N matching". */
  matchingIds: () => Promise<string[]>;
};

type Cached = { rows: Person[]; total: number; at: number };
const CACHE_MS = 2 * 60_000;
const cache = new Map<string, Cached>();
const LAST_KEY = 'clozr.peoplePage';

type RpcResult = { total?: number; rows?: PagedSellerRow[]; ids?: number[] };

/** usePeoplePage's key back into its arguments. */
function argsOf(k: string) {
  const [ws, f, so, di, pg, ps] = JSON.parse(k) as [number, PeoplePageFilters, PeoplePageSort, PeoplePageDir, number, number];
  return { workspaceId: ws, filters: f, sort: so, dir: di, page: pg, pageSize: ps };
}

async function readPage(args: Required<Omit<PeoplePageArgs, 'workspaceId'>> & { workspaceId: number }, signal?: AbortSignal): Promise<RpcResult> {
  if (!supabase) throw new Error('No database');
  let q = supabase.rpc('people_page' as never, {
    p_ws: args.workspaceId, p_filters: args.filters, p_sort: args.sort, p_dir: args.dir,
    p_lim: args.pageSize, p_off: args.page * args.pageSize,
  } as never);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? {}) as RpcResult;
}

function readLast(key: string): Cached | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const v = raw ? JSON.parse(raw) as { key: string } & Cached : null;
    return v && v.key === key && Array.isArray(v.rows) ? { rows: v.rows, total: v.total, at: v.at } : null;
  } catch { return null; }
}
function writeLast(key: string, c: Cached) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ key, ...c })); } catch { /* storage full or off */ }
}

// Sellers that changed, from use-crm.ts (realtime INSERT and UPDATE, a
// refreshed slice, a local patch). A page holding one of them re-reads that
// row; anything else re-reads the page a beat later for its total.
type Change = { ids: number[]; patch?: { id: string } & Record<string, unknown>; stale?: boolean };
const listeners = new Set<(c: Change) => void>();
/** Tell open People pages these sellers changed; `patch` is a known field change applied at once. */
export function sellersChanged(ids: number[], patch?: Change['patch']) {
  for (const fn of listeners) fn({ ids, patch });
}
/** A structural write (a reload): every open page re-reads itself a beat later. */
export function peoplePagesStale() {
  for (const fn of listeners) fn({ ids: [], stale: true });
}

export function usePeoplePage({ workspaceId, filters, sort = 'touch', dir = 'desc', page, pageSize = 50 }: PeoplePageArgs): PeoplePage {
  // The key carries every argument, so the effects below read it back instead
  // of holding refs that render would have to write.
  const key = workspaceId == null ? '' : JSON.stringify([workspaceId, filters, sort, dir, page, pageSize]);
  // What the last read returned, and for which key and refetch count.
  const [got, setGot] = useState<{ key: string; n: number; data: Cached | null; error: string | null }>({ key: '', n: -1, data: null, error: null });
  // Refetches are counted per key, so a fresh cache entry still serves the next key.
  const [again, setAgain] = useState({ key: '', n: 0 });
  const n = again.key === key ? again.n : 0;
  const hit = key ? cache.get(key) : undefined;
  // A cached page is drawn at once; the effect re-reads it when it is older than CACHE_MS.
  const fresh = !!hit && n === 0;
  const settled = got.key === key && got.n === n;
  const last = useMemo(() => (key ? readLast(key) : null), [key]);
  // This page once it has landed, else a cached copy, else the previous rows
  // (keepPreviousData), else the last page this browser saw.
  const data = settled ? got.data : hit ?? got.data ?? last;
  const loading = !!key && !settled && !fresh;

  useEffect(() => {
    if (!key) return;
    const c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS && n === 0) return;
    const ac = new AbortController();
    void readPage(argsOf(key), ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      const next = { rows: (r.rows ?? []).map(mapPagedSeller), total: r.total ?? 0, at: Date.now() };
      cache.set(key, next);
      writeLast(key, next);
      setGot({ key, n, data: next, error: null });
    }).catch((e: unknown) => {
      if (ac.signal.aborted) return;
      setGot((prev) => ({ key, n, data: prev.data, error: e instanceof Error ? e.message : 'The read failed' }));
    });
    // The previous request is aborted when the key changes.
    return () => { ac.abort(); };
  }, [key, n]);

  // Plain functions: the React Compiler memoizes them, and its inferred dependencies disagreed with a hand-written useCallback.
  const refetch = () => { cache.delete(key); setAgain((a) => ({ key, n: (a.key === key ? a.n : 0) + 1 })); };

  // Changes from realtime or a save: a row on this page is re-read by id,
  // anything else re-reads the page (debounced) so the total is right.
  const rows = data?.rows;
  const rowsRef = useRef<Person[]>([]);
  useEffect(() => { rowsRef.current = rows ?? []; }, [rows]);
  useEffect(() => {
    if (!key) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fn = ({ ids, patch, stale }: Change) => {
      const onPage = ids.filter((id) => rowsRef.current.some((r) => r.id === 's' + id));
      const apply = (edit: (rows: Person[]) => Person[]) => setGot((prev) => {
        const base = prev.key === key && prev.n === n ? prev.data : cache.get(key) ?? prev.data;
        if (!base) return prev;
        const next = edit(base.rows);
        const d = { ...base, rows: next, total: base.total - (base.rows.length - next.length) };
        cache.set(key, d);
        return { key, n, data: d, error: null };
      });
      if (patch) apply((rs) => rs.map((r) => (r.id === patch.id ? { ...r, ...patch } as Person : r)));
      if (onPage.length) {
        const a = argsOf(key);
        void readPage({ ...a, filters: { ...a.filters, ids: onPage }, page: 0, pageSize: onPage.length }).then((r) => {
          const fetched = new Map((r.rows ?? []).map(mapPagedSeller).map((p) => [p.id, p] as const));
          // A row that no longer matches the filters leaves the page; the total follows.
          apply((rs) => rs.flatMap((row) => (onPage.includes(Number(row.id.slice(1))) ? (fetched.has(row.id) ? [fetched.get(row.id)!] : []) : [row])));
        }).catch(() => { /* the next read answers for it */ });
      }
      if (stale || onPage.length < ids.length) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; cache.delete(key); setAgain((x) => ({ key, n: (x.key === key ? x.n : 0) + 1 })); }, 800);
      }
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); if (timer) clearTimeout(timer); };
  }, [key, n]);

  const matchingIds = async () => {
    if (!key) return [];
    const a = argsOf(key);
    const r = await readPage({ ...a, filters: { ...a.filters, ids_only: true } });
    return (r.ids ?? []).map((id) => 's' + id);
  };

  return { rows: rows ?? [], total: data?.total ?? 0, loading, error: settled ? got.error : null, refetch, matchingIds };
}
