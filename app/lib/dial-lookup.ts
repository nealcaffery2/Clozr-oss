// The dial box's smart lookup: type a name ("Karen", "Alamo Title", "lender")
// and pick who to call, or type a number and see whose it is. Pure: the
// matches come from V.dialerContacts (people and buyers already loaded) and
// searchContacts (the database, vendors included). tools/dial-lookup.test.ts.

import { type Contact } from './contact-search';
import type { ContactDto } from './talkr-web/api';
import { toE164 } from './talkr-web/time';

/** Letters in the dial box mean a name search, not a number. */
export const isNameQuery = (raw: string) => /[A-Za-z]/.test(raw);

const numberOf = (c: Contact) => (c.phone ? toE164(c.phone) : '');

/**
 * Loaded matches first, then the database's, keeping only people with a
 * number to dial. The same kind of contact on the same number shows once
 * (a loaded seller is "p12" and the database's is 12). Loaded rows take at
 * most `limit - 3` places up front, so vendors and people not loaded still
 * show when many loaded people match; leftover places go back to them.
 */
export function mergeDialMatches(local: Contact[], remote: Contact[], limit = 8): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  const head = Math.max(1, limit - 3);
  for (const c of [...local.slice(0, head), ...remote, ...local.slice(head)]) {
    const n = numberOf(c);
    if (!n || n.length < 8) continue;
    const key = `${c.kind}:${n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Whose number this is, from a list of matches; null when nobody's phone is exactly it. */
export function whoseNumber(digits: string, list: Contact[]): Contact | null {
  const e = toE164(digits);
  if (e.replace(/\D/g, '').length < 10) return null;
  return list.find((c) => numberOf(c) === e) ?? null;
}

/** The badge: what they are to the business, in the words reps use. A vendor shows its trade. */
export function dialKindLabel(c: Contact): string {
  if (c.kind === 'seller') return 'Seller';
  if (c.kind === 'buyer') return 'Buyer';
  if (c.kind === 'vendor') return c.trade?.trim() || 'Vendor';
  return 'Team';
}

const PARTY_TRADE: Record<string, string> = {
  title: 'Title', photographer: 'Photographer', wholesaler: 'Wholesaler', listing_agent: 'Listing agent',
  buyers_agent: "Buyer's agent", realtor: 'Realtor', tc: 'TC', acquisitions: 'Acquisitions', dispositions: 'Dispositions',
  lender: 'Lender', contractor: 'Contractor', inspector: 'Inspector', attorney: 'Attorney',
};

/** A deal party's role (deal_parties.role) in the words on its badge. */
export const partyTrade = (role: string) => PARTY_TRADE[role] ?? 'Deal contact';

const TALKR_TRADE: Record<string, string> = { title: 'Title', company: 'Company', vendor: 'Vendor', other: 'Contact' };

/** A Talkr contact as dial rows: one per number, primary first, labelled by its Talkr type. */
export function talkrContact(c: ContactDto): Contact[] {
  const phones = [...c.phones].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const numbers = phones.length ? phones.map((p) => ({ phone: p.phone_e164, label: p.label })) : c.primary_phone ? [{ phone: c.primary_phone, label: null }] : [];
  const kind = c.type === 'seller' || c.type === 'buyer' ? c.type : 'vendor';
  return numbers.map((n, i) => ({
    kind, id: `t${c.id}${i ? `:${n.phone}` : ''}`, name: c.display_name, email: null, phone: n.phone,
    sub: [i ? `${n.label || 'Other'} number` : n.label, c.company].filter(Boolean).join(' · ') || null,
    trade: kind === 'vendor' ? TALKR_TRADE[c.type] ?? 'Contact' : null,
  }));
}
