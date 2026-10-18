/**
 * Which google_accounts writes a Google sync makes: only what changed. Pure,
 * so tools/google-writes.test.ts runs it without Deno or Google.
 */
import { FAST_BEHIND_MS } from './gmail-lanes.ts';

/**
 * On a quiet minute last_gmail_sync_at is a heartbeat, not a cursor: nothing
 * arrived, so the next window has nothing new to start after. Who reads it,
 * tightest first: the slow lane's catch-up (fast lane behind past
 * FAST_BEHIND_MS), the window's start (already 15 minutes of overlap), the
 * Google card's "Last run", gmailQuick's own "current" check and upkeep's
 * edge (an hour each), scanBounces' look-back (days). Stamped once it is half
 * of FAST_BEHIND_MS old, so with the minute cron it never reaches
 * FAST_BEHIND_MS and every other minute writes nothing.
 */
export const QUIET_STAMP_MS = FAST_BEHIND_MS / 2;

/**
 * The write a quiet check makes. A moved historyId is kept with the stamp,
 * as before. An unchanged one stamps only when the stored stamp is due, or
 * unreadable, or ahead of the clock (so a stamp from the future still heals).
 * Null: nothing to write.
 */
export function quietPatch(o: { verdict: 'quiet' | 'history'; historyId: string | null; last: string | null; startedAt: Date }): Record<string, string | null> | null {
  const stamp = o.startedAt.toISOString();
  if (o.verdict === 'history') return { last_gmail_sync_at: stamp, gmail_history_id: o.historyId };
  const age = o.startedAt.getTime() - (o.last ? Date.parse(o.last) : NaN);
  return age >= 0 && age < QUIET_STAMP_MS ? null : { last_gmail_sync_at: stamp };
}

/** `patch` without the keys `was` already holds with the same value. A key `was` does not know (undefined) is kept. */
export function changedOnly(patch: Record<string, unknown>, was: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([k, v]) => was[k] === undefined || was[k] !== v));
}
