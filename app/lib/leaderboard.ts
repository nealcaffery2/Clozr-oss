// The leaderboard engine — one computation for every board.
//
// The Sales leaderboard screen in CLOZR, the `leaderboard` edge function that
// the Acme Homes TV dashboard pulls from, and Reporting's Team tab all rank the
// same people on the same rules, so the rules live in one pure function:
// rows in, ranked reps + executive summary out. Nothing here estimates. A rep
// with no calls attributed shows 0 calls, and the note on the board says why.
//
// Attribution, in order, per fact:
//   calls / texts / emails   communications.rep_id (the Talkr user who handled
//                            it, migration 85) → the owner of the team line it
//                            used (rep_phone_numbers) → the assigned rep of the
//                            seller the message was with → nobody
//   appointments             appointments.assigned_to → the seller's rep
//   offers                   offers.created_by → the seller's rep
//   leads                    sellers.assigned_to, by created_at
//   contracts                deals.owner_id by contract_date (acquisitions);
//                            deals.dispo_rep_id the same (disposition side)
//   closings / revenue       closed_on (else close_date when Closed); the fee is
//                            credited to both the owner and the dispo rep in
//                            full on their own side, and split 50/50 in the
//                            combined `revenue` when they differ — the rule
//                            the TV board has always used
//   pipeline / escrow        a snapshot of the deals in those stages today,
//                            not filtered by period (same as the board)
//
// Periods and points match the dashboard's ids and values exactly, so a number
// on the office TV is the number in CLOZR.
//
// Mirrored verbatim in supabase/functions/_shared/leaderboard.ts for Deno; keep
// the two in step (tools/leaderboard.test.ts checks they are byte-identical).

export const POINTS = {
  APPOINTMENT: 250, CONVERSATION: 100, CALL_ATTEMPT: 10, SMS: 2,
  EMAIL: 1, OFFER: 50, DEAL: 200, CLOSING: 500,
} as const;

/** A conversation is a call that lasted at least this long (the board's rule). */
export const CONVERSATION_SECONDS = 120;

export const PERIODS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this-week', 'This Week (Mon - Sun)'],
  ['last-7-days', 'Last 7 Days'], ['last-week', 'Last Week (Mon - Sun)'], ['last-14-days', 'Last 14 Days'],
  ['this-month', 'This Month'], ['last-30-days', 'Last 30 Days'], ['last-month', 'Last Month'],
  ['this-quarter', 'This Quarter'], ['this-year', 'This Year'], ['all-time', 'All Time'],
] as const;

export type Period = (typeof PERIODS)[number][0];
export const PERIOD_IDS: Period[] = PERIODS.map((p) => p[0]);
export const DEFAULT_TZ = 'America/Chicago';

export const DEFAULT_GOALS = { monthlyClosed: 150_000, pipelineTotal: 300_000, terminationPercentMax: 50 };
export type Goals = typeof DEFAULT_GOALS;

// ---- input ----------------------------------------------------------------------

export type LbMember = { id: string; name: string; role: string; email?: string | null; avatar?: string | null };
export type LbSeller = { id: number; created_at: string; assigned_to: string | null; source?: string | null };
export type LbDeal = {
  id: number; seller_id: number | null; stage: string; created_at: string; stage_entered_at: string | null;
  contract_date: string | null; close_date: string | null; closed_on: string | null;
  owner_id: string | null; dispo_rep_id: string | null;
  assignment_fee: number | null; dispo_fee?: number | null; wholesale_fee: number | null; marketed_fee?: number | null;
  total_cogs: number | null; deal_net_profit: number | null; market?: string | null;
  /** The Deal Tracker's transaction coordinator, by name (deals.coordinator). */
  coordinator?: string | null;
};
export type LbComm = { seller_id: number | null; buyer_id?: number | null; rep_id?: string | null; from_phone?: string | null; to_phone?: string | null; channel: string; direction: string | null; occurred_at: string; duration_s: number | null; status: string | null };
export type LbOffer = { seller_id: number | null; direction: string; sent_at: string; created_by: string | null };
export type LbAppointment = { seller_id: number | null; assigned_to?: string | null; starts_at: string; created_at?: string | null; deleted_at?: string | null };
export type LbBuyer = { created_at: string; created_by?: string | null };

export type LeaderboardRaw = {
  members: LbMember[];
  sellers: LbSeller[];
  deals: LbDeal[];
  comms: LbComm[];
  /** The team lines (rep_phone_numbers), so a call with no rep is credited to its line's owner. */
  lines?: { phone10: string; user_id: string | null; label: string }[];
  /** True when the communications read hit its row cap, so older activity is missing. */
  commsCapped?: boolean;
  offers: LbOffer[];
  appointments?: LbAppointment[];
  buyers?: LbBuyer[];
};

// ---- output: the dashboard's SalesPerson, verbatim -------------------------------------

export type SalesPerson = {
  id: string; name: string; avatar?: string; role?: 'acquisitions' | 'disposition' | 'lead-manager' | 'other';
  sales: number; calls: number; meetings: number; appointments?: number; emails?: number; sms?: number;
  totalCalls?: number; totalSMS?: number; totalTalkTime?: number; avgCallDuration?: number; conversations?: number;
  deals: number; offersMade: number; offersMadeLogged?: number; leads?: number;
  dealsUnderContract?: number; pipelineVolume?: number; inEscrow?: number; closed?: number; dealsClosed?: number; revenue: number;
  avgWholesaleFeeWeek?: number; avgWholesaleFeeMonth?: number; avgWholesaleFeeQuarter?: number; avgWholesaleFeeYear?: number;
  leadsToContract?: number; leadsToClosing?: number; speedToLeadSeconds?: number; speedToLeadLeadsCount?: number;
  terminationPercent?: number; dealsTerminated?: number; buyersAdded?: number; cogs?: number | null; netProfit?: number | null;
  dispositionPipelineVolume?: number; dispositionInEscrow?: number; dispositionClosed?: number; dispositionDeals?: number;
  dispositionDealsUnderContract?: number; dispositionDealsClosed?: number;
  rank: number; change: number; lastActivity?: string;
  /** CLOZR extras (not on the dashboard type, harmless there). */
  points: number; activitySource: 'clozr';
  /** Dials out: calls and voicemails left, without the inbound calls `calls` also counts. */
  outboundCalls?: number;
  /** When this rep's first contract in the period was signed, on their own side (seller side, or dispo side for dispo). */
  firstContractAt?: string;
  /** Transaction coordinator files (deals.coordinator names this member): closings, on Fridays, on or before the scheduled date, late, and fallen out. */
  tcClosings?: number; tcFridayClosings?: number; tcOnTime?: number; tcLate?: number; tcFallouts?: number;
};

export type ExecutiveSummary = {
  totalCalls: number; totalAppointments: number; totalEmails: number; totalSMS: number; totalOffersMade: number;
  totalDealsUnderContract: number; totalClosings: number; totalPipelineVolume: number; totalInEscrow: number; totalClosed: number; totalRevenue: number;
  totalCogs: number | null; totalNetProfit: number | null; netProfitCoverage: { dealsWithCogs: number; dealsClosedInPeriod: number };
  avgTerminationPercent: number; totalTerminationPercent: number;
  monthlyClosedGoal: number; monthlyClosedProgress: number; pipelineGoal: number; pipelineProgress: number;
  terminationGoal: number; terminationStatus: 'on-track' | 'at-risk';
  cashConversionDays: number | null; avgWholesaleFeeMonthly: number; avgWholesaleFeeQuarterly: number; avgWholesaleFeeYearly: number;
  topMarketsByDealsQuarter: string[]; topMarketsByDealsYear: string[]; topMarketsClosedQuarter: string[]; topMarketsClosedYear: string[];
};

export type LeaderboardPayload = {
  salesPeople: SalesPerson[];
  executiveSummary: ExecutiveSummary;
  announcements: never[];
  lastUpdated: string;
  period: Period;
  dataSource: 'clozr';
  dealsCount: number;
  /** What the numbers cannot say for themselves. */
  notes: string[];
  range: { start: string | null; end: string; tz: string };
};

// ---- time, in the board's time zone --------------------------------------------------------

type Parts = { y: number; m: number; d: number; wd: number; H: number; M: number };

// Building a DateTimeFormat costs far more than using one, and the board asks
// for parts many times a render: one per zone.
const PARTS_FMT = new Map<string, Intl.DateTimeFormat>();

function partsIn(t: number, tz: string): Parts {
  let f = PARTS_FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    PARTS_FMT.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd, H: Number(p.hour) % 24, M: Number(p.minute) };
}

/** The instant at which the tz-local calendar day (y, m, d) begins. */
function startOfDayUtc(y: number, m: number, d: number, tz: string): number {
  // Start with the UTC midnight, then correct by the zone's offset at that moment (twice, for DST edges).
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(t, tz);
    const local = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M);
    t -= local - Date.UTC(y, m - 1, d);
  }
  return t;
}

export type Range = { start: number | null; end: number };

export function periodRange(period: string, now = Date.now(), tz = DEFAULT_TZ): Range {
  const p = partsIn(now, tz);
  const day = (y: number, m: number, d: number) => startOfDayUtc(y, m, d, tz);
  const today = day(p.y, p.m, p.d);
  const DAY = 86_400_000;
  const dayN = (n: number) => { const x = new Date(Date.UTC(p.y, p.m - 1, p.d - n)); return day(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };
  const monday = (offsetDays: number) => { const back = (p.wd + 6) % 7; return dayN(back + offsetDays); };
  const endOfYesterday = today - 1;
  switch (period) {
    case 'all-time': return { start: null, end: now };
    case 'today': return { start: today, end: now };
    case 'yesterday': return { start: dayN(1), end: endOfYesterday };
    case 'this-week': return { start: monday(0), end: now };
    case 'last-7-days': return { start: dayN(6), end: now };
    case 'last-week': return { start: monday(7), end: monday(0) - 1 };
    case 'last-14-days': return { start: dayN(13), end: now };
    case 'this-month': return { start: day(p.y, p.m, 1), end: now };
    case 'last-30-days': return { start: dayN(29), end: now };
    case 'last-month': { const y = p.m === 1 ? p.y - 1 : p.y; const m = p.m === 1 ? 12 : p.m - 1; return { start: day(y, m, 1), end: day(p.y, p.m, 1) - 1 }; }
    case 'this-quarter': return { start: day(p.y, Math.floor((p.m - 1) / 3) * 3 + 1, 1), end: now };
    case 'this-year': return { start: day(p.y, 1, 1), end: now };
    default: return { start: dayN(6), end: now };
  }
}

// ---- rules -------------------------------------------------------------------------------

const ts = (v: string | null | undefined): number | null => { if (!v) return null; const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const inRange = (v: string | null | undefined, r: Range): boolean => { const t = ts(v); return t !== null && (r.start === null || t >= r.start) && t <= r.end; };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v: number) => Math.round(v);

/** The Deal Tracker's dispo fee when there is one; else wholesale fee (sold − contract); else the assignment fee typed on the deal. */
export const feeOf = (d: LbDeal): number => (d.dispo_fee != null ? num(d.dispo_fee) : num(d.wholesale_fee) > 0 ? num(d.wholesale_fee) : num(d.assignment_fee));

export const isClosed = (d: LbDeal) => /^closed/i.test(d.stage) || !!d.closed_on;
export const closedAt = (d: LbDeal): string | null => d.closed_on ?? (isClosed(d) ? d.close_date : null);
export const isTerminated = (d: LbDeal) => /terminat|dead|lost|cancel/i.test(d.stage);
/** Under contract with the seller, marketing, or the buyer is under contract: the pipeline the board sizes. */
export const isPipeline = (d: LbDeal) => !isClosed(d) && !isTerminated(d) && /contract|market|dispo|assign/i.test(d.stage) && !/escrow|closing/i.test(d.stage);
export const isEscrow = (d: LbDeal) => !isClosed(d) && !isTerminated(d) && /escrow|closing/i.test(d.stage);
const isCall = (c: LbComm) => c.channel === 'call' || c.channel === 'voicemail';
const isOut = (c: LbComm) => c.direction !== 'inbound';

export function roleOf(memberRole: string): NonNullable<SalesPerson['role']> {
  const r = memberRole.toLowerCase();
  if (/dispo/.test(r)) return 'disposition';
  if (/acq/.test(r)) return 'acquisitions';
  if (/lead.?manager|^tc$|coordinator/.test(r)) return 'lead-manager';
  return 'other';
}

export type BuildOptions = { now?: number; tz?: string; goals?: Partial<Goals>; /** Members to leave off the board (owners who do not sell). */ exclude?: string[] };

export function buildLeaderboard(raw: LeaderboardRaw, period: Period | string, opts: BuildOptions = {}): LeaderboardPayload {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const goals = { ...DEFAULT_GOALS, ...(opts.goals ?? {}) };
  const per = (PERIOD_IDS as string[]).includes(period) ? (period as Period) : 'last-30-days';
  const range = periodRange(per, now, tz);
  const cur = (v: string | null | undefined) => inRange(v, range);
  const week = periodRange('this-week', now, tz), month = periodRange('this-month', now, tz), quarter = periodRange('this-quarter', now, tz), year = periodRange('this-year', now, tz);
  const notes: string[] = [];
  const excluded = new Set(opts.exclude ?? []);

  const members = raw.members.filter((m) => !excluded.has(m.id));
  const ids = new Set(members.map((m) => m.id));
  const sellerRep = new Map<number, string | null>();
  for (const s of raw.sellers) sellerRep.set(s.id, s.assigned_to);
  const repOfSeller = (sid: number | null | undefined): string | null => (sid == null ? null : sellerRep.get(sid) ?? null);
  const own = (id: string | null | undefined): string | null => (id && ids.has(id) ? id : null);
  // A call with no rep on it belongs to the owner of the team line it used:
  // outbound, the number it came from; inbound, the number it reached.
  const lineOwner = new Map((raw.lines ?? []).map((l) => [l.phone10, l.user_id] as const));
  const ownerOfLine = (c: LbComm) => lineOwner.get(String((c.direction === 'inbound' ? c.to_phone : c.from_phone) ?? '').replace(/\D/g, '').slice(-10)) ?? null;
  // The coordinator is a name on the deal: the member with that full name, else the only one with that first name.
  const byFull = new Map<string, string>(), byFirst = new Map<string, string | null>();
  for (const m of members) {
    const full = m.name.trim().toLowerCase();
    if (full) byFull.set(full, m.id);
    const first = full.split(/\s+/)[0];
    if (first) byFirst.set(first, byFirst.has(first) ? null : m.id);
  }
  const coordinatorOf = (name: string | null | undefined): string | null => {
    const n = (name ?? '').trim().toLowerCase();
    if (!n) return null;
    return byFull.get(n) ?? byFirst.get(n.split(/\s+/)[0]) ?? null;
  };
  const weekday = (at: string): number | null => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return new Date(at + 'T12:00:00Z').getUTCDay();
    const t = ts(at);
    if (t === null) return null;
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(t));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
  };
  type Tc = { closings: number; friday: number; onTime: number; late: number; fallouts: number };
  const tc = new Map<string, Tc>();
  const T = (id: string): Tc => { let t = tc.get(id); if (!t) { t = { closings: 0, friday: 0, onTime: 0, late: 0, fallouts: 0 }; tc.set(id, t); } return t; };

  // ---- per-rep accumulators
  type Acc = {
    calls: number; outbound: number; talk: number; convos: number; sms: number; emails: number; appointments: number; offers: number; leads: number;
    firstContract: number; firstDispoContract: number;
    contracts: number; dispoContracts: number; closings: number; dispoClosings: number; closedFee: number; dispoClosedFee: number; revenue: number;
    pipeline: number; escrow: number; pipelineN: number; escrowN: number; dispoPipeline: number; dispoEscrow: number; dispoPipelineN: number; dispoEscrowN: number;
    terminated: number; buyers: number; cogs: number; net: number; cogsN: number;
    feesWeek: number[]; feesMonth: number[]; feesQuarter: number[]; feesYear: number[];
    stlSum: number; stlN: number; leadsToContract: number; leadsToClosing: number; last: number;
  };
  const acc = new Map<string, Acc>();
  for (const m of members) acc.set(m.id, {
    calls: 0, outbound: 0, talk: 0, convos: 0, sms: 0, emails: 0, appointments: 0, offers: 0, leads: 0,
    firstContract: Infinity, firstDispoContract: Infinity,
    contracts: 0, dispoContracts: 0, closings: 0, dispoClosings: 0, closedFee: 0, dispoClosedFee: 0, revenue: 0,
    pipeline: 0, escrow: 0, pipelineN: 0, escrowN: 0, dispoPipeline: 0, dispoEscrow: 0, dispoPipelineN: 0, dispoEscrowN: 0,
    terminated: 0, buyers: 0, cogs: 0, net: 0, cogsN: 0, feesWeek: [], feesMonth: [], feesQuarter: [], feesYear: [],
    stlSum: 0, stlN: 0, leadsToContract: 0, leadsToClosing: 0, last: 0,
  });
  const A = (id: string | null) => (id ? acc.get(id) ?? null : null);
  const touch = (a: Acc | null, at: string | null | undefined) => { const t = ts(at); if (a && t && t > a.last) a.last = t; };

  // ---- activity
  let unattributed = 0;
  const firstTouch = new Map<number, number>(); // seller → first outbound contact
  for (const c of raw.comms) {
    const t = ts(c.occurred_at);
    if (t === null) continue;
    if (isOut(c) && c.seller_id != null && (firstTouch.get(c.seller_id) ?? Infinity) > t) firstTouch.set(c.seller_id, t);
    if (!cur(c.occurred_at)) continue;
    const rep = own(c.rep_id) ?? own(ownerOfLine(c)) ?? own(repOfSeller(c.seller_id));
    const a = A(rep);
    if (!a) { unattributed++; continue; }
    touch(a, c.occurred_at);
    if (isCall(c)) {
      a.calls++;
      if (isOut(c)) a.outbound++;
      a.talk += num(c.duration_s);
      if (num(c.duration_s) >= CONVERSATION_SECONDS) a.convos++;
    } else if (c.channel === 'sms' || c.channel === 'text') { if (isOut(c)) a.sms++; }
    else if (c.channel === 'email') { if (isOut(c)) a.emails++; }
  }
  if (unattributed) notes.push(`${unattributed} call/text/email row${unattributed === 1 ? '' : 's'} in this period could not be credited to a rep (no Talkr user and no assigned rep on the record).`);
  if (raw.commsCapped) notes.push('The communications read hit its row cap, so older activity in long periods may be missing.');

  for (const ap of raw.appointments ?? []) {
    if (ap.deleted_at) continue;
    if (!cur(ap.created_at ?? ap.starts_at)) continue;
    const a = A(own(ap.assigned_to) ?? own(repOfSeller(ap.seller_id)));
    if (a) { a.appointments++; touch(a, ap.created_at ?? ap.starts_at); }
  }
  for (const o of raw.offers) {
    if (o.direction === 'inbound' || !cur(o.sent_at)) continue;
    const a = A(own(o.created_by) ?? own(repOfSeller(o.seller_id)));
    if (a) { a.offers++; touch(a, o.sent_at); }
  }
  for (const s of raw.sellers) {
    if (!cur(s.created_at)) continue;
    const a = A(own(s.assigned_to));
    if (a) a.leads++;
  }
  for (const b of raw.buyers ?? []) {
    if (!cur(b.created_at)) continue;
    const a = A(own(b.created_by));
    if (a) a.buyers++;
  }
  // Speed to lead: from the lead's creation to its first outbound touch, credited to the assigned rep.
  for (const s of raw.sellers) {
    const first = firstTouch.get(s.id);
    const created = ts(s.created_at);
    if (first === undefined || created === null || first < created || !cur(s.created_at)) continue;
    const a = A(own(s.assigned_to));
    if (a) { a.stlSum += (first - created) / 1000; a.stlN++; }
  }

  // ---- deals
  const dealBySeller = new Map<number, LbDeal[]>();
  for (const d of raw.deals) if (d.seller_id != null) dealBySeller.set(d.seller_id, [...(dealBySeller.get(d.seller_id) ?? []), d]);
  const closedInPeriod: LbDeal[] = [];
  for (const d of raw.deals) {
    const owner = own(d.owner_id), dispo = own(d.dispo_rep_id);
    const ao = A(owner), ad = A(dispo);
    const fee = feeOf(d);
    if (cur(d.contract_date)) {
      const at = ts(d.contract_date) ?? Infinity;
      if (ao) { ao.contracts++; ao.firstContract = Math.min(ao.firstContract, at); touch(ao, d.contract_date); }
      if (ad) { ad.dispoContracts++; ad.firstDispoContract = Math.min(ad.firstDispoContract, at); touch(ad, d.contract_date); }
    }
    if (isPipeline(d)) { if (ao) { ao.pipeline += fee; ao.pipelineN++; } if (ad) { ad.dispoPipeline += fee; ad.dispoPipelineN++; } }
    if (isEscrow(d)) { if (ao) { ao.escrow += fee; ao.escrowN++; } if (ad) { ad.dispoEscrow += fee; ad.dispoEscrowN++; } }
    const closed = closedAt(d);
    if (closed && cur(closed)) {
      closedInPeriod.push(d);
      const split = owner && dispo && owner !== dispo;
      if (ao) { ao.closings++; ao.closedFee += fee; ao.revenue += split ? fee / 2 : fee; touch(ao, closed); }
      if (ad) { ad.dispoClosings++; ad.dispoClosedFee += fee; if (ad !== ao) ad.revenue += split ? fee / 2 : fee; touch(ad, closed); }
      for (const a of [ao, ad === ao ? null : ad]) {
        if (!a) continue;
        if (d.total_cogs != null || d.deal_net_profit != null) { a.cogs += num(d.total_cogs); a.net += num(d.deal_net_profit); a.cogsN++; }
      }
    }
    if (closed) {
      for (const a of [ao, ad === ao ? null : ad]) {
        if (!a) continue;
        if (inRange(closed, week)) a.feesWeek.push(fee);
        if (inRange(closed, month)) a.feesMonth.push(fee);
        if (inRange(closed, quarter)) a.feesQuarter.push(fee);
        if (inRange(closed, year)) a.feesYear.push(fee);
      }
    }
    if (isTerminated(d) && cur(d.stage_entered_at ?? d.created_at)) { if (ao) ao.terminated++; if (ad && ad !== ao) ad.terminated++; }
    // The coordinator's file: closed in the period (on a Friday? by the scheduled date?), still open past
    // its scheduled date, or fallen out in the period.
    const coord = coordinatorOf(d.coordinator);
    if (coord) {
      const t = T(coord);
      if (closed && cur(closed)) {
        t.closings++;
        if (weekday(closed) === 5) t.friday++;
        if (d.close_date && d.closed_on && d.closed_on.slice(0, 10) > d.close_date.slice(0, 10)) t.late++; else t.onTime++;
      } else if (!closed && !isTerminated(d) && d.close_date && cur(d.close_date) && (ts(d.close_date.slice(0, 10) + 'T23:59:59Z') ?? Infinity) < now) t.late++;
      if (isTerminated(d) && cur(d.stage_entered_at ?? d.created_at)) t.fallouts++;
    }
  }
  // Leads → contract / closing: of this rep's leads created in the period, how many reached each.
  for (const s of raw.sellers) {
    if (!cur(s.created_at)) continue;
    const a = A(own(s.assigned_to));
    if (!a) continue;
    const ds = dealBySeller.get(s.id) ?? [];
    if (ds.some((d) => d.contract_date)) a.leadsToContract++;
    if (ds.some((d) => closedAt(d))) a.leadsToClosing++;
  }

  // ---- reps
  const avg = (xs: number[]) => (xs.length ? round(xs.reduce((p, c) => p + c, 0) / xs.length) : 0);
  const people: SalesPerson[] = members.map((m) => {
    const a = acc.get(m.id)!;
    const role = roleOf(m.role);
    const dispo = role === 'disposition';
    const contracts = dispo ? a.dispoContracts : a.contracts;
    const closings = dispo ? a.dispoClosings : a.closings;
    const firstContract = dispo ? a.firstDispoContract : a.firstContract;
    const points = a.appointments * POINTS.APPOINTMENT + a.convos * POINTS.CONVERSATION + a.calls * POINTS.CALL_ATTEMPT
      + a.sms * POINTS.SMS + a.emails * POINTS.EMAIL + a.offers * POINTS.OFFER + contracts * POINTS.DEAL + closings * POINTS.CLOSING;
    const concluded = a.closings + a.terminated;
    return {
      id: m.id, name: m.name, avatar: m.avatar ?? undefined, role,
      sales: a.closings, calls: a.calls, meetings: a.appointments, appointments: a.appointments, emails: a.emails, sms: a.sms,
      totalCalls: a.calls, totalSMS: a.sms, totalTalkTime: round(a.talk), avgCallDuration: a.calls ? round(a.talk / a.calls) : 0, conversations: a.convos,
      deals: a.contracts, offersMade: a.offers, offersMadeLogged: a.offers, leads: a.leads,
      dealsUnderContract: a.contracts, pipelineVolume: round(a.pipeline), inEscrow: round(a.escrow), closed: round(a.closedFee), dealsClosed: a.closings,
      revenue: round(a.revenue),
      avgWholesaleFeeWeek: avg(a.feesWeek), avgWholesaleFeeMonth: avg(a.feesMonth), avgWholesaleFeeQuarter: avg(a.feesQuarter), avgWholesaleFeeYear: avg(a.feesYear),
      leadsToContract: a.leadsToContract, leadsToClosing: a.leadsToClosing,
      speedToLeadSeconds: a.stlN ? round(a.stlSum / a.stlN) : undefined, speedToLeadLeadsCount: a.stlN,
      terminationPercent: concluded ? round((a.terminated / concluded) * 100) : 0, dealsTerminated: a.terminated, buyersAdded: a.buyers,
      cogs: a.cogsN ? round(a.cogs) : null, netProfit: a.cogsN ? round(a.net) : null,
      dispositionPipelineVolume: round(a.dispoPipeline), dispositionInEscrow: round(a.dispoEscrow), dispositionClosed: round(a.dispoClosedFee),
      dispositionDeals: a.dispoContracts, dispositionDealsUnderContract: a.dispoContracts, dispositionDealsClosed: a.dispoClosings,
      ...(tc.has(m.id) ? { tcClosings: tc.get(m.id)!.closings, tcFridayClosings: tc.get(m.id)!.friday, tcOnTime: tc.get(m.id)!.onTime, tcLate: tc.get(m.id)!.late, tcFallouts: tc.get(m.id)!.fallouts } : {}),
      rank: 0, change: 0, lastActivity: a.last ? new Date(a.last).toISOString() : undefined,
      points, activitySource: 'clozr',
      outboundCalls: a.outbound, firstContractAt: Number.isFinite(firstContract) ? new Date(firstContract).toISOString() : undefined,
    };
  });
  // The board ranks on revenue (the dashboard's rule); ties go to contracts, then calls.
  const ranked = [...people].sort((x, y) => y.revenue - x.revenue || (y.dealsUnderContract ?? 0) - (x.dealsUnderContract ?? 0) || y.calls - x.calls)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  // ---- executive summary
  const sum = (f: (p: SalesPerson) => number) => ranked.reduce((t, p) => t + f(p), 0);
  const totalClosedCount = closedInPeriod.length;
  const totalTerminated = sum((p) => p.dealsTerminated ?? 0);
  const concludedAll = totalClosedCount + totalTerminated;
  const totalRevenue = round(closedInPeriod.reduce((t, d) => t + feeOf(d), 0));
  const pipelineDeals = raw.deals.filter(isPipeline), escrowDeals = raw.deals.filter(isEscrow);
  const totalPipelineVolume = round(pipelineDeals.reduce((t, d) => t + feeOf(d), 0));
  const totalInEscrow = round(escrowDeals.reduce((t, d) => t + feeOf(d), 0));
  const withCogs = closedInPeriod.filter((d) => d.total_cogs != null || d.deal_net_profit != null);
  const feeAvg = (r: Range) => { const xs = raw.deals.filter((d) => { const c = closedAt(d); return c && inRange(c, r); }).map(feeOf); return avg(xs); };
  const conv = closedInPeriod.map((d) => { const a = ts(d.contract_date), b = ts(closedAt(d)); return a !== null && b !== null && b >= a ? (b - a) / 86_400_000 : null; }).filter((x): x is number => x !== null);
  const topMarkets = (ds: LbDeal[]) => { const m = new Map<string, number>(); for (const d of ds) if (d.market) m.set(d.market, (m.get(d.market) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k); };
  const inQ = (d: LbDeal) => inRange(d.created_at, quarter), inY = (d: LbDeal) => inRange(d.created_at, year);
  const closedQ = raw.deals.filter((d) => { const c = closedAt(d); return c && inRange(c, quarter); }), closedY = raw.deals.filter((d) => { const c = closedAt(d); return c && inRange(c, year); });
  const totalTermPct = concludedAll ? Math.round((totalTerminated / concludedAll) * 1000) / 10 : 0;
  const executiveSummary: ExecutiveSummary = {
    totalCalls: sum((p) => p.calls), totalAppointments: sum((p) => p.appointments ?? 0), totalEmails: sum((p) => p.emails ?? 0), totalSMS: sum((p) => p.sms ?? 0),
    totalOffersMade: sum((p) => p.offersMade), totalDealsUnderContract: raw.deals.filter((d) => cur(d.contract_date)).length, totalClosings: totalClosedCount,
    totalPipelineVolume, totalInEscrow, totalClosed: totalRevenue, totalRevenue,
    totalCogs: withCogs.length ? round(withCogs.reduce((t, d) => t + num(d.total_cogs), 0)) : null,
    totalNetProfit: withCogs.length ? round(withCogs.reduce((t, d) => t + num(d.deal_net_profit), 0)) : null,
    netProfitCoverage: { dealsWithCogs: withCogs.length, dealsClosedInPeriod: totalClosedCount },
    avgTerminationPercent: ranked.length ? round(sum((p) => p.terminationPercent ?? 0) / ranked.length) : 0, totalTerminationPercent: totalTermPct,
    monthlyClosedGoal: goals.monthlyClosed, monthlyClosedProgress: Math.min(100, round((totalRevenue / goals.monthlyClosed) * 100)),
    pipelineGoal: goals.pipelineTotal, pipelineProgress: Math.min(100, round((totalPipelineVolume / goals.pipelineTotal) * 100)),
    terminationGoal: goals.terminationPercentMax, terminationStatus: totalTermPct < goals.terminationPercentMax ? 'on-track' : 'at-risk',
    cashConversionDays: conv.length ? round(conv.reduce((a, b) => a + b, 0) / conv.length) : null,
    avgWholesaleFeeMonthly: feeAvg(month), avgWholesaleFeeQuarterly: feeAvg(quarter), avgWholesaleFeeYearly: feeAvg(year),
    topMarketsByDealsQuarter: topMarkets(raw.deals.filter(inQ)), topMarketsByDealsYear: topMarkets(raw.deals.filter(inY)),
    topMarketsClosedQuarter: topMarkets(closedQ), topMarketsClosedYear: topMarkets(closedY),
  };

  return {
    salesPeople: ranked, executiveSummary, announcements: [], lastUpdated: new Date(now).toISOString(), period: per, dataSource: 'clozr',
    dealsCount: raw.deals.length, notes,
    range: { start: range.start === null ? null : new Date(range.start).toISOString(), end: new Date(range.end).toISOString(), tz },
  };
}

// ---- gamification: the catalog the TV board draws from ----------------------------------------

export const getContracts = (p: SalesPerson) => (p.role === 'disposition' ? p.dispositionDealsUnderContract ?? p.dispositionDeals ?? 0 : p.dealsUnderContract ?? p.deals ?? 0);
export const getClosings = (p: SalesPerson) => (p.role === 'disposition' ? p.dispositionDealsClosed ?? 0 : p.dealsClosed ?? 0);
export const getRevenue = (p: SalesPerson) => (p.role === 'disposition' ? p.dispositionClosed : p.closed) ?? p.revenue ?? 0;
export const getAvgFee = (p: SalesPerson) => p.avgWholesaleFeeMonth || p.avgWholesaleFeeQuarter || p.avgWholesaleFeeYear || 0;
export const getCalls = (p: SalesPerson) => p.totalCalls || p.calls || 0;
export const getSms = (p: SalesPerson) => p.totalSMS || p.sms || 0;
export const getConversations = (p: SalesPerson) => p.conversations || 0;
export const getAppointments = (p: SalesPerson) => p.appointments || p.meetings || 0;
export const calculatePoints = (p: SalesPerson) => getAppointments(p) * POINTS.APPOINTMENT + getConversations(p) * POINTS.CONVERSATION + getCalls(p) * POINTS.CALL_ATTEMPT
  + getSms(p) * POINTS.SMS + (p.emails || 0) * POINTS.EMAIL + (p.offersMade || 0) * POINTS.OFFER + getContracts(p) * POINTS.DEAL + getClosings(p) * POINTS.CLOSING;

export type BadgeTier = 'prestige' | 'earned' | 'shame';
export type BadgeDef = { id: string; name: string; hint: string; tier: BadgeTier; image: string; icon: string; threshold?: number; approximation?: string };

export const BADGES: BadgeDef[] = [
  { id: 'apex-predator', name: 'Apex Predator', hint: '#1 salesperson for the month', tier: 'prestige', image: '/badges/apex-predator.png', icon: 'crown' },
  { id: 'whale-hunter', name: 'Whale Hunter', hint: '$50k+ single assignment', tier: 'prestige', image: '/badges/whale-hunter.png', icon: 'fish', threshold: 50_000, approximation: 'Uses the average fee on closed deals this month.' },
  { id: 'triple-crown', name: 'Triple Crown', hint: '#1 in activity, contracts and GP', tier: 'prestige', image: '/badges/triple-crown.png', icon: 'trophy' },
  { id: 'blood-in-the-water', name: 'Blood in the Water', hint: 'First contract of the week', tier: 'earned', image: '/badges/blood-in-the-water.png', icon: 'droplet' },
  { id: 'deal-reaper', name: 'Deal Reaper', hint: '3+ contracts in one week', tier: 'earned', image: '/badges/deal-reaper.png', icon: 'skull', threshold: 3 },
  { id: 'money-printer', name: 'Money Printer', hint: '$50k+ projected fees in a month', tier: 'earned', image: '/badges/money-printer.png', icon: 'banknote', threshold: 50_000 },
  { id: 'dialing-for-dollars', name: 'Dialing for Dollars', hint: '150+ outbound calls in a day', tier: 'earned', image: '/badges/dialing-for-dollars.png', icon: 'phone', threshold: 150, approximation: 'Counted across the selected period rather than a single day.' },
  { id: 'dead-lead-resurrection', name: 'Dead Lead Resurrection', hint: 'Contract a lead 60+ days old', tier: 'earned', image: '/badges/dead-lead-resurrection.png', icon: 'heart-pulse' },
  { id: 'one-shot-one-kill', name: 'One Shot, One Kill', hint: 'Contract on the first real call', tier: 'earned', image: '/badges/one-shot-one-kill.png', icon: 'crosshair' },
  { id: 'arsonist', name: 'Arsonist', hint: 'Three contracts inside one week', tier: 'earned', image: '/badges/arsonist.png', icon: 'flame' },
  { id: 'dog-with-a-bone', name: 'Dog With a Bone', hint: 'Would not let a dead deal die', tier: 'earned', image: '/badges/dog-with-a-bone.png', icon: 'bone' },
  { id: 'speed-demon', name: 'Speed Demon', hint: 'New leads answered in under 5 minutes on average', tier: 'earned', image: '/badges/speed-demon.svg', icon: 'zap', threshold: 300 },
  { id: 'smooth-talker', name: 'Smooth Talker', hint: '25+ real conversations in one week', tier: 'earned', image: '/badges/smooth-talker.svg', icon: 'mic', threshold: 25 },
  { id: 'offer-cannon', name: 'Offer Cannon', hint: '15+ offers out in one week', tier: 'earned', image: '/badges/offer-cannon.svg', icon: 'send', threshold: 15 },
  { id: 'buyer-magnet', name: 'Buyer Magnet', hint: '10+ buyers added in one week', tier: 'earned', image: '/badges/buyer-magnet.svg', icon: 'magnet', threshold: 10 },
  { id: 'ice-cold-closer', name: 'Ice Cold Closer', hint: '3+ closings in a month', tier: 'earned', image: '/badges/ice-cold-closer.svg', icon: 'snowflake', threshold: 3 },
  { id: 'furniture', name: 'Furniture', hint: 'Lowest outbound activity this week', tier: 'shame', image: '/badges/furniture.png', icon: 'armchair' },
  { id: 'casper', name: 'Casper', hint: 'Nobody knows what you did all day', tier: 'shame', image: '/badges/casper.png', icon: 'ghost' },
  { id: 'warm-milk', name: 'Warm Milk', hint: 'A week without a serious offer', tier: 'shame', image: '/badges/warm-milk.png', icon: 'milk' },
  { id: 'paper-tiger', name: 'Paper Tiger', hint: '100+ calls this month and not one contract', tier: 'shame', image: '/badges/paper-tiger.svg', icon: 'cat', threshold: 100 },
  { id: 'butterfingers', name: 'Butterfingers', hint: 'Half your deals fell out this month', tier: 'shame', image: '/badges/butterfingers.svg', icon: 'hand', threshold: 50 },
  // Transaction coordinator: the files a deal names them coordinator on.
  { id: 'friday-closer', name: 'Friday Closer', hint: 'Got a deal closed on a Friday', tier: 'earned', image: '/badges/friday-closer.svg', icon: 'party-popper' },
  { id: 'swiss-watch', name: 'Swiss Watch', hint: 'Every closing this month on or before its scheduled date (2+)', tier: 'earned', image: '/badges/swiss-watch.svg', icon: 'watch', threshold: 2 },
  { id: 'title-wave', name: 'Title Wave', hint: '4+ closings coordinated in a month', tier: 'earned', image: '/badges/title-wave.svg', icon: 'waves', threshold: 4 },
  { id: 'rain-check', name: 'Rain Check', hint: '2+ closings pushed past their scheduled date this month', tier: 'shame', image: '/badges/rain-check.svg', icon: 'cloud-rain', threshold: 2 },
  { id: 'leaky-bucket', name: 'Leaky Bucket', hint: 'A file you coordinated fell out this month', tier: 'shame', image: '/badges/leaky-bucket.svg', icon: 'droplets', threshold: 1 },
  { id: 'snail-mail', name: 'Snail Mail', hint: 'New leads waited over an hour for you this week', tier: 'shame', image: '/badges/snail-mail.svg', icon: 'snail', threshold: 3600 },
];

/**
 * lowestActivityIds: the quietest rep in each role, so dispo is not ranked against acquisitions dialing.
 * firstContractIds: whoever signed the period's first contract (a tie on the same day shares it).
 */
export type BadgeContext = { topPointsId?: string; topContractsId?: string; topRevenueId?: string; lowestActivityId?: string; lowestActivityIds?: string[]; firstContractIds?: string[]; manual?: Record<string, string[]> };

export function buildBadgeContext(people: SalesPerson[], manual: Record<string, string[]> = {}): BadgeContext {
  const maxBy = (f: (p: SalesPerson) => number) => { let id: string | undefined, best = 0; for (const p of people) { const v = f(p); if (v > best) { best = v; id = p.id; } } return id; };
  const active = people.filter((p) => getCalls(p) + getSms(p) + getConversations(p) > 0);
  let lowestActivityId: string | undefined, lowest = Infinity;
  for (const p of active) { const v = getCalls(p) + getSms(p); if (v < lowest) { lowest = v; lowestActivityId = p.id; } }
  const byRole = new Map<string, SalesPerson[]>();
  for (const p of active) byRole.set(p.role ?? 'other', [...(byRole.get(p.role ?? 'other') ?? []), p]);
  const lowestActivityIds: string[] = [];
  for (const peers of byRole.values()) {
    if (peers.length < 2) continue;
    let id: string | undefined, low = Infinity;
    for (const p of peers) { const v = getCalls(p) + getSms(p); if (v < low) { low = v; id = p.id; } }
    if (id) lowestActivityIds.push(id);
  }
  let firstAt = Infinity;
  for (const p of people) { const t = ts(p.firstContractAt); if (t !== null && getContracts(p) > 0 && t < firstAt) firstAt = t; }
  const firstContractIds = people.filter((p) => getContracts(p) > 0 && ts(p.firstContractAt) === firstAt).map((p) => p.id);
  return { topPointsId: maxBy(calculatePoints), topContractsId: maxBy(getContracts), topRevenueId: maxBy(getRevenue), lowestActivityId: active.length > 1 ? lowestActivityId : undefined, lowestActivityIds, firstContractIds, manual };
}

export function qualifies(badge: BadgeDef, p: SalesPerson, ctx: BadgeContext): boolean {
  switch (badge.id) {
    case 'apex-predator': return ctx.topPointsId === p.id;
    case 'triple-crown': return ctx.topPointsId === p.id && ctx.topContractsId === p.id && ctx.topRevenueId === p.id;
    case 'whale-hunter': return getAvgFee(p) >= (badge.threshold ?? 0);
    // The first contract of the period, not every contract in it. A board fed reps without the
    // timestamp (an outside dashboard) has no "first" to go on and keeps the looser rule.
    case 'blood-in-the-water': return getContracts(p) >= 1 && (!ctx.firstContractIds?.length || ctx.firstContractIds.includes(p.id));
    case 'deal-reaper': return getContracts(p) >= (badge.threshold ?? 3);
    case 'money-printer': return getRevenue(p) >= (badge.threshold ?? 0);
    // Dials out. Inbound calls are not dialing.
    case 'dialing-for-dollars': return (p.outboundCalls ?? getCalls(p)) >= (badge.threshold ?? 0);
    case 'furniture': return (ctx.lowestActivityIds ?? (ctx.lowestActivityId ? [ctx.lowestActivityId] : [])).includes(p.id);
    case 'casper': return getCalls(p) + getSms(p) + getConversations(p) === 0;
    // Seller offers are an acquisitions number; a dispo rep never makes one.
    case 'warm-milk': return p.role !== 'disposition' && (p.offersMade || 0) === 0 && getCalls(p) > 0;
    // Speed to lead needs a few leads behind it, or one lucky pickup is a badge.
    case 'speed-demon': return (p.speedToLeadLeadsCount ?? 0) >= 3 && p.speedToLeadSeconds != null && p.speedToLeadSeconds < (badge.threshold ?? 300);
    case 'snail-mail': return (p.speedToLeadLeadsCount ?? 0) >= 3 && p.speedToLeadSeconds != null && p.speedToLeadSeconds > (badge.threshold ?? 3600);
    case 'smooth-talker': return getConversations(p) >= (badge.threshold ?? 25);
    case 'offer-cannon': return p.role !== 'disposition' && (p.offersMade || 0) >= (badge.threshold ?? 15);
    case 'buyer-magnet': return p.role === 'disposition' && (p.buyersAdded ?? 0) >= (badge.threshold ?? 10);
    case 'ice-cold-closer': return getClosings(p) >= (badge.threshold ?? 3);
    case 'paper-tiger': return p.role !== 'disposition' && getCalls(p) >= (badge.threshold ?? 100) && getContracts(p) === 0;
    // Two concluded deals at least, so a single termination is not "half".
    case 'friday-closer': return (p.tcFridayClosings ?? 0) >= 1;
    case 'swiss-watch': return (p.tcClosings ?? 0) >= (badge.threshold ?? 2) && (p.tcLate ?? 0) === 0;
    case 'title-wave': return (p.tcClosings ?? 0) >= (badge.threshold ?? 4);
    case 'rain-check': return (p.tcLate ?? 0) >= (badge.threshold ?? 2);
    case 'leaky-bucket': return (p.tcFallouts ?? 0) >= (badge.threshold ?? 1);
    case 'butterfingers': return (p.dealsTerminated ?? 0) >= 2 && (p.terminationPercent ?? 0) >= (badge.threshold ?? 50);
    default: return (ctx.manual?.[p.name.trim().toLowerCase()] ?? ctx.manual?.[p.id] ?? []).includes(badge.id);
  }
}

export function badgesFor(p: SalesPerson, ctx: BadgeContext, includeShame = false): BadgeDef[] {
  const order: Record<BadgeTier, number> = { prestige: 0, earned: 1, shame: 2 };
  return BADGES.filter((b) => (includeShame || b.tier !== 'shame') && qualifies(b, p, ctx)).sort((a, b) => order[a.tier] - order[b.tier]);
}

export type TitleDef = { id: string; name: string; description: string; image: string; icon: string; metric: 'revenue' | 'avg-fee' | 'conversations' | 'contract-rate'; minSample?: number };
export const TITLES: TitleDef[] = [
  { id: 'the-crown', name: 'The Crown', description: 'Most assignment revenue in the period', image: '/badges/apex-predator.png', icon: 'crown', metric: 'revenue' },
  { id: 'big-dog', name: 'Big Dog', description: 'Highest average assignment fee in the period', image: '/badges/big-dog.png', icon: 'paw-print', metric: 'avg-fee' },
  { id: 'the-belt', name: 'The Belt', description: 'Most qualified conversations in the period', image: '/badges/dialing-for-dollars.png', icon: 'phone', metric: 'conversations' },
  { id: 'sniper', name: 'Sniper', description: 'Best contracts per conversation (5 or more)', image: '/badges/one-shot-one-kill.png', icon: 'crosshair', metric: 'contract-rate', minSample: 5 },
];

export const formatMoney = (v: number) => (!v ? '$0' : Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

export function titleScore(p: SalesPerson, t: TitleDef): number {
  switch (t.metric) {
    case 'revenue': return getRevenue(p);
    case 'avg-fee': return getAvgFee(p);
    case 'conversations': return getConversations(p);
    case 'contract-rate': { const c = getConversations(p); return c < (t.minSample ?? 1) ? 0 : getContracts(p) / c; }
  }
}
export function titleValueLabel(p: SalesPerson, t: TitleDef): string {
  switch (t.metric) {
    case 'revenue': return formatMoney(getRevenue(p));
    case 'avg-fee': return formatMoney(getAvgFee(p));
    case 'conversations': return String(getConversations(p));
    case 'contract-rate': { const c = getConversations(p); return c ? `${Math.round((getContracts(p) / c) * 100)}%` : '—'; }
  }
}
export function resolveTitles(people: SalesPerson[]): { title: TitleDef; holder?: SalesPerson; valueLabel: string }[] {
  return TITLES.map((title) => {
    let holder: SalesPerson | undefined, best = 0;
    for (const p of people) { const s = titleScore(p, title); if (s > best) { best = s; holder = p; } }
    return { title, holder, valueLabel: holder ? titleValueLabel(holder, title) : '—' };
  });
}

export type PrizeTier = { id: string; name: string; image: string; target: number };
export type IncentiveProgram = { id: string; name: string; kind: 'milestone' | 'tournament'; window: string; windowShort: string; cover: string; prizes: PrizeTier[] };
export const INCENTIVES: IncentiveProgram[] = [
  { id: 'champions-cup', name: 'Champions Cup', kind: 'tournament', window: 'Round 4 · Monday to Friday', windowShort: 'Round 4', cover: '/incentives/champions-cup.png', prizes: [] },
  { id: 'gear-up-2026', name: 'Gear Up 2026', kind: 'milestone', window: 'January to December', windowShort: 'Jan to Dec', cover: '/incentives/gear-up-2026.png', prizes: [
    { id: 'airpods', name: 'AirPods Pro 3', image: '/incentives/airpods-pro-3.png', target: 10 },
    { id: 'rayban', name: 'Ray-Ban Meta Sunglasses', image: '/incentives/ray-ban-meta.png', target: 20 },
  ] },
  { id: 'paradise-getaway', name: 'Paradise Getaway', kind: 'milestone', window: 'Q3 to Q4', windowShort: 'Q3 to Q4', cover: '/incentives/paradise-getaway.png', prizes: [
    { id: 'getaway', name: 'Paradise Getaway', image: '/incentives/paradise-getaway.png', target: 40 },
  ] },
];
export const FEATURED_INCENTIVE_ID = 'gear-up-2026';

/**
 * A rep zeroed on the board. Activity strictly before this instant is left off
 * their numbers, so a bulk import of old leads and calls does not count.
 * Keys are user ids; values are ISO timestamps.
 */
export type LeaderboardResets = Record<string, string>;

function resetCut(resets: LeaderboardResets, id: string | null | undefined): number | null {
  if (!id) return null;
  const iso = resets[id];
  if (typeof iso !== 'string') return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

function dropped(resets: LeaderboardResets, id: string | null | undefined, iso: string | null | undefined): boolean {
  const cut = resetCut(resets, id);
  if (cut == null || !iso) return false;
  const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
  return !Number.isNaN(n) && n < cut;
}

/** The same rows, with each reset rep's history before their cut removed. */
export function applyLeaderboardResets<T extends LeaderboardRaw>(raw: T, resets: LeaderboardResets | null | undefined): T {
  if (!resets || !Object.keys(resets).length) return raw;
  const sellerRep = new Map(raw.sellers.map((s) => [s.id, s.assigned_to]));
  return {
    ...raw,
    sellers: raw.sellers.filter((s) => !dropped(resets, s.assigned_to, s.created_at)),
    comms: raw.comms.filter((c) => {
      const rep = c.rep_id || (c.seller_id != null ? sellerRep.get(c.seller_id) ?? null : null);
      return !dropped(resets, rep, c.occurred_at);
    }),
    offers: raw.offers.filter((o) => !dropped(resets, o.created_by, o.sent_at)),
    appointments: (raw.appointments ?? []).filter((a) => {
      const rep = a.assigned_to || (a.seller_id != null ? sellerRep.get(a.seller_id) ?? null : null);
      return !dropped(resets, rep, a.starts_at);
    }),
    buyers: (raw.buyers ?? []).filter((b) => !dropped(resets, b.created_by ?? null, b.created_at)),
    deals: raw.deals.map((d) => {
      let next = d;
      if (dropped(resets, d.owner_id, d.contract_date)) next = { ...next, contract_date: null };
      const closed = d.closed_on || d.close_date;
      if (dropped(resets, d.owner_id, closed)) next = { ...next, closed_on: null, close_date: null };
      if (d.dispo_rep_id && d.dispo_rep_id !== d.owner_id && (dropped(resets, d.dispo_rep_id, d.contract_date) || dropped(resets, d.dispo_rep_id, closed))) {
        next = { ...next, dispo_rep_id: null };
      }
      return next;
    }),
  };
}
