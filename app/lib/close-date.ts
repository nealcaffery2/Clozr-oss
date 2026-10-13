// The close date on a Deals card: when it closes (or closed), how far away,
// and how loudly to say it. Dates are calendar days (`deals.close_date` and
// `closed_on` are `date` columns), compared with today's local date, so a
// deal closing tomorrow says "Tomorrow" all day, in any timezone.

export type CloseTone = 'closed' | 'late' | 'today' | 'soon' | 'upcoming' | 'missing';
export type CloseBadge = { tone: CloseTone; label: string; detail: string; title: string };

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A `YYYY-MM-DD` (or ISO timestamp) as a calendar day, or null. */
function dayOf(v: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

const utc = (x: { y: number; m: number; d: number }) => Date.UTC(x.y, x.m - 1, x.d);

/** "Tue Oct 21", with the year only when it is not this year. */
export function closeDayLabel(v: string, now: Date = new Date()): string {
  const x = dayOf(v);
  if (!x) return '';
  const wd = WEEKDAYS[new Date(utc(x)).getUTCDay()];
  return `${wd} ${MONTHS[x.m - 1]} ${x.d}${x.y !== now.getFullYear() ? `, ${x.y}` : ''}`;
}

/** Stages where a deal should already have a close date: contract onward. */
export const needsCloseDate = (stage: string) => /contract|market|escrow|closing|assigned|dispo/i.test(stage) && !/^prospect/i.test(stage);

/**
 * What the card says about closing. Closed deals show when they closed; open
 * deals show the scheduled date and the days left (or late). A contract-stage
 * deal with no date says so; other stages with no date show nothing (null).
 */
export function closeBadge(input: { scheduled?: string | null; closedOn?: string | null; stage: string }, now: Date = new Date()): CloseBadge | null {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const closed = dayOf(input.closedOn);
  if (closed || /^closed$/i.test(input.stage)) {
    const when = input.closedOn ?? input.scheduled;
    if (!dayOf(when)) return { tone: 'closed', label: 'Closed', detail: '', title: 'Closed; no close date on file' };
    return { tone: 'closed', label: `Closed ${closeDayLabel(when!, now)}`, detail: '', title: `Closed on ${when!.slice(0, 10)}` };
  }
  if (/terminated|realtor referral/i.test(input.stage)) return null;
  const sched = dayOf(input.scheduled);
  if (!sched) {
    return needsCloseDate(input.stage)
      ? { tone: 'missing', label: 'No close date', detail: '', title: 'This deal is under contract with no close date. Open the deal to set it.' }
      : null;
  }
  const days = Math.round((utc(sched) - today) / DAY);
  const label = `Closes ${closeDayLabel(input.scheduled!, now)}`;
  const title = `Scheduled close ${input.scheduled!.slice(0, 10)}`;
  if (days < 0) {
    const late = -days;
    return { tone: 'late', label: `Due ${closeDayLabel(input.scheduled!, now)}`, detail: `${late} day${late === 1 ? '' : 's'} late`, title };
  }
  if (days === 0) return { tone: 'today', label: 'Closes today', detail: closeDayLabel(input.scheduled!, now), title };
  if (days === 1) return { tone: 'soon', label, detail: 'Tomorrow', title };
  if (days <= 3) return { tone: 'soon', label, detail: `in ${days} days`, title };
  return { tone: 'upcoming', label, detail: `in ${days} days`, title };
}

/** Sort key: soonest scheduled close first; closed and undated deals last. */
export function closeSortKey(scheduled: string | null | undefined): number {
  const x = dayOf(scheduled);
  return x ? utc(x) : Number.MAX_SAFE_INTEGER;
}
