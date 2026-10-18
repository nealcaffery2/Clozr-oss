// The team stoplight: each teammate graded green / yellow / red against the
// targets Acme Homes already wrote down, from what CLOZR logged.
//
// Targets come from two Drive files and nothing else:
//   * "Stoplight Report 2026" (sheet 12CmfNRAWYBuI8rBW-ZACdAgEgNMN0GpXnHxkjXt9uvs),
//     tab Targets: the monthly expectation and goal per KPI, the daily
//     activity minimums, 4 weeks a month, 5 workdays a week, and the colour
//     rule (green = met the goal, yellow = met the expectation, red = below it).
//   * "Sales Quota and Expectations" (doc 1XibhoirVMOPsjrmq2P5bOb0wqPKhyQhg-HG2jge9QLo):
//     the lead manager appointment minimums.
// A metric with no number in either file shows "No target set" and is never
// graded. "Sales Team KPI Bonus" sets bonuses, not targets, so nothing here
// reads it.
//
// Pure: no database, no clock unless one is passed. Tests:
// `npx tsx tools/stoplight.test.ts`.

import { plusIsoDays, readScheduleC } from './deal-close';

export type Light = 'green' | 'yellow' | 'red' | 'none';
export type Direction = 'higher' | 'lower';
/** One graded KPI: green at `goal`, yellow at `expectation`, red below. */
export type Target = { expectation: number; goal: number; direction: Direction; prorate: boolean; source: string; placeholder?: boolean };

/** Targets tab, ASSUMPTIONS. */
export const SCHEDULE = { weeksPerMonth: 4, workDaysPerWeek: 5 } as const;
const MONTH_WORKDAYS = SCHEDULE.weeksPerMonth * SCHEDULE.workDaysPerWeek;

const SHEET = 'Stoplight Report 2026, Targets';
const QUOTA_DOC = 'Sales Quota and Expectations';

/** Targets tab, ACQUISITIONS KPI TARGETS (monthly). Pipeline is a balance, so it is not prorated. */
export const ACQ_TARGETS = {
  pipeline: { expectation: 150_000, goal: 200_000, direction: 'higher', prorate: false, source: SHEET },
  revenue: { expectation: 75_000, goal: 100_000, direction: 'higher', prorate: true, source: SHEET },
  avgFee: { expectation: 15_000, goal: 20_000, direction: 'higher', prorate: false, source: SHEET },
} satisfies Record<string, Target>;

/** Sales Quota and Expectations, MONTHLY LEAD MANAGERS EXPECTATIONS / GOALS. */
export const LEAD_MANAGER_TARGETS = {
  appointments: { expectation: 15, goal: 30, direction: 'higher', prorate: true, source: QUOTA_DOC },
} satisfies Record<string, Target>;

/** Targets tab, DISPOSITIONS KPI TARGETS (monthly). The sheet marks deals assigned as a placeholder. */
export const DISPO_TARGETS = {
  dealsAssigned: { expectation: 5, goal: 6, direction: 'higher', prorate: true, source: SHEET, placeholder: true },
  revenue: { expectation: 75_000, goal: 100_000, direction: 'higher', prorate: true, source: SHEET },
  avgFee: { expectation: 15_000, goal: 20_000, direction: 'higher', prorate: false, source: SHEET },
} satisfies Record<string, Target>;

/**
 * Targets tab, ACQUISITIONS ACTIVITY MINIMUMS: hit any one per day. Graded by
 * how many were hit: 2 or more green, 1 yellow, none red. JV sellers is not
 * something CLOZR records, so it can never count as a hit here.
 */
export const ACQ_ACTIVITY = {
  mode: 'any' as const,
  daily: { contracts: 1, calls: 50, offers: 3, talkMin: 90, jvSellers: 2 },
};

/**
 * Targets tab, DISPOSITIONS DAILY ACTIVITY MINIMUMS, grading mode ALL (cell
 * C49): 4 of 4 green, 3 of 4 yellow, 2 or fewer red.
 */
export const DISPO_ACTIVITY = {
  mode: 'all' as const,
  daily: { buyerCalls: 50, talkMin: 90, buyersAdded: 3, offers: 2 },
};

/** Days a TC file can sit with no call, text, email, finished task or stage change before it reads stale. */
export const TC_STALE_DAYS = 7;

// ---- grading -----------------------------------------------------------------

/** The sheet's rule: green at the goal, yellow at the expectation, red below. A missing value is not graded. */
export function grade(value: number | null | undefined, t: Pick<Target, 'expectation' | 'goal' | 'direction'>): Light {
  if (value == null || !Number.isFinite(value)) return 'none';
  if (t.direction === 'higher') return value >= t.goal ? 'green' : value >= t.expectation ? 'yellow' : 'red';
  return value <= t.goal ? 'green' : value <= t.expectation ? 'yellow' : 'red';
}

/** A monthly target scaled to the workdays in the range (20 workdays a month), unless it is a balance. */
export function scaled(t: Target, workdays: number): { expectation: number; goal: number } {
  if (!t.prorate) return { expectation: t.expectation, goal: t.goal };
  const f = workdays / MONTH_WORKDAYS;
  return { expectation: t.expectation * f, goal: t.goal * f };
}

/** Activity hits graded the sheet's way: `any` needs 2 for green, `all` needs every one. */
export function activityLight(hits: number, of: number, mode: 'any' | 'all'): Light {
  if (of <= 0) return 'none';
  if (mode === 'any') return hits >= 2 ? 'green' : hits === 1 ? 'yellow' : 'red';
  return hits >= of ? 'green' : hits === of - 1 ? 'yellow' : 'red';
}

/** Week status from the sheet: any red is red, all green is green, else yellow. Ungraded cells don't count. */
export function overall(lights: Light[]): Light {
  const graded = lights.filter((l) => l !== 'none');
  if (!graded.length) return 'none';
  if (graded.includes('red')) return 'red';
  return graded.every((l) => l === 'green') ? 'green' : 'yellow';
}

/** A gap (overdue task, untouched lead, missed TC item) has one target: none. */
export const gapLight = (count: number): Light => (count > 0 ? 'red' : 'green');

// ---- ranges --------------------------------------------------------------------

export const STOPLIGHT_RANGES = ['This week', 'Last week', 'This month'] as const;
export type StoplightRange = (typeof STOPLIGHT_RANGES)[number];

const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isWorkday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

/** Monday to Friday days from `from` up to, not including, `to` (local days). */
export function workdaysBetween(from: Date, to: Date): number {
  let n = 0;
  for (let d = atMidnight(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) if (isWorkday(d)) n++;
  return n;
}

/**
 * The range's start and end, and the workdays the targets are scaled to.
 * Weeks start on Monday. A range still running counts today as a workday.
 */
export function stoplightRange(label: StoplightRange, now = new Date()): { from: Date; to: Date; workdays: number } {
  const today = atMidnight(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  if (label === 'Last week') {
    const from = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
    return { from, to: monday, workdays: workdaysBetween(from, monday) };
  }
  const from = label === 'This month' ? new Date(today.getFullYear(), today.getMonth(), 1) : monday;
  return { from, to: now, workdays: workdaysBetween(from, tomorrow) };
}

// ---- people ----------------------------------------------------------------------

/** What `team_stoplight` (migration 260) returns per teammate. */
export type StoplightMetrics = {
  calls: number; talk_min: number; conversations: number; appointments: number; calendar_meetings: number;
  offers: number; contracts: number;
  buyer_calls: number; buyer_talk_min: number; buyer_texts: number; buyers_added: number; buyer_offers: number;
  deals_marketed: number; buyer_contracts: number;
  closed_acq: number; revenue_acq: number; closed_dispo: number; revenue_dispo: number;
  pipeline_acq: number; pipeline_dispo: number;
};
export type GapItems = {
  overdue_tasks: { id: number; title: string; due_at: string; seller_id: number | null; deal_id: number | null; buyer_id: number | null; who: string | null }[];
  untouched_leads: { id: number; name: string | null; address: string | null; created_at: string }[];
  no_next_step: { deal_id: number; seller_id: number | null; label: string; stage: string }[];
};
export type StoplightPerson = {
  user_id: string; name: string; role: string; avatar_url: string | null; is_tc: boolean; last_call_at: string | null;
  metrics: StoplightMetrics;
  gaps: { overdue_tasks: number; overdue_unlinked: number; untouched_leads: number; no_next_step: number };
  items: GapItems;
};
export type TcFileRow = {
  transaction_id: number; deal_id: number; seller_id: number | null; label: string; stage: string; deal_type: string;
  contract_date: string | null; ctc_target: string | null; close_date: string | null; emd_received_at: string | null;
  checklist: string[]; schedule_c: unknown; tc_rep_id: string | null; last_activity_at: string | null;
};
export type StoplightPayload = {
  generated_at: string; from: string; to: string; stale_days: number;
  people: StoplightPerson[]; tc_files: TcFileRow[];
  noise: { prospect_deals: number; prospect_negative_fee: number; open_files_on_ended_deals: number; calendar_meetings: number; buyers_imported: number };
};

export type Lane = 'acquisitions' | 'dispositions' | 'tc' | 'other';
export const LANE_LABEL: Record<Lane, string> = { acquisitions: 'Acquisitions', dispositions: 'Dispositions', tc: 'Transaction coordination', other: 'Owners, admins and partners' };

/** Which targets a teammate is held to: their CLOZR role, or TC when they coordinate live files. */
export function laneOf(p: Pick<StoplightPerson, 'role' | 'is_tc'>): Lane {
  if (p.role === 'acquisitions') return 'acquisitions';
  if (p.role === 'dispositions') return 'dispositions';
  if (p.role === 'tc' || p.is_tc) return 'tc';
  return 'other';
}

export type Cell = {
  key: string;
  label: string;
  /** The number as it reads in the grid. */
  shown: string;
  /** The target as it reads, or null for "No target set". */
  target: string | null;
  /** The target squeezed for a grid cell ("goal $25K"); the full one goes in its title. */
  short: string | null;
  light: Light;
  /** Where the target came from, or why the cell is not graded. */
  note?: string;
  /**
   * False for a single daily minimum: the Activity cell already grades the
   * minimums as a block (any one, or all four), so one missed minimum does
   * not turn the whole row red on its own.
   */
  rollup?: false;
};

/** A teammate's overall light: every cell that rolls up, and every gap. */
export const personLight = (cells: Cell[], gaps: Cell[]): Light =>
  overall([...cells, ...gaps].filter((c) => c.rollup !== false).map((c) => c.light));

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const perDay = (n: number, wd: number) => (wd > 0 ? n / wd : 0);
const oneDp = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');
/** $18,750 as "$18.8K", $200,000 as "$200K". */
export const usdShort = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return '$' + oneDp(n / 1_000_000) + 'M';
  if (a >= 1_000) return '$' + oneDp(n / 1_000) + 'K';
  return usd(n);
};

function kpiCell(key: string, label: string, value: number | null, t: Target, workdays: number, money: boolean): Cell {
  const s = scaled(t, workdays);
  const f = money ? usd : (n: number) => (Number.isInteger(n) ? num(n) : oneDp(n));
  const goalText = f(s.goal);
  const expText = f(s.expectation);
  return {
    key, label,
    shown: value == null ? 'None yet' : f(value),
    target: `${expText} expected, ${goalText} goal`,
    short: `${money ? usdShort(s.expectation) : expText} / ${money ? usdShort(s.goal) : goalText} goal`,
    light: workdays > 0 || !t.prorate ? grade(value, { ...s, direction: t.direction }) : 'none',
    note: t.placeholder ? `${t.source}. The sheet marks this target as a placeholder.` : t.source,
  };
}

/**
 * A daily minimum, graded on the range's daily average: met when the total
 * reaches the minimum times the workdays. team_stoplight returns totals, not
 * per-day counts, so a heavy day can cover a light one; the note says so.
 */
function minimumCell(key: string, label: string, total: number, daily: number, workdays: number, unit = ''): { cell: Cell; hit: boolean } {
  const need = daily * workdays;
  const hit = workdays > 0 && total >= need;
  const cell: Cell = {
    key, label,
    shown: `${oneDp(perDay(total, workdays))}${unit}/day`,
    target: `${num(daily)}${unit}/day`,
    short: `min ${num(daily)}${unit}/day`,
    light: workdays > 0 ? (hit ? 'green' : 'red') : 'none',
    rollup: false,
    note: `${num(total)}${unit} in ${workdays} workday${workdays === 1 ? '' : 's'}, graded on the daily average, not day by day. Daily minimum from ${SHEET}.`,
  };
  return { cell, hit };
}

const untargeted = (key: string, label: string, shown: string, note: string): Cell => ({ key, label, shown, target: null, short: null, light: 'none', note });

/** The acquisitions row: the five activity minimums (graded as a block), then the KPIs. */
export function acquisitionsCells(m: StoplightMetrics, workdays: number): Cell[] {
  const d = ACQ_ACTIVITY.daily;
  const mins = [
    minimumCell('calls', 'Calls', m.calls, d.calls, workdays),
    minimumCell('talk', 'Talk time', m.talk_min, d.talkMin, workdays, ' min'),
    minimumCell('offers', 'Offers', m.offers, d.offers, workdays),
    minimumCell('contracts', 'Contracts', m.contracts, d.contracts, workdays),
  ];
  const hits = mins.filter((m) => m.hit).length;
  const activity: Cell = {
    key: 'activity', label: 'Activity',
    shown: `${hits} of 5 minimums`,
    target: '2 of 5 for green',
    short: '2 of 5',
    light: activityLight(hits, workdays > 0 ? 5 : 0, 'any'),
    note: `Any one daily minimum meets the standard (${SHEET}). JV sellers are not recorded in CLOZR, so that minimum never counts.`,
  };
  const avgFee = m.closed_acq > 0 ? m.revenue_acq / m.closed_acq : null;
  return [
    activity,
    ...mins.map((m) => m.cell),
    untargeted('conversations', 'Conversations', num(m.conversations), 'Calls of a minute or more. No target in the Drive docs.'),
    kpiCell('appointments', 'Appointments', m.appointments, LEAD_MANAGER_TARGETS.appointments, workdays, false),
    kpiCell('revenue', 'Closed revenue', m.revenue_acq, ACQ_TARGETS.revenue, workdays, true),
    kpiCell('pipeline', 'Pipeline', m.pipeline_acq, ACQ_TARGETS.pipeline, workdays, true),
    avgFee == null
      ? untargeted('avgFee', 'Average fee', 'No closings', `Graded once a deal closes: ${usd(ACQ_TARGETS.avgFee.expectation)} expected, ${usd(ACQ_TARGETS.avgFee.goal)} goal.`)
      : kpiCell('avgFee', 'Average fee', avgFee, ACQ_TARGETS.avgFee, workdays, true),
  ];
}

/** The dispositions row: the four daily minimums (all four for green), then the KPIs. */
export function dispositionsCells(m: StoplightMetrics, workdays: number): Cell[] {
  const d = DISPO_ACTIVITY.daily;
  const mins = [
    minimumCell('buyerCalls', 'Buyer calls', m.buyer_calls, d.buyerCalls, workdays),
    minimumCell('buyerTalk', 'Talk time', m.buyer_talk_min, d.talkMin, workdays, ' min'),
    minimumCell('buyersAdded', 'Buyers added', m.buyers_added, d.buyersAdded, workdays),
    minimumCell('buyerOffers', 'Buyer offers', m.buyer_offers, d.offers, workdays),
  ];
  const hits = mins.filter((m) => m.hit).length;
  const activity: Cell = {
    key: 'activity', label: 'Activity',
    shown: `${hits} of 4 minimums`,
    target: '4 of 4 for green',
    short: '4 of 4',
    light: activityLight(hits, workdays > 0 ? 4 : 0, 'all'),
    note: `Grading mode ALL on ${SHEET}: 3 of 4 is yellow, 2 or fewer is red.`,
  };
  const avgFee = m.closed_dispo > 0 ? m.revenue_dispo / m.closed_dispo : null;
  return [
    activity,
    ...mins.map((m) => m.cell),
    untargeted('buyerTexts', 'Buyer texts', num(m.buyer_texts), 'No target in the Drive docs.'),
    untargeted('marketed', 'Deals marketed', num(m.deals_marketed), 'The sheet tracks deals taken to market but sets no target.'),
    kpiCell('assigned', 'Buyer contracts', m.buyer_contracts, DISPO_TARGETS.dealsAssigned, workdays, false),
    kpiCell('revenue', 'Closed revenue', m.revenue_dispo, DISPO_TARGETS.revenue, workdays, true),
    avgFee == null
      ? untargeted('avgFee', 'Average fee', 'No closings', `Graded once a deal closes: ${usd(DISPO_TARGETS.avgFee.expectation)} expected, ${usd(DISPO_TARGETS.avgFee.goal)} goal.`)
      : kpiCell('avgFee', 'Average fee', avgFee, DISPO_TARGETS.avgFee, workdays, true),
  ];
}

/** The admin gaps every teammate has, graded against zero. */
export function gapCells(p: Pick<StoplightPerson, 'gaps'>): Cell[] {
  const g = p.gaps;
  return [
    { key: 'overdue', label: 'Overdue tasks', shown: num(g.overdue_tasks), target: '0', short: 'target 0', light: gapLight(g.overdue_tasks), note: 'Open tasks assigned to them, past due.' },
    { key: 'untouched', label: 'Leads never worked', shown: num(g.untouched_leads), target: '0', short: 'target 0', light: gapLight(g.untouched_leads), note: 'Leads assigned to them with no call, text or email out from anyone.' },
    { key: 'nonext', label: 'Deals with no next step', shown: num(g.no_next_step), target: '0', short: 'target 0', light: gapLight(g.no_next_step), note: 'Live deals they own, sell or coordinate with no open task.' },
  ];
}

// ---- TC files --------------------------------------------------------------------

export type TcGapKind = 'no_tc' | 'owner_check' | 'emd' | 'schedule_c' | 'schedule_c_blocker' | 'ctc' | 'novation_not_started' | 'stale';
export type TcGap = { kind: TcGapKind; text: string };

/** Checklist ids from supabase/functions/_shared/tc-checklists.ts, per file type. */
const TC_IDS = {
  assignment: { owner: 'a34', emd: 'a11', scheduleC: 'a17', ctc: 'a22' },
  novation: { owner: 'n41', emd: null, scheduleC: 'n21', ctc: 'n32' },
} as const;

const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

/**
 * What a TC file has missed as of `today` ('YYYY-MM-DD'). Day counts follow the
 * TC SOP: owner of record by D1, EMD to title by D2, Schedule C reviewed by D7,
 * CTC by the file's CTC target. `stale` is no activity in `staleDays`.
 */
export function tcFileGaps(f: TcFileRow, today: string, staleDays = TC_STALE_DAYS): TcGap[] {
  const novation = f.deal_type === 'novation';
  const ids = novation ? TC_IDS.novation : TC_IDS.assignment;
  const ticked = new Set(f.checklist ?? []);
  const cd = dayOf(f.contract_date);
  const past = (n: number) => !!cd && plusIsoDays(cd, n) < today;
  const out: TcGap[] = [];
  if (!f.tc_rep_id) out.push({ kind: 'no_tc', text: 'No TC assigned' });
  if (novation && ticked.size === 0) out.push({ kind: 'novation_not_started', text: 'Novation file not started: no checklist item ticked' });
  if (past(1) && !ticked.has(ids.owner)) out.push({ kind: 'owner_check', text: `Owner of record not checked (${ids.owner}, due D1)` });
  if (ids.emd && past(2) && !ticked.has(ids.emd) && !f.emd_received_at) out.push({ kind: 'emd', text: `EMD not confirmed with title (${ids.emd}, due D2)` });
  if (past(7) && !ticked.has(ids.scheduleC)) out.push({ kind: 'schedule_c', text: `Schedule C not reviewed (${ids.scheduleC}, due D7)` });
  const blockers = readScheduleC(f.schedule_c).filter((i) => i.status === 'red').length;
  if (blockers) out.push({ kind: 'schedule_c_blocker', text: `${blockers} Schedule C blocker${blockers === 1 ? '' : 's'} open` });
  const ctc = dayOf(f.ctc_target);
  if (ctc && ctc < today && !ticked.has(ids.ctc)) out.push({ kind: 'ctc', text: `CTC overdue since ${ctc} (${ids.ctc})` });
  const last = dayOf(f.last_activity_at);
  if (!last || plusIsoDays(last, staleDays) < today) out.push({ kind: 'stale', text: last ? `No activity since ${last}` : 'No activity logged' });
  return out;
}

/** The TC's own row: files, and how many of them miss each item. */
export function tcCells(files: TcFileRow[], today: string, unlinkedOverdue: number, staleDays = TC_STALE_DAYS): Cell[] {
  const gaps = files.map((f) => tcFileGaps(f, today, staleDays));
  const count = (k: TcGapKind) => gaps.filter((g) => g.some((x) => x.kind === k)).length;
  const clean = gaps.filter((g) => g.length === 0).length;
  const cell = (key: TcGapKind, label: string, note: string): Cell => {
    const n = count(key);
    return { key, label, shown: num(n), target: '0', short: 'target 0', light: gapLight(n), note };
  };
  return [
    { key: 'files', label: 'Open files', shown: num(files.length), target: null, short: null, light: 'none', note: `${num(clean)} with nothing missed. Files on live deals only.` },
    cell('owner_check', 'Owner check missed', 'Owner of record (a34 / n41) unticked after D1.'),
    cell('emd', 'EMD not confirmed', 'a11 unticked after D2 and no EMD receipt on the file.'),
    cell('schedule_c', 'Schedule C overdue', 'a17 / n21 unticked after D7.'),
    cell('schedule_c_blocker', 'Schedule C blockers', 'Files with a Schedule C item marked red (a blocker).'),
    cell('ctc', 'CTC overdue', 'Past the CTC target with a22 / n32 unticked.'),
    cell('novation_not_started', 'Novation not started', 'Novation files with no checklist item ticked.'),
    cell('stale', 'Stale files', `No call, text, email, finished task or stage change in ${staleDays} days.`),
    { key: 'unlinked', label: 'Overdue tasks off a deal', shown: num(unlinkedOverdue), target: '0', short: 'target 0', light: gapLight(unlinkedOverdue), note: 'Their overdue tasks with no deal attached.' },
  ];
}

// ---- links -----------------------------------------------------------------------

/**
 * The CLOZR address of a record (lib/nav-hash): the TC file, the seller, or the
 * deal sheet. `sample` is the /demo team (lib/stoplight-sample): its seller N is
 * the demo graph's person pN, and the demo has no deal ids to pin.
 */
export function recordHref(r: { screen: 'tc' | 'person' | 'dealSheet' | 'buyer'; sellerId?: number | null; dealId?: number | null; buyerId?: number | null }, sample = false): string {
  const q = new URLSearchParams({ screen: r.screen });
  if (r.screen === 'buyer') {
    if (r.buyerId) q.set('id', 'b' + r.buyerId);
  } else if (r.sellerId) q.set('id', (sample ? 'p' : 's') + r.sellerId);
  if (r.dealId && r.screen !== 'buyer' && !sample) q.set('deal', 'd' + r.dealId);
  q.set('from', 'reporting');
  return '#' + q.toString();
}
