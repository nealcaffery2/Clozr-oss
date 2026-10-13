// Which line a reply goes out on.
//
// A thread stays on the line already carrying it, so the seller keeps one
// conversation. The transaction coordinator is the exception: she texts as
// herself. Replying on the assigned rep's line put her words under his name
// and number, and the line-owner trigger (migration 153) then credited the
// text to him on the timeline, the leaderboard and the bell.

type Line = { id: string; phone_e164: string; assigned_user_id: string | null };
export type LineOwner = {
  id: string;
  numbers: { id: string }[];
  org_numbers: Line[];
  default_phone_number_id: string | null;
};

/**
 * The line id for a reply on a thread whose org line is `ourNumber` (null on a
 * brand-new thread). `asSelf` is the TC rule: a teammate's line gives way to
 * the sender's own default; a shared line (no owner) or her own stays.
 */
export function replyLine(me: LineOwner, ourNumber: string | null, asSelf: boolean): string | null {
  const own = me.default_phone_number_id ?? me.numbers[0]?.id ?? null;
  if (!ourNumber) return own ?? me.org_numbers[0]?.id ?? null;
  const thread = me.org_numbers.find((n) => n.phone_e164 === ourNumber) ?? null;
  if (!thread) return null;
  const teammates = !!thread.assigned_user_id && thread.assigned_user_id !== me.id;
  return asSelf && teammates && own ? own : thread.id;
}

/** Roles that text as themselves rather than on the thread's line. */
export const textsAsSelf = (role: string | null | undefined) => role === 'tc';

// lib/sms and the phone hook send outside React, so the session sets this once
// the signed-in user's workspace role is read.
let asSelf = false;
export function setSenderRole(role: string | null | undefined) { asSelf = textsAsSelf(role); }
export const sendsAsSelf = () => asSelf;
