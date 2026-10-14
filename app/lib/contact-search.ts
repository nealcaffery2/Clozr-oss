// One search box across People (sellers), Buyers, Vendors and the team, for
// picking who a contract goes to. Pure: tools/contact-search.test.ts covers
// it; lib/contract-recipients.ts does the reads.

export type ContactKind = 'seller' | 'buyer' | 'vendor' | 'team';
export type Contact = {
  kind: ContactKind;
  /** Seller, buyer or vendor id; the user id for a teammate. */
  id: number | string;
  name: string; email: string | null; phone: string | null;
  /** Second line: the property, the company, the trade, the title. */
  sub: string | null;
  /** Vendors only: the trade (Lender, Title, Contractor), which the dialer shows in place of "Vendor". */
  trade?: string | null;
};

/** How a recipient row remembers the record it came from (contract_signers, migration 114). */
export type ContactLink = { seller_id?: number | null; buyer_id?: number | null; vendor_id?: number | null; user_id?: string | null };

export const KIND_LABEL: Record<ContactKind, string> = { seller: 'Person', buyer: 'Buyer', vendor: 'Vendor', team: 'Team' };

export function linkOf(c: Contact): ContactLink {
  if (c.kind === 'seller') return { seller_id: Number(c.id) };
  if (c.kind === 'buyer') return { buyer_id: Number(c.id) };
  if (c.kind === 'vendor') return { vendor_id: Number(c.id) };
  return { user_id: String(c.id) };
}

export const isLinked = (l: ContactLink | null | undefined) => !!(l && (l.seller_id || l.buyer_id || l.vendor_id || l.user_id));

/** What to search for: the words, and the digits when it looks like a phone. */
export function parseQuery(q: string): { terms: string[]; digits: string | null } {
  const t = q.trim().toLowerCase();
  const digits = t.replace(/\D/g, '');
  return { terms: t.split(/\s+/).filter(Boolean), digits: digits.length >= 4 && /^[\d\s()+.-]+$/.test(t) ? digits : null };
}

/** A PostgREST ilike pattern, with the characters that would break the or() filter taken out. */
export const ilikeSafe = (s: string) => s.replace(/[%_,()*\\]/g, ' ').trim();

/**
 * Best first: every word matches; then a name that starts with the query,
 * an exact email, a phone that ends in the digits; People and Buyers ahead
 * of vendors and the team at a tie. Duplicates (same kind and id) collapse.
 */
export function rankContacts(list: Contact[], q: string, limit = 12): Contact[] {
  const { terms, digits } = parseQuery(q);
  if (!terms.length) return [];
  const seen = new Set<string>();
  const order: Record<ContactKind, number> = { seller: 0, buyer: 1, vendor: 2, team: 3 };
  const scored: { c: Contact; s: number }[] = [];
  for (const c of list) {
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hay = `${c.name} ${c.email ?? ''} ${c.sub ?? ''}`.toLowerCase();
    const phone = (c.phone ?? '').replace(/\D/g, '');
    const words = terms.every((t) => hay.includes(t));
    const byPhone = !!digits && phone.includes(digits);
    if (!words && !byPhone) continue;
    let s = 0;
    const name = c.name.toLowerCase();
    const whole = terms.join(' ');
    if (name === whole) s += 50;
    else if (name.startsWith(whole)) s += 30;
    else if (name.split(/\s+/).some((w) => w.startsWith(terms[0]))) s += 15;
    if ((c.email ?? '').toLowerCase() === whole) s += 40;
    if (byPhone && phone.endsWith(digits!)) s += 35;
    if (c.email) s += 3;
    if (c.phone) s += 2;
    scored.push({ c, s: s - order[c.kind] });
  }
  return scored.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name)).slice(0, limit).map((x) => x.c);
}
