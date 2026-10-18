// A date filter: a named window, or a custom from/to. Dates are local calendar
// days. A record with no timestamp is outside every window.

export const DATE_RANGES = [
  'Any', 'Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month', 'This year', 'Custom',
] as const;

const DAY = 86_400_000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Inclusive local day from an `<input type="date">` value. Null when it is not a date. */
function dayStart(iso: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The window as [lo, hi) epoch ms. Null for 'Any', an empty choice or an
 * unknown name (everything matches); Custom with no dates is null too.
 * Infinity on an open side. Server-side paging sends these bounds.
 */
export function dateWindowBounds(when: string | undefined, from?: string, to?: string, now = new Date()): { lo: number; hi: number } | null {
  if (!when || when === 'Any') return null;
  const today = startOfDay(now);
  switch (when) {
    case 'Today': return { lo: today, hi: today + DAY };
    case 'Yesterday': return { lo: today - DAY, hi: today };
    case 'Last 7 days': return { lo: today - 6 * DAY, hi: today + DAY };
    case 'Last 30 days': return { lo: today - 29 * DAY, hi: today + DAY };
    case 'Last 90 days': return { lo: today - 89 * DAY, hi: today + DAY };
    case 'This month': return { lo: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), hi: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() };
    case 'Last month': return { lo: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), hi: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
    case 'This year': return { lo: new Date(now.getFullYear(), 0, 1).getTime(), hi: new Date(now.getFullYear() + 1, 0, 1).getTime() };
    case 'Custom': {
      const a = dayStart(from);
      const b = dayStart(to);
      if (a == null && b == null) return null;
      return { lo: a ?? -Infinity, hi: b == null ? Infinity : b + DAY };
    }
    default: return null;
  }
}

/**
 * Does this timestamp fall in the window. 'Any' and an empty choice match
 * everything. Custom is inclusive of both days; a missing end is open.
 */
export function inDateWindow(
  iso: string | null | undefined,
  when: string | undefined,
  from?: string,
  to?: string,
  now = new Date(),
): boolean {
  if (!when || when === 'Any') return true;
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return false;
  const w = dateWindowBounds(when, from, to, now);
  return !w || (t >= w.lo && t < w.hi);
}
