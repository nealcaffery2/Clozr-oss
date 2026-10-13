// Who signs when, who is only copied, and when to nudge. No I/O:
// tools/signing-order.test.ts covers it; esign, contracts and docs-remind use it.
//
//   signer  must sign; the contract completes when every signer has
//   cc      gets the signed copy at the end, never a signing link
//   viewer  may open and read, never signs, never holds anything up
//   approver  internal sign-off before it goes out (the COO on an assignment):
//            never a signatory; while any approver has not approved, nobody
//            else gets a link and nobody can sign (migration 114)
//   filler  fills in their fields on a PDF and presses Done (status
//           'filled'): takes a turn like a signer and must finish before the
//           contract completes, but never signs and is never a signatory
//
// Parallel: every signer gets a link at once. Sequential: by `sort`, one
// turn at a time; signers sharing a `sort` sign together. A recipient whose
// signature was handed to someone else (status `delegated`) is closed: the
// person they delegated to holds their place.

export type RecipientType = 'signer' | 'approver' | 'cc' | 'viewer' | 'filler';
export type OrderMode = 'parallel' | 'sequential';
export type Recip = { id: number; sort?: number | null; status?: string | null; recipient_type?: string | null; email?: string | null };

/** Takes a turn: signers, and fillers (who fill in fields rather than sign). Approvers gate the send instead. */
export const signs = (r: Recip) => !['cc', 'viewer', 'approver'].includes(String(r.recipient_type ?? 'signer'));
export const isApprover = (r: Recip) => String(r.recipient_type ?? '') === 'approver';
export const fills = (r: Recip) => String(r.recipient_type ?? 'signer') === 'filler';
/** Their turn is over: signed, or for a filler, done filling in. */
export const isDone = (r: Recip) => r.status === 'signed' || (fills(r) && r.status === 'filled');
/** Handed to someone else: no longer holds anything up, and their link is dead. */
export const delegated = (r: Recip) => r.status === 'delegated';

/** Approvers who have not approved yet (a rejection counts as not approved). */
export function pendingApprovals<T extends Recip>(all: T[]): T[] {
  return all.filter((r) => isApprover(r) && !delegated(r) && r.status !== 'approved');
}

/** True while an approver still has to sign off: nothing goes to signers until then. */
export const needsApproval = (all: Recip[]) => pendingApprovals(all).length > 0;

/** Signers (and fillers) who still have to finish, in order. */
export function pending<T extends Recip>(all: T[]): T[] {
  return all.filter((r) => signs(r) && !isDone(r) && !delegated(r)).sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
}

/** Whose turn it is: everyone unsigned (parallel), or the lowest unsigned `sort` (sequential). Nobody's while approval is pending. */
export function turn<T extends Recip>(all: T[], mode: OrderMode | string | null | undefined): T[] {
  if (needsApproval(all)) return [];
  const left = pending(all);
  if (mode !== 'sequential' || !left.length) return left;
  const first = Number(left[0].sort ?? 0);
  return left.filter((r) => Number(r.sort ?? 0) === first);
}

export const canSignNow = (all: Recip[], mode: OrderMode | string | null | undefined, id: number) => turn(all, mode).some((r) => r.id === id);

/** Every signer has signed, every filler is done (cc and viewers never hold it up; approvers must have approved). */
export const allSigned = (all: Recip[]) => all.some((r) => signs(r) && !delegated(r)) && pending(all).length === 0 && !needsApproval(all);

/**
 * Who gets a link when it is sent: the current turn, plus viewers. CC waits
 * for the signed copy. With an approval outstanding, only the approvers who
 * still have to approve: the document goes out after they sign off.
 */
export function sendTo<T extends Recip>(all: T[], mode: OrderMode | string | null | undefined): T[] {
  if (needsApproval(all)) return pendingApprovals(all);
  const now = new Set(turn(all, mode).map((r) => r.id));
  return all.filter((r) => now.has(r.id) || (String(r.recipient_type) === 'viewer' && !delegated(r)));
}

/** Emails already on the contract as CC, lowercased, once each. */
export function ccAddresses(all: { email?: string | null; recipient_type?: string | null }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of all) {
    if (String(r.recipient_type ?? '') !== 'cc') continue;
    const email = String(r.email ?? '').trim().toLowerCase();
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export type TcCopy = { email: string; name?: string | null };

/** The contracts TC is copied on every send. Someone already on the contract is not added twice. */
export function appendTcCc<T extends { email?: string | null }>(signers: T[], tcs: TcCopy[]): T[] {
  const have = new Set(signers.map((s) => String(s.email ?? '').trim().toLowerCase()).filter((e) => e.includes('@')));
  const extra: T[] = [];
  let n = 0;
  for (const tc of tcs) {
    const email = String(tc.email ?? '').trim().toLowerCase();
    if (!email.includes('@') || have.has(email)) continue;
    have.add(email);
    n += 1;
    extra.push({
      role: `tc_cc${n}`, label: 'CC', name: tc.name ?? null, email, phone: null,
      optional: false, recipient_type: 'cc',
    } as unknown as T);
  }
  return extra.length ? [...signers, ...extra] : signers;
}

export type ReminderPolicy = { first_after_days?: number; repeat_every_days?: number; max?: number };
export const DEFAULT_REMINDERS: Required<ReminderPolicy> = { first_after_days: 1, repeat_every_days: 2, max: 10 };

/**
 * Is a reminder due for this signer? The first goes `first_after_days` after
 * the link went out (or after it became their turn), then every
 * `repeat_every_days`, up to `max`. A 0 turns reminders off.
 */
export function reminderDue(
  p: ReminderPolicy | null | undefined,
  since: string | null | undefined, lastReminded: string | null | undefined, count: number, now = Date.now(),
): boolean {
  const pol = { ...DEFAULT_REMINDERS, ...(p ?? {}) };
  if (!pol.first_after_days || count >= pol.max) return false;
  const day = 864e5;
  if (!lastReminded) return !!since && now - Date.parse(since) >= pol.first_after_days * day;
  if (!pol.repeat_every_days) return false;
  return now - Date.parse(lastReminded) >= pol.repeat_every_days * day;
}

/** Reminders go out 8am–8pm in the deal's time zone (Central when it has none). */
export function inSendingHours(now = new Date(), tz = 'America/Chicago'): boolean {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(now));
  return h >= 8 && h < 20;
}
