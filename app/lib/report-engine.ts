// The custom-report engine: a widget is a spec (source, aggregation, group-by,
// date field, filters), and this turns a spec plus a date range into numbers.
//
// Every prebuilt widget in lib/report-catalog.ts is just a saved spec; a custom
// metric is two to four specs combined by a formula. The rows come from
// lib/reporting.ts's ReportRaw (the browser) or from supabase/functions/
// report-mail (the scheduled email) — the same code runs in both, so this file
// imports nothing and is copied verbatim into the function's _shared folder;
// tools/report-engine.test.ts fails when the two copies drift.

export type Kind = 'date' | 'text' | 'tags' | 'number' | 'money' | 'duration' | 'user' | 'bool' | 'pct';
export type Field = { key: string; label: string; kind: Kind };
export type Source = 'sellers' | 'deals' | 'calls' | 'sms' | 'emails' | 'appointments' | 'tasks' | 'offers' | 'contracts' | 'buyers' | 'blasts';
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type Agg = 'count' | 'distinct' | 'sum' | 'avg' | 'min' | 'max';
export type Op = 'is' | 'is_not' | 'contains' | 'gt' | 'lt' | 'set' | 'unset';
export type Cond = { field: string; op: Op; value: string };
export type Chart = 'number' | 'donut' | 'line' | 'column' | 'bar' | 'table' | 'funnel';
export type Comparison = 'report' | 'none' | 'previous' | 'year';
export type Polarity = 'up' | 'down';
export type Format = 'int' | 'float' | 'usd' | 'pct' | 'dur';

export type Spec = {
  source: Source;
  agg: Agg;
  /** The numeric field sum/avg/min/max/distinct read; ignored by count. */
  field?: string | null;
  /** A field to split the value by (donut, bars); null for one number. */
  groupBy?: string | null;
  /** The date the range filters on; null means "till date" (no date filter). */
  dateField: string | null;
  /** OR of AND groups. An empty list matches every row. */
  filters: Cond[][];
  /** The widget's own date range instead of the report's; null follows the report. */
  datePreset?: string | null;
  comparison?: Comparison;
  polarity?: Polarity;
  /** Table widgets: the fields shown, in order. */
  columns?: string[];
  /** Funnel widgets: each step is its own filter set over the same source. */
  funnel?: { label: string; filters: Cond[][] }[];
  /** Groups / rows to show before folding the rest into "Other" (groups) or cutting (rows). */
  limit?: number;
};

export type Range = { start: number; end: number; prevStart: number | null; prevEnd: number | null };

export type Result = {
  value: number | null;
  prev: number | null;
  format: Format;
  groups: { label: string; value: number }[] | null;
  series: { label: string; value: number }[] | null;
  table: { cols: string[]; rows: string[][] } | null;
  funnel: { label: string; value: number }[] | null;
  /** Rows the value was computed from (after filters and the date range). */
  n: number;
};

/** What the engine reads. lib/reporting.ts's ReportRaw is a superset of this. */
export type EngineRaw = {
  members: { id: string; name: string; role: string }[];
  sellers: { id: number; name: string; created_at: string; source: string | null; assigned_to: string | null; stage: string; address: string | null; email?: string | null; phone?: string | null; tags?: string[] | null; stage_entered_at?: string | null }[];
  deals: {
    id: number; seller_id: number | null; buyer_id: number | null; stage: string; created_at: string; stage_entered_at: string | null;
    contract_date: string | null; close_date: string | null; closed_on: string | null; marketing_started_on: string | null;
    owner_id: string | null; dispo_rep_id: string | null;
    offer_amount: number | null; arv: number | null; mao: number | null; assignment_fee: number | null; sold_price: number | null; dispo_fee?: number | null;
    wholesale_fee: number | null; total_cogs: number | null; team_commissions_paid: number | null; deal_net_profit: number | null; final_profit: number | null;
    lead_source?: string | null; market?: string | null; marketed_price?: number | null;
  }[];
  comms: { seller_id: number | null; buyer_id?: number | null; rep_id?: string | null; from_phone?: string | null; to_phone?: string | null; channel: string; direction: string | null; occurred_at: string; duration_s: number | null; status: string | null }[];
  /** The team lines (rep_phone_numbers): a message with no rep is its line owner's. */
  lines?: { phone10: string; user_id: string | null; label: string }[];
  offers: { id: number; deal_id: number | null; seller_id: number | null; buyer_id: number | null; direction: string; amount: number | null; status: string; sent_at: string; responded_at: string | null; created_by: string | null }[];
  contracts: { id: number; deal_id: number | null; kind: string; status: string; provider: string | null; sent_at: string | null; viewed_at: string | null; completed_at: string | null; created_at: string }[];
  matches: { deal_id: number; buyer_id: number; status: string; sent_at: string | null; viewed_at: string | null; replied_at: string | null }[];
  buyers: { id: number; name: string; vip: boolean; created_at: string; last_activity_at: string | null; blacklisted_at: string | null }[];
  appointments?: { id: number; seller_id: number | null; buyer_id: number | null; title: string; kind: string; starts_at: string; assigned_to?: string | null; source?: string | null; created_at?: string | null; deleted_at?: string | null }[];
  tasks?: { id: number; seller_id: number | null; title: string; task_type: string; priority: string; due_at: string | null; assigned_to: string | null; done: boolean; completed_at?: string | null; created_at?: string | null }[];
};

const DAY = 86_400_000;

// ---- fields ------------------------------------------------------------------

const f = (key: string, label: string, kind: Kind): Field => ({ key, label, kind });
const COMM_FIELDS: Field[] = [
  f('occurred_at', 'Occurred', 'date'), f('direction', 'Direction', 'text'), f('status', 'Status', 'text'),
  f('rep', 'Rep (assigned on the record)', 'user'), f('seller', 'Seller', 'text'), f('buyer', 'Buyer', 'text'), f('record', 'Record type', 'text'),
];

export const FIELDS: Record<Source, Field[]> = {
  sellers: [
    f('created_at', 'Created', 'date'), f('stage_entered_at', 'Stage entered', 'date'), f('name', 'Name', 'text'), f('stage', 'Stage', 'text'),
    f('stage_group', 'Stage group', 'text'), f('source', 'Source', 'text'), f('assigned', 'Assigned to', 'user'), f('tags', 'Tags', 'tags'),
    f('has_email', 'Has email', 'bool'), f('has_phone', 'Has phone', 'bool'), f('address', 'Property', 'text'),
  ],
  deals: [
    f('created_at', 'Created', 'date'), f('stage_entered_at', 'Stage entered', 'date'), f('contract_date', 'Contract date', 'date'), f('close_date', 'Close date', 'date'),
    f('closed_on', 'Closed on', 'date'), f('marketing_started_on', 'Marketing started', 'date'),
    f('stage', 'Stage', 'text'), f('status', 'Status', 'text'), f('lead_source', 'Lead source', 'text'), f('market', 'Market', 'text'),
    f('owner', 'Acquisitions rep', 'user'), f('dispo_rep', 'Dispo rep', 'user'), f('seller', 'Seller', 'text'), f('buyer', 'Buyer', 'text'),
    f('offer_amount', 'Contract price', 'money'), f('arv', 'ARV', 'money'), f('mao', 'MAO', 'money'), f('marketed_price', 'Marketed price', 'money'),
    f('fee', 'Fee', 'money'), f('sold_price', 'Sold price', 'money'), f('spread', 'Spread (sold − contract)', 'money'), f('net_profit', 'Net profit', 'money'), f('final_profit', 'Final profit', 'money'),
    f('days_to_assign', 'Days to assign', 'number'), f('days_to_close', 'Days to close', 'number'),
  ],
  calls: [...COMM_FIELDS, f('duration', 'Duration', 'duration'), f('answered', 'Answered', 'bool'), f('first_time', 'First call with this seller', 'bool')],
  sms: [...COMM_FIELDS],
  emails: [...COMM_FIELDS],
  appointments: [
    f('starts_at', 'Starts', 'date'), f('created_at', 'Booked', 'date'), f('title', 'Title', 'text'), f('kind', 'Kind', 'text'), f('source', 'Source', 'text'),
    f('assigned', 'Assigned to', 'user'), f('seller', 'Seller', 'text'), f('cancelled', 'Cancelled', 'bool'), f('upcoming', 'Upcoming', 'bool'),
  ],
  tasks: [
    f('created_at', 'Created', 'date'), f('due_at', 'Due', 'date'), f('completed_at', 'Completed', 'date'), f('title', 'Title', 'text'), f('type', 'Type', 'text'),
    f('priority', 'Priority', 'text'), f('assigned', 'Assigned to', 'user'), f('seller', 'Seller', 'text'), f('done', 'Done', 'bool'), f('overdue', 'Overdue', 'bool'),
  ],
  offers: [
    f('sent_at', 'Sent', 'date'), f('responded_at', 'Responded', 'date'), f('direction', 'Direction', 'text'), f('status', 'Status', 'text'), f('outcome', 'Outcome', 'text'),
    f('amount', 'Amount', 'money'), f('rep', 'Sent by', 'user'), f('seller', 'Seller', 'text'), f('buyer', 'Buyer', 'text'), f('deal', 'Deal', 'text'), f('vs_asking', 'Offer vs contract price', 'pct'),
  ],
  contracts: [
    f('created_at', 'Created', 'date'), f('sent_at', 'Sent', 'date'), f('completed_at', 'Signed', 'date'), f('kind', 'Kind', 'text'), f('status', 'Status', 'text'),
    f('provider', 'Provider', 'text'), f('hours_to_sign', 'Hours to sign', 'number'),
  ],
  buyers: [
    f('created_at', 'Added', 'date'), f('last_activity_at', 'Last activity', 'date'), f('name', 'Name', 'text'), f('vip', 'VIP', 'bool'),
    f('blacklisted', 'Blacklisted', 'bool'), f('active', 'Active in 90 days', 'bool'),
  ],
  blasts: [
    f('sent_at', 'Sent', 'date'), f('viewed_at', 'Viewed', 'date'), f('replied_at', 'Replied', 'date'), f('status', 'Status', 'text'),
    f('deal', 'Deal', 'text'), f('buyer', 'Buyer', 'text'), f('viewed', 'Viewed', 'bool'), f('replied', 'Replied', 'bool'),
  ],
};

export const SOURCE_LABEL: Record<Source, string> = {
  sellers: 'Sellers', deals: 'Deals', calls: 'Calls', sms: 'Texts', emails: 'Emails', appointments: 'Appointments',
  tasks: 'Tasks', offers: 'Offers', contracts: 'Contracts', buyers: 'Buyers', blasts: 'Dispo blasts',
};

export function fieldOf(source: Source, key: string | null | undefined): Field | null {
  return FIELDS[source].find((x) => x.key === key) ?? null;
}

// ---- normalising the rows ------------------------------------------------------

const ts = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
  return Number.isNaN(n) ? null : n;
};

/** A seller stage's group, including older vocabulary. */
export function stageGroupOf(stage: string): string {
  const s = stage || '';
  if (/closed|sold/i.test(s)) return 'closed';
  if (/refund/i.test(s)) return 'refund';
  if (/dead|lost|declin|not interested|do not/i.test(s)) return 'dead';
  if (/contract|dispo|assigned|closing|marketing|under/i.test(s)) return 'contract';
  if (/offer|negotiat|counter/i.test(s)) return 'offer';
  if (/appointment|appt/i.test(s)) return 'appointment';
  if (/new lead|^new$|incoming/i.test(s)) return 'lead';
  return 'working';
}

/** open · won · lost · abandoned, from the deal's stage. */
export function dealStatusOf(stage: string): string {
  const s = stage || '';
  if (/closed|sold/i.test(s)) return 'won';
  if (/dead|lost|cancel|terminat|fell/i.test(s)) return 'lost';
  if (/abandon|refund|archiv/i.test(s)) return 'abandoned';
  return 'open';
}

const fee = (d: EngineRaw['deals'][number]) => (d.dispo_fee != null ? Number(d.dispo_fee) : Number(d.wholesale_fee) > 0 ? Number(d.wholesale_fee) : Number(d.assignment_fee ?? 0));
const days = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((b - a) / DAY));

export function normalize(raw: EngineRaw, now = Date.now()): Record<Source, Row[]> {
  const sellerName = new Map(raw.sellers.map((s) => [s.id, s.name]));
  const sellerRep = new Map(raw.sellers.map((s) => [s.id, s.assigned_to]));
  const team = new Set(raw.members.map((m) => m.id));
  const lineOwner = new Map((raw.lines ?? []).map((l) => [l.phone10, l.user_id] as const));
  const lineRep = (c: EngineRaw['comms'][number]) => {
    const owner = lineOwner.get(String((c.direction === 'inbound' ? c.to_phone : c.from_phone) ?? '').replace(/\D/g, '').slice(-10));
    return owner && team.has(owner) ? owner : null;
  };
  const buyerName = new Map(raw.buyers.map((b) => [b.id, b.name]));
  const dealName = new Map(raw.deals.map((d) => [d.id, (d.seller_id !== null && sellerName.get(d.seller_id)) || 'Deal ' + d.id]));
  const dealPrice = new Map(raw.deals.map((d) => [d.id, d.offer_amount]));

  const sellers: Row[] = raw.sellers.map((s) => ({
    created_at: ts(s.created_at), stage_entered_at: ts(s.stage_entered_at), name: s.name, stage: s.stage, stage_group: stageGroupOf(s.stage),
    source: s.source || 'Unknown', assigned: s.assigned_to, tags: (s.tags ?? []).join('|'),
    has_email: !!(s.email && s.email.trim()), has_phone: !!(s.phone && s.phone.trim()), address: s.address,
  }));

  const deals: Row[] = raw.deals.map((d) => {
    const contract = ts(d.contract_date), closed = ts(d.closed_on) ?? (dealStatusOf(d.stage) === 'won' ? ts(d.close_date) : null);
    const marketed = ts(d.marketing_started_on);
    return {
      created_at: ts(d.created_at), stage_entered_at: ts(d.stage_entered_at), contract_date: contract, close_date: ts(d.close_date), closed_on: closed,
      marketing_started_on: marketed, stage: d.stage, status: dealStatusOf(d.stage), lead_source: d.lead_source ?? null, market: d.market ?? null,
      owner: d.owner_id, dispo_rep: d.dispo_rep_id, seller: d.seller_id !== null ? sellerName.get(d.seller_id) ?? null : null,
      buyer: d.buyer_id !== null ? buyerName.get(d.buyer_id) ?? null : null,
      offer_amount: d.offer_amount, arv: d.arv, mao: d.mao, marketed_price: d.marketed_price ?? null, fee: fee(d) || null, sold_price: d.sold_price,
      spread: d.sold_price != null && d.offer_amount != null ? Number(d.sold_price) - Number(d.offer_amount) : null,
      net_profit: d.deal_net_profit, final_profit: d.final_profit,
      days_to_assign: closed !== null ? days(marketed ?? contract, closed) : null, days_to_close: closed !== null ? days(contract, closed) : null,
    };
  });

  const firstCall = new Map<number, number>();
  for (const c of raw.comms) {
    if (c.channel !== 'call' || c.seller_id === null) continue;
    const t = ts(c.occurred_at);
    if (t !== null && (firstCall.get(c.seller_id) ?? Infinity) > t) firstCall.set(c.seller_id, t);
  }
  const comm = (c: EngineRaw['comms'][number]): Row => ({
    occurred_at: ts(c.occurred_at), direction: c.direction ?? 'outbound', status: c.status ?? null,
    // Whoever handled it (lib/comm-rep's order): the rep on the row, the owner
    // of the team line it used, else the seller's rep.
    rep: (c.rep_id && team.has(c.rep_id) ? c.rep_id : null) ?? lineRep(c) ?? (c.seller_id !== null ? sellerRep.get(c.seller_id) ?? null : null),
    seller: c.seller_id !== null ? sellerName.get(c.seller_id) ?? null : null,
    buyer: c.buyer_id != null ? buyerName.get(c.buyer_id) ?? null : null,
    record: c.seller_id !== null ? 'Seller' : c.buyer_id != null ? 'Buyer' : 'Unfiled',
  });
  const calls: Row[] = raw.comms.filter((c) => c.channel === 'call').map((c) => ({
    ...comm(c), duration: c.duration_s, answered: (c.duration_s ?? 0) > 0 || /answered|completed/i.test(c.status ?? ''),
    first_time: c.seller_id !== null && firstCall.get(c.seller_id) === ts(c.occurred_at),
  }));
  const sms: Row[] = raw.comms.filter((c) => c.channel === 'sms').map(comm);
  const emails: Row[] = raw.comms.filter((c) => c.channel === 'email').map(comm);

  const appointments: Row[] = (raw.appointments ?? []).map((a) => {
    const starts = ts(a.starts_at);
    return {
      starts_at: starts, created_at: ts(a.created_at) ?? starts, title: a.title, kind: a.kind || 'Appointment', source: a.source ?? 'CLOZR',
      assigned: a.assigned_to ?? null, seller: a.seller_id !== null ? sellerName.get(a.seller_id) ?? null : null,
      cancelled: !!a.deleted_at, upcoming: starts !== null && starts >= now && !a.deleted_at,
    };
  });

  const tasks: Row[] = (raw.tasks ?? []).map((t) => {
    const due = ts(t.due_at);
    return {
      created_at: ts(t.created_at) ?? due, due_at: due, completed_at: ts(t.completed_at), title: t.title, type: t.task_type || 'task', priority: t.priority || 'Normal',
      assigned: t.assigned_to, seller: t.seller_id !== null ? sellerName.get(t.seller_id) ?? null : null, done: !!t.done,
      overdue: !t.done && due !== null && due < now,
    };
  });

  const offers: Row[] = raw.offers.map((o) => {
    const price = o.deal_id !== null ? dealPrice.get(o.deal_id) ?? null : null;
    return {
      sent_at: ts(o.sent_at), responded_at: ts(o.responded_at), direction: o.direction, status: o.status,
      outcome: /accept|signed|won/i.test(o.status) ? 'accepted' : /declin|reject|expired|lost|dead|counter/i.test(o.status) ? 'declined' : 'pending',
      amount: o.amount, rep: o.created_by, seller: o.seller_id !== null ? sellerName.get(o.seller_id) ?? null : null,
      buyer: o.buyer_id !== null ? buyerName.get(o.buyer_id) ?? null : null,
      deal: o.deal_id !== null ? dealName.get(o.deal_id) ?? null : null,
      vs_asking: o.amount != null && price ? Math.round((Number(o.amount) / Number(price)) * 100) : null,
    };
  });

  const contracts: Row[] = raw.contracts.map((c) => ({
    created_at: ts(c.created_at), sent_at: ts(c.sent_at), completed_at: ts(c.completed_at), kind: c.kind, status: c.status, provider: c.provider ?? 'clozr',
    hours_to_sign: ts(c.sent_at) !== null && ts(c.completed_at) !== null ? Math.round(((ts(c.completed_at) as number) - (ts(c.sent_at) as number)) / 3_600_000) : null,
  }));

  const buyers: Row[] = raw.buyers.map((b) => ({
    created_at: ts(b.created_at), last_activity_at: ts(b.last_activity_at), name: b.name, vip: !!b.vip, blacklisted: !!b.blacklisted_at,
    active: ts(b.last_activity_at) !== null && (ts(b.last_activity_at) as number) >= now - 90 * DAY,
  }));

  const blasts: Row[] = raw.matches.filter((m) => m.sent_at).map((m) => ({
    sent_at: ts(m.sent_at), viewed_at: ts(m.viewed_at), replied_at: ts(m.replied_at), status: m.status,
    deal: dealName.get(m.deal_id) ?? 'Deal ' + m.deal_id, buyer: buyerName.get(m.buyer_id) ?? 'Buyer ' + m.buyer_id,
    viewed: !!m.viewed_at, replied: !!m.replied_at,
  }));

  return { sellers, deals, calls, sms, emails, appointments, tasks, offers, contracts, buyers, blasts };
}

// ---- date ranges ----------------------------------------------------------------

export const DATE_PRESETS = [
  'Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'This week', 'Last week', 'This month', 'Last month',
  'This quarter', 'Last quarter', 'This year', 'Last year', 'Next 7 days', 'All time', 'Custom',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

/** The window a preset means right now; Custom takes from/to as YYYY-MM-DD (inclusive). */
export function presetRange(preset: string, custom?: { from: string; to: string } | null, now = new Date()): { start: number; end: number } {
  const t = now.getTime();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const midnight = new Date(y, mo, d).getTime();
  const q = Math.floor(mo / 3) * 3;
  const endOfDay = (x: number) => x + DAY - 1;
  switch (preset) {
    case 'Today': return { start: midnight, end: t };
    case 'Yesterday': return { start: midnight - DAY, end: midnight - 1 };
    case 'Last 7 days': return { start: midnight - 6 * DAY, end: t };
    case 'Last 30 days': return { start: midnight - 29 * DAY, end: t };
    case 'Last 90 days': return { start: midnight - 89 * DAY, end: t };
    case 'This week': return { start: midnight - now.getDay() * DAY, end: t };
    case 'Last week': return { start: midnight - (now.getDay() + 7) * DAY, end: midnight - now.getDay() * DAY - 1 };
    case 'This month': return { start: new Date(y, mo, 1).getTime(), end: t };
    case 'Last month': return { start: new Date(y, mo - 1, 1).getTime(), end: new Date(y, mo, 1).getTime() - 1 };
    case 'This quarter': return { start: new Date(y, q, 1).getTime(), end: t };
    case 'Last quarter': return { start: new Date(y, q - 3, 1).getTime(), end: new Date(y, q, 1).getTime() - 1 };
    case 'This year': return { start: new Date(y, 0, 1).getTime(), end: t };
    case 'Last year': return { start: new Date(y - 1, 0, 1).getTime(), end: new Date(y, 0, 1).getTime() - 1 };
    case 'Next 7 days': return { start: t, end: midnight + 8 * DAY - 1 };
    case 'Custom': {
      const a = ts(custom?.from ?? '') ?? midnight - 29 * DAY;
      const b = ts(custom?.to ?? '');
      return { start: a, end: b === null ? t : Math.min(endOfDay(b), Math.max(t, endOfDay(b))) };
    }
    default: return { start: -Infinity, end: t };
  }
}

/** Adds the comparison window: the equal-length period before, or the same dates a year earlier. */
export function withComparison(win: { start: number; end: number }, mode: Comparison): Range {
  if (mode === 'none' || !Number.isFinite(win.start)) return { ...win, prevStart: null, prevEnd: null };
  if (mode === 'year') {
    const back = (x: number) => { const d = new Date(x); d.setFullYear(d.getFullYear() - 1); return d.getTime(); };
    return { ...win, prevStart: back(win.start), prevEnd: back(win.end) };
  }
  const len = win.end - win.start;
  return { ...win, prevStart: win.start - len - 1, prevEnd: win.start - 1 };
}

export function rangeFor(preset: string, comparison: Comparison, custom?: { from: string; to: string } | null, now = new Date()): Range {
  return withComparison(presetRange(preset, custom, now), comparison === 'report' ? 'previous' : comparison);
}

/** "Sep 1 – Sep 21, 2026" for the page header. */
export function rangeLabel(r: { start: number; end: number }): string {
  if (!Number.isFinite(r.start)) return 'All time';
  const a = new Date(r.start), b = new Date(r.end);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${a.toLocaleDateString('en-US', sameYear ? opts : { ...opts, year: 'numeric' })} – ${b.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`;
}

// ---- computing --------------------------------------------------------------------

export type Names = Map<string, string>;

function cellText(v: Cell, kind: Kind, names: Names): string {
  if (v === null || v === undefined || v === '') return '—';
  if (kind === 'user') return names.get(String(v)) ?? String(v);
  if (kind === 'bool') return v ? 'Yes' : 'No';
  if (kind === 'date') return new Date(Number(v)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (kind === 'money') return fmtValue(Number(v), 'usd');
  if (kind === 'duration') return fmtValue(Number(v), 'dur');
  if (kind === 'tags') return String(v).split('|').filter(Boolean).join(', ') || '—';
  if (kind === 'pct') return fmtValue(Number(v), 'pct');
  return String(v);
}

function condTrue(row: Row, c: Cond, source: Source, names: Names, me: string | null): boolean {
  const field = fieldOf(source, c.field);
  const v = row[c.field];
  const want = (c.value ?? '').trim();
  const wantMe = field?.kind === 'user' && want === '@me' ? me ?? '' : want;
  switch (c.op) {
    case 'set': return v !== null && v !== undefined && v !== '' && v !== false;
    case 'unset': return v === null || v === undefined || v === '' || v === false;
    case 'gt': case 'lt': {
      const n = typeof v === 'number' ? v : v === null ? null : Number(v);
      if (n === null || Number.isNaN(n)) return false;
      const w = field?.kind === 'date' ? ts(want) ?? Number(want) : Number(want);
      return c.op === 'gt' ? n > w : n < w;
    }
    case 'contains': {
      const hay = (field?.kind === 'user' ? names.get(String(v)) ?? '' : v === null ? '' : String(v)).toLowerCase();
      return hay.includes(wantMe.toLowerCase());
    }
    case 'is': case 'is_not': {
      let hit: boolean;
      if (field?.kind === 'bool') hit = (v === true) === /^(true|yes|1)$/i.test(wantMe);
      else if (field?.kind === 'tags') hit = String(v ?? '').split('|').some((x) => x.toLowerCase() === wantMe.toLowerCase());
      else if (field?.kind === 'user') hit = String(v ?? '') === wantMe || (names.get(String(v)) ?? '').toLowerCase() === wantMe.toLowerCase();
      else hit = String(v ?? '').toLowerCase() === wantMe.toLowerCase();
      return c.op === 'is' ? hit : !hit;
    }
    default: return true;
  }
}

function matches(row: Row, filters: Cond[][], source: Source, names: Names, me: string | null): boolean {
  if (!filters.length) return true;
  return filters.some((group) => group.every((c) => condTrue(row, c, source, names, me)));
}

function inWindow(row: Row, dateField: string | null, a: number, b: number): boolean {
  if (!dateField) return true;
  const v = row[dateField];
  return typeof v === 'number' && v >= a && v <= b;
}

function aggregate(rows: Row[], agg: Agg, field: string | null | undefined): number | null {
  if (agg === 'count') return rows.length;
  const key = field ?? '';
  if (agg === 'distinct') return new Set(rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined && v !== '')).size;
  const xs = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!xs.length) return agg === 'sum' ? 0 : null;
  if (agg === 'sum') return xs.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return xs.reduce((a, b) => a + b, 0) / xs.length;
  if (agg === 'min') return Math.min(...xs);
  return Math.max(...xs);
}

export function formatOf(spec: Spec): Format {
  if (spec.agg === 'count' || spec.agg === 'distinct') return 'int';
  const kind = fieldOf(spec.source, spec.field)?.kind;
  if (kind === 'money') return 'usd';
  if (kind === 'duration') return 'dur';
  if (kind === 'pct') return 'pct';
  return spec.agg === 'avg' ? 'float' : 'int';
}

/** Buckets over the window: hours for a day, days to a month, weeks to ~4 months, then months. */
function bucketSeries(rows: Row[], dateField: string, win: { start: number; end: number }, agg: Agg, field: string | null | undefined) {
  const known = rows.map((r) => r[dateField]).filter((t): t is number => typeof t === 'number');
  const start = Number.isFinite(win.start) ? win.start : known.length ? Math.min(...known) : win.end - 30 * DAY;
  const span = win.end - start;
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
    return step === 'hour' ? k + 3_600_000 : step === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      : step === 'week' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime() : new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  };
  const buckets = new Map<number, Row[]>();
  for (let k = keyOf(start), i = 0; k <= win.end && i < 120; k = next(k), i++) buckets.set(k, []);
  for (const r of rows) {
    const t = r[dateField];
    if (typeof t !== 'number') continue;
    const k = keyOf(t);
    buckets.get(k)?.push(r);
  }
  return [...buckets.entries()].map(([k, rs]) => {
    const d = new Date(k);
    const label = step === 'hour' ? d.toLocaleTimeString('en-US', { hour: 'numeric' }) : step === 'month' ? d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { label, value: aggregate(rs, agg, field) ?? 0 };
  });
}

export type ComputeOpts = { now?: number; me?: string | null; chart?: Chart };

/**
 * One widget's numbers for a range. `range` is the report's; a spec with its own
 * datePreset uses that instead. The chart decides which extra shape is filled in:
 * groups for donut/bar/column with a groupBy, a series for line/column without
 * one, rows for a table, steps for a funnel.
 */
export function compute(spec: Spec, range: Range, data: Record<Source, Row[]>, raw: EngineRaw, opts: ComputeOpts = {}): Result {
  const now = opts.now ?? Date.now();
  const names: Names = new Map(raw.members.map((m) => [m.id, m.name]));
  const r = spec.datePreset ? withComparison(presetRange(spec.datePreset, null, new Date(now)), spec.comparison && spec.comparison !== 'report' ? spec.comparison : 'previous')
    : spec.comparison && spec.comparison !== 'report' ? withComparison(range, spec.comparison) : range;
  const all = data[spec.source] ?? [];
  const filtered = all.filter((row) => matches(row, spec.filters ?? [], spec.source, names, opts.me ?? null));
  const rows = filtered.filter((row) => inWindow(row, spec.dateField, r.start, r.end));
  const format = formatOf(spec);
  const chart = opts.chart ?? 'number';
  const out: Result = { value: aggregate(rows, spec.agg, spec.field), prev: null, format, groups: null, series: null, table: null, funnel: null, n: rows.length };

  if (r.prevStart !== null && r.prevEnd !== null && spec.dateField) {
    const prevRows = filtered.filter((row) => inWindow(row, spec.dateField, r.prevStart as number, r.prevEnd as number));
    out.prev = aggregate(prevRows, spec.agg, spec.field);
  }

  if (spec.groupBy && chart !== 'table' && chart !== 'funnel') {
    const field = fieldOf(spec.source, spec.groupBy);
    const byKey = new Map<string, Row[]>();
    for (const row of rows) {
      const v = row[spec.groupBy];
      const keys = field?.kind === 'tags' ? String(v ?? '').split('|').filter(Boolean) : [cellText(v, field?.kind ?? 'text', names)];
      for (const k of keys.length ? keys : ['—']) byKey.set(k, [...(byKey.get(k) ?? []), row]);
    }
    const groups = [...byKey.entries()].map(([label, rs]) => ({ label, value: aggregate(rs, spec.agg, spec.field) ?? 0 }));
    if (field?.kind === 'date') groups.sort((a, b) => a.label.localeCompare(b.label)); else groups.sort((a, b) => b.value - a.value);
    const limit = spec.limit ?? 8;
    out.groups = groups.length > limit && spec.agg !== 'avg' && spec.agg !== 'min' && spec.agg !== 'max'
      ? [...groups.slice(0, limit), { label: 'Other', value: groups.slice(limit).reduce((a, g) => a + g.value, 0) }]
      : groups.slice(0, limit);
  }

  if ((chart === 'line' || (chart === 'column' && !spec.groupBy)) && spec.dateField) {
    out.series = bucketSeries(rows, spec.dateField, r, spec.agg, spec.field);
  }

  if (chart === 'table') {
    const cols = (spec.columns?.length ? spec.columns : FIELDS[spec.source].slice(0, 5).map((x) => x.key)).filter((k) => fieldOf(spec.source, k));
    const sorted = spec.dateField ? [...rows].sort((a, b) => Number(b[spec.dateField as string] ?? 0) - Number(a[spec.dateField as string] ?? 0)) : rows;
    out.table = {
      cols: cols.map((k) => fieldOf(spec.source, k)?.label ?? k),
      rows: sorted.slice(0, spec.limit ?? 50).map((row) => cols.map((k) => cellText(row[k], fieldOf(spec.source, k)?.kind ?? 'text', names))),
    };
  }

  if (chart === 'funnel' && spec.funnel?.length) {
    out.funnel = spec.funnel.map((step) => ({ label: step.label, value: rows.filter((row) => matches(row, step.filters, spec.source, names, opts.me ?? null)).length }));
  }

  return out;
}

// ---- custom metrics ------------------------------------------------------------------

export type Token = { kind: 'metric'; spec: Spec; label: string } | { kind: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' } | { kind: 'num'; v: number };
export type MetricFormat = 'int' | 'float' | 'pct' | 'usd';

/** Evaluates a formula with each metric already reduced to a number; null when it cannot be (empty, unbalanced, ÷0). */
export function evalFormula(tokens: Token[], valueOf: (spec: Spec, i: number) => number | null): number | null {
  const out: (number | null)[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const apply = () => {
    const op = ops.pop();
    const b = out.pop(), a = out.pop();
    if (op === undefined || a === undefined || b === undefined) { out.push(null); return; }
    if (a === null || b === null) { out.push(null); return; }
    out.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : b === 0 ? null : a / b);
  };
  tokens.forEach((t, i) => {
    if (t.kind === 'num') out.push(t.v);
    else if (t.kind === 'metric') out.push(valueOf(t.spec, i));
    else if (t.v === '(') ops.push('(');
    else if (t.v === ')') { while (ops.length && ops[ops.length - 1] !== '(') apply(); ops.pop(); }
    else { while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t.v]) apply(); ops.push(t.v); }
  });
  while (ops.length) { if (ops[ops.length - 1] === '(') { ops.pop(); continue; } apply(); }
  if (out.length !== 1) return null;
  const v = out[0];
  return v === null || !Number.isFinite(v) ? null : v;
}

/** Why a formula cannot run, or null when it is well formed. */
export function formulaError(tokens: Token[]): string | null {
  if (!tokens.length) return 'Add a metric to start the formula.';
  if (tokens.filter((t) => t.kind === 'metric').length > 4) return 'A custom metric combines up to four metrics.';
  let depth = 0, expectValue = true;
  for (const t of tokens) {
    if (t.kind === 'op' && t.v === '(') { if (!expectValue) return 'A ( needs an operator before it.'; depth++; continue; }
    if (t.kind === 'op' && t.v === ')') { if (expectValue || depth === 0) return 'Unbalanced parentheses.'; depth--; continue; }
    if (t.kind === 'op') { if (expectValue) return `Nothing before "${t.v}".`; expectValue = true; continue; }
    if (!expectValue) return 'Two values need an operator between them.';
    expectValue = false;
  }
  if (depth !== 0) return 'Unbalanced parentheses.';
  if (expectValue) return 'The formula ends on an operator.';
  return null;
}

// ---- formatting ------------------------------------------------------------------------

export function fmtValue(v: number | null, format: Format): string {
  if (v === null || !Number.isFinite(v)) return '—';
  switch (format) {
    case 'usd': return (v < 0 ? '−$' : '$') + abbreviate(Math.abs(v));
    case 'pct': return (Math.round(v * 10) / 10).toLocaleString('en-US') + '%';
    case 'float': return (Math.round(v * 10) / 10).toLocaleString('en-US');
    case 'dur': {
      const s = Math.round(v);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }
    default: return abbreviate(Math.round(v));
  }
}

/** 2.64K, $1.13M — the way a number tile reads at a glance; exact under 10,000. */
export function abbreviate(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return (Math.round(n / 10_000) / 100).toLocaleString('en-US') + 'M';
  if (a >= 10_000) return (Math.round(n / 100) / 10).toLocaleString('en-US') + 'K';
  return Math.round(n * 10) === Math.round(n) * 10 ? Math.round(n).toLocaleString('en-US') : (Math.round(n * 10) / 10).toLocaleString('en-US');
}

/** The delta chip: "↑ 12%" and whether that is good under the widget's polarity. */
export function fmtDelta(cur: number | null, prev: number | null, polarity: Polarity = 'up'): { text: string; good: boolean | null } | null {
  if (cur === null || prev === null) return null;
  if (prev === 0) return cur === 0 ? { text: '— flat', good: null } : { text: '↑ new', good: polarity === 'up' };
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return { text: '— flat', good: null };
  const up = pct > 0;
  return { text: `${up ? '↑' : '↓'} ${Math.abs(pct)}%`, good: polarity === 'up' ? up : !up };
}
