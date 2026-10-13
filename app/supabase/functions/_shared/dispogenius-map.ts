/**
 * Turning Dispo Genius records into CLOZR ones. Pure functions, no network and
 * no database, so the mapping rules can be tested on their own — the same split
 * podio-map.ts makes for Podio.
 *
 * Tested by dispogenius-map.test.ts.
 */

// deno-lint-ignore no-explicit-any
export type Any = any;

export type DgBuyer = { full_name: string | null; email: string | null; phone: string | null; type: string | null; is_active: boolean };

export const phoneKey = (v: string | null | undefined) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
};
export const emailKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase() || null;
/**
 * Number(null) and Number('') are both 0, which would turn "Dispo Genius does
 * not know the ARV" into "the ARV is zero" and overwrite a real CLOZR figure.
 * Absent stays absent; a genuine 0 (a no-fee assignment) still comes through.
 */
export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Dispo Genius states the ARV as either a single number or a low-high range. */
export function arvOf(d: Any): number | null {
  if (d?.is_arv_range) {
    const lo = num(d.low_end_arv); const hi = num(d.high_end_arv);
    if (lo && hi) return Math.round((lo + hi) / 2);
    return lo ?? hi;
  }
  return num(d.arv_price);
}

/**
 * deal_buyer_matches.status is CHECK-constrained to eight values, and Dispo
 * Genius publishes no enum for its buyer status, so anything unrecognised
 * lands on 'matched' rather than failing the whole import on one odd row.
 */
export const MATCH_STATUS: Record<string, string> = {
  interested: 'interested', 'not interested': 'not_interested', not_interested: 'not_interested',
  sent: 'sent', viewed: 'viewed', offered: 'offered', 'offer received': 'offered',
  'offer accepted': 'under_contract', 'under contract': 'under_contract', pending: 'under_contract',
  closed: 'closed',
};
export const matchStatus = (v: unknown) => MATCH_STATUS[String(v ?? '').trim().toLowerCase()] ?? 'matched';

/** The column is CHECK (score between 0 and 100). */
export const clampScore = (v: unknown) => Math.max(0, Math.min(100, Math.round(num(v) ?? 0)));


/**
 * Where an incoming buyer already lives in CLOZR. Phone wins over email: a
 * shared office inbox puts several buyers behind one address, while the number
 * someone answers is theirs.
 */
export function matchBuyer(
  b: DgBuyer,
  byPhone: Map<string, number>,
  byEmail: Map<string, number>,
): { id: number; by: 'phone' | 'email' } | null {
  const p = phoneKey(b.phone);
  if (p && byPhone.has(p)) return { id: byPhone.get(p)!, by: 'phone' };
  const e = emailKey(b.email);
  if (e && byEmail.has(e)) return { id: byEmail.get(e)!, by: 'email' };
  return null;
}

/**
 * Dispo Genius stores the address as one string: "123 Main St, Austin, TX 78701".
 * Split from the right, because the tail is the regular part — "STATE ZIP",
 * then city — while the street itself may hold commas (apartments, units).
 * Anything that does not end in a recognisable "TX 78701" is left as line1
 * alone rather than guessed at.
 */
export function splitAddress(raw: string | null | undefined): { line1: string; city: string; state: string; zip: string } | null {
  const full = String(raw ?? '').trim();
  if (!full) return null;
  const parts = full.split(',').map((x) => x.trim()).filter(Boolean);
  const tail = parts.length > 1 ? parts[parts.length - 1] : '';
  const m = tail.match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (!m || parts.length < 3) return { line1: full, city: '', state: '', zip: '' };
  return { line1: parts.slice(0, -2).join(', '), city: parts[parts.length - 2], state: m[1].toUpperCase(), zip: m[2] };
}

/** Only the columns Dispo Genius actually knows, and only when it knows them. */
export function dealPatch(d: Any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== '') out[k] = v; };
  set('asking_price', num(d.asking_price));
  set('arv', arvOf(d));
  set('assignment_fee', num(d.assignment_fee));
  set('notes', d.notes);
  return out;
}

