// Load the signed-in workspace and keep it fresh.
//
// Kept apart from lib/crm.ts so that module stays a pure mapping from rows to
// screen shapes, testable without React.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type CrmData, emptyLiveData, enrichWorkspace, loadDealGallery, loadSellerSlice, loadSellerSlices, loadWorkspace, mergeSlice, withGallery } from './crm';
import { LEAD_BATCH_MS, LEAD_HOLD_AT, RELOAD_DEBOUNCE_MS, planLeadRefresh } from './lead-refresh';
import { playEvent } from './phone-audio';
import { supabase } from './supabase';
import { type WorkspaceSettings, loadSettings } from './integrations';
import { ensureCatalogPlans } from './plans';
import { useSession } from './session';

export type CrmState = {
  /** The workspace, or null while loading or in demo mode. */
  live: CrmData | null;
  /** False until the first load settles, so screens can hold the frame. */
  ready: boolean;
  /**
   * False when a read failed. An empty workspace and an unreachable database
   * both render as "nothing here", and they mean opposite things — this is how
   * a screen tells them apart.
   */
  ok: boolean;
  /** True while the first screen shows the shell read (newest 1,000 sellers); the full read is still coming. */
  partial: boolean;
  /**
   * Re-read the whole workspace (about 29 reads). For a bulk or structural
   * write; a save on one record wants refreshSeller or patchLocal.
   */
  reload: () => void;
  /**
   * Change rows already on screen, with no read: `row` is the screen shape's
   * id and the fields that changed. For a field save whose new value is known.
   */
  patchLocal: (table: PatchTable, row: { id: string } & Record<string, unknown>) => void;
  /** Re-read one seller and their deals (five small reads) after a save on that record. */
  refreshSeller: (sellerId: number) => Promise<void>;
  /** Re-read one deal's seller and deals; a deal with no seller re-reads the workspace. */
  refreshDeal: (dealId: number) => Promise<void>;
  /** Read every photo on these deals into their galleries (the workspace load reads one cover per deal). */
  loadGallery: (dealIds: number[]) => Promise<void>;
  /** Integration keys from Settings; empty until loaded. */
  settings: WorkspaceSettings;
};

/** The lists patchLocal can change in place, each keyed by its screen id. */
export type PatchTable = 'people' | 'deals' | 'buyers' | 'vendors' | 'tasks' | 'offers' | 'matches' | 'transactions';
type Patch = { at: number; apply: (d: CrmData) => CrmData };
/** How long a local patch is re-applied over a full load that started before it. */
const PATCH_KEEP_MS = 60_000;

/**
 * The import screen calls pauseLive for the whole run and resumeLive when it
 * finishes. While paused, seller inserts do not start reads: the import
 * reloads once at the end. A count, so a nested pause still holds.
 */
let livePause = 0;
export function pauseLive() { livePause += 1; }
export function resumeLive() { livePause = Math.max(0, livePause - 1); }
export function liveIsPaused() { return livePause > 0; }

/**
 * Reporting and the leaderboard call holdReporting while they are on screen.
 * The heavy reporting reads wait for that, and refresh on a ten minute timer
 * only while something is holding.
 */
let reportingWatchers = 0;
const reportingListeners = new Set<() => void>();

export function reportingHeld() { return reportingWatchers > 0; }

export function holdReporting(): () => void {
  reportingWatchers += 1;
  for (const fn of reportingListeners) fn();
  return () => {
    reportingWatchers = Math.max(0, reportingWatchers - 1);
    for (const fn of reportingListeners) fn();
  };
}

function onReportingWatch(fn: () => void): () => void {
  reportingListeners.add(fn);
  return () => { reportingListeners.delete(fn); };
}

function reportingOff() { return false; }

/** New leads held back from a read, waiting for a click. */
let pendingLeads = 0;
const pendingListeners = new Set<() => void>();
let pendingRefresh: (() => void) | null = null;

function setPendingLeads(n: number) {
  pendingLeads = n;
  for (const fn of pendingListeners) fn();
}

export function usePendingLeads(): { count: number; refresh: () => void } {
  const [count, setCount] = useState(pendingLeads);
  useEffect(() => {
    const fn = () => setCount(pendingLeads);
    pendingListeners.add(fn);
    fn();
    return () => { pendingListeners.delete(fn); };
  }, []);
  return { count, refresh: () => pendingRefresh?.() };
}

/** One row in a list replaced field by field; the list itself is new only when the row was there. */
export function patchRows<T extends { id: string }>(rows: T[] | undefined, row: { id: string } & Record<string, unknown>): T[] | undefined {
  if (!rows) return rows;
  const at = rows.findIndex((r) => r.id === row.id);
  if (at < 0) return rows;
  const next = rows.slice();
  next[at] = { ...rows[at], ...row };
  return next;
}

/** How long offer gaps and the reporting history are reused across reloads before they are read again. */
const HEAVY_EVERY_MS = 10 * 60_000;
/** Workspace and user pairs whose catalog plans were already checked this page load. */
const plansChecked = new Set<string>();

export function useCrm(): CrmState {
  const s = useSession();
  const workspaceId = s.workspace?.id ?? null;
  const userId = s.user?.id ?? null;
  const [nonce, setNonce] = useState(0);
  const [reportTick, setReportTick] = useState(0);
  const reportingOn = useSyncExternalStore(onReportingWatch, reportingHeld, reportingOff);

  // Keyed by the workspace it was loaded for, so switching workspaces (or
  // signing out) reads as "not loaded" on the very next render instead of
  // briefly showing the previous workspace's pipeline. Clearing it from an
  // effect would be a frame too late, and a synchronous setState in an effect
  // is exactly what React warns about.
  const [loaded, setLoaded] = useState<{ key: string; data: CrmData; ok: boolean; settings: WorkspaceSettings; partial?: boolean } | null>(null);
  const key = workspaceId === null ? '' : `${workspaceId}:${nonce}`;
  const loadedRef = useRef<string | null>(null);
  useEffect(() => { loadedRef.current = loaded?.key ?? null; }, [loaded]);

  // One full read at a time. A reload asked for while one is running waits
  // for it and then runs once, instead of starting a second read of every
  // table whose answer the first one's cleanup throws away.
  const inFlight = useRef(false);
  const again = useRef(false);
  // The last enriched load and when its heavy half (offer gaps, reporting
  // history) was read; reloads in between reuse it.
  const enriched = useRef<{ ws: number; at: number; data: CrmData; reporting: boolean } | null>(null);
  const reportGen = useRef(0);
  const loadedNow = useRef(loaded);
  useEffect(() => { loadedNow.current = loaded; }, [loaded]);
  // Local patches and refreshed slices, kept a minute: a full load that was
  // already reading when one landed would otherwise put the old row back.
  const patches = useRef<Patch[]>([]);
  const replay = (data: CrmData, since: number) => {
    patches.current = patches.current.filter((p) => Date.now() - p.at < PATCH_KEEP_MS);
    return patches.current.filter((p) => p.at >= since).reduce((d, p) => p.apply(d), data);
  };

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    reportGen.current += 1;
    const gen = reportGen.current;
    const key = `${workspaceId}:${nonce}`;
    const startedAt = Date.now();
    inFlight.current = true;
    const settle = () => {
      inFlight.current = false;
      if (again.current) { again.current = false; setNonce((n) => n + 1); }
    };
    // Catalog plans used to block the whole read. They only matter the first
    // time a workspace is missing one, so they run beside the shell load.
    const planKey = `${workspaceId}:${userId}`;
    if (!plansChecked.has(planKey)) { plansChecked.add(planKey); void ensureCatalogPlans(workspaceId, userId); }
    const settingsP = loadSettings(workspaceId);
    // First paint: when nothing of this workspace is on screen yet, the shell
    // read (the newest 1,000 sellers plus what Home needs) paints in one round
    // of reads while the full read continues. A reload never takes this path,
    // so it never shrinks the list to the shell.
    const first = !loadedRef.current || !loadedRef.current.startsWith(`${workspaceId}:`);
    let fullLanded = false;
    if (first) {
      void Promise.all([loadWorkspace(workspaceId, { shell: true }), settingsP]).then(([{ ok, data }, settings]) => {
        if (live && !fullLanded && ok) setLoaded((prev) => (prev && prev.key === key ? prev : { key, data: replay(data, startedAt), ok, settings, partial: true }));
      }).catch(() => { /* the full read below answers for it */ });
    }
    void Promise.all([loadWorkspace(workspaceId), settingsP]).then(([{ ok, data }, settings]) => {
      fullLanded = true;
      if (!live) { settle(); return; }
      setLoaded({ key, data: replay(data, startedAt), ok, settings });
      if (!ok) { settle(); return; }
      // Photos every time. Offer gaps and the reporting history only while
      // Reporting or the leaderboard is open, and only once every ten minutes.
      const last = enriched.current;
      const reuse = last && last.reporting && last.ws === workspaceId && Date.now() - last.at < HEAVY_EVERY_MS ? last.data : null;
      const ask = reportingHeld() && (typeof document === 'undefined' || !document.hidden) && !reuse;
      void enrichWorkspace(workspaceId, data, reuse, { reporting: ask }).then((next) => {
        if (!live || reportGen.current !== gen) return;
        enriched.current = {
          ws: workspaceId,
          at: ask ? Date.now() : (reuse && last ? last.at : 0),
          data: next,
          reporting: ask || !!reuse,
        };
        setLoaded((prev) => (prev && prev.key === key ? { ...prev, data: replay(next, startedAt) } : prev));
        if (reportingHeld() && !ask && !reuse) setReportTick((n) => n + 1);
      }).catch(() => {
        // The money columns, offers and full call history never came: say so
        // on Reporting rather than leave the first load's zeros standing.
        if (!live || !ask) return;
        setLoaded((prev) => {
          const raw = prev && prev.key === key ? prev.data.reporting.raw : null;
          return raw ? { ...prev!, data: { ...prev!.data, reporting: { ...prev!.data.reporting, raw: { ...raw, partial: 'failed' } } } } : prev;
        });
      }).finally(settle);
    }, () => {
      // A read that threw used to leave the skeleton up for good. Now the app
      // opens with its "couldn't load" states and Retry instead.
      fullLanded = true;
      // What is already on screen stays (the shell's sellers too), marked failed.
      if (live) setLoaded((prev) => (prev && prev.key.startsWith(`${workspaceId}:`)
        ? { ...prev, ok: prev.partial ? false : prev.ok, partial: false }
        : { key, data: emptyLiveData(), ok: false, settings: {} }));
      settle();
    });
    return () => { live = false; };
  }, [workspaceId, userId, nonce]);

  // Writes fire reload() in bursts (a save, then the timeline, then a match
  // refresh); one read serves them all, so a burst is coalesced into a single
  // fetch a beat later instead of three full loads of every table.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      if (inFlight.current) again.current = true;
      else setNonce((n) => n + 1);
    }, RELOAD_DEBOUNCE_MS);
  }, []);
  // Applied now and replayed over any full load already reading (replay above).
  const apply = useCallback((fn: (d: CrmData) => CrmData) => {
    patches.current.push({ at: Date.now(), apply: fn });
    setLoaded((prev) => (prev ? { ...prev, data: fn(prev.data) } : prev));
  }, []);
  const patchLocal = useCallback((table: PatchTable, row: { id: string } & Record<string, unknown>) => {
    apply((d) => {
      const list = d[table] as { id: string }[] | undefined;
      const next = patchRows(list, row);
      return next === list ? d : { ...d, [table]: next };
    });
  }, [apply]);
  // The workspace a refresh was read for must still be the one on screen.
  const wsNow = useRef(workspaceId);
  useEffect(() => { wsNow.current = workspaceId; patches.current = []; }, [workspaceId]);

  useEffect(() => {
    if (!reportingOn) return;
    const onVis = () => { if (!document.hidden) setReportTick((n) => n + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [reportingOn]);
  useEffect(() => {
    if (!workspaceId || !reportingOn) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setReportTick((n) => n + 1);
    }, HEAVY_EVERY_MS);
    return () => window.clearInterval(id);
  }, [workspaceId, reportingOn]);
  useEffect(() => {
    if (!workspaceId || !reportingOn || (typeof document !== 'undefined' && document.hidden)) return;
    if (inFlight.current) return;
    const last = enriched.current;
    if (last?.reporting && last.ws === workspaceId && Date.now() - last.at < HEAVY_EVERY_MS) return;
    const cur = loadedNow.current;
    if (!cur?.ok || !cur.data.reporting.raw) return;
    const gen = reportGen.current;
    const started = Date.now();
    let cancelled = false;
    void enrichWorkspace(workspaceId, cur.data, null, { reporting: true }).then((next) => {
      if (cancelled || reportGen.current !== gen || wsNow.current !== workspaceId) return;
      enriched.current = { ws: workspaceId, at: Date.now(), data: next, reporting: true };
      setLoaded((prev) => (prev && prev.key.startsWith(`${workspaceId}:`) ? { ...prev, data: replay(next, started) } : prev));
    }).catch(() => {
      if (cancelled || reportGen.current !== gen) return;
      setLoaded((prev) => {
        const raw = prev?.data.reporting.raw;
        if (!raw || !prev.key.startsWith(`${workspaceId}:`)) return prev;
        return { ...prev, data: { ...prev.data, reporting: { ...prev.data.reporting, raw: { ...raw, partial: 'failed' } } } };
      });
    });
    return () => { cancelled = true; };
  }, [workspaceId, reportingOn, reportTick, nonce]);
  const refreshSeller = useCallback(async (sellerId: number) => {
    if (!workspaceId || !Number.isFinite(sellerId)) return;
    const slice = await loadSellerSlice(workspaceId, sellerId);
    if (wsNow.current !== workspaceId) return;
    if (!slice) { reload(); return; }
    apply((d) => mergeSlice(d, slice));
  }, [workspaceId, apply, reload]);
  const sellerOfDeal = useRef<(dealId: number) => number | null>(() => null);
  const refreshDeal = useCallback(async (dealId: number) => {
    const seller = sellerOfDeal.current(dealId);
    if (seller == null) { reload(); return; }
    await refreshSeller(seller);
  }, [refreshSeller, reload]);
  const loadGallery = useCallback(async (dealIds: number[]) => {
    const ids = [...new Set(dealIds.filter((n) => Number.isFinite(n)))];
    if (!ids.length) return;
    const ws = wsNow.current;
    const rows = await loadDealGallery(ids);
    if (!rows?.length || wsNow.current !== ws) return;
    const want = new Set(ids.map((n) => 'd' + n));
    apply((d) => ({ ...d, deals: d.deals.map((x) => (want.has(x.id) ? withGallery(x, rows) : x)) }));
  }, [apply]);

  // A lead that lands (a web form, a Podio sync, a teammate's add) is on
  // screen within seconds and makes the new-lead sound, so it is called
  // inside the 60–90 second window instead of after someone reloads. One
  // channel per workspace; RLS decides which rows reach this browser
  // (migration 226 adds sellers to the realtime publication). Arrivals are
  // gathered for a moment. A burst is read by id in chunks of 200. Past
  // LEAD_HOLD_AT the tab shows a count and waits for a click, instead of
  // re-reading the workspace. Nothing runs while the tab is hidden or while
  // an import has paused live updates.
  const refreshRef = useRef(refreshSeller);
  const reloadRef = useRef(reload);
  const applyRef = useRef(apply);
  useEffect(() => { refreshRef.current = refreshSeller; reloadRef.current = reload; applyRef.current = apply; }, [refreshSeller, reload, apply]);
  useEffect(() => {
    pendingRefresh = () => { setPendingLeads(0); reloadRef.current(); };
    return () => { if (pendingRefresh) pendingRefresh = null; };
  }, []);
  useEffect(() => {
    const db = supabase;
    if (!db || !workspaceId || s.demo) return;
    const batch = { ids: new Set<number>(), sound: false, timer: null as ReturnType<typeof setTimeout> | null };
    const flush = () => {
      batch.timer = null;
      if (liveIsPaused()) { batch.ids.clear(); batch.sound = false; return; }
      if (typeof document !== 'undefined' && document.hidden) return;
      const ids = [...batch.ids];
      const sound = batch.sound;
      batch.ids.clear(); batch.sound = false;
      if (!ids.length) return;
      if (sound) playEvent('lead');
      const plan = planLeadRefresh(ids.length);
      if (plan === 'hold') { setPendingLeads(pendingLeads + ids.length); return; }
      if (plan === 'each') { for (const id of ids) void refreshRef.current(id); return; }
      const ws = workspaceId;
      void loadSellerSlices(ws, ids).then((slices) => {
        if (wsNow.current !== ws) return;
        if (!slices) { setPendingLeads(pendingLeads + ids.length); return; }
        applyRef.current((d) => slices.reduce((acc, slice) => mergeSlice(acc, slice), d));
      }).catch(() => { if (wsNow.current === ws) setPendingLeads(pendingLeads + ids.length); });
    };
    const ch = db.channel(`crm-sellers:${workspaceId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sellers', filter: `workspace_id=eq.${workspaceId}` }, (m) => {
        if (liveIsPaused()) return;
        const row = m.new as { id?: number; archived_at?: string | null; created_by?: string | null };
        if (row.id == null || row.archived_at) return;
        batch.ids.add(row.id);
        // Someone adding a contact by hand already knows it arrived.
        if (!row.created_by || row.created_by !== userId) batch.sound = true;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (batch.ids.size > LEAD_HOLD_AT) {
          if (batch.timer) clearTimeout(batch.timer);
          flush();
          return;
        }
        batch.timer ??= setTimeout(flush, LEAD_BATCH_MS);
      })
      .subscribe();
    const onVisible = () => { if (!document.hidden && batch.ids.size) flush(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (batch.timer) clearTimeout(batch.timer);
      document.removeEventListener('visibilitychange', onVisible);
      void db.removeChannel(ch);
    };
  }, [workspaceId, userId, s.demo]);

  // A reload (same workspace, new nonce) keeps showing what is on screen until
  // the fresh read lands; only a different workspace reads as "not loaded".
  // Otherwise every save blanked the whole app for a moment, like a refresh.
  const current = loaded && (loaded.key === key || (workspaceId !== null && loaded.key.startsWith(`${workspaceId}:`))) ? loaded : null;
  const liveDeals = current?.data.deals;
  useEffect(() => {
    const byDeal = new Map((liveDeals ?? []).map((d) => [d.id, d.personId] as const));
    sellerOfDeal.current = (dealId) => {
      const pid = byDeal.get('d' + dealId);
      return pid && /^s\d+$/.test(pid) ? Number(pid.slice(1)) : null;
    };
  }, [liveDeals]);

  return useMemo(() => ({
    live: current ? current.data : null,
    // In demo mode there is nothing to wait for.
    ready: s.demo ? true : !!current,
    ok: current ? current.ok : true,
    partial: !!current?.partial,
    reload,
    patchLocal,
    refreshSeller,
    refreshDeal,
    loadGallery,
    settings: current ? current.settings : {},
  }), [current, s.demo, reload, patchLocal, refreshSeller, refreshDeal, loadGallery]);
}
