// A COMPR report, onto the right deal. The COMPR window posts every report it
// paints and every edit it saves (lib/compr-embed.ts); this says which deal
// that is, and the line the deal keeps about the rest of the report.

const money = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString('en-US'));

/**
 * The deal a COMPR report is for: the deal whose report it is (its lead id in
 * the deal's report link or photos), else the house the COMPR window was
 * opened for when the report is on that street address (a re-run in COMPR
 * gets a new lead id). A report on any other house is no deal's here, and
 * nothing is written.
 */
export function comprReportDealId<D extends { id: string }>(
  r: { leadId: string | null; address?: string | null },
  deals: readonly D[],
  leadOf: (d: D) => string | null,
  opened: { dealId: string; addr: string } | null,
): string | null {
  if (r.leadId) {
    const own = opened ? deals.find((d) => d.id === opened.dealId) : undefined;
    if (own && leadOf(own) === r.leadId) return own.id;
    const hit = deals.find((d) => leadOf(d) === r.leadId);
    if (hit) return hit.id;
  }
  if (opened && sameStreet(r.address, opened.addr)) return opened.dealId;
  return null;
}

/** "123 Main St, Dallas…" and "123 Main Street" are one house: same number, same first street word. */
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (s: string | null | undefined) => (s ?? '').split(',')[0].toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
  const ka = key(a);
  const kb = key(b);
  return /^\d+\w* [a-z0-9]+$/.test(ka) && ka === kb;
}

/** One line stored on the deal so the record shows the rest of the report, not only the three money fields. */
export function comprNote(r: {
  condition?: string | null;
  arvLow?: number | null;
  arvHigh?: number | null;
  wholesale?: number | null;
  institutional?: number | null;
  compCount?: number | null;
  confidence?: number | null;
  redFlags?: { description?: string }[];
}): string {
  const flags = (r.redFlags ?? []).map((f) => f.description).filter((d): d is string => !!d).slice(0, 3);
  const parts = [
    r.condition ? `condition ${r.condition}` : null,
    r.arvLow != null && r.arvHigh != null ? `ARV range ${money(r.arvLow)}–${money(r.arvHigh)}` : null,
    r.wholesale != null || r.institutional != null
      ? `low ${money(r.wholesale ?? null)} · high ${money(r.institutional ?? null)}`
      : null,
    r.compCount != null ? `${r.compCount} comps` : null,
    r.confidence != null ? `confidence ${r.confidence}%` : null,
    flags.length ? flags.join('; ') : null,
  ].filter((p): p is string => !!p);
  return parts.length ? 'COMPR · ' + parts.join(' · ') : '';
}
