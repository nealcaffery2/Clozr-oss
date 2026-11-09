// The four ways Acme Homes takes a deal down. The label is what the deal,
// the deal sheet, and the seller record show. The TC checklist only has two
// printed tracks, so JV and Double Close run the assignment checklist and
// Novation runs the novation checklist.

export const DEAL_TYPES = [
  { key: 'assignment', label: 'Assignment', bg: 'var(--positive-soft, #dcfce7)', fg: 'var(--tx-green, #15803d)' },
  { key: 'jv', label: 'JV', bg: '#f3e8ff', fg: '#7e22ce' },
  { key: 'double_close', label: 'Double Close', bg: 'var(--tint-orange-2, #ffedd5)', fg: 'var(--tx-orange, #c2410c)' },
  { key: 'novation', label: 'Novation', bg: 'var(--tint-blue-2, #dbeafe)', fg: 'var(--tx-blue, #1d4ed8)' },
] as const;

export type DealTypeKey = (typeof DEAL_TYPES)[number]['key'];

const BY_LABEL = new Map(DEAL_TYPES.map((t) => [t.label.toLowerCase(), t]));
const BY_KEY = new Map(DEAL_TYPES.map((t) => [t.key, t]));

/** Read whatever was typed on a deal ("novation", "Double close", "JV") into a known type. */
export function parseDealType(raw: string | null | undefined): (typeof DEAL_TYPES)[number] | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'jv' || s === 'joint venture') return BY_KEY.get('jv') ?? null;
  if (s === 'double close' || s === 'doubleclose' || s === 'double closing') return BY_KEY.get('double_close') ?? null;
  if (s.startsWith('novation')) return BY_KEY.get('novation') ?? null;
  if (s.startsWith('assignment') || s === 'wholesale' || s === 'assign') return BY_KEY.get('assignment') ?? null;
  return BY_LABEL.get(s) ?? null;
}

export function dealTypeLabel(raw: string | null | undefined): string {
  return parseDealType(raw)?.label ?? '';
}

/** Which printed TC checklist runs. JV and double close stay on assignment. */
export function tcChecklistFor(raw: string | null | undefined): 'assignment' | 'novation' | null {
  const t = parseDealType(raw);
  if (!t) return null;
  return t.key === 'novation' ? 'novation' : 'assignment';
}

/**
 * How the dispo seat is filled. Novation with nobody on it yet is dealt by
 * the dispositions round robin. Assignment and double close are whoever is
 * selling the deal — not a second person, and not a rotation.
 */
export function dispoAssignment(raw: string | null | undefined): 'round_robin' | 'seller' | null {
  const key = parseDealType(raw)?.key;
  if (key === 'novation') return 'round_robin';
  if (key === 'assignment' || key === 'double_close') return 'seller';
  return null;
}

/**
 * How the deal closes (migration 406), separate from the deal type. A split
 * double close has two title companies, so the team asks for a second one. A
 * liquid double close funds our first closing with a transactional funder,
 * so the team asks for the funder and Admin / COGS asks for the funding fee.
 */
export const CLOSING_STRUCTURES = [
  { key: 'assignment', label: 'Assignment', hint: 'We assign the contract; one closing.' },
  { key: 'split_double_close', label: 'Split double close', hint: 'Two closings at two title companies. Add the second title company to the deal team.' },
  { key: 'passthrough_double_close', label: 'Passthrough double close', hint: 'Two closings, the end buyer’s money funds ours.' },
  { key: 'liquid_double_close', label: 'Liquid double close', hint: 'Two closings, a transactional funder funds the first. Add the funder to the deal team and the funding fee to Admin / COGS.' },
] as const;
export type ClosingStructure = (typeof CLOSING_STRUCTURES)[number]['key'];

/** The deal team seats this deal asks to have filled, in order. */
export type SeatRole = 'listing_agent' | 'buyers_agent' | 'lender' | 'second_title' | 'transactional_funder';
export function teamSeatsFor(dealType: string | null | undefined, closing: string | null | undefined): SeatRole[] {
  const out: SeatRole[] = [];
  if (parseDealType(dealType)?.key === 'novation') out.push('listing_agent', 'buyers_agent', 'lender');
  if (closing === 'split_double_close') out.push('second_title');
  if (closing === 'liquid_double_close') out.push('transactional_funder');
  return out;
}
