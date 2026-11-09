// Reporting, computed in the browser from rows CLOZR already loads.
//
// lib/crm.ts hands over `ReportRaw` — the loaded rows with their real
// timestamps, not the display strings the screens use — and `buildReport`
// turns one tab + one range into blocks the Reporting screen draws. Nothing
// here is estimated: a figure the data cannot support is left out and a note
// says which data is missing, because a zero on a report reads as a fact.

import { ACTIVE_DEAL_STAGES, SELLER_STAGE_LABELS, sellerStageGroup } from './stages';
import { type LineRow, commLineName, commRep, lineBook } from './comm-rep';

export type ReportRaw = {
  members: { id: string; name: string; role: string; email?: string | null; avatar?: string | null }[];
  sellers: { id: number; name: string; created_at: string; source: string | null; assigned_to: string | null; stage: string; address: string | null; email?: string | null; phone?: string | null; tags?: string[] | null; stage_entered_at?: string | null }[];
  deals: {
    id: number; seller_id: number | null; buyer_id: number | null; stage: string; created_at: string; stage_entered_at: string | null;
    contract_date: string | null; close_date: string | null; closed_on: string | null; marketing_started_on: string | null;
    owner_id: string | null; dispo_rep_id: string | null;
    offer_amount: number | null; arv: number | null; mao: number | null; assignment_fee: number | null; sold_price: number | null; dispo_fee?: number | null;
    wholesale_fee: number | null; total_cogs: number | null; team_commissions_paid: number | null; deal_net_profit: number | null; final_profit: number | null;
    lead_source?: string | null; market?: string | null; marketed_price?: number | null;
    /** The Deal Tracker's transaction coordinator, by name. */
    coordinator?: string | null;
    /** Why and when a contract fell out (Deal Tracker columns). */
    termination_reason?: string | null; terminated_on?: string | null;
  }[];
  comms: { seller_id: number | null; buyer_id?: number | null; /** The rep who handled it (migration 85); null falls back to the line's owner, then the seller's rep (lib/comm-rep). */ rep_id?: string | null; from_phone?: string | null; to_phone?: string | null; channel: string; direction: string | null; occurred_at: string; duration_s: number | null; status: string | null }[];
  /** The team lines (rep_phone_numbers): whose each number is, or its name. */
  lines?: LineRow[];
  /** True when the communications read hit its row cap, so older activity is missing. */
  commsCapped: boolean;
  /**
   * The first load reads deals without their money columns, no offers and only
   * the newest calls; the full read follows (enrichWorkspace). 'loading' until
   * it lands, 'failed' if it did not, so those figures never read as zero.
   */
  partial?: 'loading' | 'failed';
  offers: { id: number; deal_id: number | null; seller_id: number | null; buyer_id: number | null; direction: string; amount: number | null; status: string; sent_at: string; responded_at: string | null; created_by: string | null }[];
  contracts: { id: number; deal_id: number | null; kind: string; status: string; provider: string | null; sent_at: string | null; viewed_at: string | null; completed_at: string | null; created_at: string }[];
  matches: { deal_id: number; buyer_id: number; status: string; sent_at: string | null; viewed_at: string | null; replied_at: string | null }[];
  buyers: { id: number; name: string; vip: boolean; created_at: string; last_activity_at: string | null; blacklisted_at: string | null; created_by?: string | null }[];
  transactions: { deal_id: number | null; close_date: string | null; status: string; title_company: string | null }[];
  /** For the custom report builder (lib/report-engine.ts); the fixed tabs do not read these. */
  appointments?: { id: number; seller_id: number | null; buyer_id: number | null; title: string; kind: string; starts_at: string; assigned_to?: string | null; source?: string | null; created_at?: string | null; deleted_at?: string | null }[];
  tasks?: { id: number; seller_id: number | null; title: string; task_type: string; priority: string; due_at: string | null; assigned_to: string | null; done: boolean; completed_at?: string | null; created_at?: string | null }[];
};

export type Kpi = { k: string; v: string; d?: string; dColor?: string };
export type Block =
  | { kind: 'kpis'; items: Kpi[] }
  | { kind: 'bars'; title: string; sub?: string; items: { label: string; value: number; tip: string }[]; empty: string; half?: boolean; /** Named categories as rows rather than a time series. */ rows?: boolean }
  | { kind: 'funnel'; title: string; sub?: string; steps: { k: string; n: number; rate: string; pct: number }[]; empty: string; half?: boolean }
  | { kind: 'table'; title: string; sub?: string; cols: string[]; rows: string[][]; empty: string; half?: boolean }
  | { kind: 'note'; title: string; text: string; half?: boolean }
  | { kind: 'bank' }
  /** An SVG diagram (components/reporting/diagrams) over the same numbers the tab's tables show. */
  | { kind: 'diagram'; title: string; sub: string; empty: string; half?: boolean; diagram: Diagram };

export type Diagram =
  | { type: 'funnel'; steps: { k: string; n: number; rate: string; pct: number }[] }
  /** Leads created in range: source → assigned rep → where they are now. One flow per (source, rep, stage) with its lead count. */
  | { type: 'leadflow'; sources: string[]; reps: string[]; stages: string[]; flows: { source: number; rep: number; stage: number; n: number }[] }
  /** In-range counts per system, keyed by the diagram's node ids; a missing key means CLOZR holds no count for it. */
  | { type: 'dataflow'; counts: Record<string, string> }
  | { type: 'org'; people: { id: string; name: string; role: string; calls: number; offers: number; contracts: number; closings: number }[] }
  | { type: 'pipeline'; stages: { k: string; n: number; days: number | null; fees: number }[] }
  | { type: 'timeline'; start: number; end: number; total: number; events: { t: number; label: string; fee: number }[] }
  /** Road to 100 (lib/compr-road-to-100): customers against the marks, then each daily goal's count against its pace. */
  | { type: 'goals'; customers: number; marks: number[]; goals: { k: string; got: number; want: number; perDay: number }[]; label?: string; money?: boolean }
  /** One honest-width funnel row per avatar and tier: reached → demos → sign-ups → customers. */
  | { type: 'avatars'; rows: { label: string; reached: number; demos: number; signups: number; customers: number }[] };

export const REPORT_TABS = ['Overview', 'Acquisitions', 'Lead Sources', 'Calls', 'Team', 'Offers', 'Contracts', 'Dispo', 'Buyers', 'Closings', 'Marketing', 'Profitability', 'Team stoplight', 'AI Agents', 'AI Sales Manager', 'Flows', 'Custom reports'];
/** Every diagram on one tab (components/reporting/diagrams). */
export const FLOWS_TAB = 'Flows';
/** The tab the report builder lives on; it draws itself (components/reporting/custom) rather than through buildReport. */
export const CUSTOM_TAB = 'Custom reports';
/** Each teammate against their targets (migration 260, lib/stoplight). Owner/admin only; draws itself (components/reporting/TeamStoplight). */
export const TEAM_STOPLIGHT_TAB = 'Team stoplight';
/** Tabs only owners and admins see: commissions and the bank feed, and the team's grades. */
export const ADMIN_REPORT_TABS: readonly string[] = ['Profitability', TEAM_STOPLIGHT_TAB];
/** The AI agents' own report (migration 123); it draws itself (components/reporting/AiAgentsReport) from the ai-agent function. */
export const AI_AGENTS_TAB = 'AI Agents';
/** The AI Sales Manager (migration 149): call reviews, flagged calls, rep scorecards, roleplay. Draws itself (components/coaching/SalesManager). */
export const AI_SALES_TAB = 'AI Sales Manager';
export const REPORT_RANGES = ['Today', 'Yesterday', '7 Days', '30 Days', '90 Days', 'MTD', 'QTD', 'YTD', 'All time', 'Custom'];
/** A Custom range's days, "YYYY-MM-DD" each; a missing end is today, a missing start 30 days before the end. */
export type CustomRange = { from: string; to: string };

// ---- time ------------------------------------------------------------------

const DAY = 86_400_000;
export type Range = { start: number; end: number; prevStart: number | null; prevEnd: number | null };

export function rangeOf(label: string, now = new Date(), custom?: CustomRange): Range {
  const t = now.getTime();
  if (label === 'Custom') {
    const end = custom?.to ? new Date(custom.to + 'T00:00:00').getTime() + DAY - 1 : t;
    const from = custom?.from ? new Date(custom.from + 'T00:00:00').getTime() : end + 1 - 30 * DAY;
    const start = Math.min(from, end);
    const len = Math.max(DAY, end - start);
    return { start, end, prevStart: start - len, prevEnd: start - 1 };
  }
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Local midnight `n` days back, by the calendar: a day across a DST change
  // is 23 or 25 hours, so `midnight - n * DAY` started an hour off.
  const dayStart = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime();
  const days = (n: number): Range => ({ start: t - n * DAY, end: t, prevStart: t - 2 * n * DAY, prevEnd: t - n * DAY });
  const since = (start: Date, prev: Date): Range => ({ start: start.getTime(), end: t, prevStart: prev.getTime(), prevEnd: prev.getTime() + (t - start.getTime()) });
  const q = Math.floor(now.getMonth() / 3) * 3;
  switch (label) {
    case 'Today': return { start: midnight, end: t, prevStart: dayStart(1), prevEnd: t - DAY };
    case 'Yesterday': return { start: dayStart(1), end: midnight, prevStart: dayStart(2), prevEnd: dayStart(1) };
    case '7 Days': return days(7);
    case '30 Days': return days(30);
    case '90 Days': return days(90);
    case 'MTD': return since(new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() - 1, 1));
    case 'QTD': return since(new Date(now.getFullYear(), q, 1), new Date(now.getFullYear(), q - 3, 1));
    case 'YTD': return since(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() - 1, 0, 1));
    default: return { start: -Infinity, end: t, prevStart: null, prevEnd: null };
  }
}

/** Date-only columns ("2026-09-01") are local days, not UTC midnight. */
const ts = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
  return Number.isNaN(n) ? null : n;
};
const inR = (iso: string | null | undefined, a: number, b: number) => { const n = ts(iso); return n !== null && n >= a && n <= b; };

// ---- format ----------------------------------------------------------------

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const usd = (n: number | null | undefined) => (n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '—');
export function dur(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  if (s < DAY / 1000) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + Number(b ?? 0), 0);
const shortDay = (n: number) => new Date(n).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ---- shared definitions ----------------------------------------------------

const GREEN = '#16a34a', RED = '#dc2626', MUTED = '#71717a';

/** The seller-stage group, including the sample graph's older vocabulary. */
function stageGroup(stage: string) {
  if (SELLER_STAGE_LABELS.includes(stage)) return sellerStageGroup(stage);
  return /closed/i.test(stage) ? 'closed' : /contract|dispo|assigned|closing/i.test(stage) ? 'contract'
    : /offer|negotiat/i.test(stage) ? 'offer' : /lost|dead/i.test(stage) ? 'dead' : /new lead/i.test(stage) ? 'lead' : 'working';
}
const isCall = (c: ReportRaw['comms'][number]) => c.channel === 'call';
const isOut = (c: ReportRaw['comms'][number]) => c.direction !== 'inbound';
const accepted = (s: string) => /accept|signed|won/i.test(s);
const declined = (s: string) => /declin|reject|expired|lost|dead/i.test(s);
/** When a deal closed. A terminated deal never closed, whatever date the tracker carries in Closed On. */
export const closedAt = (d: ReportRaw['deals'][number]) => (d.stage === 'Terminated' ? null : d.closed_on ?? (d.stage === 'Closed' ? d.close_date : null));
/** When a contract fell out: the tracker's terminated date, else when the deal moved to Terminated. */
const terminatedAt = (d: ReportRaw['deals'][number]) => (d.stage === 'Terminated' ? d.terminated_on ?? d.stage_entered_at : null);
/** The Deal Tracker's dispo fee when there is one; else the spread (sold − contract) when both prices are on file and it is positive; else the assignment fee typed on the deal. The first load has no wholesale_fee yet, so the spread is figured here. */
export const fee = (d: ReportRaw['deals'][number]) => {
  if (d.dispo_fee != null) return Number(d.dispo_fee);
  const spread = d.sold_price != null && d.offer_amount != null ? Number(d.sold_price) - Number(d.offer_amount) : Number(d.wholesale_fee ?? 0);
  return spread > 0 ? spread : Number(d.assignment_fee ?? 0);
};
/**
 * A deal's money from its fee down. Not the table's deal_net_profit / final_profit:
 * those start from wholesale_fee (sold price − contract price), which turns into
 * minus the whole contract price whenever the sold price is blank.
 */
export function profitOf(d: ReportRaw['deals'][number]) {
  const f = fee(d), cogs = Number(d.total_cogs ?? 0), comm = Number(d.team_commissions_paid ?? 0);
  return { fee: f, cogs, net: f - cogs, comm, final: f - cogs - comm };
}

// ---- leads and sources -----------------------------------------------------
//
// A cold list pull (PropStream, DealMachine, a dated list name) puts thousands
// of owners in the workspace who never asked to sell. Each is a prospect, not a
// lead, until it answers (an inbound call, text or email) or a rep moves it off
// a new-lead stage. It becomes a lead on that date, not the day it was imported.

const LIST_RE = /propstream|deal ?machine|batch ?leads|skip ?trac|\blist\b|\bpull\b|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?/i;
export const isListSource = (src: string | null | undefined) => !!src && LIST_RE.test(src);

/** Source groups, first match wins. Names that fit none show as Other; import channels with no real source as Not recorded. */
const SOURCE_GROUPS: [string, RegExp][] = [
  ['Cold lists', LIST_RE],
  ['Pay per lead', /\bppl\b|pay ?per ?lead|motivated sellers|istl|property leads/i],
  ['PPC', /ppc|google|facebook|\bmeta\b|adwords|bing/i],
  ['Direct mail', /direct mail|mailer|postcard|letter/i],
  ['Cold call', /cold ?call|dialer/i],
  ['Inbound call', /inbound/i],
  ['Texting', /\bsms\b|texting/i],
  ['Website', /website|web ?form|jotform|webhook|zapier|landing/i],
  ['Referral', /referr|realtor|agent/i],
  ['MLS', /\bmls\b/i],
  ['Wholesaler / JV', /wholesal|\bjv\b|offerpad|opendoor|home ?buyers|investments?\b|capital|holdings|propert|realty|\bllc\b|\binc\b|\bco\b|partners?\b/i],
  ['Not recorded', /^(podio|deal-?tracker|deal tracker|manual|import|csv|unknown)$/i],
];
export function sourceGroup(src: string | null | undefined): string {
  const t = (src ?? '').trim();
  if (!t) return 'Not recorded';
  return SOURCE_GROUPS.find(([, re]) => re.test(t))?.[0] ?? 'Other';
}

export type Lead = { s: ReportRaw['sellers'][number]; at: number };
/** Every real lead in the workspace and when it became one (see above), built once per load. */
const leadsCache = new WeakMap<ReportRaw, Lead[]>();
export function leadsOf(raw: ReportRaw): Lead[] {
  const hit = leadsCache.get(raw);
  if (hit) return hit;
  const reply = new Map<number, number>();
  for (const c of raw.comms) {
    if (c.seller_id == null || c.direction !== 'inbound' || c.channel === 'note') continue;
    const t = ts(c.occurred_at);
    if (t !== null && t < (reply.get(c.seller_id) ?? Infinity)) reply.set(c.seller_id, t);
  }
  const out: Lead[] = [];
  for (const s of raw.sellers) {
    const created = ts(s.created_at);
    if (created === null) continue;
    if (!isListSource(s.source)) { out.push({ s, at: created }); continue; }
    const r = reply.get(s.id);
    // ponytail: a worked prospect with no reply on file is dated by its current stage's entry, which can be later than the day it was first worked.
    if (r !== undefined || stageGroup(s.stage) !== 'lead') out.push({ s, at: r ?? ts(s.stage_entered_at) ?? created });
  }
  leadsCache.set(raw, out);
  return out;
}

/** The acquisitions rep on a deal: its owner, else the rep its seller is assigned to. */
const acqCache = new WeakMap<ReportRaw, (d: ReportRaw['deals'][number]) => string | null>();
function acqRepOf(raw: ReportRaw) {
  const hit = acqCache.get(raw);
  if (hit) return hit;
  const sellerRep = new Map(raw.sellers.map((s) => [s.id, s.assigned_to] as const));
  const f = (d: ReportRaw['deals'][number]) => d.owner_id ?? (d.seller_id != null ? sellerRep.get(d.seller_id) ?? null : null);
  acqCache.set(raw, f);
  return f;
}

/**
 * One teammate's slice of the workspace, for the rep filter: the sellers
 * assigned to them, the deals they own (acquisitions or dispo), the calls,
 * texts and emails they handled, the offers they made. Every block and diagram
 * then reads it like the whole workspace.
 */
const scopeCache = new WeakMap<ReportRaw, Map<string, ReportRaw>>();
export function scopeToRep(raw: ReportRaw, rep: string): ReportRaw {
  const byRep = scopeCache.get(raw) ?? new Map<string, ReportRaw>();
  scopeCache.set(raw, byRep);
  const hit = byRep.get(rep);
  if (hit) return hit;
  const acq = acqRepOf(raw), who = handlerOf(raw);
  const sellers = raw.sellers.filter((s) => s.assigned_to === rep);
  const sellerIds = new Set(sellers.map((s) => s.id));
  const deals = raw.deals.filter((d) => acq(d) === rep || d.dispo_rep_id === rep);
  const dealIds = new Set(deals.map((d) => d.id));
  const out: ReportRaw = {
    ...raw,
    members: raw.members.filter((m) => m.id === rep),
    sellers, deals,
    comms: raw.comms.filter((c) => who(c) === rep),
    offers: raw.offers.filter((o) => o.created_by === rep || (o.seller_id != null && sellerIds.has(o.seller_id)) || (o.deal_id != null && dealIds.has(o.deal_id))),
    contracts: raw.contracts.filter((c) => c.deal_id != null && dealIds.has(c.deal_id)),
    matches: raw.matches.filter((m) => dealIds.has(m.deal_id)),
    buyers: raw.buyers.filter((b) => b.created_by === rep),
    transactions: raw.transactions.filter((t) => t.deal_id != null && dealIds.has(t.deal_id)),
    appointments: raw.appointments?.filter((a) => a.assigned_to === rep || (a.seller_id != null && sellerIds.has(a.seller_id))),
    tasks: raw.tasks?.filter((t) => t.assigned_to === rep),
  };
  byRep.set(rep, out);
  return out;
}

function delta(cur: number, prev: number | null, money = false, lowerIsBetter = false): Pick<Kpi, 'd' | 'dColor'> {
  if (prev === null) return {};
  const diff = cur - prev;
  if (diff === 0) return { d: 'flat vs prior', dColor: MUTED };
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const mag = money ? usd(Math.abs(diff)).replace('−', '') : num(Math.abs(diff));
  const rel = prev ? ` (${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff / prev) * 100)}%)` : '';
  return { d: `${diff > 0 ? '+' : '−'}${mag}${rel} vs prior`, dColor: good ? GREEN : RED };
}

/** Bars over the range: hours for a day, days to a month, weeks to ~4 months, then months. */
function series(r: Range, points: { t: number | null; v: number }[], fmt: (v: number) => string) {
  const known = points.map((p) => p.t).filter((t): t is number => t !== null);
  const start = Number.isFinite(r.start) ? r.start : known.length ? Math.min(...known) : r.end - 30 * DAY;
  const span = r.end - start;
  const step = span <= DAY + 1 ? 'hour' : span <= 32 * DAY ? 'day' : span <= 125 * DAY ? 'week' : 'month';
  const keyOf = (t: number) => {
    const d = new Date(t);
    if (step === 'hour') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    if (step === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (step === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };
  const next = (k: number) => {
    const d = new Date(k);
    return step === 'hour' ? k + 3600_000 : step === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      : step === 'week' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime() : new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  };
  const buckets = new Map<number, number>();
  for (let k = keyOf(start), i = 0; k <= r.end && i < 60; k = next(k), i++) buckets.set(k, 0);
  for (const p of points) {
    if (p.t === null || p.t < start || p.t > r.end) continue;
    const k = keyOf(p.t);
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + p.v);
  }
  return [...buckets.entries()].map(([k, v]) => {
    const d = new Date(k);
    const label = step === 'hour' ? String(d.getHours()) : step === 'month' ? d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : shortDay(k);
    return { label, value: v, tip: `${label}${step === 'week' ? ' wk' : ''} · ${fmt(v)}` };
  });
}

// ---- per-rep metrics -------------------------------------------------------
//
// One definition of each headline count, read by the Overview and Team tabs,
// and by Home's tiles, so a figure with the same name is
// the same number wherever it appears. A rep's share follows the Team tab's
// rules: leads and contacts through the seller the rep is assigned to; calls,
// texts and emails to whoever handled them (lib/comm-rep: the rep on the row,
// the owner of the line it used, else the seller's rep); offers the rep made
// or sent to their sellers, contracts the rep owns, and closings and revenue on deals where the
// rep is the acquisitions owner or the dispo rep.

export type RepMetrics = {
  newLeads: number; contacted: number; offers: number; contracts: number; closings: number; revenue: number;
  /** Revenue on closings where the rep is the acquisitions rep, and where they are the dispo rep. One deal can count in both for different reps. */
  acqRevenue: number; dispoRevenue: number;
  calls: number; connected: number; talk: number; texts: number; emails: number;
  /** Median seconds from a new lead's creation to its first outbound touch; null when none was contacted. */
  speed: number | null;
  /** How many new leads that median is over. */
  speedN: number;
};

/** Who handled each message (lib/comm-rep), built once per load. */
const handlerCache = new WeakMap<ReportRaw, (c: ReportRaw['comms'][number]) => string | null>();
function handlerOf(raw: ReportRaw) {
  const hit = handlerCache.get(raw);
  if (hit) return hit;
  const sellerRep = new Map(raw.sellers.map((s) => [s.id, s.assigned_to] as const));
  const team = new Set(raw.members.map((m) => m.id));
  const lines = lineBook(raw.lines);
  const who = (c: ReportRaw['comms'][number]) => commRep(c, lines, (id) => (id == null ? null : sellerRep.get(id) ?? null), (id) => !!id && team.has(id));
  handlerCache.set(raw, who);
  return who;
}

/** Each seller's outbound touches (calls, texts, emails; not notes), built once per load. */
const outreachCache = new WeakMap<ReportRaw, Map<number, number[]>>();
function outreachOf(raw: ReportRaw) {
  const hit = outreachCache.get(raw);
  if (hit) return hit;
  const m = new Map<number, number[]>();
  for (const c of raw.comms) {
    if (c.seller_id == null || !isOut(c) || c.channel === 'note') continue;
    const t = ts(c.occurred_at);
    if (t === null) continue;
    const xs = m.get(c.seller_id);
    if (xs) xs.push(t); else m.set(c.seller_id, [t]);
  }
  outreachCache.set(raw, m);
  return m;
}

/** Seconds from each lead's creation to its first outbound touch. Leads never contacted are left out rather than counted as zero. */
function leadSpeeds(leads: Lead[], outreach: Map<number, number[]>) {
  return leads.map(({ s, at: created }) => {
    const first = (outreach.get(s.id) ?? []).filter((t) => t >= created).sort((a, b) => a - b)[0];
    return first === undefined ? null : (first - created) / 1000;
  }).filter((x): x is number => x !== null);
}

/** The headline counts over [start, end] for one rep, or for the whole workspace when `rep` is undefined. */
export function repMetrics(raw: ReportRaw, r: { start: number; end: number }, rep?: string): RepMetrics {
  const cur = (iso: string | null | undefined) => inR(iso, r.start, r.end);
  const all = rep === undefined;
  const mine = new Set(all ? [] : raw.sellers.filter((s) => s.assigned_to === rep).map((s) => s.id));
  const ownSeller = (id: number | null) => all || (id != null && mine.has(id));
  const inRange = (t: number) => t >= r.start && t <= r.end;
  const leads = leadsOf(raw).filter((l) => inRange(l.at) && (all || l.s.assigned_to === rep));
  const leadIds = new Set(leadsOf(raw).map((l) => l.s.id));
  const cs = raw.comms.filter((c) => cur(c.occurred_at) && ownSeller(c.seller_id) && c.seller_id != null && leadIds.has(c.seller_id));
  // Calls, texts and emails count for whoever handled them, not whose seller it was.
  const who = handlerOf(raw);
  const handled = all ? raw.comms.filter((c) => cur(c.occurred_at)) : raw.comms.filter((c) => cur(c.occurred_at) && who(c) === rep);
  const calls = handled.filter(isCall);
  const acq = acqRepOf(raw);
  const closed = raw.deals.filter((d) => cur(closedAt(d)) && (all || acq(d) === rep || d.dispo_rep_id === rep));
  const speeds = leadSpeeds(leads, outreachOf(raw));
  return {
    newLeads: leads.length,
    contacted: new Set(cs.filter((c) => c.seller_id != null && isOut(c) && c.channel !== 'note').map((c) => c.seller_id)).size,
    offers: raw.offers.filter((o) => o.direction === 'outbound' && cur(o.sent_at) && (all || o.created_by === rep || ownSeller(o.seller_id))).length,
    contracts: raw.deals.filter((d) => cur(d.contract_date) && (all || acq(d) === rep)).length,
    closings: closed.length,
    revenue: sum(closed.map(fee)),
    acqRevenue: sum(closed.filter((d) => all || acq(d) === rep).map(fee)),
    dispoRevenue: sum(closed.filter((d) => all || d.dispo_rep_id === rep).map(fee)),
    calls: calls.length,
    connected: calls.filter((c) => Number(c.duration_s) > 0).length,
    talk: sum(calls.map((c) => c.duration_s)),
    texts: handled.filter((c) => c.channel === 'sms' && isOut(c)).length,
    emails: handled.filter((c) => c.channel === 'email' && isOut(c)).length,
    speed: median(speeds),
    speedN: speeds.length,
  };
}

/** The Team tab's leaderboard rows: every teammate's counts, ranked by revenue, then contracts, then calls. */
export function teamRows(raw: ReportRaw, r: { start: number; end: number }) {
  return [...new Set(raw.members.map((m) => m.id))]
    .map((id) => ({ id, ...repMetrics(raw, r, id) }))
    .sort((a, b) => b.revenue - a.revenue || b.contracts - a.contracts || b.calls - a.calls);
}

/**
 * Home's tiles: Reporting's own figures for one rep, or the whole team when
 * `rep` is undefined. Activity reads today, outcomes this month (Reporting's
 * MTD), and speed to lead the last 30 days, because a single day rarely holds
 * a contacted new lead. Each label names its period.
 */
export function homeKpis(raw: ReportRaw, rep?: string, now = new Date()): Kpi[] {
  const over = (label: string) => {
    const r = rangeOf(label, now);
    return { cur: repMetrics(raw, r, rep), prev: r.prevStart === null ? null : repMetrics(raw, { start: r.prevStart, end: r.prevEnd! }, rep) };
  };
  const day = over('Today'), month = over('MTD'), speed = repMetrics(raw, rangeOf('30 Days', now), rep);
  const vs = (k: Exclude<keyof RepMetrics, 'speed'>, p: { cur: RepMetrics; prev: RepMetrics | null }) => delta(p.cur[k], p.prev ? p.prev[k] : null);
  return [
    { k: 'New leads today', v: num(day.cur.newLeads), ...vs('newLeads', day) },
    { k: 'Leads contacted today', v: num(day.cur.contacted), ...vs('contacted', day) },
    { k: 'Speed to lead · 30 days', v: dur(speed.speed), d: speed.speedN ? `median of ${num(speed.speedN)} new lead${speed.speedN === 1 ? '' : 's'}` : 'no new lead contacted', dColor: MUTED },
    { k: 'Calls today', v: num(day.cur.calls), ...vs('calls', day) },
    { k: 'Talk time today', v: dur(day.cur.talk), d: `${num(day.cur.connected)} connected`, dColor: MUTED },
    // Offers arrive with the second read: '…' until then, '—' if it failed, never a false zero.
    raw.partial ? { k: 'Offers sent today', v: raw.partial === 'loading' ? '…' : '—' } : { k: 'Offers sent today', v: num(day.cur.offers), ...vs('offers', day) },
    { k: 'Contracts signed this month', v: num(month.cur.contracts), ...vs('contracts', month) },
    { k: 'Closings this month', v: num(month.cur.closings), d: usd(month.cur.revenue) + ' assignment revenue', dColor: MUTED },
  ];
}

// ---- the report ------------------------------------------------------------

export type ReportOpts = { admin: boolean; now?: Date; custom?: CustomRange; /** One teammate's id: every block reads only their slice (scopeToRep). */ rep?: string | null };
export function buildReport(tab: string, rangeLabel: string, raw: ReportRaw, opts: ReportOpts): Block[] {
  const blocks = tabBlocks(tab, rangeLabel, opts.rep ? scopeToRep(raw, opts.rep) : raw, opts);
  if (!raw.partial) return blocks;
  const note: Block = raw.partial === 'loading'
    ? { kind: 'note', title: 'Still loading', text: 'Offers, deal money (fees, COGS, profit), dispo reps and the full call history are still loading, so those figures read low for a few seconds. They fill in on their own.' }
    : { kind: 'note', title: 'Part of the report did not load', text: 'Offers, deal money (fees, COGS, profit), dispo reps or the full call history could not be read, so figures that need them read low. Reload to try again.' };
  return [note, ...blocks];
}

function tabBlocks(tab: string, rangeLabel: string, raw: ReportRaw, opts: ReportOpts): Block[] {
  const r = rangeOf(rangeLabel, opts.now, opts.custom);
  const cur = (iso: string | null | undefined) => inR(iso, r.start, r.end);
  const prev = (iso: string | null | undefined) => r.prevStart !== null && inR(iso, r.prevStart, r.prevEnd!);
  // A "line:" key is a call nobody on the team is credited with, under its line's name.
  const repName = (id: string | null) => (id ? (id.startsWith('line:') ? id.slice(5) : raw.members.find((m) => m.id === id)?.name ?? 'Former teammate') : 'Unassigned');
  const sellerById = new Map(raw.sellers.map((s) => [s.id, s]));
  const dealById = new Map(raw.deals.map((d) => [d.id, d]));
  const addr = (d: ReportRaw['deals'][number] | undefined) => (d?.seller_id ? sellerById.get(d.seller_id)?.address || sellerById.get(d.seller_id)?.name : null) || (d ? 'Deal ' + d.id : '—');
  const outreachBySeller = outreachOf(raw);
  const outboundOffers = raw.offers.filter((o) => o.direction === 'outbound');
  const offeredSellers = new Set(outboundOffers.map((o) => o.seller_id));
  const dealsBySeller = new Map<number, ReportRaw['deals']>();
  for (const d of raw.deals) if (d.seller_id != null) dealsBySeller.set(d.seller_id, [...(dealsBySeller.get(d.seller_id) ?? []), d]);
  const contacted = (s: ReportRaw['sellers'][number]) => outreachBySeller.has(s.id) || stageGroup(s.stage) !== 'lead';
  const offered = (s: ReportRaw['sellers'][number]) => offeredSellers.has(s.id) || ['offer', 'contract', 'closed'].includes(stageGroup(s.stage));
  const contractedS = (s: ReportRaw['sellers'][number]) => (dealsBySeller.get(s.id) ?? []).some((d) => d.contract_date) || ['contract', 'closed'].includes(stageGroup(s.stage));
  const closedS = (s: ReportRaw['sellers'][number]) => (dealsBySeller.get(s.id) ?? []).some((d) => closedAt(d)) || stageGroup(s.stage) === 'closed';
  const apptSellers = new Set((raw.appointments ?? []).filter((a) => !a.deleted_at && a.seller_id != null).map((a) => a.seller_id));
  // A booked appointment or an appointment stage, never inferred from an offer.
  const appointed = (s: ReportRaw['sellers'][number]) => apptSellers.has(s.id) || /appointment/i.test(s.stage);
  // The report holds the newest 60,000 messages. A range that starts before the oldest of them undercounts calls, texts and contacts.
  const commsFrom = raw.commsCapped && raw.comms.length ? Math.min(...raw.comms.map((c) => ts(c.occurred_at) ?? Infinity)) : null;
  const commsShort = commsFrom !== null && r.start < commsFrom;
  const commsNote = commsShort ? ` Calls, texts and emails are loaded from ${shortDay(commsFrom!)} on, so this range undercounts them.` : '';
  const callNote = 'A call is credited to whoever made or took it: the rep on the call, else the owner of the team line it used (Settings → Numbers), else the seller\'s rep. One with none of those shows under its line\'s name.' + commsNote;

  const inN = (t: number, a: number, b: number) => t >= a && t <= b;
  // Real leads only (leadsOf): a cold list row counts once it answers or is worked, on that day.
  const leadsIn = (a: number, b: number) => leadsOf(raw).filter((l) => inN(l.at, a, b));
  const newLeadRows = leadsIn(r.start, r.end);
  const newLeads = newLeadRows.map((l) => l.s);
  const prevLeadCount = r.prevStart === null ? null : leadsIn(r.prevStart, r.prevEnd!).length;
  const listRows = raw.sellers.filter((s) => isListSource(s.source) && cur(s.created_at)).length;
  const acq = acqRepOf(raw);
  const groupOfDeal = (d: ReportRaw['deals'][number]) => {
    const g = sourceGroup(d.lead_source);
    if (g !== 'Not recorded') return g;
    return sourceGroup(d.seller_id != null ? sellerById.get(d.seller_id)?.source : null);
  };
  const closedDeals = raw.deals.filter((d) => cur(closedAt(d)));
  const prevClosed = raw.deals.filter((d) => prev(closedAt(d)));
  const terminated = raw.deals.filter((d) => cur(terminatedAt(d)));
  const activeDeals = raw.deals.filter((d) => (ACTIVE_DEAL_STAGES as string[]).includes(d.stage));
  /** Share of contracts that ended in the range and fell out rather than closed. */
  const falloutPct = (t: number, c: number) => (t + c ? Math.round((t / (t + c)) * 100) : null);

  // Where the business came from, by source group: real leads that came in during
  // the range (and how many of them reached a contract), and the deals that
  // signed, closed or fell out in the range, by the deal's source, else its seller's.
  const sourceRows = () => {
    type Row = { leads: ReportRaw['sellers']; contracts: number; closed: number; revenue: number; fell: number };
    const groups = new Map<string, Row>();
    const g = (k: string) => { let x = groups.get(k); if (!x) { x = { leads: [], contracts: 0, closed: 0, revenue: 0, fell: 0 }; groups.set(k, x); } return x; };
    for (const s of newLeads) g(sourceGroup(s.source)).leads.push(s);
    for (const d of raw.deals) {
      const inC = cur(d.contract_date), inX = cur(closedAt(d)), inT = cur(terminatedAt(d));
      if (!inC && !inX && !inT) continue;
      const x = g(groupOfDeal(d));
      if (inC) x.contracts++;
      if (inX) { x.closed++; x.revenue += fee(d); }
      if (inT) x.fell++;
    }
    return [...groups.entries()].map(([k, x]) => ({ k, ...x, n: x.leads.length, toContract: x.leads.filter(contractedS).length }))
      .sort((a, b) => b.revenue - a.revenue || b.contracts - a.contracts || b.n - a.n);
  };
  const sourceTable = (title: string): Block => {
    const rows = sourceRows();
    return {
      kind: 'table', title, sub: 'Leads: real leads that came in during the range, and the share that reached a contract. Contracts, closed, fell out and revenue: deals that hit that step in the range, by the deal\'s source (else its seller\'s).',
      cols: ['Source', 'Leads', 'Lead to contract', 'Contracts', 'Closed', 'Fell out', 'Revenue'],
      rows: rows.map((x) => [x.k, num(x.n), pctOf(x.toContract, x.n), num(x.contracts), num(x.closed), num(x.fell), usd(x.revenue)]),
      empty: 'No leads or deals in this range.',
    };
  };

  const funnel = (cohort: ReportRaw['sellers'], title: string): Block => {
    const steps = [
      ['Leads', cohort.length], ['Contacted', cohort.filter((s) => contacted(s) || appointed(s) || offered(s)).length], ['Appointment', cohort.filter(appointed).length],
      ['Offer made', cohort.filter(offered).length], ['Under contract', cohort.filter(contractedS).length], ['Closed', cohort.filter(closedS).length],
    ] as [string, number][];
    return {
      kind: 'funnel', title, sub: 'leads that came in during the range, how far each got', empty: 'No leads were created in this range.', half: true,
      steps: steps.map(([k, n], i) => ({ k, n, pct: cohort.length ? Math.round((n / cohort.length) * 100) : 0, rate: i ? pctOf(n, steps[i - 1][1]) + ' of prior step' : '' })),
    };
  };

  // ---- diagrams (components/reporting/diagrams), each over the figures its home tab's table shows ----
  const dia = {
    funnel: (): Block => {
      const f = funnel(newLeads, 'Lead funnel') as Extract<Block, { kind: 'funnel' }>;
      return { kind: 'diagram', half: true, title: f.title, sub: 'leads that came in during the range and how far each got, cold to hot', empty: f.empty, diagram: { type: 'funnel', steps: f.steps } };
    },
    leadflow: (): Block => {
      const STAGES: [string, string][] = [['lead', 'New'], ['working', 'Working'], ['offer', 'Offer'], ['contract', 'Contract'], ['closed', 'Closed'], ['dead', 'Dead']];
      const idx = (xs: string[], k: string) => { const i = xs.indexOf(k); return i < 0 ? xs.push(k) - 1 : i; };
      const tally = (key: (s: ReportRaw['sellers'][number]) => string) => {
        const m = new Map<string, number>();
        for (const s of newLeads) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
      };
      // The top sources and reps by volume keep their names; the rest fold into Other so the ribbons stay readable.
      const top = tally((s) => sourceGroup(s.source));
      const topReps = tally((s) => repName(s.assigned_to));
      const sources: string[] = [], reps: string[] = [], stages: string[] = [];
      const flows = new Map<string, { source: number; rep: number; stage: number; n: number }>();
      for (const s of newLeads) {
        const src = idx(sources, top.includes(sourceGroup(s.source)) ? sourceGroup(s.source) : 'Other');
        const rep = idx(reps, topReps.includes(repName(s.assigned_to)) ? repName(s.assigned_to) : 'Other');
        const g = stageGroup(s.stage);
        const stage = idx(stages, STAGES.find(([k]) => k === g)?.[1] ?? 'Other');
        const key = `${src}/${rep}/${stage}`;
        const f = flows.get(key) ?? { source: src, rep, stage, n: 0 };
        f.n++;
        flows.set(key, f);
      }
      const order = (xs: string[], want: string[]) => { const ord = [...xs].sort((a, b) => (want.indexOf(a) + 1 || 99) - (want.indexOf(b) + 1 || 99)); return { xs: ord, map: xs.map((k) => ord.indexOf(k)) }; };
      const st = order(stages, STAGES.map(([, l]) => l));
      const so = order(sources, top);
      return { kind: 'diagram', title: 'Lead flow', sub: 'leads created in range: where they came from, who got them, where they are now', empty: 'No leads were created in this range.',
        diagram: { type: 'leadflow', sources: so.xs, reps, stages: st.xs, flows: [...flows.values()].map((f) => ({ ...f, source: so.map[f.source], stage: st.map[f.stage] })) } };
    },
    dataflow: (): Block => {
      const comms = raw.comms.filter((c) => cur(c.occurred_at));
      const n = (x: number, unit: string) => `${num(x)} ${unit}${x === 1 ? '' : 's'}`;
      const leadsFrom = (re: RegExp) => raw.sellers.filter((s) => cur(s.created_at) && re.test(s.source ?? '')).length;
      const underwritten = raw.deals.filter((d) => d.arv != null && cur(d.created_at)).length;
      const counts: Record<string, string> = {
        talkr: `${n(comms.filter(isCall).length, 'call')} · ${n(comms.filter((c) => c.channel === 'sms').length, 'text')}`,
        gmail: n(comms.filter((c) => c.channel === 'email').length, 'email'),
        dealmachine: n(leadsFrom(/deal\s*machine/i), 'row') + ' imported',
        podio: n(leadsFrom(/podio/i), 'row') + ' imported',
        compr: raw.partial === 'loading' ? 'loading…' : raw.partial === 'failed' ? 'not loaded' : n(underwritten, 'deal') + ' underwritten',
        clozr: `${n(newLeads.length, 'lead')} · ${n(raw.deals.filter((d) => cur(d.created_at)).length, 'deal')}`,
        buyr: n(raw.matches.filter((m) => cur(m.sent_at)).length, 'deal send'),
        esign: n(raw.contracts.filter((c) => cur(c.sent_at)).length, 'contract') + ' sent',
        ads: 'no spend on file',
        reports: `${REPORT_TABS.length} tabs`,
        sequences: 'sends not loaded here',
      };
      return { kind: 'diagram', title: 'Data flow', sub: 'where CLOZR\'s data comes from and where it goes, with this range\'s counts', empty: '', diagram: { type: 'dataflow', counts } };
    },
    org: (): Block => ({
      kind: 'diagram', title: 'Team', sub: 'who reports to whom, with each rep\'s calls, offers and contracts in range', empty: 'No teammates in this workspace yet.',
      diagram: { type: 'org', people: [...new Map(raw.members.map((m) => [m.id, m])).values()].map((m) => { const x = repMetrics(raw, r, m.id); return { id: m.id, name: m.name, role: m.role, calls: x.calls, offers: x.offers, contracts: x.contracts, closings: x.closings }; }) },
    }),
    pipeline: (half = true): Block => {
      const today = (opts.now ?? new Date()).getTime();
      const active = raw.deals.filter((d) => (ACTIVE_DEAL_STAGES as string[]).includes(d.stage));
      const stages = (ACTIVE_DEAL_STAGES as string[]).map((k) => {
        const ds = active.filter((d) => d.stage === k);
        const days = median(ds.map((d) => ts(d.stage_entered_at)).filter((t): t is number => t !== null).map((t) => Math.max(0, (today - t) / DAY)));
        return { k, n: ds.length, days: days === null ? null : Math.round(days), fees: sum(ds.map(fee)) };
      });
      stages.push({ k: 'Closed', n: closedDeals.length, days: null, fees: sum(closedDeals.map(fee)) });
      return { kind: 'diagram', half, title: 'Dispo pipeline', sub: 'active inventory by stage with median days in stage; Closed is this range', empty: 'No active inventory and nothing closed in this range.', diagram: { type: 'pipeline', stages } };
    },
    timeline: (): Block => {
      const events = closedDeals.map((d) => ({ t: ts(closedAt(d))!, label: addr(d), fee: fee(d) })).sort((a, b) => a.t - b.t);
      const start = Number.isFinite(r.start) ? r.start : events.length ? events[0].t - DAY : r.end - 30 * DAY;
      return { kind: 'diagram', title: 'Closings timeline', sub: 'each closing on its close date, marker size by assignment fee', empty: 'Nothing closed in this range.', diagram: { type: 'timeline', start, end: r.end, total: sum(events.map((e) => e.fee)), events } };
    },
  };

  switch (tab) {
    case FLOWS_TAB:
      return [dia.funnel(), dia.pipeline(), dia.leadflow(), dia.org(), dia.timeline(), dia.dataflow()];

    case 'Acquisitions': {
      const reps = raw.members.filter((m) => ['owner', 'admin', 'acquisitions', 'partnerships', 'member'].includes(m.role) || newLeads.some((s) => s.assigned_to === m.id));
      const rows = [...reps.map((m) => m.id), null].map((id) => {
        const leadRows = newLeadRows.filter((l) => l.s.assigned_to === id);
        const leads = leadRows.map((l) => l.s);
        const offers = outboundOffers.filter((o) => cur(o.sent_at) && (o.created_by === id || (o.seller_id != null && sellerById.get(o.seller_id)?.assigned_to === id)));
        const contracts = raw.deals.filter((d) => cur(d.contract_date) && acq(d) === id);
        const speeds = leadSpeeds(leadRows, outreachBySeller);
        return { id, leads: leads.length, contacted: leads.filter(contacted).length, offers: offers.length, contracts: contracts.length, speed: median(speeds), speedN: speeds.length };
      }).filter((x) => x.id !== null || x.leads || x.offers || x.contracts);
      // The team figure is the median over every contacted new lead, the same
      // number Home shows for the Entire Team, not a median of the reps' medians.
      const allSpeeds = leadSpeeds(newLeadRows, outreachBySeller);
      return [
        { kind: 'kpis', items: [
          { k: 'New leads', v: num(newLeads.length), ...delta(newLeads.length, prevLeadCount) },
          { k: 'Contact rate', v: pctOf(newLeads.filter(contacted).length, newLeads.length) },
          { k: 'Offers made', v: num(outboundOffers.filter((o) => cur(o.sent_at)).length) },
          { k: 'Contracts', v: num(raw.deals.filter((d) => cur(d.contract_date)).length) },
          { k: 'Median speed to lead', v: dur(median(allSpeeds)) },
        ] },
        { kind: 'table', title: 'By acquisitions rep', sub: 'leads are credited to whoever they are assigned to; contracts to the deal owner',
          cols: ['Rep', 'Leads', 'Contacted', 'Contact rate', 'Offers', 'Contracts', 'Lead to contract', 'Median speed to lead'],
          rows: rows.map((x) => [x.id ? repName(x.id) : 'Unassigned', num(x.leads), num(x.contacted), pctOf(x.contacted, x.leads), num(x.offers), num(x.contracts), pctOf(x.contracts, x.leads), x.speedN ? `${dur(x.speed)} (${x.speedN})` : '—']),
          empty: 'No teammates or leads in this range.' },
        funnel(newLeads, 'Acquisitions funnel'),
        { kind: 'note', half: true, title: 'Speed to lead', text: 'Time from a lead being created to the first outbound call, text or email logged against it, median per rep (count in brackets). Leads never contacted are left out rather than counted as zero.' + commsNote },
      ];
    }

    case 'Lead Sources':
    case 'Marketing': {
      const rows = sourceRows();
      const table = sourceTable(tab === 'Marketing' ? 'Source volume and conversion' : 'By source');
      const bars: Block = { kind: 'bars', rows: true, title: 'Leads by source', half: true, empty: 'No leads in this range.', items: rows.filter((x) => x.n).slice(0, 12).map((x) => ({ label: x.k, value: x.n, tip: `${x.k} · ${x.n} leads` })) };
      const volume: Block = { kind: 'bars', half: true, title: 'Lead volume', empty: 'No leads in this range.', items: series(r, newLeadRows.map((l) => ({ t: l.at, v: 1 })), (v) => num(v) + ' leads') };
      if (tab === 'Lead Sources') {
        const byName = new Map<string, ReportRaw['sellers']>();
        for (const s of newLeads) byName.set(s.source || 'Not recorded', [...(byName.get(s.source || 'Not recorded') ?? []), s]);
        const conv = rows.filter((x) => x.n >= 3);
        return [
          dia.leadflow(),
          { kind: 'kpis', items: [
            { k: 'New leads', v: num(newLeads.length), ...delta(newLeads.length, prevLeadCount) },
            { k: 'List rows imported', v: num(listRows), d: 'not leads until they answer', dColor: MUTED },
            { k: 'Best converting', v: conv.sort((a, b) => b.toContract / b.n - a.toContract / a.n)[0]?.k ?? '—' },
            { k: 'Top revenue source', v: rows.filter((x) => x.revenue > 0)[0]?.k ?? '—' },
          ] },
          table, bars,
          { kind: 'table', half: true, title: 'By source name', sub: 'the source field as typed or imported, top 30, with the group it counts under',
            cols: ['Source name', 'Group', 'Leads', 'Reached contract'],
            rows: [...byName.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 30).map(([k, ss]) => [k, sourceGroup(k === 'Not recorded' ? '' : k), num(ss.length), num(ss.filter(contractedS).length)]),
            empty: 'No leads in this range.' },
          { kind: 'note', title: 'Cost per lead', text: 'Not shown: CLOZR holds no spend per source yet. Once spend per source is imported (Google Ads, Facebook, pay-per-lead invoices, list costs), cost per lead, per contract and per closing go in the table above.' },
        ];
      }
      return [
        { kind: 'note', title: 'Connect ad spend', text: 'CLOZR has no ad-spend or campaign data yet, so cost per lead, cost per contract and ROAS are not shown rather than guessed. A campaign split needs spend per source and campaign imported (Google Ads, Facebook, direct-mail invoices) before those figures can exist.' },
        table, bars, volume,
      ];
    }

    case 'Calls': {
      const calls = raw.comms.filter((c) => isCall(c) && cur(c.occurred_at));
      const prevCalls = raw.comms.filter((c) => isCall(c) && prev(c.occurred_at));
      const connected = calls.filter((c) => Number(c.duration_s) > 0);
      const talk = sum(connected.map((c) => c.duration_s));
      const byRep = new Map<string | null, typeof calls>();
      const who = handlerOf(raw);
      const lines = lineBook(raw.lines);
      for (const c of calls) {
        const line = commLineName(c, lines);
        const id = who(c) ?? (line ? 'line:' + line : null);
        byRep.set(id, [...(byRep.get(id) ?? []), c]);
      }
      const statuses = new Map<string, number>();
      for (const c of calls) if (c.status) statuses.set(c.status, (statuses.get(c.status) ?? 0) + 1);
      return [
        { kind: 'kpis', items: [
          { k: 'Calls', v: num(calls.length), ...delta(calls.length, r.prevStart === null ? null : prevCalls.length) },
          { k: 'Outbound', v: num(calls.filter(isOut).length) },
          { k: 'Inbound', v: num(calls.filter((c) => !isOut(c)).length) },
          { k: 'Connected', v: num(connected.length), d: pctOf(connected.length, calls.length) + ' connect rate', dColor: MUTED },
          { k: 'Avg talk time', v: dur(avg(connected.map((c) => Number(c.duration_s)))) },
          { k: 'Total talk time', v: dur(talk) },
          { k: 'Voicemails', v: num(raw.comms.filter((c) => c.channel === 'voicemail' && cur(c.occurred_at)).length) },
        ] },
        { kind: 'bars', title: 'Calls over time', sub: 'all calls, inbound and outbound', empty: 'No calls in this range.', items: series(r, calls.map((c) => ({ t: ts(c.occurred_at), v: 1 })), (v) => num(v) + ' calls') },
        { kind: 'table', title: 'By rep', sub: callNote, half: true,
          cols: ['Rep', 'Calls', 'Outbound', 'Connected', 'Talk time', 'Avg call'],
          rows: [...byRep.entries()].sort((a, b) => b[1].length - a[1].length).map(([id, cs]) => {
            const con = cs.filter((c) => Number(c.duration_s) > 0);
            return [repName(id), num(cs.length), num(cs.filter(isOut).length), num(con.length), dur(sum(con.map((c) => c.duration_s))), dur(avg(con.map((c) => Number(c.duration_s))))];
          }),
          empty: 'No calls in this range.' },
        statuses.size
          ? { kind: 'table', half: true, title: 'Call outcomes', sub: 'the status the phone system reported', cols: ['Outcome', 'Calls', 'Share'], rows: [...statuses.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, num(n), pctOf(n, calls.length)]), empty: '' }
          : { kind: 'note', half: true, title: 'Call outcomes', text: 'No dispositions recorded: calls in this range carry no status from the phone system, so outcomes (no answer, busy, voicemail) cannot be split out. Connected is a call with any talk time.' },
      ];
    }

    case 'Team': {
      const rows = teamRows(raw, r);
      return [
        dia.org(),
        { kind: 'table', title: 'Leaderboard', sub: callNote + ' Acquisitions revenue goes to the deal\'s owner, else the seller\'s rep; dispo revenue to the dispo rep. A closing counts once in each column, so neither column double counts.',
          cols: ['#', 'Rep', 'Role', 'Calls', 'Talk time', 'Texts', 'Offers', 'Contracts', 'Closings', 'Acq. revenue', 'Dispo revenue'],
          rows: rows.map((x, i) => [String(i + 1), repName(x.id), raw.members.find((m) => m.id === x.id)?.role ?? '—', num(x.calls), dur(x.talk), num(x.texts), num(x.offers), num(x.contracts), num(x.closings), usd(x.acqRevenue), usd(x.dispoRevenue)]),
          empty: 'No teammates in this workspace yet.' },
      ];
    }

    case 'Offers': {
      const sent = outboundOffers.filter((o) => cur(o.sent_at));
      const acc = sent.filter((o) => accepted(o.status));
      const dealFor = (o: ReportRaw['offers'][number]) => (o.deal_id != null ? dealById.get(o.deal_id) : o.seller_id != null ? dealsBySeller.get(o.seller_id)?.[0] : undefined);
      const vsArv = sent.map((o) => { const d = dealFor(o); return d?.arv && o.amount ? o.amount / d.arv : null; }).filter((x): x is number => x !== null);
      const vsMao = sent.map((o) => { const d = dealFor(o); return d?.mao && o.amount ? o.amount / d.mao : null; }).filter((x): x is number => x !== null);
      const toAccept = acc.map((o) => (o.responded_at ? (ts(o.responded_at)! - ts(o.sent_at)!) / 1000 : null)).filter((x): x is number => x !== null && x >= 0);
      const buyerOffers = raw.offers.filter((o) => o.direction !== 'outbound' && cur(o.sent_at));
      return [
        { kind: 'kpis', items: [
          { k: 'Offers sent', v: num(sent.length), ...delta(sent.length, r.prevStart === null ? null : outboundOffers.filter((o) => prev(o.sent_at)).length) },
          { k: 'Accepted', v: num(acc.length), d: pctOf(acc.length, sent.length) + ' acceptance', dColor: MUTED },
          { k: 'Declined / expired', v: num(sent.filter((o) => declined(o.status)).length) },
          { k: 'Avg offer', v: usd(avg(sent.map((o) => Number(o.amount)).filter((n) => n > 0))) },
          { k: 'Avg % of ARV', v: vsArv.length ? Math.round(avg(vsArv)! * 100) + '%' : '—' },
          { k: 'Avg % of MAO', v: vsMao.length ? Math.round(avg(vsMao)! * 100) + '%' : '—' },
          { k: 'Median time to accept', v: toAccept.length ? dur(median(toAccept)) : '—' },
          { k: 'Buyer offers received', v: num(buyerOffers.length) },
        ] },
        { kind: 'table', title: 'Offers to sellers', sub: 'sent in range, newest first',
          cols: ['Property', 'Offer', 'ARV', '% ARV', 'MAO', 'Status', 'Sent', 'Response time'],
          rows: [...sent].sort((a, b) => ts(b.sent_at)! - ts(a.sent_at)!).map((o) => {
            const d = dealFor(o);
            const s = o.seller_id != null ? sellerById.get(o.seller_id) : undefined;
            return [s?.address || s?.name || addr(d), usd(o.amount), usd(d?.arv), d?.arv && o.amount ? Math.round((o.amount / d.arv) * 100) + '%' : '—', usd(d?.mao), o.status, shortDay(ts(o.sent_at)!), o.responded_at ? dur((ts(o.responded_at)! - ts(o.sent_at)!) / 1000) : '—'];
          }),
          empty: 'No offers were sent to sellers in this range. Offers made from a seller record are logged here.' },
      ];
    }

    case 'Contracts': {
      const touched = raw.contracts.filter((c) => cur(c.created_at) || cur(c.sent_at) || cur(c.completed_at));
      const signTimes = (cs: typeof raw.contracts) => cs.filter((c) => c.sent_at && c.completed_at && cur(c.completed_at)).map((c) => (ts(c.completed_at)! - ts(c.sent_at)!) / 1000).filter((x) => x >= 0);
      const row = (label: string, cs: typeof raw.contracts) => [label, num(cs.filter((c) => cur(c.created_at)).length), num(cs.filter((c) => cur(c.sent_at)).length), num(cs.filter((c) => cur(c.viewed_at)).length), num(cs.filter((c) => cur(c.completed_at)).length), num(cs.filter((c) => ['voided', 'declined', 'expired'].includes(c.status) && (cur(c.created_at) || cur(c.sent_at))).length), dur(median(signTimes(cs)))];
      const kinds = [...new Set(touched.map((c) => c.kind))];
      const signed = raw.contracts.filter((c) => cur(c.completed_at));
      return [
        { kind: 'kpis', items: [
          { k: 'Sent', v: num(raw.contracts.filter((c) => cur(c.sent_at)).length) },
          { k: 'Viewed', v: num(raw.contracts.filter((c) => cur(c.viewed_at)).length) },
          { k: 'Signed', v: num(signed.length), ...delta(signed.length, r.prevStart === null ? null : raw.contracts.filter((c) => prev(c.completed_at)).length) },
          { k: 'Voided / declined', v: num(touched.filter((c) => ['voided', 'declined', 'expired'].includes(c.status)).length) },
          { k: 'Median sent → signed', v: dur(median(signTimes(raw.contracts))) },
          { k: 'Out for signature', v: num(raw.contracts.filter((c) => ['sent', 'viewed'].includes(c.status)).length), d: 'right now', dColor: MUTED },
        ] },
        { kind: 'table', title: 'By engine', half: true, cols: ['Engine', 'Created', 'Sent', 'Viewed', 'Signed', 'Voided', 'Median to sign'],
          rows: ['clozr', 'pandadoc'].map((p) => row(p === 'clozr' ? 'CLOZR e-sign' : 'PandaDoc', raw.contracts.filter((c) => (c.provider ?? 'pandadoc') === p))),
          empty: '' },
        { kind: 'table', title: 'By document type', half: true, cols: ['Type', 'Created', 'Sent', 'Viewed', 'Signed', 'Voided', 'Median to sign'],
          rows: kinds.map((k) => row(k.toUpperCase(), raw.contracts.filter((c) => c.kind === k))),
          empty: 'No contracts were created, sent or signed in this range.' },
      ];
    }

    case 'Dispo': {
      const today = (opts.now ?? new Date()).getTime();
      const active = raw.deals.filter((d) => (ACTIVE_DEAL_STAGES as string[]).includes(d.stage));
      const dom = (d: ReportRaw['deals'][number]) => {
        const from = ts(d.marketing_started_on) ?? ts(d.contract_date) ?? ts(d.stage_entered_at);
        return from === null ? null : Math.max(0, Math.floor((today - from) / DAY));
      };
      const matches = raw.matches.filter((m) => cur(m.sent_at));
      const fees = closedDeals.map(fee).filter((n) => n > 0);
      return [
        dia.pipeline(false),
        { kind: 'kpis', items: [
          { k: 'Active inventory', v: num(active.length), d: 'right now', dColor: MUTED },
          { k: 'Median days on market', v: (() => { const m = median(active.map(dom).filter((x): x is number => x !== null)); return m === null ? '—' : Math.round(m) + 'd'; })() },
          { k: 'Deals sent to buyers', v: num(matches.length) },
          { k: 'Viewed', v: num(raw.matches.filter((m) => cur(m.viewed_at)).length), d: pctOf(matches.filter((m) => m.viewed_at).length, matches.length) + ' of sent', dColor: MUTED },
          { k: 'Replied', v: num(raw.matches.filter((m) => cur(m.replied_at)).length), d: pctOf(matches.filter((m) => m.replied_at).length, matches.length) + ' of sent', dColor: MUTED },
          { k: 'Assignment fees', v: usd(sum(fees)), ...delta(sum(fees), r.prevStart === null ? null : sum(prevClosed.map(fee)), true) },
          { k: 'Avg fee', v: usd(avg(fees)) },
        ] },
        { kind: 'bars', rows: true, half: true, title: 'Inventory by stage', empty: 'No active inventory.', items: (ACTIVE_DEAL_STAGES as string[]).map((s) => { const n = active.filter((d) => d.stage === s).length; return { label: s, value: n, tip: `${s} · ${n}` }; }) },
        { kind: 'table', half: true, title: 'Active inventory', sub: 'days on market from marketing start, else contract date',
          cols: ['Property', 'Stage', 'DOM', 'Sent', 'Viewed', 'Replied', 'Fee'],
          rows: active.sort((a, b) => (dom(b) ?? 0) - (dom(a) ?? 0)).map((d) => {
            const ms = raw.matches.filter((m) => m.deal_id === d.id);
            return [addr(d), d.stage, dom(d) === null ? '—' : dom(d) + 'd', num(ms.filter((m) => m.sent_at).length), num(ms.filter((m) => m.viewed_at).length), num(ms.filter((m) => m.replied_at).length), fee(d) ? usd(fee(d)) : '—'];
          }),
          empty: 'Nothing under contract and unsold.' },
      ];
    }

    case 'Buyers': {
      const newB = raw.buyers.filter((b) => cur(b.created_at));
      const rows = raw.buyers.map((b) => ({
        b, purchases: raw.deals.filter((d) => d.buyer_id === b.id && closedAt(d)).length,
        offers: raw.offers.filter((o) => o.buyer_id === b.id && o.direction !== 'outbound' && cur(o.sent_at)).length,
        sent: raw.matches.filter((m) => m.buyer_id === b.id && cur(m.sent_at)).length,
        replied: raw.matches.filter((m) => m.buyer_id === b.id && cur(m.replied_at)).length,
      })).filter((x) => x.purchases || x.offers || x.sent || x.replied)
        .sort((a, b) => b.purchases - a.purchases || b.offers - a.offers || b.replied - a.replied);
      return [
        { kind: 'kpis', items: [
          { k: 'Buyers', v: num(raw.buyers.filter((b) => !b.blacklisted_at).length), d: 'on file', dColor: MUTED },
          { k: 'New buyers', v: num(newB.length), ...delta(newB.length, r.prevStart === null ? null : raw.buyers.filter((b) => prev(b.created_at)).length) },
          { k: 'VIP', v: num(raw.buyers.filter((b) => b.vip).length) },
          { k: 'Active in range', v: num(raw.buyers.filter((b) => cur(b.last_activity_at)).length) },
          { k: 'Blacklisted', v: num(raw.buyers.filter((b) => b.blacklisted_at).length) },
        ] },
        { kind: 'table', title: 'Top buyers', sub: 'purchases are all-time closed deals; offers and deal sends are in range',
          cols: ['Buyer', 'VIP', 'Purchases', 'Offers', 'Deals sent', 'Replied', 'Last active'],
          rows: rows.slice(0, 25).map((x) => [x.b.name, x.b.vip ? 'VIP' : '', num(x.purchases), num(x.offers), num(x.sent), num(x.replied), x.b.last_activity_at ? shortDay(ts(x.b.last_activity_at)!) : '—']),
          empty: 'No buyer bought, offered, or was sent a deal in this range.' },
      ];
    }

    case 'Closings': {
      const today = (opts.now ?? new Date()).getTime();
      const days = closedDeals.map((d) => (d.contract_date ? (ts(closedAt(d))! - ts(d.contract_date)!) / DAY : null)).filter((x): x is number => x !== null && x >= 0);
      const txByDeal = new Map(raw.transactions.filter((t) => t.deal_id != null).map((t) => [t.deal_id!, t]));
      const upcoming = raw.deals.filter((d) => !closedAt(d) && d.stage !== 'Terminated')
        .map((d) => ({ d, when: ts(txByDeal.get(d.id)?.close_date ?? d.close_date) }))
        .filter((x): x is { d: ReportRaw['deals'][number]; when: number } => x.when !== null && x.when >= today - DAY)
        .sort((a, b) => a.when - b.when);
      const rev = sum(closedDeals.map(fee));
      return [
        dia.timeline(),
        { kind: 'kpis', items: [
          { k: 'Closed', v: num(closedDeals.length), ...delta(closedDeals.length, r.prevStart === null ? null : prevClosed.length) },
          { k: 'Revenue', v: usd(rev), ...delta(rev, r.prevStart === null ? null : sum(prevClosed.map(fee)), true) },
          { k: 'Avg fee', v: usd(avg(closedDeals.map(fee).filter((n) => n > 0))) },
          { k: 'Avg contract → close', v: days.length ? Math.round(avg(days)!) + ' days' : '—' },
          { k: 'Upcoming', v: num(upcoming.length), d: 'scheduled to close', dColor: MUTED },
        ] },
        { kind: 'bars', half: true, title: 'Revenue by close date', empty: 'Nothing closed in this range.', items: series(r, closedDeals.map((d) => ({ t: ts(closedAt(d)), v: fee(d) })), usd) },
        { kind: 'table', half: true, title: 'Upcoming closings', sub: 'close date from the TC file, else the deal',
          cols: ['Property', 'Stage', 'Close', 'In', 'Title', 'Fee'],
          rows: upcoming.slice(0, 30).map(({ d, when }) => [addr(d), d.stage, shortDay(when), Math.max(0, Math.ceil((when - today) / DAY)) + 'd', txByDeal.get(d.id)?.title_company ?? '—', fee(d) ? usd(fee(d)) : '—']),
          empty: 'No open deal has a close date set.' },
        { kind: 'table', title: 'Closed in range', cols: ['Property', 'Closed', 'Contract → close', 'Fee'],
          rows: closedDeals.map((d) => [addr(d), shortDay(ts(closedAt(d))!), d.contract_date ? Math.round((ts(closedAt(d))! - ts(d.contract_date)!) / DAY) + 'd' : '—', usd(fee(d))]),
          empty: 'Nothing closed in this range. A deal counts once it has a Closed On date or reaches Closed with a close date.' },
      ];
    }

    case 'Profitability': {
      if (!opts.admin) return [{ kind: 'note', title: 'Owner and admin only', text: 'Profitability shows commissions and bank records, which only an owner or admin can see.' }];
      const f = profitOf;
      const t = closedDeals.map(f);
      const tot = { fee: sum(t.map((x) => x.fee)), cogs: sum(t.map((x) => x.cogs)), net: sum(t.map((x) => x.net)), comm: sum(t.map((x) => x.comm)), final: sum(t.map((x) => x.final)) };
      const prevFinal = r.prevStart === null ? null : sum(prevClosed.map((d) => profitOf(d).final));
      const reps = new Map<string | null, { deals: number; comm: number; final: number }>();
      for (const d of closedDeals) {
        for (const id of new Set([acq(d), d.dispo_rep_id])) {
          const x = reps.get(id) ?? { deals: 0, comm: 0, final: 0 };
          reps.set(id, { deals: x.deals + 1, comm: x.comm + Number(d.team_commissions_paid ?? 0), final: x.final + profitOf(d).final });
        }
      }
      return [
        { kind: 'kpis', items: [
          { k: 'Wholesale fees', v: usd(tot.fee) }, { k: 'Total COGS', v: usd(tot.cogs) }, { k: 'Deal net profit', v: usd(tot.net) },
          { k: 'Commissions paid', v: usd(tot.comm) }, { k: 'Final profit', v: usd(tot.final), ...delta(tot.final, prevFinal, true) },
          { k: 'Margin', v: pctOf(tot.final, tot.fee) },
        ] },
        { kind: 'table', title: 'Per deal', sub: 'deals closed in range · profit is figured from the fee: fee − COGS = net, net − commissions = final',
          cols: ['Property', 'Closed', 'Wholesale fee', 'COGS', 'Deal net', 'Commissions', 'Final profit'],
          rows: [...closedDeals.map((d) => { const x = f(d); return [addr(d), shortDay(ts(closedAt(d))!), usd(x.fee), usd(x.cogs), usd(x.net), usd(x.comm), usd(x.final)]; }),
            ...(closedDeals.length > 1 ? [['Total', '', usd(tot.fee), usd(tot.cogs), usd(tot.net), usd(tot.comm), usd(tot.final)]] : [])],
          empty: 'Nothing closed in this range. Fill in sold price and COGS on the deal sheet and mark it closed to see profit here.' },
        { kind: 'table', half: true, title: 'Commissions by rep', sub: 'the deal sheet stores one team-commission total, not a per-rep split, so each rep on a deal (acquisitions owner, dispo rep) is shown the deal\'s full figure',
          cols: ['Rep', 'Deals', 'Commissions on those deals', 'Final profit on those deals'],
          rows: [...reps.entries()].sort((a, b) => b[1].comm - a[1].comm).map(([id, x]) => [repName(id), num(x.deals), usd(x.comm), usd(x.final)]),
          empty: 'No closed deals in this range.' },
        { kind: 'bank' },
      ];
    }

    default: { // Overview: the figures an owner runs a wholesale business by
      // Whole-team figures come from repMetrics, the same numbers Home's tiles read.
      const m = repMetrics(raw, r);
      const pm = r.prevStart === null ? null : repMetrics(raw, { start: r.prevStart, end: r.prevEnd! });
      // Offers, deal money and the full call history come with the second read; until
      // then (or if it failed) those tiles say so instead of showing zero.
      const held = raw.partial === 'loading' ? '…' : raw.partial === 'failed' ? '—' : null;
      const today = (opts.now ?? new Date()).getTime();
      const fees = closedDeals.map(fee).filter((n) => n > 0);
      const days = closedDeals.map((d) => (d.contract_date ? (ts(closedAt(d))! - ts(d.contract_date)!) / DAY : null)).filter((x): x is number => x !== null && x >= 0);
      const fo = falloutPct(terminated.length, closedDeals.length);
      const net = sum(closedDeals.map((d) => profitOf(d).final));
      const txByDeal = new Map(raw.transactions.filter((t) => t.deal_id != null).map((t) => [t.deal_id!, t]));
      const expected = (d: ReportRaw['deals'][number]) => ts(txByDeal.get(d.id)?.close_date ?? d.close_date);
      const items: Kpi[] = [
        held ? { k: 'Closed revenue', v: held } : { k: 'Closed revenue', v: usd(m.revenue), ...delta(m.revenue, pm && pm.revenue, true) },
        { k: 'Deals closed', v: num(m.closings), ...delta(m.closings, pm && pm.closings) },
        held ? { k: 'Avg fee', v: held } : { k: 'Avg fee', v: usd(avg(fees)) },
        ...(opts.admin ? [held ? { k: 'Net profit', v: held } : { k: 'Net profit', v: usd(net), ...delta(net, pm === null ? null : sum(prevClosed.map((d) => profitOf(d).final)), true) }] : []),
        { k: 'Contracts signed', v: num(m.contracts), ...delta(m.contracts, pm && pm.contracts) },
        { k: 'Fall-out rate', v: fo === null ? '—' : fo + '%', d: `${num(terminated.length)} fell out · ${num(closedDeals.length)} closed`, dColor: fo !== null && fo >= 50 ? RED : MUTED },
        { k: 'Contract to close', v: days.length ? Math.round(avg(days)!) + ' days' : '—', d: days.length ? `average of ${num(days.length)}` : undefined, dColor: MUTED },
        held ? { k: 'Pending fees', v: held } : { k: 'Pending fees', v: usd(sum(activeDeals.map(fee))), d: `${num(activeDeals.length)} under contract now`, dColor: MUTED },
        { k: 'New leads', v: num(m.newLeads), ...delta(m.newLeads, pm && pm.newLeads) },
        held ? { k: 'Offers sent', v: held } : { k: 'Offers sent', v: num(m.offers), ...delta(m.offers, pm && pm.offers) },
      ];

      // Pending closings by the month they are due, so next month's revenue is visible now.
      const monthKey = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
      const byMonth = new Map<string, { order: number; deals: number; fees: number; noFee: number }>();
      for (const d of activeDeals) {
        const t = expected(d);
        const [label, order] = t === null ? ['No close date', Infinity] : t < today - DAY ? ['Past due', -Infinity]
          : [new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), monthKey(t)];
        const x = byMonth.get(label) ?? { order, deals: 0, fees: 0, noFee: 0 };
        byMonth.set(label, { order, deals: x.deals + 1, fees: x.fees + fee(d), noFee: x.noFee + (fee(d) ? 0 : 1) });
      }
      const forecast: Block = { kind: 'table', half: true, title: 'Pending closings', sub: 'deals under contract now, by the month they are due to close (TC file, else the deal)',
        cols: ['Due', 'Deals', 'Fees', 'No fee yet'],
        rows: [...byMonth.entries()].sort((a, b) => a[1].order - b[1].order).map(([k, x]) => [k, num(x.deals), usd(x.fees), x.noFee ? num(x.noFee) : '—']),
        empty: 'Nothing under contract right now.' };

      const reasons = new Map<string, { n: number; fees: number }>();
      for (const d of terminated) {
        const k = d.termination_reason?.trim() || 'No reason recorded';
        const x = reasons.get(k) ?? { n: 0, fees: 0 };
        reasons.set(k, { n: x.n + 1, fees: x.fees + fee(d) });
      }
      const fellOut: Block = { kind: 'table', half: true, title: 'Why contracts fell out', sub: 'deals terminated in range, by the reason on the Deal Tracker',
        cols: ['Reason', 'Deals', 'Share', 'Fees lost'],
        rows: [...reasons.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, x]) => [k, num(x.n), pctOf(x.n, terminated.length), usd(x.fees)]),
        empty: 'No contract fell out in this range.' };

      const reps = teamRows(raw, r).filter((x) => x.calls || x.offers || x.contracts || x.closings);
      const scorecard: Block = { kind: 'table', title: 'Reps', sub: 'activity and results in range; daily minimums and grades are on the Team stoplight tab.' + commsNote,
        cols: ['Rep', 'Calls', 'Talk time', 'Offers', 'Contracts', 'Closings', 'Acq. revenue', 'Dispo revenue'],
        rows: reps.map((x) => [repName(x.id), num(x.calls), dur(x.talk), num(x.offers), num(x.contracts), num(x.closings), usd(x.acqRevenue), usd(x.dispoRevenue)]),
        empty: 'No rep activity in this range.' };

      // What is missing on the records, so the owner knows which figures read low and what to fill in.
      const noRep = raw.deals.filter((d) => closedAt(d) && !acq(d)).length;
      const noReason = raw.deals.filter((d) => d.stage === 'Terminated' && !d.termination_reason?.trim()).length;
      const noFee = activeDeals.filter((d) => !fee(d)).length;
      const noDate = activeDeals.filter((d) => expected(d) === null).length;
      const gaps = [
        noRep && `${num(noRep)} closed deal${noRep === 1 ? ' has' : 's have'} no acquisitions rep, so that revenue counts for no one on the rep tables`,
        noReason && `${num(noReason)} terminated deal${noReason === 1 ? ' has' : 's have'} no termination reason`,
        noFee && `${num(noFee)} of ${num(activeDeals.length)} deals under contract have no fee, so pending fees read low`,
        noDate && `${num(noDate)} of ${num(activeDeals.length)} deals under contract have no close date`,
      ].filter(Boolean);

      return [
        { kind: 'kpis', items },
        ...(commsShort ? [{ kind: 'note' as const, title: 'Activity covers part of this range', text: commsNote.trim() }] : []),
        { kind: 'bars', title: 'Closed revenue', sub: 'assignment fees by close date', empty: 'Nothing closed in this range.', items: series(r, closedDeals.map((d) => ({ t: ts(closedAt(d)), v: fee(d) })), usd) },
        forecast, fellOut,
        // The funnel diagram draws the same steps the Acquisitions tab's bar funnel shows.
        dia.funnel(),
        { kind: 'bars', half: true, title: 'New leads', sub: listRows ? `${num(listRows)} list rows imported in range are not counted until they answer` : undefined, empty: 'No leads came in during this range.', items: series(r, newLeadRows.map((l) => ({ t: l.at, v: 1 })), (v) => num(v) + ' leads') },
        sourceTable('Where the business came from'),
        scorecard,
        ...(gaps.length ? [{ kind: 'note' as const, title: 'Fill these in so the numbers are complete', text: gaps.join('. ') + '.' }] : []),
      ];
    }
  }
}

/** CSV rows for the Export button: every KPI and table on the tab. */
export function reportCsv(blocks: Block[]): string[][] {
  const out: string[][] = [];
  for (const b of blocks) {
    if (b.kind === 'kpis') for (const k of b.items) out.push([k.k, k.v, k.d ?? '']);
    if (b.kind === 'table' && b.rows.length) { out.push([], [b.title], b.cols, ...b.rows); }
    if (b.kind === 'bars' && b.items.length) { out.push([], [b.title], ...b.items.map((i) => [i.label, String(i.value)])); }
    if (b.kind === 'funnel') { out.push([], [b.title], ...b.steps.map((s) => [s.k, String(s.n), s.rate])); }
    if (b.kind === 'diagram') {
      const d = b.diagram;
      if (d.type === 'funnel') out.push([], [b.title], ...d.steps.map((s) => [s.k, String(s.n), s.rate]));
      if (d.type === 'pipeline') out.push([], [b.title], ['Stage', 'Deals', 'Median days in stage'], ...d.stages.map((s) => [s.k, String(s.n), s.days === null ? '' : String(s.days)]));
      if (d.type === 'leadflow') out.push([], [b.title], ['Source', 'Rep', 'Stage', 'Leads'], ...d.flows.map((f) => [d.sources[f.source], d.reps[f.rep], d.stages[f.stage], String(f.n)]));
      if (d.type === 'org') out.push([], [b.title], ['Rep', 'Role', 'Calls', 'Offers', 'Contracts', 'Closings'], ...d.people.map((p) => [p.name, p.role, String(p.calls), String(p.offers), String(p.contracts), String(p.closings)]));
      if (d.type === 'timeline') out.push([], [b.title], ['Property', 'Closed', 'Fee'], ...d.events.map((e) => [e.label, shortDay(e.t), String(e.fee)]));
    }
  }
  return out;
}

// ---- the sample graph ------------------------------------------------------

type SampleGraph = {
  team: Record<string, { id: string; name: string; role: string }>;
  people: { id: string; name: string; stage: string; assigned: string | null; source: string; property: { addr: string } }[];
  deals: { id: string; personId: string; contract: number | null; arv: number | null; assignment: number | null; owner: string | null }[];
  communications: { personId: string; channel: string; dir: string; ts: number; dur?: string }[];
  buyers: { id: string; name: string; status: string }[];
  offers: { id: string; buyerId: string; offer: number }[];
};

/**
 * /demo has no rows with timestamps, so the sample graph is laid out over the
 * last few weeks to give every tab something to draw. Only ever used when
 * there is no signed-in workspace.
 */
export function sampleReportRaw(G: SampleGraph, now = new Date()): ReportRaw {
  const t = now.getTime();
  const ago = (days: number) => new Date(t - days * DAY).toISOString();
  const n = (id: string) => Number(id.replace(/\D/g, '')) || 0;
  const roleOf = (role: string) => (/owner/i.test(role) ? 'owner' : /dispo/i.test(role) ? 'dispositions' : /transaction|tc/i.test(role) ? 'tc' : 'acquisitions');
  const sellers = G.people.map((p, i) => ({ id: n(p.id), name: p.name, created_at: ago(2 + ((i * 5) % 26)), source: p.source, assigned_to: p.assigned, stage: p.stage, address: p.property.addr }));
  const deals = G.deals.map((d, i) => {
    const s = G.people.find((p) => p.id === d.personId);
    const g = stageGroup(s?.stage ?? '');
    const closed = g === 'closed' || /closing/i.test(s?.stage ?? '');
    const fee = Number(d.assignment ?? 0);
    return {
      id: n(d.id), seller_id: n(d.personId), buyer_id: closed ? 1 : null, stage: closed ? 'Closed' : g === 'contract' ? 'Ready To Market' : 'Prospect',
      created_at: ago(20 - i), stage_entered_at: ago(6 + i), contract_date: g === 'contract' || closed ? ago(18 - i).slice(0, 10) : null,
      close_date: closed ? ago(2 + i).slice(0, 10) : g === 'contract' ? new Date(t + (7 + i * 3) * DAY).toISOString().slice(0, 10) : null,
      closed_on: closed ? ago(2 + i).slice(0, 10) : null, marketing_started_on: g === 'contract' ? ago(10 - (i % 8)).slice(0, 10) : null,
      owner_id: d.owner, dispo_rep_id: g === 'contract' || closed ? 'morgan' : null,
      offer_amount: d.contract, arv: d.arv, mao: d.arv ? Math.round(d.arv * 0.7) : null, assignment_fee: d.assignment, sold_price: null,
      wholesale_fee: fee, total_cogs: fee ? Math.round(fee * 0.12) : 0, deal_net_profit: fee ? Math.round(fee * 0.88) : 0,
      team_commissions_paid: fee ? Math.round(fee * 0.25) : 0, final_profit: fee ? Math.round(fee * 0.63) : 0,
    };
  });
  const secs = (d?: string) => { const m = /(\d+)m\s*(\d+)?s?/.exec(d ?? ''); return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : 0; };
  return {
    members: Object.values(G.team).map((m) => ({ id: m.id, name: m.name, role: roleOf(m.role) })),
    sellers, deals,
    comms: G.communications.map((c) => ({ seller_id: n(c.personId), channel: c.channel, direction: c.dir === 'in' ? 'inbound' : 'outbound', occurred_at: new Date(t - c.ts * 60_000).toISOString(), duration_s: secs(c.dur), status: null })),
    commsCapped: false,
    offers: [
      ...deals.filter((d) => d.offer_amount).map((d, i) => ({ id: 100 + i, deal_id: d.id, seller_id: d.seller_id, buyer_id: null, direction: 'outbound', amount: d.offer_amount, status: d.contract_date ? 'accepted' : 'pending', sent_at: ago(19 - i), responded_at: d.contract_date ? ago(18 - i) : null, created_by: d.owner_id })),
      ...G.offers.map((o, i) => ({ id: n(o.id), deal_id: deals[1]?.id ?? null, seller_id: null, buyer_id: n(o.buyerId), direction: 'inbound', amount: o.offer, status: 'pending', sent_at: ago(1 + i), responded_at: null, created_by: null })),
    ],
    contracts: deals.filter((d) => d.contract_date).map((d, i) => ({ id: d.id, deal_id: d.id, kind: 'psa', status: 'completed', provider: i % 2 ? 'pandadoc' : 'clozr', sent_at: ago(19 - i), viewed_at: ago(19 - i), completed_at: d.contract_date, created_at: ago(19 - i) })),
    matches: G.buyers.slice(0, 6).flatMap((b, i) => deals.filter((d) => d.stage === 'Ready To Market').map((d) => ({ deal_id: d.id, buyer_id: n(b.id), status: 'sent', sent_at: ago(5 + i), viewed_at: i % 2 ? null : ago(4 + i), replied_at: i % 3 ? null : ago(3 + i) }))),
    buyers: G.buyers.map((b, i) => ({ id: n(b.id), name: b.name, vip: b.status === 'VIP', created_at: ago(3 + i * 9), last_activity_at: ago(i), blacklisted_at: null })),
    transactions: [],
  };
}
