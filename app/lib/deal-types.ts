// The four ways Acme Homes takes a deal down. The label is what the deal,
// the deal sheet, and the seller record show. The TC checklist only has two
// printed tracks, so JV and Double Close run the assignment checklist and
// Novation runs the novation checklist.

export const DEAL_TYPES = [
  { key: 'assignment', label: 'Assignment', bg: '#dcfce7', fg: '#15803d' },
  { key: 'jv', label: 'JV', bg: '#f3e8ff', fg: '#7e22ce' },
  { key: 'double_close', label: 'Double Close', bg: '#ffedd5', fg: '#c2410c' },
  { key: 'novation', label: 'Novation', bg: '#dbeafe', fg: '#1d4ed8' },
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
