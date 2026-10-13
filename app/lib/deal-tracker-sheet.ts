// The 2026 Acme Homes Deal Tracker, Deals tab. Column order and the formulas
// behind the calculated columns (Days to Close, Closing Month, Sched Mo,
// Booked Spread, Close Mo, Written Mo, Week Sort Key).
//
// Booked Spread is the sheet's V column: a closed deal with a dispo fee uses
// that fee; otherwise a live, escrowed, closed or terminated deal is
// buyer price minus seller price minus price drop, and a novation also gives
// up 8% of the buyer price (Settings!I14). Week Sort Key marks an escrow whose
// scheduled close falls in the current Sunday–Saturday week.

import { parseDealType } from './deal-types';

/** Labels for `cells`, in the order the Deals table has always keyed them.
 *  The six calculated columns are appended so a saved view's c0–c28 stay put. */
export const DEAL_COL_LABELS = [
  'Property #', 'Contract Date', 'Scheduled Close', 'Days to Close', 'Address',
  'Seller Price', 'Price Drop', 'Marketed Price', 'Marketed Fee', 'Dispo Price',
  'Dispo Upsell', 'Dispo Fee', 'Acquisitions Agent', 'Dispositions Agent',
  'Transaction Type', 'Actual Close Date', 'Lead Manager', 'Coordinator',
  'Contract Status', 'Lead Source', 'Seller', 'Seller Phone', 'Seller Email',
  'City', 'ARV', 'Days in Stage', 'Seller option', 'Buyer option', 'Date added',
  'Closing Month', 'Sched Mo ★', 'Booked Spread ★', 'Close Mo', 'Written Mo', 'Week Sort Key',
] as const;

/** What the Deals table shows before anyone saves a view: the tracker, left to right. */
export const DEAL_TABLE_DEFAULT = [
  'Property #', 'Contract Date', 'Scheduled Close', 'Days to Close', 'Address',
  'Seller Price', 'Price Drop', 'Marketed Price', 'Marketed Fee', 'Dispo Price',
  'Dispo Upsell', 'Dispo Fee', 'Acquisitions Agent', 'Dispositions Agent',
  'Transaction Type', 'Actual Close Date', 'Lead Manager', 'Coordinator',
  'Contract Status', 'Closing Month', 'Sched Mo ★', 'Booked Spread ★', 'Lead Source',
  'Close Mo', 'Written Mo', 'Week Sort Key', 'Date added',
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Settings!I14, Novation Fee %. */
export const NOVATION_FEE_PCT = 0.08;

export type TrackerSheetInput = {
  contractDate?: string | null;
  scheduledClose?: string | null;
  closedOn?: string | null;
  sellerPrice?: number | null;
  priceDrop?: number | null;
  marketedPrice?: number | null;
  dispoPrice?: number | null;
  dispoFee?: number | null;
  transactionType?: string | null;
  contractStatus?: string | null;
};

export type TrackerSheet = {
  daysToClose: number | null;
  closingMonth: string | null;
  schedMo: string | null;
  bookedSpread: number;
  closeMo: string | null;
  writtenMo: string | null;
  /** Scheduled close (ISO date) when this escrow closes in the current week. */
  weekSort: string | null;
};

type Day = { y: number; m: number; d: number };

function dayOf(iso: string | null | undefined): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function utc(day: Day): number {
  return Date.UTC(day.y, day.m - 1, day.d);
}

function monthName(day: Day | null): string | null {
  return day ? MONTHS[day.m - 1] ?? null : null;
}

function num(v: number | null | undefined): number {
  return v == null || !Number.isFinite(Number(v)) ? 0 : Number(v);
}

/** The sheet's status words. Pipeline stages ("In Escrow", "Under Contract Seller") count as the same. */
export function trackerStatus(status: string | null | undefined): string {
  const s = String(status ?? '').trim();
  if (/^closed$/i.test(s)) return 'Closed';
  if (/terminat/i.test(s)) return 'Terminated';
  if (/escrow/i.test(s)) return 'Escrow';
  if (/under contract/i.test(s)) return 'Under Contract';
  return s;
}

const SPREAD_STATUSES = new Set(['Closed', 'Under Contract', 'Escrow', 'Terminated']);

/**
 * Days from contract to the actual close, or to the scheduled close when it
 * has not closed. Blank until there is a contract date and one of those.
 */
export function daysToClose(contractDate: string | null | undefined, scheduledClose: string | null | undefined, closedOn: string | null | undefined): number | null {
  const start = dayOf(contractDate);
  const end = dayOf(closedOn) ?? dayOf(scheduledClose);
  if (!start || !end) return null;
  return Math.round((utc(end) - utc(start)) / 86400000);
}

export function closingMonth(closedOn: string | null | undefined): string | null {
  const day = dayOf(closedOn);
  if (!day) return null;
  return `${day.y}-${String(day.m).padStart(2, '0')}`;
}

export function bookedSpread(input: TrackerSheetInput): number {
  const status = trackerStatus(input.contractStatus);
  const fee = num(input.dispoFee);
  if (status === 'Closed' && fee > 0) return fee;
  if (!SPREAD_STATUSES.has(status)) return 0;
  const buyer = num(input.dispoPrice) > 0 ? num(input.dispoPrice) : num(input.marketedPrice);
  let spread = buyer - num(input.sellerPrice) - num(input.priceDrop);
  if (parseDealType(input.transactionType)?.key === 'novation') spread -= buyer * NOVATION_FEE_PCT;
  return Math.round(spread * 100) / 100;
}

/** Sunday through Saturday of the week that contains `now`, as UTC midnights. */
function weekSpan(now: Date): { start: number; end: number } {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  local.setDate(local.getDate() - local.getDay());
  const start = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
  return { start, end: start + 6 * 86400000 };
}

export function weekSortDate(status: string | null | undefined, scheduledClose: string | null | undefined, now: Date): string | null {
  if (trackerStatus(status) !== 'Escrow') return null;
  const day = dayOf(scheduledClose);
  if (!day) return null;
  const { start, end } = weekSpan(now);
  const at = utc(day);
  if (at < start || at > end) return null;
  return `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
}

export function trackerSheet(input: TrackerSheetInput, now = new Date()): TrackerSheet {
  const closed = dayOf(input.closedOn);
  const scheduled = dayOf(input.scheduledClose);
  const written = dayOf(input.contractDate);
  return {
    daysToClose: daysToClose(input.contractDate, input.scheduledClose, input.closedOn),
    closingMonth: closingMonth(input.closedOn),
    schedMo: monthName(scheduled),
    bookedSpread: bookedSpread(input),
    closeMo: monthName(closed),
    writtenMo: monthName(written),
    weekSort: weekSortDate(input.contractStatus, input.scheduledClose, now),
  };
}
