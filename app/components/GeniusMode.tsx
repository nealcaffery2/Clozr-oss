// Genius Mode: every cash buyer already buying around a house.
//
// Two homes, one component. On the Genius page (standalone) it opens with a
// search bar — any address, or one of your deals — and a rail of past searches
// that reopen for free. On a deal it is the Genius tab, centred on that deal.
//
// The layout is InvestorBase's and DispoGenius's: a map on the left with every
// purchase pinned by buyer type, the ranked list on the right, a filter bar
// over both. A run streams in: the subject first, then how many sales there are
// to scan, progress, and buyers as they are ready. Narrowing a filter
// (tighter radius, fewer months, a price band) applies to the list at once;
// widening one needs a new search, and the bar says so.
//
// On a phone the map sits above the list at a fixed height, and every card's
// actions move under it as full-width buttons.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Candidate, type Kind, type Method, type PastRun, type PhoneMark, type Run, type RunEvent, type RunFilters, type Strategy, type Suggestion, type Target,
  DEFAULT_FILTERS, KIND_BADGE, KIND_COLOR, KIND_LABEL, KIND_PLURAL, METHOD_BLURB, METHOD_LABEL, RUN_METHODS, STRATEGY_LABEL, foundLabel, methodOf,
  addCandidate, addPhone, applyTraceToBuyer, autocomplete, bestPhone, dealCenter, dealOptions, discover, downloadCsv, estimate, hasSkipTraceContact, lastPropertyRun, loadRun, markPhone, pastRuns, propertyRuns,
  saveCandidates, skipTrace, toCsv,
} from '@/lib/genius';
import { importInvestorBase } from '@/lib/investorbase';
import { SearchSelect } from '@/components/SearchSelect';
import { heat } from '@/lib/heat';
import { SKIPTRACE_TAG, logRun, notifyUser } from '@/lib/data-runs';
import { Analytics } from './genius/Analytics';
import { BuyerCard } from './genius/BuyerCard';
import { GeniusMap, type MapPin } from './genius/GeniusMap';
import { PortfolioDrawer } from './genius/PortfolioDrawer';
import { Wholesalers } from './genius/Wholesalers';
import { Badge, Control, Field, GREEN, GX_CSS, HAIR, ICON, INK, Icon, LINE, MUTED, PURPLE, PURPLE_TINT, Pill, RED, SHADOW, Toggle, ago, btn, input, money, shortMoney, when } from './genius/parts';

type Props = {
  workspaceId: number | null; userId: string | null; canWrite: boolean; isMobile: boolean;
  onToast: (m: string) => void; onAdded?: () => void;
  /** Deal mode: the run centres on this deal. */
  dealId?: number | null;
  /** The Genius page: search bar and past searches. */
  standalone?: boolean;
  onCall?: (name: string, phone: string) => void;
  onQueue?: (buyerIds: number[]) => void | Promise<void>;
  onOpenBuyer?: (id: number) => void;
  /**
   * Hand the selection, once it is in the buyer list, to the campaign builder of
   * the deal this search was run for. It says so when the builder has them.
   */
  onCampaign?: (buyerIds: number[], dealId: number) => void;
  /** Add the selection to a deal's marketing list and stay on this search. */
  onAddToMarketing?: (buyerIds: number[], dealId: number) => void;
  /** After buyers land in Buyer Prospects. */
  onShowProspects?: () => void;
  initialFilters?: Partial<RunFilters>;
  initialQuery?: string;
  /** The /demo route only: a finished search and past searches held in memory (lib/genius-demo.ts). */
  seed?: { run: Run; past: PastRun[] };
};

type Sort = 'smart' | 'distance' | 'recent' | 'deals' | 'price';
type Sub = 'all' | 'matched' | 'not';
type Progress = { stage: keyof typeof STAGE_LABEL; done: number; total: number } | null;
const PAGE = 25;
/** Height of the phone list/map/analytics switch; the bulk bar sticks just under it. */
const SWITCH_H = 44;
const KINDS: Kind[] = ['flipper', 'landlord', 'builder'];
const TYPES: [string, string][] = [['SFR', 'SFR'], ['CONDO', 'Condo'], ['MFR', 'Multi'], ['MOBILE', 'Mobile'], ['LAND', 'Land']];
/** Which data source found a buyer, in compare mode. */
const sourceOf = (c: Candidate): 'both' | 'reapi' | 'attom' => {
  const s = c.sources ?? [];
  return s.includes('attom') && s.includes('reapi') ? 'both' : s.includes('attom') ? 'attom' : 'reapi';
};

const STAGE_LABEL = { search: 'Pulling sales', enrich: 'Enriching purchases', skiptrace: 'Skip tracing', attom: 'Pulling ATTOM sales', attom_owners: 'Reading ATTOM owners', homefull: 'Checking flip photos', snipe: 'Reading deed chains', deeds: 'Searching the deed index' } as const;

const card: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '14px', overflow: 'hidden' };

/** Current owner of a house someone already resold. Homefull wants the flipper. */
function retailEndBuyer(c: Candidate, all: Candidate[]): boolean {
  const open = new Set(c.purchases.filter((p) => !p.resale_date && p.reapi_id).map((p) => p.reapi_id));
  if (!open.size) return false;
  return all.some((o) => o.key !== c.key && o.purchases.some((p) => p.resale_date && p.reapi_id && open.has(p.reapi_id)));
}

/** Did the filters widen past what the run pulled? Then only a new search can show more. */
function widened(f: RunFilters, ran: Partial<RunFilters> | undefined): boolean {
  if (!ran) return false;
  const has = (xs: string[] | undefined, x: string) => !xs || xs.includes(x);
  return f.radius_mi > (ran.radius_mi ?? 99) || f.months > (ran.months ?? 99)
    || f.kinds.some((k) => !has(ran.kinds, k)) || f.property_types.some((t) => !has(ran.property_types, t))
    || (f.include_non_arms_length && ran.include_non_arms_length === false)
    || (f.flip_months !== (ran.flip_months ?? f.flip_months))
    || f.methods.some((m) => !(ran.methods ?? []).includes(m));
}

export function GeniusMode(props: Props) {
  const { workspaceId, userId, canWrite, isMobile, onToast, standalone } = props;
  const dealId = props.dealId ?? null;
  const [filters, setFilters] = useState<RunFilters>({ ...DEFAULT_FILTERS, ...props.initialFilters });
  const setF = (p: Partial<RunFilters>) => setFilters((f) => ({ ...f, ...p }));
  const [hideNoPhone, setHideNoPhone] = useState(false);
  const [more, setMore] = useState(false);
  const [traceAll, setTraceAll] = useState(false);
  // Compare mode: RealEstateAPI and ATTOM side by side, merged without duplicates.
  const [compare, setCompare] = useState(false);
  const [compareStats, setCompareStats] = useState<Extract<RunEvent, { type: 'compare' }> | null>(null);
  const [sourceSel, setSourceSel] = useState<'all' | 'both' | 'reapi' | 'attom'>('all');
  // The method passes: which labelled or added how many, and what one could not do.
  const [methodStats, setMethodStats] = useState<Extract<RunEvent, { type: 'methods' }> | null>(null);
  const [methodSel, setMethodSel] = useState<Method | 'all'>('all');
  // The Genius page: the search, or the wholesaler database behind the Wholesaler buyers method.
  const [pane, setPane] = useState<'search' | 'wholesalers'>('search');
  // Phones: the filters fold to a one-line summary once there are results, and
  // the map and the list take turns filling the screen instead of stacking.
  const [editF, setEditF] = useState(false);
  const [mView, setMView] = useState<'list' | 'map'>('list');

  // Where the search centres.
  const [query, setQuery] = useState(props.initialQuery ?? '');
  const [typed, setTyped] = useState(false);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [picked, setPicked] = useState<Target | null>(null);
  const [arv, setArv] = useState('');
  const [deals, setDeals] = useState<Awaited<ReturnType<typeof dealOptions>>>([]);
  // Where the map sits before any search: the deal's house, the address or deal
  // just picked. The map is always there; a search fills it.
  const [preview, setPreview] = useState<{ lat: number; lng: number } | null>(null);
  const target: Target | null = dealId ? { deal_id: dealId } : picked ? { ...picked, ...('address' in picked && Number(arv) ? { arv: Number(arv) } : {}) } : query.trim().length > 5 ? { address: query.trim(), arv: Number(arv) || null } : null;

  // The run.
  const [run, setRun] = useState<Run | null>(props.seed?.run ?? null);
  const [busy, setBusy] = useState(false);
  const [ibBusy, setIbBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);
  const [scan, setScan] = useState<{ total: number; ceiling: number } | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [est, setEst] = useState<string | null>(null);
  const [past, setPast] = useState<PastRun[]>(props.seed?.past ?? []);
  const abort = useRef<AbortController | null>(null);

  // The list.
  const [tab, setTab] = useState<'buyers' | 'analytics'>('buyers');
  const [sub, setSub] = useState<Sub>('all');
  const [sort, setSort] = useState<Sort>('smart');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [popKey, setPopKey] = useState<string | null>(null);
  const [traces, setTraces] = useState<Record<string, { busy?: boolean; error?: string }>>({});
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [bulk, setBulk] = useState<string | null>(null);
  const [marketPick, setMarketPick] = useState<number | null>(null);
  const [portfolioFor, setPortfolioFor] = useState<Candidate | null>(null);
  /** Buyers just filed. The banner's button opens Buyer Prospects. */
  const [prospectsAdded, setProspectsAdded] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const cands = useMemo(() => run?.candidates ?? [], [run]);
  const setCands = useCallback((fn: (c: Candidate[]) => Candidate[], persist = true) => {
    setRun((r) => {
      if (!r) return r;
      const next = fn(r.candidates);
      if (persist && workspaceId && canWrite) void saveCandidates(workspaceId, r.run_id, next);
      return { ...r, candidates: next };
    });
  }, [workspaceId, canWrite]);

  const refreshPast = useCallback(() => {
    if (!workspaceId) return;
    if (!standalone && dealId) {
      void dealOptions(workspaceId).then((d) => {
        const addr = d.find((x) => x.id === dealId)?.address ?? null;
        void propertyRuns(workspaceId, dealId, addr).then(setPast);
      });
      return;
    }
    void pastRuns(workspaceId, null).then(setPast);
  }, [workspaceId, dealId, standalone]);

  const applyRunFilters = (r: Run) => setFilters((f) => ({ ...f, ...r.filters, kinds: (r.filters.kinds as Kind[] | undefined)?.filter((k) => KINDS.includes(k)) ?? f.kinds, homefull: r.filters.homefull === true, found_via: r.filters.found_via ?? f.found_via, methods: r.filters.methods ?? [] }));

  // Open on the deal's last run, or load the past-search rail.
  // On a dispo property the history is every run of that street, including
  // searches started from the Genius page that never stored a deal id.
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    if (dealId && !standalone) {
      void dealCenter(workspaceId, dealId).then((c) => { if (live && c) setPreview(c); });
      void dealOptions(workspaceId).then((d) => {
        if (!live) return;
        setDeals(d);
        const addr = d.find((x) => x.id === dealId)?.address ?? null;
        void propertyRuns(workspaceId, dealId, addr).then((p) => { if (live) setPast(p); });
        void lastPropertyRun(workspaceId, dealId, addr).then((r) => {
          if (!live || !r) return;
          setRun(r);
          applyRunFilters(r);
        });
      });
    } else {
      void pastRuns(workspaceId, null).then((p) => { if (live) setPast(p); });
      void dealOptions(workspaceId).then((d) => { if (live) setDeals(d); });
    }
    return () => { live = false; };
  }, [workspaceId, dealId, standalone]);

  // Address autocomplete, 250ms after the last keystroke. Free on every REAPI plan.
  useEffect(() => {
    if (!workspaceId || !typed || query.trim().length < 4) return;
    const t = setTimeout(() => { void autocomplete(workspaceId, query.trim()).then((r) => setSugs(r.ok ? r.data.results : [])); }, 250);
    return () => clearTimeout(t);
  }, [query, typed, workspaceId]);

  async function openPast(id: number) {
    if (!workspaceId) return;
    const r = await loadRun(workspaceId, id);
    if (!r) return onToast('That search is gone.');
    setRun(r); setErr(null); setProgress(null); setScan(null); setSel({}); setPage(0); setOpenKey(null); setTruncated(false); setEditF(false); setMView('list');
    setFilters((f) => ({ ...f, ...r.filters, kinds: (r.filters.kinds as Kind[] | undefined)?.filter((k) => KINDS.includes(k)) ?? f.kinds, homefull: r.filters.homefull === true, found_via: r.filters.found_via ?? f.found_via, methods: r.filters.methods ?? [] }));
    setMethodStats(null); setMethodSel('all');
    setQuery([r.subject?.address, r.subject?.city, r.subject?.state].filter(Boolean).join(', ')); setTyped(false); setSugs([]);
    setPicked(r.deal_id ? { deal_id: r.deal_id } : { address: r.subject.address, city: r.subject.city, state: r.subject.state, zip: r.subject.zip, reapi_id: r.subject.reapi_id });
  }

  async function doEstimate() {
    if (!workspaceId || !target) return;
    setEst('Counting…');
    const r = await estimate(workspaceId, target, filters);
    setEst(r.ok ? `About ${r.data.total.toLocaleString('en-US')} sales to scan${r.data.total > r.data.ceiling ? ` (first ${r.data.ceiling.toLocaleString('en-US')} pulled)` : ''} · ~${r.data.est_credits.toLocaleString('en-US')} credits` : r.message);
  }

  async function go() {
    if (!workspaceId) return onToast('Genius Mode runs on a signed-in workspace.');
    if (!target) return onToast('Type an address or pick a deal first.');
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setBusy(true); setEditF(false); setErr(null); setEst(null); setProgress(null); setScan(null); setTruncated(false); setSel({}); setPage(0); setOpenKey(null); setPopKey(null);
    const searching = { ...filters, found_via: filters.found_via ?? 'genius' as const };
    setCompareStats(null); setSourceSel('all'); setMethodStats(null); setMethodSel('all');
    const r = await discover(workspaceId, target, searching, { skipTrace: traceAll, compare }, (ev) => {
      if (ev.type === 'compare') { setCompareStats(ev); return; }
      if (ev.type === 'methods') { setMethodStats(ev); return; }
      if (ev.type === 'subject') setRun({ run_id: null, deal_id: 'deal_id' in target ? target.deal_id : null, subject: ev.subject, filters: searching, candidates: [], sales_scanned: 0, properties_scanned: null, credits: {}, created_at: new Date().toISOString(), status: 'running' });
      else if (ev.type === 'scan_count') setScan({ total: ev.total, ceiling: ev.ceiling });
      else if (ev.type === 'progress') setProgress({ stage: ev.stage, done: ev.done, total: ev.total });
      else if (ev.type === 'buyers') setRun((x) => (x ? { ...x, candidates: ev.candidates, properties_scanned: ev.properties_scanned } : x));
      else if (ev.type === 'done') {
        setRun((x) => (x ? { ...x, run_id: ev.run_id, credits: ev.credits, sales_scanned: ev.sales_scanned, status: 'done' } : x));
        setTruncated(ev.truncated);
      }
    }, ac.signal);
    setBusy(false); setProgress(null);
    if (!r.ok) { setErr(r.message); if (r.message !== 'Stopped.') onToast(r.message); }
    refreshPast();
  }

  // ---- the list, as filtered right now ----
  const view = useMemo(() => {
    const since = new Date(); since.setMonth(since.getMonth() - filters.months);
    const cutoff = since.toISOString().slice(0, 10);
    const inR = (v: number | null, lo: number | null, hi: number | null) => v === null || ((lo === null || v >= lo) && (hi === null || v <= hi));
    let l = cands.filter((c) => filters.kinds.includes(c.kind)
      && (!filters.homefull || (c.flips > 0 && !retailEndBuyer(c, cands)))
      && (filters.include_institutional || !c.institutional)
      && (!filters.min_portfolio || (c.portfolio_count ?? c.purchase_count) >= filters.min_portfolio)
      && (c.nearest_mi === null || c.nearest_mi <= filters.radius_mi + 0.05)
      && (!c.last_purchase || c.last_purchase >= cutoff)
      && (!hideNoPhone || !!bestPhone(c))
      && c.purchases.some((p) => inR(p.price, filters.price_min, filters.price_max) && inR(p.beds, filters.beds_min, filters.beds_max) && inR(p.baths, filters.baths_min, filters.baths_max)));
    const counts = { all: l.length, matched: l.filter((c) => c.matched_buyer_id).length, not: l.filter((c) => !c.matched_buyer_id).length };
    // Compare mode: who found each buyer.
    const bySource = { both: l.filter((c) => sourceOf(c) === 'both').length, reapi: l.filter((c) => sourceOf(c) === 'reapi').length, attom: l.filter((c) => sourceOf(c) === 'attom').length };
    if (sourceSel !== 'all') l = l.filter((c) => sourceOf(c) === sourceSel);
    // Which method found each buyer, for the method pills.
    const byMethod: Partial<Record<Method, number>> = {};
    for (const c of l) for (const m of c.methods ?? []) byMethod[m] = (byMethod[m] ?? 0) + 1;
    if (methodSel !== 'all') l = l.filter((c) => c.methods?.includes(methodSel));
    if (sub === 'matched') l = l.filter((c) => c.matched_buyer_id); else if (sub === 'not') l = l.filter((c) => !c.matched_buyer_id);
    const nul = (v: number | null, d: number) => (v === null ? d : v);
    const cmp: Record<Sort, (a: Candidate, b: Candidate) => number> = {
      smart: (a, b) => b.likelihood - a.likelihood || b.purchase_count - a.purchase_count,
      distance: (a, b) => nul(a.nearest_mi, 99) - nul(b.nearest_mi, 99),
      recent: (a, b) => (b.last_purchase ?? '').localeCompare(a.last_purchase ?? ''),
      deals: (a, b) => b.purchase_count - a.purchase_count || nul(b.portfolio_count, 0) - nul(a.portfolio_count, 0),
      price: (a, b) => nul(a.avg_price, 9e9) - nul(b.avg_price, 9e9),
    };
    l = [...l].sort(cmp[sort]);
    const props = new Set(l.flatMap((c) => c.purchases.map((p) => p.reapi_id || p.address))).size;
    return { list: l, counts, props, bySource, byMethod };
  }, [cands, filters, hideNoPhone, sub, sort, sourceSel, methodSel]);

  const pages = Math.max(1, Math.ceil(view.list.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const shown = view.list.slice(pg * PAGE, pg * PAGE + PAGE);
  const selected = view.list.filter((c) => sel[c.key]);
  const activeKey = hoverKey ?? openKey ?? popKey;

  // One pin per purchase, coloured by what the buyer is; a buyer's pins light up together.
  const pins: MapPin[] = useMemo(() => view.list.flatMap((c) => c.purchases.flatMap((p, i) => (p.lat && p.lng ? [{
    id: `${c.key}::${i}`, group: c.key, lat: p.lat, lng: p.lng, color: KIND_COLOR[c.kind], ring: c.smart_match,
    title: `${c.owner_name} · ${p.address}${p.price ? ` · ${money(p.price)}` : ''}`,
  }] : []))).slice(0, 2500), [view.list]);

  // ---- actions ----
  /** Skip-trace anyone not yet traced. Returns the list with fresh contacts filled in. */
  async function ensureTraced(list: Candidate[]): Promise<Candidate[]> {
    if (!workspaceId) return list;
    const need = list.filter((c) => !c.contacts);
    if (!need.length) return list;
    const patch: Record<string, Candidate> = {};
    const keys = need.map((c) => c.key);
    setTraces((t) => ({ ...t, ...Object.fromEntries(keys.map((k) => [k, { busy: true }])) }));
    let found = 0; let cached = 0;
    for (let i = 0; i < need.length; i += 25) {
      const chunk = need.slice(i, i + 25);
      if (need.length > 1) setBulk(`Skip tracing ${Math.min(i + 25, need.length)} of ${need.length}…`);
      const r = await skipTrace(workspaceId, chunk, run?.run_id ?? null);
      if (!r.ok) {
        setTraces((t) => ({ ...t, ...Object.fromEntries(chunk.map((c) => [c.key, { error: r.message }])) }));
        onToast(r.message);
        break;
      }
      const res = r.data.results;
      for (const c of chunk) {
        const x = res[c.key];
        if (x && 'hits' in x) patch[c.key] = { ...c, contacts: x.hits, contacts_at: x.at };
      }
      setCands((cs) => cs.map((c) => patch[c.key] ?? c), false);
      setTraces((t) => ({ ...t, ...Object.fromEntries(chunk.map((c) => { const x = res[c.key]; return [c.key, x && 'error' in x ? { error: x.error } : {}]; })) }));
      for (const x of Object.values(res)) if ('hits' in x) { if (x.hits.length) found++; if (x.cached) cached++; }
    }
    setBulk(null);
    if (need.length > 1) onToast(`Skip traced ${need.length}: ${found} with contacts${cached ? ` · ${cached} from cache (free)` : ''}`);
    void logRun(workspaceId, { kind: 'skiptrace', entity: 'buyer', label: `Genius skip trace · ${need.length} prospect${need.length === 1 ? '' : 's'}`, total: need.length, succeeded: found, failed: 0, credits: Math.max(0, need.length - cached), detail: { found, cached, source: 'genius' } });
    void notifyUser(workspaceId, userId, { category: 'Skip trace', title: `Skip trace finished · ${need.length === 1 ? need[0].owner_name : `${need.length} prospects`}`, body: `${found} with contacts${cached ? ` · ${cached} from cache` : ''}. Buyers added from them are tagged "${SKIPTRACE_TAG}".` });
    return list.map((c) => patch[c.key] ?? c);
  }

  async function traceSome(list: Candidate[]) {
    await ensureTraced(list);
  }

  /**
   * Add to the buyer list. Anyone not yet skip-traced is traced first.
   * An owner whose trace found no phone or email is not added.
   * A buyer already on file still receives the skip trace.
   */
  async function addMany(list: Candidate[]): Promise<{ ids: number[]; added: number; traced: number; blocked: number }> {
    if (!workspaceId) return { ids: [], added: 0, traced: 0, blocked: 0 };
    const fresh = await ensureTraced(list);
    const ready = fresh.filter(hasSkipTraceContact);
    const blocked = fresh.length - ready.length;
    if (!ready.length) return { ids: [], added: 0, traced: 0, blocked };
    const ids: number[] = []; const made: Record<string, number> = {};
    let added = 0; let traced = 0; let n = 0;
    for (const c of ready) {
      if (c.matched_buyer_id) {
        ids.push(c.matched_buyer_id);
        const applied = await applyTraceToBuyer(workspaceId, c.matched_buyer_id, c);
        if (applied.phones || applied.phone || applied.email) traced++;
        continue;
      }
      setAdding((a) => ({ ...a, [c.key]: true }));
      if (ready.length > 3) setBulk(`Adding ${++n} of ${ready.filter((x) => !x.matched_buyer_id).length}…`);
      const via = runRef.current?.filters.found_via ?? filters.found_via ?? null;
      const r = await addCandidate(workspaceId, c, userId, via);
      setAdding((a) => ({ ...a, [c.key]: false }));
      const id = r.id; // a dupe on phone/email comes back not-ok but with the existing buyer's id
      if (id) {
        ids.push(id);
        made[c.key] = id;
        if (r.ok) added++;
        else traced++;
      } else if (!r.ok && ready.length === 1) onToast(r.message ?? 'Could not add that buyer.');
    }
    setBulk(null);
    if (Object.keys(made).length) {
      const link = (cs: Candidate[]) => cs.map((c) => (made[c.key] ? { ...c, matched_buyer_id: made[c.key], match_by: c.match_by ?? 'name' } : c));
      setCands(link, false);
      // Save here, not in the state updater: "Send deal via campaign" navigates
      // away in the same tick, the unmount drops the queued updater, and the
      // run would forget which buyers these owners became.
      const r0 = runRef.current;
      if (r0 && workspaceId && canWrite) await saveCandidates(workspaceId, r0.run_id, link(r0.candidates));
    }
    if (Object.keys(made).length || traced) props.onAdded?.();
    if (added > 0) setProspectsAdded((n0) => n0 + added);
    return { ids, added, traced, blocked };
  }

  async function addOne(c: Candidate) {
    const { ids, traced, blocked } = await addMany([c]);
    if (blocked && !ids.length) return onToast(`${c.owner_name} has no phone or email after skip trace — not added.`);
    if (!ids.length) return;
    onToast(c.matched_buyer_id
      ? (traced ? `${c.owner_name} updated with the skip trace` : `${c.owner_name} is already in buyers`)
      : `${c.owner_name} added to buyers`);
  }

  async function onMark(c: Candidate, number: string, mark: PhoneMark) {
    if (!workspaceId) return;
    const next = await markPhone(workspaceId, run?.run_id ?? null, cands, c.key, number, mark);
    setCands(() => next, false);
  }

  const bulkAdd = async () => {
    const { ids, added, traced, blocked } = await addMany(selected);
    const parts = [`${ids.length} in your buyers`];
    if (added) parts.push(`${added} new`);
    if (traced) parts.push(`${traced} updated with skip trace`);
    if (blocked) parts.push(`${blocked} skipped — no phone or email after skip trace`);
    onToast(parts.join(' · '));
    setSel({});
  };
  const bulkQueue = async () => {
    const { ids, blocked } = await addMany(selected);
    if (!ids.length) return onToast(blocked ? 'None of these have a phone or email after skip trace.' : 'Could not add those buyers.');
    await props.onQueue?.(ids);
    if (blocked) onToast(`${blocked} skipped — no phone or email after skip trace`);
    setSel({});
  };
  const queueOne = async (c: Candidate) => {
    const { ids, blocked } = await addMany([c]);
    if (!ids.length) return onToast(blocked ? `${c.owner_name} has no phone or email after skip trace — not queued.` : 'Could not add that buyer.');
    await props.onQueue?.(ids);
  };
  // The deal a campaign would send: the one this search was run for. A search
  // around a bare address has no deal, so it has no campaign to send.
  const marketDeal = marketPick ?? dealId ?? run?.deal_id ?? null;
  const campaignDeal = dealId ?? run?.deal_id ?? null;
  const bulkCampaign = async () => {
    if (!campaignDeal) return;
    const { ids, blocked } = await addMany(selected);
    setSel({});
    if (!ids.length) return onToast(blocked ? 'No phone or email after skip trace — not added.' : 'Could not add those buyers.');
    if (blocked) onToast(`${blocked} skipped — no phone or email after skip trace`);
    // The builder confirms once it has them, so the toast never runs ahead of the hand-off.
    props.onCampaign?.(ids, campaignDeal);
  };
  const marketSome = async (list: Candidate[]) => {
    if (!marketDeal) return onToast('Pick a deal for the marketing list.');
    const { ids, blocked } = await addMany(list);
    if (!ids.length) return onToast(blocked ? 'No phone or email after skip trace — not added.' : 'Could not add those buyers.');
    if (blocked) onToast(`${blocked} skipped — no phone or email after skip trace`);
    props.onAddToMarketing?.(ids, marketDeal);
  };
  const exportCsv = () => {
    const list = selected.length ? selected : view.list;
    downloadCsv(`genius-${(run?.subject?.address ?? 'buyers').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`, toCsv(list));
  };

  // ---- pieces ----
  const gutter = isMobile ? '12px' : '16px';
  const dirty = widened(filters, run?.filters);
  const creditsLine = run?.credits && Object.keys(run.credits).length
    ? Object.entries(run.credits).filter(([k]) => k !== 'count').map(([k, v]) => `${v.toLocaleString('en-US')} ${k}`).join(' · ') : null;

  const fieldH = '34px';
  const searchBar = standalone ? (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'minmax(0, 2.2fr) minmax(0, 1.4fr) 128px 128px', gap: '10px', padding: `12px ${gutter}`, borderBottom: `1px solid ${HAIR}` }}>
      <Field label="Address or APN" span={isMobile ? '1 / -1' : undefined}>
        <span style={{ position: 'relative', display: 'block' }}>
          <input value={query} onChange={(e) => { setQuery(e.target.value); setTyped(true); setPicked(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { setSugs([]); void go(); } }}
            placeholder="123 Rigsby Ave, San Antonio, TX" autoComplete="off" style={{ ...input, width: '100%', height: fieldH, fontSize: isMobile ? '16px' : '13px' }} />
          {typed && sugs.length ? (
            <div style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 20, background: '#fff', borderRadius: '10px', boxShadow: SHADOW.md, overflow: 'hidden' }}>
              {sugs.map((s, i) => (
                <button key={i} type="button" onClick={() => { setPicked({ address: s.address || s.title, city: s.city, state: s.state, zip: s.zip, reapi_id: s.reapi_id }); if (s.lat && s.lng) setPreview({ lat: s.lat, lng: s.lng }); setQuery(s.title); setTyped(false); setSugs([]); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderTop: i ? `1px solid ${HAIR}` : 0, background: '#fff', fontSize: '12.5px', color: INK, cursor: 'pointer' }}>{s.title}</button>
              ))}
            </div>
          ) : null}
        </span>
      </Field>
      {/* Type to find a deal by address, seller or city. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0, gridColumn: isMobile ? '1 / -1' : undefined }}>
        <span style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>Or one of your deals</span>
        <SearchSelect value={picked && 'deal_id' in picked ? String(picked.deal_id) : ''} placeholder="Search your deals" ariaLabel="Pick one of your deals"
          fieldStyle={{ height: fieldH, border: 0, boxShadow: SHADOW.ring, background: '#fff', fontSize: isMobile ? '16px' : '13px', padding: '0 10px' }}
          options={deals.map((d) => ({ v: String(d.id), label: d.label }))}
          onChange={(v) => {
            const d = deals.find((x) => String(x.id) === v);
            if (!d) { setPicked(null); return; }
            if (d.lat && d.lng) setPreview({ lat: d.lat, lng: d.lng }); setPicked({ deal_id: d.id }); setQuery([d.address, d.city, d.state].filter(Boolean).join(', ')); setTyped(false); setSugs([]);
            setArv(d.arv ? String(d.arv) : ''); setF({ asking_price: d.price ?? null });
          }} />
      </div>
      <Field label="Asking price">
        <input value={filters.asking_price ?? ''} onChange={(e) => setF({ asking_price: Number(e.target.value.replace(/\D/g, '')) || null })} inputMode="numeric" placeholder="$" style={{ ...input, height: fieldH, fontVariantNumeric: 'tabular-nums', fontSize: isMobile ? '16px' : '13px' }} />
      </Field>
      <Field label="ARV" hint={picked && 'deal_id' in picked ? 'Comes from the deal' : undefined}>
        <input value={arv} onChange={(e) => setArv(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="$" disabled={!!picked && 'deal_id' in picked} style={{ ...input, height: fieldH, fontVariantNumeric: 'tabular-nums', fontSize: isMobile ? '16px' : '13px' }} />
      </Field>
    </div>
  ) : null;

  async function pullInvestorBase() {
    if (!workspaceId || !target || ibBusy) return;
    setIbBusy(true);
    const place = 'deal_id' in target
      ? { deal_id: target.deal_id }
      : { address: target.address, city: target.city ?? null, state: target.state ?? null, zip: target.zip ?? null };
    const kinds = filters.kinds.filter((k) => k === 'flipper' || k === 'landlord');
    const r = await importInvestorBase(workspaceId, {
      ...place,
      radius_miles: filters.radius_mi,
      lookback_years: filters.months / 12,
      buyer_types: kinds,
      property_types: filters.property_types,
      min_bedrooms: filters.beds_min,
      max_bedrooms: filters.beds_max,
      min_bathrooms: filters.baths_min,
      max_bathrooms: filters.baths_max,
      min_purchase_price: filters.price_min,
      max_purchase_price: filters.price_max,
      hide_non_arms_length: !filters.include_non_arms_length,
      hide_hedge_fund: !filters.include_institutional,
      hide_no_phone: hideNoPhone,
    });
    setIbBusy(false);
    if (!r.ok) { onToast(r.message); return; }
    const where = r.data.address ? ` for ${r.data.address}` : '';
    if (r.data.created === 0 && r.data.existing === 0) { onToast(`InvestorBase found no buyers${where}`); return; }
    const already = r.data.existing ? `, ${r.data.existing} already in the CRM` : '';
    onToast(`${r.data.created} InvestorBase buyer${r.data.created === 1 ? '' : 's'} added to Buyer Prospects${already}${where}`);
    props.onAdded?.();
  }

  const subjectLine = run?.subject ? [run.subject.address, run.subject.city, run.subject.state].filter(Boolean).join(', ') : null;
  const header = (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: '10px 16px', padding: isMobile ? '12px' : '14px 16px', background: 'var(--band)', borderBottom: '1px solid var(--band-line)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: '15px', lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.015em', color: INK }}>Genius Mode</h2>
        {isMobile && subjectLine ? null : <p style={{ margin: '3px 0 0', fontSize: '12px', color: MUTED, lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap' }} title={subjectLine ?? undefined}>
          {subjectLine
            ? <><span style={{ color: INK, fontWeight: 600 }}>{subjectLine}</span>{run ? ` · found via ${foundLabel(run.filters)}` : ''}</>
            : 'Investors who bought near a house, from public records and MLS, checked against your buyers.'}
        </p>}
      </div>
      {!standalone && past.length > 0 ? (
        <select value={run?.run_id ?? ''} onChange={(e) => void openPast(Number(e.target.value))} aria-label="Earlier searches for this property" style={{ ...input, height: '32px', maxWidth: isMobile ? 'none' : '280px' }}>
          {past.map((p) => <option key={p.id} value={p.id}>{[p.address, when(p.created_at.slice(0, 10)), `${p.radius_mi} mi`, `${p.buyer_count ?? 0} buyers`].filter(Boolean).join(' · ')}</option>)}
        </select>
      ) : null}
      {standalone && isMobile && past.length ? (
        <select value={run?.run_id ?? ''} onChange={(e) => { if (e.target.value) void openPast(Number(e.target.value)); }} aria-label="Past searches" style={{ ...input, height: '36px' }}>
          <option value="">Past searches ({past.length})</option>
          {past.map((p) => <option key={p.id} value={p.id}>{p.address ?? 'Untitled'} · {p.status === 'error' ? 'failed' : `${p.buyer_count ?? 0} buyers`} · {ago(p.created_at)}</option>)}
        </select>
      ) : null}
    </div>
  );

  const blocked = busy || !canWrite || !target;
  const filterBar = (
    <div style={{ padding: `12px ${gutter} 0`, borderBottom: '1px solid var(--inset-line)', background: 'var(--inset)' }}>
      <div style={{ display: 'flex', gap: isMobile ? '12px 16px' : '12px 24px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Control label="Buyer type">
          {KINDS.map((k) => <Pill key={k} on={filters.kinds.includes(k)} onClick={() => setF({ kinds: filters.kinds.includes(k) ? (filters.kinds.length > 1 ? filters.kinds.filter((x) => x !== k) : filters.kinds) : [...filters.kinds, k] })}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: KIND_COLOR[k], boxShadow: filters.kinds.includes(k) ? '0 0 0 1.5px rgba(255,255,255,.9)' : 'none' }} />{KIND_PLURAL[k]}
          </Pill>)}
        </Control>
        <Control label="Property">
          {TYPES.map(([t, l]) => <Pill key={t} on={filters.property_types.includes(t)} title={t === 'LAND' ? 'Land is pulled only with Builders selected' : undefined}
            onClick={() => setF({ property_types: filters.property_types.includes(t) ? (filters.property_types.length > 1 ? filters.property_types.filter((x) => x !== t) : filters.property_types) : [...filters.property_types, t] })}>{l}</Pill>)}
        </Control>
        <Control label="Radius">{[0.5, 1, 2, 3, 5, 10].map((r) => <Pill key={r} on={filters.radius_mi === r} onClick={() => setF({ radius_mi: r })}>{r} mi</Pill>)}</Control>
        <Control label="Bought within">{[6, 12, 24, 36].map((m) => <Pill key={m} on={filters.months === m} onClick={() => setF({ months: m })}>{m < 12 ? '6 mo' : `${m / 12} yr`}</Pill>)}</Control>
        <Control label="Exit">
          <select value={filters.strategy} onChange={(e) => setF({ strategy: e.target.value as Strategy })} aria-label="Exit strategy" style={{ ...input, height: '28px', fontSize: '12px', paddingRight: '6px' }}>
            {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>)}
          </select>
        </Control>
      </div>
      <div style={{ marginTop: '12px' }}>
        <Control label="Find by method">
          {RUN_METHODS.map((m) => (
            <Pill key={m} on={filters.methods.includes(m)} title={METHOD_BLURB[m]} onClick={() => setF({ methods: filters.methods.includes(m) ? filters.methods.filter((x) => x !== m) : [...filters.methods, m] })}>{METHOD_LABEL[m]}</Pill>
          ))}
          <Pill on={filters.methods.length === RUN_METHODS.length} onClick={() => setF({ methods: filters.methods.length === RUN_METHODS.length ? [] : [...RUN_METHODS] })}>All methods</Pill>
        </Control>
        <p style={{ margin: '6px 0 0', fontSize: '12px', color: MUTED, maxWidth: '640px', lineHeight: 1.45 }}>
          {filters.methods.length ? filters.methods.map((m) => METHOD_BLURB[m]).join(' ') : 'Optional. Each method tags a buyer with how it found them and the proof: the flip the photos confirmed, the deed chain, the wholesaler they bought from.'}
        </p>
      </div>
      {more ? (
        <div style={{ display: 'flex', gap: '12px 24px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${LINE}` }}>
          <Control label="Beds">
            {[null, 1, 2, 3, 4, 5].map((b) => <Pill key={String(b)} on={filters.beds_min === b} onClick={() => setF({ beds_min: b, beds_max: filters.beds_max !== null && b !== null && filters.beds_max === filters.beds_min ? b : filters.beds_max })}>{b === null ? 'Any' : `${b}+`}</Pill>)}
            <Pill on={filters.beds_min !== null && filters.beds_max === filters.beds_min} onClick={() => setF({ beds_max: filters.beds_max === filters.beds_min ? null : filters.beds_min })} disabled={filters.beds_min === null}>Exact</Pill>
          </Control>
          <Control label="Baths">
            {[null, 1, 2, 3].map((b) => <Pill key={String(b)} on={filters.baths_min === b} onClick={() => setF({ baths_min: b, baths_max: filters.baths_max !== null && b !== null && filters.baths_max === filters.baths_min ? b : filters.baths_max })}>{b === null ? 'Any' : `${b}+`}</Pill>)}
            <Pill on={filters.baths_min !== null && filters.baths_max === filters.baths_min} onClick={() => setF({ baths_max: filters.baths_max === filters.baths_min ? null : filters.baths_min })} disabled={filters.baths_min === null}>Exact</Pill>
          </Control>
          <Control label="Purchase price">
            <input value={filters.price_min ?? ''} onChange={(e) => setF({ price_min: Number(e.target.value.replace(/\D/g, '')) || null })} placeholder="Min" aria-label="Minimum purchase price" inputMode="numeric" style={{ ...input, height: '28px', width: '96px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }} />
            <input value={filters.price_max ?? ''} onChange={(e) => setF({ price_max: Number(e.target.value.replace(/\D/g, '')) || null })} placeholder="Max" aria-label="Maximum purchase price" inputMode="numeric" style={{ ...input, height: '28px', width: '96px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }} />
          </Control>
          <Control label="Min portfolio">{[0, 2, 5, 10].map((n) => <Pill key={n} on={filters.min_portfolio === n} onClick={() => setF({ min_portfolio: n })}>{n ? `${n}+` : 'Any'}</Pill>)}</Control>
          <Control label="Flip window">{[6, 12, 18, 24].map((n) => <Pill key={n} on={filters.flip_months === n} onClick={() => setF({ flip_months: n })}>{n} mo</Pill>)}</Control>
          <Control label="Include">
            <Pill on={filters.include_non_arms_length} onClick={() => setF({ include_non_arms_length: !filters.include_non_arms_length })}>Non-arm&rsquo;s-length</Pill>
            <Pill on={filters.include_institutional} onClick={() => setF({ include_institutional: !filters.include_institutional })}>Institutional</Pill>
            <Pill on={hideNoPhone} onClick={() => setHideNoPhone((h) => !h)}>Hide no phone</Pill>
          </Control>
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px 16px', margin: `12px -${gutter} 0`, padding: `10px ${gutter}`, borderTop: `1px solid ${LINE}`, background: '#fff', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: isMobile ? '1 1 100%' : 'none' }}>
          <button type="button" onClick={() => void go()} disabled={blocked} aria-busy={busy || undefined} style={{ ...btn('purple'), padding: '0 16px', cursor: busy ? 'wait' : 'pointer', flex: isMobile ? 1 : 'none' }}>
            <Icon d={ICON.search} size={14} />{busy ? 'Searching…' : run ? 'Search again' : 'Find buyers'}
          </button>
          {busy ? <button type="button" onClick={() => abort.current?.abort()} style={btn('ghost')}>Stop</button> : null}
          {!busy && canWrite && target ? <button type="button" onClick={() => void doEstimate()} style={btn('ghost')}>Estimate size</button> : null}
          {isMobile && run?.subject && !busy ? <button type="button" onClick={() => setEditF(false)} style={btn('ghost')}>Done</button> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px 16px', flexWrap: 'wrap' }}>
          <Toggle on={traceAll} disabled={!canWrite || busy} onChange={setTraceAll} title="Skip trace the top buyers as soon as the run finishes. Owners traced in the last 90 days come back free.">Skip trace top buyers</Toggle>
          <Toggle on={compare} disabled={!canWrite || busy} onChange={setCompare} title="Also search ATTOM around the same address and merge the two: each buyer once, marked by which source found them">Compare with ATTOM</Toggle>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: isMobile ? 0 : 'auto', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void pullInvestorBase()} disabled={ibBusy || blocked} aria-busy={ibBusy || undefined} style={{ ...btn('ghost'), cursor: ibBusy ? 'wait' : 'pointer' }}>
            {ibBusy ? 'Importing InvestorBase…' : 'Import InvestorBase'}
          </button>
          <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} style={btn('ghost')}><Icon d={ICON.sliders} size={14} />{more ? 'Fewer filters' : 'More filters'}</button>
        </div>
        {est || (dirty && !busy) ? (
          <div role="status" style={{ flexBasis: '100%', display: 'flex', gap: '4px 12px', flexWrap: 'wrap', fontSize: '12px' }}>
            {est ? <span style={{ color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{est}</span> : null}
            {dirty && !busy ? <span style={{ color: '#b45309', fontWeight: 600 }}>Filters widened. Search again to pull the rest.</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  // Phones, once there are results: what was searched and how, in one line.
  const folded = isMobile && !!run?.subject && !editF;
  const summary = folded && run?.subject ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: `10px ${gutter}`, borderBottom: `1px solid ${HAIR}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 650, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[run.subject.address, run.subject.city, run.subject.state].filter(Boolean).join(', ')}</div>
        <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {filters.kinds.map((k) => KIND_PLURAL[k]).join(', ')} · {filters.radius_mi} mi · {filters.months < 12 ? '6 mo' : `${filters.months / 12} yr`}
          {filters.property_types.length < TYPES.length ? ` · ${filters.property_types.length} property type${filters.property_types.length === 1 ? '' : 's'}` : ''}
        </div>
        {dirty && !busy ? <div style={{ fontSize: '11.5px', color: '#b45309', fontWeight: 600, marginTop: '2px' }}>Filters widened. Search again to pull the rest.</div> : null}
      </div>
      {busy ? <button type="button" onClick={() => abort.current?.abort()} style={btn('ghost')}>Stop</button>
        : <button type="button" onClick={() => setEditF(true)} style={btn('ghost')} aria-expanded={false}><Icon d={ICON.sliders} size={14} />Edit</button>}
    </div>
  ) : null;

  const status = (busy || err || run) ? (
    <div style={{ padding: `9px ${gutter}`, borderBottom: '1px solid var(--band-line)', background: 'var(--band)', fontSize: '12px', color: MUTED }}>
      {err ? <div style={{ color: RED, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '9px', padding: '8px 10px', lineHeight: 1.5, marginBottom: busy || run ? '8px' : 0 }}>{err}</div> : null}
      {busy ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '5px' }}>
            <span>{progress ? `${STAGE_LABEL[progress.stage]}: ${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')}` : scan ? `${scan.total.toLocaleString('en-US')} sales to scan` : run?.subject ? 'Counting sales…' : 'Finding the property…'}</span>
            {cands.length ? <strong style={{ color: INK }}>{cands.length} buyers so far</strong> : null}
          </div>
          <div style={{ height: '5px', borderRadius: '99px', background: HAIR, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 6}%`, background: PURPLE, transition: 'width .3s' }} />
          </div>
        </div>
      ) : run ? (
        <div style={{ display: 'flex', gap: '6px 10px', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <strong style={{ color: INK, fontSize: '13px' }}>{view.counts.all.toLocaleString('en-US')} buyer{view.counts.all === 1 ? '' : 's'}</strong>
          <span>across {view.props.toLocaleString('en-US')} properties</span>
          <span style={{ color: LINE }}>·</span>
          <span>{(run.properties_scanned ?? run.sales_scanned).toLocaleString('en-US')} records scanned</span>
          {run.candidates.some((c) => c.smart_match) ? <><span style={{ color: LINE }}>·</span><span style={{ color: PURPLE, fontWeight: 600 }}>{run.candidates.filter((c) => c.smart_match).length} SmartMatch</span></> : null}
          {truncated ? <><span style={{ color: LINE }}>·</span><span style={{ color: '#b45309' }}>hit the record ceiling; narrow the radius for the rest</span></> : null}
          {run.created_at ? <span style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : undefined, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{run.status === 'done' ? 'Saved' : run.status} {ago(run.created_at)}{creditsLine ? ` · ${creditsLine}` : ''}</span> : null}
        </div>
      ) : null}
      {methodStats ? (
        <div role="status" style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '9px', border: `1px solid ${LINE}`, background: '#fafafa', fontSize: '12px', color: MUTED, lineHeight: 1.5 }}>
          <b style={{ color: INK }}>Methods </b>
          {methodStats.methods.map((m) => `${METHOD_LABEL[m]} ${methodStats.counts[m] ?? 0}`).join(' · ')}
          {methodStats.counts.homefull_checked ? ` · ${methodStats.counts.homefull_checked} flips photo-checked` : ''}
          {methodStats.counts.contract_buyers ? ` · ${methodStats.counts.contract_buyers} from our contracts` : ''}
          {methodStats.counts.deeds ? ` · ${methodStats.counts.deeds} deeds read` : ''}
          {methodStats.notes.length ? <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', color: '#b45309' }}>{methodStats.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
        </div>
      ) : null}
      {compareStats ? (
        <div role="status" style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '9px', border: `1px solid ${compareStats.error ? '#fecaca' : LINE}`, background: compareStats.error ? '#fef2f2' : '#fafafa', fontSize: '12px', color: compareStats.error ? '#b91c1c' : MUTED, lineHeight: 1.5 }}>
          {compareStats.error ? <>ATTOM did not run: {compareStats.error}</> : (
            <>
              <b style={{ color: INK }}>Compare </b>
              RealEstateAPI found <b style={{ color: INK }}>{(compareStats.reapi_properties ?? 0).toLocaleString('en-US')}</b> properties;
              ATTOM found <b style={{ color: INK }}>{(compareStats.attom_with_owner ?? 0).toLocaleString('en-US')}</b> with an owner ({(compareStats.attom_sales ?? 0).toLocaleString('en-US')} sales).
              {' '}Both: <b style={{ color: INK }}>{(compareStats.both ?? 0).toLocaleString('en-US')}</b> · RealEstateAPI only: <b style={{ color: INK }}>{(compareStats.reapi_only ?? 0).toLocaleString('en-US')}</b> · ATTOM only: <b style={{ color: INK }}>{(compareStats.attom_only ?? 0).toLocaleString('en-US')}</b>.
              {' '}Buyers: both {view.bySource.both} · RealEstateAPI only {view.bySource.reapi} · ATTOM only {view.bySource.attom}. Each buyer and property appears once.
              {compareStats.attom_calls ? <span> · {compareStats.attom_calls} ATTOM calls</span> : null}
              {compareStats.note ? <div style={{ color: '#b45309', marginTop: '4px' }}>{compareStats.note}</div> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  ) : null;

  const popup = (key: string) => {
    const c = cands.find((x) => x.key === key); if (!c) return null;
    const p = c.purchases.find((x) => x.lat) ?? c.purchases[0];
    return (
      <div style={{ fontSize: '12px' }}>
        <div style={{ fontWeight: 700, color: INK, paddingRight: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.owner_name}</div>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', margin: '5px 0' }}>
          <Badge {...KIND_BADGE[c.kind]}>{KIND_LABEL[c.kind]}</Badge>
          {c.smart_match ? <Badge color="#08694C" tint={PURPLE_TINT}>SmartMatch</Badge> : null}
          {c.non_disclosure ? <Badge>Non-disclosure</Badge> : null}
          {c.corporate ? <Badge>Entity</Badge> : null}
        </div>
        {p ? <div style={{ color: MUTED, lineHeight: 1.45 }}>{p.address} · {p.price ? money(p.price) : 'price not disclosed'} · {when(p.date)}{p.financed === false ? ' · cash' : p.financed ? ' · financed' : ''}</div> : null}
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <button type="button" style={btn('ghost', true)} onClick={() => { const i = view.list.findIndex((x) => x.key === key); if (i >= 0) { setPage(Math.floor(i / PAGE)); setOpenKey(key); setTab('buyers'); setMView('list'); setPopKey(null); setTimeout(() => document.getElementById(`gb-${key}`)?.scrollIntoView({ block: isMobile ? 'start' : 'nearest', behavior: 'smooth' }), 60); } }}>Show in list</button>
          {c.portfolio_count && c.portfolio_count > 1 ? <button type="button" style={btn('ghost', true)} onClick={() => setPortfolioFor(c)}>View all {c.portfolio_count}</button> : null}
        </div>
      </div>
    );
  };

  const subTabs = (
    <div className={isMobile ? 'gx-scroll' : undefined} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: `8px ${isMobile ? '12px' : '14px'}`, borderBottom: `1px solid ${HAIR}`, flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : undefined }}>
      {([['all', 'All'], ['not', 'New'], ['matched', 'In buyers']] as [Sub, string][]).map(([k, l]) => (
        <Pill key={k} on={sub === k} title={k === 'not' ? 'Not in your buyers yet' : k === 'matched' ? 'Already in your buyers' : undefined} onClick={() => { setSub(k); setPage(0); }}>{l} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{view.counts[k]}</span></Pill>
      ))}
      {cands.some((c) => c.sources?.length) ? (
        <>
          <span style={{ width: '1px', height: '18px', background: HAIR, margin: '0 4px', flex: 'none' }} />
          {([['all', 'Every source'], ['both', 'Both found'], ['reapi', 'RealEstateAPI only'], ['attom', 'ATTOM only']] as const).map(([k, l]) => (
            <Pill key={k} on={sourceSel === k} onClick={() => { setSourceSel(k); setPage(0); }}>{l}{k === 'all' ? '' : ` · ${view.bySource[k]}`}</Pill>
          ))}
        </>
      ) : null}
      {Object.keys(view.byMethod).length || methodSel !== 'all' ? (
        <>
          <span style={{ width: '1px', height: '18px', background: HAIR, margin: '0 4px', flex: 'none' }} />
          <Pill on={methodSel === 'all'} onClick={() => { setMethodSel('all'); setPage(0); }}>Any method</Pill>
          {(Object.keys(view.byMethod) as Method[]).map((m) => (
            <Pill key={m} on={methodSel === m} title={METHOD_BLURB[m]} onClick={() => { setMethodSel(methodSel === m ? 'all' : m); setPage(0); }}>{METHOD_LABEL[m]} · {view.byMethod[m]}</Pill>
          ))}
        </>
      ) : null}
      <select value={sort} onChange={(e) => { setSort(e.target.value as Sort); setPage(0); }} aria-label="Sort buyers" style={{ ...input, height: '28px', fontSize: '12px', marginLeft: 'auto', flex: 'none' }}>
        <option value="smart">SmartMatch</option><option value="distance">Closest</option><option value="recent">Most recent</option><option value="deals">Most deals</option><option value="price">Price (low first)</option>
      </select>
    </div>
  );

  const pageIds = shown.map((c) => c.key);
  const allOnPage = pageIds.length > 0 && pageIds.every((k) => sel[k]);
  const bulkBar = (
    <div className={isMobile ? 'gx-scroll' : undefined} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : undefined, padding: `8px ${isMobile ? '12px' : '14px'}`, borderBottom: `1px solid ${HAIR}`, background: selected.length ? '#F0FAF5' : '#fff', position: 'sticky', top: isMobile ? SWITCH_H : 0, zIndex: 3 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: INK, fontWeight: 600, cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}>
        <input type="checkbox" checked={allOnPage} onChange={() => setSel((s) => ({ ...s, ...Object.fromEntries(pageIds.map((k) => [k, !allOnPage])) }))} style={{ accentColor: PURPLE }} />
        {selected.length ? `${selected.length} selected` : 'Select page'}
      </label>
      {props.onAddToMarketing && canWrite ? (
        <div style={{ width: '240px', maxWidth: '100%' }}>
          <SearchSelect value={marketDeal != null ? String(marketDeal) : ''} placeholder="Pick a deal" ariaLabel="Deal for the marketing list"
            options={deals.map((d) => ({ v: String(d.id), label: d.label }))} onChange={(v) => setMarketPick(v ? Number(v) : null)} />
        </div>
      ) : null}
      {selected.length ? (
        <>
          <button type="button" onClick={() => setSel(Object.fromEntries(view.list.map((c) => [c.key, true])))} style={btn('ghost', true)}>All {view.list.length}</button>
          <button type="button" onClick={() => setSel({})} style={btn('ghost', true)}>Clear</button>
          {canWrite ? <>
            <button type="button" disabled={!!bulk} onClick={() => void bulkAdd()} style={btn('solid', true)}>Add to buyers</button>
            {props.onAddToMarketing ? (
              <button type="button" disabled={!!bulk || !marketDeal} onClick={() => void marketSome(selected)} style={btn('solid', true)}>Add to marketing list</button>
            ) : null}
            <button type="button" disabled={!!bulk} onClick={() => void traceSome(selected.filter((c) => !c.contacts))} style={btn('ghost', true)} title="Owners traced in the last 90 days come back free">
              Skip trace {selected.filter((c) => !c.contacts).length}
            </button>
            {props.onQueue ? <button type="button" disabled={!!bulk} onClick={() => void bulkQueue()} style={btn('ghost', true)} title="Skip-traces anyone not yet traced, then adds the ones with a phone or email. DNC numbers stay on the record but are never auto-dialed">Add to call queue</button> : null}
            {props.onCampaign && campaignDeal ? <button type="button" disabled={!!bulk} onClick={() => void bulkCampaign()} style={btn('ghost', true)}>Send deal via campaign</button> : null}
          </> : null}
        </>
      ) : null}
      <button type="button" onClick={exportCsv} style={{ ...btn('ghost', true), marginLeft: 'auto' }}><Icon d={ICON.download} size={13} />{isMobile ? 'CSV' : 'Export CSV'}</button>
      {bulk && !isMobile ? <span style={{ width: '100%', fontSize: '11.5px', color: '#08694C', fontWeight: 600 }}>{bulk}</span> : null}
    </div>
  );
  const bulkNote = bulk && isMobile ? <div role="status" style={{ padding: `6px ${gutter}`, fontSize: '11.5px', color: PURPLE, fontWeight: 600, borderBottom: `1px solid ${HAIR}` }}>{bulk}</div> : null;

  const list = (
    <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: isMobile ? 'visible' : 'auto', height: isMobile ? 'auto' : '100%' }}>
      <div style={{ display: isMobile ? 'none' : 'flex', gap: '2px', padding: '0 10px', borderBottom: '1px solid var(--band-line)', background: 'var(--band)' }}>
        {([['buyers', `Buyers`], ['analytics', 'Analytics']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} style={{ border: 0, background: 'none', padding: '11px 10px 9px', fontSize: '12.5px', fontWeight: 650, cursor: 'pointer', color: tab === k ? INK : MUTED, borderBottom: `2px solid ${tab === k ? INK : 'transparent'}` }}>{l}</button>
        ))}
      </div>
      {tab === 'analytics' ? <Analytics cands={view.list} subject={run?.subject ?? null} isMobile={isMobile} /> : (
        <>
          {subTabs}
          {bulkBar}
          {bulkNote}
          {prospectsAdded > 0 && props.onShowProspects ? (
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: `8px ${gutter}`, background: '#E7F8F1', borderBottom: `1px solid ${HAIR}`, fontSize: '12.5px', color: INK }}>
              <span>{prospectsAdded} buyer{prospectsAdded === 1 ? '' : 's'} added to Buyer Prospects.</span>
              <button type="button" onClick={props.onShowProspects} style={btn('solid', true)}>Show me the prospects</button>
            </div>
          ) : null}
          {view.list.length === 0 ? (
            <div style={{ padding: '30px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{busy ? 'Looking…' : cands.length ? 'No buyers match these filters' : 'No investor purchases found'}</div>
              <div style={{ fontSize: '12.5px', color: MUTED, marginTop: '4px' }}>{busy ? 'Buyers appear here as they are ready.' : 'Widen the radius or the window, or add a buyer type, and search again.'}</div>
            </div>
          ) : shown.map((c, i) => (
            <div key={c.key} id={`gb-${c.key}`} data-alt={i % 2 ? '' : undefined} style={{ scrollMarginTop: isMobile ? SWITCH_H + 52 : undefined }}>
              <BuyerCard c={c} isMobile={isMobile} canWrite={canWrite}
                selected={!!sel[c.key]} onSelect={() => setSel((s) => ({ ...s, [c.key]: !s[c.key] }))}
                open={openKey === c.key} onToggle={() => setOpenKey((k) => (k === c.key ? null : c.key))}
                active={activeKey === c.key} onHover={(on) => setHoverKey(on ? c.key : null)}
                tracing={!!traces[c.key]?.busy} traceError={traces[c.key]?.error} adding={!!adding[c.key]}
                onTrace={() => void traceSome([c])} onAdd={() => void addOne(c)}
                foundVia={METHOD_LABEL[methodOf(c, run?.filters.found_via ?? null)]}
                onMarketing={props.onAddToMarketing ? () => void marketSome([c]) : undefined}
                onQueue={props.onQueue ? () => void queueOne(c) : undefined}
                onCall={props.onCall} onOpenBuyer={props.onOpenBuyer}
                onMark={(n, m) => void onMark(c, n, m)} onAddPhone={(n) => setCands((cs) => addPhone(cs, c.key, n))}
                onPortfolio={() => setPortfolioFor(c)} />
            </div>
          ))}
          {pages > 1 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px', fontSize: '12px', color: MUTED }}>
              <button type="button" disabled={pg === 0} onClick={() => { setPage(pg - 1); listRef.current?.scrollTo({ top: 0 }); }} aria-label="Previous page" style={btn('ghost', true)}><Icon d={ICON.chevronLeft} size={13} />Prev</button>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>Page {pg + 1} of {pages}</span>
              <button type="button" disabled={pg >= pages - 1} onClick={() => { setPage(pg + 1); listRef.current?.scrollTo({ top: 0 }); }} aria-label="Next page" style={btn('ghost', true)}>Next<Icon d={ICON.chevronRight} size={13} /></button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  const legend = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(255,255,255,.94)', backdropFilter: 'blur(8px)', borderRadius: '10px', padding: '7px 11px',
      boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.07)', fontSize: '11.5px', fontWeight: 550, color: '#3f3f46' }}>
      {filters.kinds.map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: KIND_COLOR[k], boxShadow: '0 0 0 1.5px #fff, 0 0 0 2.5px rgba(0,0,0,.08)' }} />{KIND_PLURAL[k]}
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#a1a1aa', boxShadow: '0 0 0 1.5px #fff, 0 0 0 3px #f59e0b' }} />SmartMatch
      </span>
    </div>
  );

  // Before a search: the deal's house or the picked address, else the team's
  // deals as pins (pick one to centre on it), else the whole country.
  const dealPins: MapPin[] = standalone && !run?.subject
    ? deals.filter((d) => d.lat && d.lng).map((d) => ({ id: `deal:${d.id}`, lat: d.lat!, lng: d.lng!, color: PURPLE, title: d.label }))
    : [];
  const fallback = dealPins.length
    ? { lat: dealPins.reduce((a, p) => a + p.lat, 0) / dealPins.length, lng: dealPins.reduce((a, p) => a + p.lng, 0) / dealPins.length }
    : { lat: 39.5, lng: -98.35 };
  const centre = run?.subject ? { lat: run.subject.lat, lng: run.subject.lng } : preview ?? fallback;
  const located = !!run?.subject || !!preview;
  const pickDealPin = (id: string) => {
    const d = deals.find((x) => `deal:${x.id}` === id);
    if (!d) return;
    if (d.lat && d.lng) setPreview({ lat: d.lat, lng: d.lng });
    setPicked({ deal_id: d.id }); setQuery([d.address, d.city, d.state].filter(Boolean).join(', ')); setTyped(false); setSugs([]);
    setArv(d.arv ? String(d.arv) : ''); setF({ asking_price: d.price ?? null });
  };

  const waiting = (
    <div style={{ padding: `34px ${gutter} 38px`, textAlign: 'center' }}>
      <div style={{ fontSize: '13.5px', fontWeight: 650, color: INK }}>{busy ? 'Finding the property…' : standalone ? (located ? 'Ready to search' : 'Search any address') : 'No search on this deal yet'}</div>
      <div style={{ fontSize: '12.5px', color: MUTED, marginTop: '5px', maxWidth: '420px', marginInline: 'auto', lineHeight: 1.5 }}>
        {standalone && !located && dealPins.length ? 'Type an address, pick a deal, or click one of your deals on the map. ' : ''}
        Pick the buyer types, radius and window, then Find buyers. Estimate size first to see how many sales it will scan. Past searches reopen for free.
      </div>
    </div>
  );

  const map = (height: number | string) => (
    <GeniusMap center={centre} radiusMi={located ? filters.radius_mi : null} zoom={dealPins.length ? 9 : 4} subject={located}
      pins={run?.subject ? pins : dealPins} activeId={run?.subject ? activeKey : null}
      height={height} onPin={(id) => (run?.subject ? setPopKey(id) : pickDealPin(id))} onHover={run?.subject ? setHoverKey : undefined}
      popup={popup} popupId={run?.subject ? popKey : null} onClosePopup={() => setPopKey(null)}>
      {run?.subject ? legend : null}
    </GeniusMap>
  );

  // Phones: one segmented switch for the three ways to look at a run.
  const phoneView = mView === 'map' ? 'map' : tab;
  const pickView = (v: 'buyers' | 'map' | 'analytics') => {
    if (v === 'map') setMView('map'); else { setMView('list'); setTab(v); }
    setPopKey(null);
  };
  const viewSwitch = (
    <div style={{ position: 'sticky', top: 0, zIndex: 4, background: 'var(--band)', padding: `6px ${gutter}`, height: SWITCH_H, boxSizing: 'border-box', borderBottom: '1px solid var(--band-line)', boxShadow: '0 4px 8px -6px rgba(20,30,55,.25)' }}>
      <div role="tablist" aria-label="View" style={{ display: 'flex', height: '32px', padding: '2px', borderRadius: '9px', background: 'var(--inset)', boxShadow: 'var(--elev-inset)' }}>
        {([['buyers', ICON.list, `Buyers · ${view.counts.all}`], ['map', ICON.map, 'Map'], ['analytics', ICON.chart, 'Analytics']] as const).map(([k, d, l]) => {
          const on = phoneView === k;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} onClick={() => pickView(k)}
              style={{ flex: 1, minWidth: 0, border: 0, borderRadius: '7px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', cursor: 'pointer',
                fontSize: '12.5px', fontWeight: on ? 650 : 500, color: on ? INK : MUTED, background: on ? '#fff' : 'transparent', boxShadow: on ? SHADOW.ring : 'none', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              <Icon d={d} size={14} />{l}
            </button>
          );
        })}
      </div>
    </div>
  );

  const phoneBody = run?.subject ? (
    <>
      {viewSwitch}
      {mView === 'map' ? map('calc(100dvh - 250px)') : list}
    </>
  ) : (
    <>
      <div style={{ borderBottom: `1px solid ${HAIR}` }}>{map(240)}</div>
      {waiting}
    </>
  );

  const body = !workspaceId && !props.seed ? (
    <div style={{ padding: gutter, fontSize: '12.5px', color: MUTED, lineHeight: 1.55 }}>Sign in to a workspace to run Genius Mode.</div>
  ) : isMobile ? phoneBody : (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(400px, 1fr)', height: 'max(600px, calc(100vh - 290px))' }}>
      <div style={{ position: 'relative', borderRight: '1px solid var(--edge)' }}>
        {map('100%')}
      </div>
      {run?.subject ? list : waiting}
    </div>
  );

  const main = (
    // clip, not hidden, on phones: hidden makes the card a scroll box and the
    // view switch and bulk bar would stop sticking to the top of the screen.
    <div style={{ ...card, overflow: isMobile ? 'clip' : 'hidden' }} data-gx>
      <style>{GX_CSS}</style>
      {header}
      {folded ? summary : <>{searchBar}{filterBar}</>}
      {status}
      {body}
      {portfolioFor && workspaceId ? <PortfolioDrawer workspaceId={workspaceId} c={portfolioFor} isMobile={isMobile} onClose={() => setPortfolioFor(null)} onOpenBuyer={props.onOpenBuyer} /> : null}
    </div>
  );

  if (!standalone || isMobile) return main;
  return (
    <div data-gx style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: '16px', alignItems: 'start' }}>
      <aside style={card}>
        <div style={{ display: 'flex', gap: '4px', padding: '8px', borderBottom: '1px solid var(--band-line)', background: 'var(--band)' }}>
          {([['search', 'Find buyers'], ['wholesalers', 'Wholesalers']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setPane(k)} style={{ flex: 1, border: 0, borderRadius: '7px', padding: '7px 6px', fontSize: '12px', fontWeight: 650, cursor: 'pointer', color: pane === k ? INK : MUTED, background: pane === k ? '#fff' : 'transparent', boxShadow: pane === k ? SHADOW.ring : 'none' }}>{l}</button>
          ))}
        </div>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--band-line)', background: 'var(--band)', fontSize: '12px', fontWeight: 700, color: INK }}>Past searches</div>
        <div style={{ maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
          {past.length === 0 ? <div style={{ padding: '14px', fontSize: '12px', color: MUTED, lineHeight: 1.5 }}>Searches you run are saved here and reopen without spending a credit.</div> : past.map((p) => (
            <button key={p.id} type="button" onClick={() => void openPast(p.id)} style={{ display: 'flex', gap: '9px', alignItems: 'center', width: '100%', textAlign: 'left', padding: '10px 12px', border: 0, borderTop: `1px solid ${HAIR}`, background: run?.run_id === p.id ? '#F0FAF5' : '#fff', boxShadow: run?.run_id === p.id ? `inset 3px 0 0 ${PURPLE}` : 'none', cursor: 'pointer' }}>
              <span style={{ width: '34px', height: '34px', flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700, color: p.top_score == null ? MUTED : heat(p.top_score).text, border: `3px solid ${p.top_score == null ? HAIR : heat(p.top_score).stroke}` }}>{p.top_score ?? '—'}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.address ?? 'Untitled'}</span>
                <span style={{ display: 'block', fontSize: '11.5px', color: p.status === 'error' ? RED : MUTED, marginTop: '1px' }}>{p.status === 'error' ? 'failed' : `${p.buyer_count ?? 0} buyers`} · {foundLabel(p.filters)} · {p.radius_mi} mi · {ago(p.created_at)}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      {pane === 'wholesalers' && workspaceId
        ? <Wholesalers workspaceId={workspaceId} userId={userId} canWrite={canWrite} isMobile={isMobile} onToast={onToast} onOpenBuyer={props.onOpenBuyer} onAdded={props.onAdded} />
        : main}
    </div>
  );
}

/**
 * The Matches tab's "Genius-found" strip: the top five from the deal's last run,
 * with a way into the full Genius tab. Reads the saved run only — no spend.
 */
export function GeniusTopFive({ workspaceId, dealId, onViewAll }: { workspaceId: number | null; dealId: number | null; onViewAll: () => void }) {
  const [run, setRun] = useState<Run | null | undefined>(undefined);
  useEffect(() => {
    if (!workspaceId || !dealId) return;
    let live = true;
    void lastPropertyRun(workspaceId, dealId, null).then((r) => { if (live) setRun(r); });
    return () => { live = false; };
  }, [workspaceId, dealId]);
  const top = (run?.candidates ?? []).filter((c) => !c.institutional).sort((a, b) => b.likelihood - a.likelihood).slice(0, 5);
  return (
    <div style={{ ...card, marginTop: '16px' }} data-gx>
      <style>{GX_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', borderBottom: top.length ? `1px solid ${HAIR}` : 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13.5px', fontWeight: 650, color: INK }}><span style={{ color: PURPLE, display: 'inline-flex' }}><Icon d={ICON.sparkle} size={14} /></span>Genius-found buyers</span>
        <span style={{ fontSize: '12px', color: MUTED, flex: 1 }}>{run ? `${run.candidates.length} investors bought nearby · ${ago(run.created_at)}` : 'Investors buying around this house, off public records'}</span>
        <button type="button" onClick={onViewAll} style={btn('purple', true)}>{run ? 'View all' : 'Run Genius'}</button>
      </div>
      {top.map((c) => (
        <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px', borderTop: `1px solid ${HAIR}`, fontSize: '12.5px' }}>
          <span style={{ width: '30px', fontWeight: 700, color: heat(c.likelihood).text, fontVariantNumeric: 'tabular-nums' }}>{c.likelihood}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: INK, fontWeight: 600 }}>{c.owner_name}</span>
          <Badge {...KIND_BADGE[c.kind]}>{KIND_LABEL[c.kind]}</Badge>
          <span style={{ color: MUTED, whiteSpace: 'nowrap' }}>{c.purchase_count} buy{c.purchase_count === 1 ? '' : 's'} · {c.nearest_mi ?? '?'} mi · {shortMoney(c.avg_price)}</span>
          {c.matched_buyer_id ? <span style={{ color: GREEN, fontSize: '11px', fontWeight: 700 }}>In buyers</span> : null}
        </div>
      ))}
    </div>
  );
}
