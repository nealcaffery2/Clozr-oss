/**
 * Google Calendar push channels (events.watch), the pure half.
 *
 * Without a channel CLOZR only learns about a change made in Google Calendar
 * when the cron's calendar pass comes round, every 14 minutes. With one,
 * Google posts to google-calendar-push within seconds and that account's
 * calendar syncs at once. Polling stays as the fallback: a channel can lapse,
 * be refused, or miss a message, and the cron still catches up.
 *
 * Kept free of Deno so tools/calendar-watch.test.ts runs it under tsx.
 */

export type WatchFeed = {
  calendar_id: string;
  enabled: boolean;
  watch_channel_id: string | null;
  watch_resource_id: string | null;
  watch_expires_at: string | null;
};

/** Google allows up to about a week on a calendar channel; ask for that and renew a day early. */
export const WATCH_TTL_SECONDS = 7 * 24 * 3600;
export const RENEW_BEFORE_MS = 24 * 3_600_000;
/** After Google refuses a channel, wait this long before asking again (the cron keeps the calendar moving meanwhile). */
export const RETRY_AFTER_MS = 6 * 3_600_000;

/**
 * What to do with one feed's channel now.
 *  keep   a live channel with more than a day left
 *  renew  no channel, or one inside its last day: open a new one (and stop the old)
 *  stop   the feed was switched off: close its channel
 *  wait   Google refused last time; the backoff stamp has not run out
 *  none   switched off and nothing open
 */
export function watchPlan(f: WatchFeed, now = Date.now()): 'keep' | 'renew' | 'stop' | 'wait' | 'none' {
  const exp = f.watch_expires_at ? Date.parse(f.watch_expires_at) : NaN;
  if (!f.enabled) return f.watch_channel_id ? 'stop' : 'none';
  if (f.watch_channel_id) return Number.isFinite(exp) && exp - now > RENEW_BEFORE_MS ? 'keep' : 'renew';
  // No channel but a future expiry is the backoff marker a refusal leaves.
  if (Number.isFinite(exp) && exp > now) return 'wait';
  return 'renew';
}

/** Constant-time string compare, for the channel token Google echoes back. */
export function sameToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a push should start a sync. Google's first message on a new channel
 * is resource state `sync`, which says only that the channel works; `exists`
 * (something changed) and `not_exists` (something was deleted) are the ones
 * worth a pass.
 */
export const pushWantsSync = (state: string | null | undefined): boolean => state === 'exists' || state === 'not_exists';

/**
 * Whether the cron should run an account's calendar now: the 14-minute gate,
 * or a push from Google newer than the last pass, whatever the gate says.
 */
export function calendarDue(a: { last_calendar_sync_at: string | null; calendar_push_at?: string | null }, now = Date.now(), gateMs = 14 * 60_000): boolean {
  const last = a.last_calendar_sync_at ? Date.parse(a.last_calendar_sync_at) : NaN;
  if (!Number.isFinite(last) || last < now - gateMs) return true;
  const pushed = a.calendar_push_at ? Date.parse(a.calendar_push_at) : NaN;
  return Number.isFinite(pushed) && pushed > last;
}
