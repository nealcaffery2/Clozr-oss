// Who gets a document and how it reaches them: approvers, delegation, a
// recipient added after sending, and signing links by text (migration 114).
// No I/O: tools/docs-people.test.ts covers it; esign, contracts, docs-remind
// and the app's recipient picker use it.

export type Delivery = 'email' | 'sms' | 'both';

/** Anything else (null, a typo) is email, which is what every recipient had before. */
export const normalizeDelivery = (v: unknown): Delivery => (v === 'sms' || v === 'both' ? v : 'email');

type Reach = { delivery?: string | null; email?: string | null; phone?: string | null };
/** Email the link: email or both, and there is an address. */
export const wantsEmail = (r: Reach) => normalizeDelivery(r.delivery) !== 'sms' && !!(r.email ?? '').trim();
/** Text the link: sms or both, and there is a number that can take a text. */
export const wantsSms = (r: Reach) => normalizeDelivery(r.delivery) !== 'email' && !!phoneE164(r.phone);

/** Last ten digits, so "(210) 555-0100" and "+12105550100" are one phone (lib/import-dedupe.ts agrees). */
export const phoneKey = (v: string | null | undefined): string | null => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
};

/** A US number as +1XXXXXXXXXX, or null when it is not ten digits. */
export function phoneE164(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

/** "(210) 555-0100" → "•••-•••-0100". */
export const maskPhone = (v: string | null | undefined) => {
  const k = phoneKey(v);
  return k ? `•••-•••-${k.slice(-4)}` : '•••';
};

export const phonesMatch = (a: string | null | undefined, b: unknown) => {
  const x = phoneKey(a);
  return !!x && x === phoneKey(typeof b === 'string' ? b : null);
};

/** Opened with a texted code: a phone on file, proven, and this browser holds the gate. */
export function phoneGateOk(
  s: { phone?: string | null; phone_verified_at?: string | null; access_gate?: string | null },
  gate: unknown,
): boolean {
  if (!phoneKey(s.phone) || !s.phone_verified_at || !s.access_gate) return false;
  return s.access_gate === String(gate ?? '');
}

const short = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v);
const first = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || '';

/**
 * The text a signing link goes out as. Short on purpose: one segment when the
 * link allows it, and nothing a carrier would read as marketing.
 *   "Acme Homes: Karen, please review and sign Purchase Agreement: https://…"
 */
export function signingText(p: { company: string | null | undefined; name?: string | null; doc: string; url: string; reminder?: boolean; approve?: boolean }): string {
  const who = first(p.name);
  const co = (p.company ?? '').trim() || 'CLOZR';
  const verb = p.approve ? 'review and approve' : 'review and sign';
  const lead = p.reminder ? `Reminder${who ? `, ${who}` : ''}: please` : `${who ? `${who}, please` : 'Please'}`;
  return `${co}: ${lead} ${verb} ${short(p.doc.trim() || 'your document', 60)}: ${p.url}`;
}

/** The access code by text. */
export const codeText = (company: string | null | undefined, doc: string, code: string) =>
  `${(company ?? '').trim() || 'CLOZR'}: your code to open ${short(doc.trim() || 'the document', 50)} is ${code}. It expires in 10 minutes.`;

/**
 * Which side of the deal a template role is on, for "save as a new Person or
 * Buyer?". Sellers are People; buyers, assignees and end buyers are Buyers.
 * Company, TC, title and anyone else: null (not saved to either list by default).
 */
export function sideOfRole(role: string | null | undefined): 'seller' | 'buyer' | null {
  const r = (role ?? '').toLowerCase();
  if (/^(seller|owner|grantor|optionor)/.test(r)) return 'seller';
  if (/^(buyer|assignee|purchaser|end_?buyer|grantee|optionee|investor)/.test(r)) return 'buyer';
  return null;
}

/** The CRM list a typed-in recipient goes to by default: People for the seller side, Buyers for the buyer side. */
export const defaultCrmKind = (role: string | null | undefined): 'seller' | 'buyer' => (sideOfRole(role) === 'buyer' ? 'buyer' : 'seller');

/**
 * Where a recipient added after sending lands in the order. `position` is
 * 1-based among the recipients as listed (by sort); anything past the end
 * appends. Returns the new recipient's sort and the rows that move down one.
 */
export function insertAt(existing: { id: number; sort?: number | null }[], position: number | null | undefined): { sort: number; shift: { id: number; sort: number }[] } {
  const rows = [...existing].sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
  const max = rows.reduce((m, r) => Math.max(m, Number(r.sort ?? 0)), 0);
  const pos = Math.floor(Number(position ?? 0));
  if (!pos || pos > rows.length) return { sort: max + 1, shift: [] };
  const at = Number(rows[Math.max(0, pos - 1)].sort ?? 0);
  return { sort: at, shift: rows.filter((r) => Number(r.sort ?? 0) >= at).map((r) => ({ id: r.id, sort: Number(r.sort ?? 0) + 1 })) };
}

/**
 * The role a delegated recipient keeps, renamed so the person they handed it
 * to owns the signature line (every renderer finds a signer by role).
 */
export const delegatedRole = (role: string, id: number) => `${role}~delegated${id}`;

/** Approve or reject: a rejection needs a reason, because the sender has to act on it. */
export function approvalDecision(decision: unknown, reason: unknown): { ok: true; approve: boolean; reason: string | null } | { ok: false; message: string } {
  const d = String(decision ?? '').toLowerCase();
  const why = String(reason ?? '').trim().slice(0, 500) || null;
  if (d === 'approve' || d === 'approved') return { ok: true, approve: true, reason: why };
  if (d === 'reject' || d === 'rejected') {
    if (!why) return { ok: false, message: 'Say why so the sender can fix it.' };
    return { ok: true, approve: false, reason: why };
  }
  return { ok: false, message: 'decision must be approve or reject' };
}

/** Email or SMS changed on a recipient: which fields, for the audit line and the "update the CRM too?" offer. */
export function contactChanges(before: { name?: string | null; email?: string | null; phone?: string | null }, after: { name?: string | null; email?: string | null; phone?: string | null }): ('name' | 'email' | 'phone')[] {
  const out: ('name' | 'email' | 'phone')[] = [];
  if (after.name !== undefined && (after.name ?? '').trim() !== (before.name ?? '').trim()) out.push('name');
  if (after.email !== undefined && (after.email ?? '').trim().toLowerCase() !== (before.email ?? '').trim().toLowerCase()) out.push('email');
  if (after.phone !== undefined && phoneKey(after.phone) !== phoneKey(before.phone)) out.push('phone');
  return out;
}
