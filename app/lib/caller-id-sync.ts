// A rep's default caller ID lives in two places: Talkr's
// default_phone_number_id (what actually dials) and CLOZR's
// rep_phone_numbers.is_caller_id (the Numbers page, credit, reporting). This
// decides which side to write so the two agree. Talkr wins when it has a
// default, because that is the number the call goes out on; CLOZR only fills
// Talkr in when Talkr has none.
//
// Pure, so tools/caller-id-sync.test.ts covers it. lib/caller-id-link.ts does
// the writes.
import { e164 } from './number-book';

export type CallerIdRow = { phone_e164: string; user_id: string | null; is_caller_id?: boolean | null };
export type CallerIdMe = {
  id: string;
  default_phone_number_id: string | null;
  org_numbers: Array<{ id: string; phone_e164: string; assigned_user_id: string | null }>;
};

export type CallerIdPlan =
  | { write: 'none' }
  | { write: 'clozr'; phone: string }
  | { write: 'talkr'; numberId: string };

/**
 * The CLOZR line to flag after the rep picks `phone` in the dialer, or null.
 * Only the rep's own row: an admin's RPC would otherwise move a teammate's
 * caller ID just because the admin dialed from that teammate's line.
 */
export function clozrPickFor(userId: string, rows: CallerIdRow[], phone: string | null | undefined): string | null {
  const want = e164(phone);
  if (!want) return null;
  const row = rows.find((r) => r.user_id === userId && e164(r.phone_e164) === want);
  return row && !row.is_caller_id ? row.phone_e164 : null;
}

/** What to write, once per load, so CLOZR and Talkr name the same default line. */
export function callerIdSyncPlan(userId: string, rows: CallerIdRow[], me: CallerIdMe): CallerIdPlan {
  const talkrDefault = me.org_numbers.find((n) => n.id === me.default_phone_number_id) ?? null;
  if (talkrDefault) {
    const phone = clozrPickFor(userId, rows, talkrDefault.phone_e164);
    return phone ? { write: 'clozr', phone } : { write: 'none' };
  }
  const flagged = rows.find((r) => r.user_id === userId && r.is_caller_id);
  const want = e164(flagged?.phone_e164);
  if (!want) return { write: 'none' };
  // Never point Talkr at a line Talkr hands to someone else.
  const line = me.org_numbers.find((n) => e164(n.phone_e164) === want && (n.assigned_user_id == null || n.assigned_user_id === me.id));
  return line ? { write: 'talkr', numberId: line.id } : { write: 'none' };
}
