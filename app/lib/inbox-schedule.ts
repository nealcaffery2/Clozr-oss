// Scheduled texts (migration 367): the composer's "Send later" presets, the
// label on a pending bubble, and the due rule the scheduled-send tick applies.
// Pure, so `npx tsx tools/inbox-schedule.test.ts` covers it without the DOM.

export type SchedulePreset = 'hour' | 'tomorrow' | 'monday' | 'pick';

export const PRESETS: { id: SchedulePreset; label: string }[] = [
  { id: 'hour', label: 'In 1 hour' },
  { id: 'tomorrow', label: 'Tomorrow 9:00 am' },
  { id: 'monday', label: 'Monday 9:00 am' },
  { id: 'pick', label: 'Pick a time' },
];

/** When a preset sends, from `now` in the rep's local time. `pick` has no time of its own. */
export function presetTime(id: SchedulePreset, now: Date = new Date()): Date | null {
  if (id === 'hour') return new Date(now.getTime() + 3600_000);
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (id === 'tomorrow') { d.setDate(d.getDate() + 1); return d; }
  if (id === 'monday') {
    // The coming Monday; a Monday before 9 am counts as today.
    const ahead = (8 - d.getDay()) % 7;
    d.setDate(d.getDate() + (ahead === 0 && d <= now ? 7 : ahead));
    return d;
  }
  return null;
}

/** A Date as `<input type="datetime-local">` wants it, in local time. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Why a time cannot be scheduled, or null when it can. */
export function scheduleProblem(at: Date | null, now: Date = new Date()): string | null {
  if (!at || Number.isNaN(at.getTime())) return 'Pick a date and time.';
  if (at.getTime() < now.getTime() + 60_000) return 'That time has passed. Send it now instead.';
  if (at.getTime() > now.getTime() + 90 * 86_400_000) return 'Schedule at most 90 days out.';
  return null;
}

/** "Sends Mon 9:00 am", "Sends tomorrow 9:00 am", "Sends today 3:15 pm", or the date when it is further out. */
export function sendsLabel(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `Sends today ${time}`;
  if (days === 1) return `Sends tomorrow ${time}`;
  if (days > 1 && days < 7) return `Sends ${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `Sends ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** The tick's rule (scheduled_claim): due, and not held by a tick that is still running. */
export function isDue(row: { status: string; send_at: string; claimed_at: string | null }, now: Date = new Date()): boolean {
  if (row.status !== 'scheduled') return false;
  if (Date.parse(row.send_at) > now.getTime()) return false;
  return !row.claimed_at || Date.parse(row.claimed_at) < now.getTime() - 10 * 60_000;
}

/** Due rows, oldest first, at most `limit`. */
export function dueRows<T extends { status: string; send_at: string; claimed_at: string | null }>(rows: readonly T[], now: Date = new Date(), limit = 20): T[] {
  return rows.filter((r) => isDue(r, now)).sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at)).slice(0, limit);
}
