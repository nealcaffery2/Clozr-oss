// Contract recipients and the CRM (migration 114). A recipient is picked from
// People, Buyers, Vendors or the team, and keeps a link to that record, so
// the contract shows on the record's Contracts card. Someone typed in by hand
// is saved to People or Buyers on send, through the same create helpers (and
// the same duplicate rules) as anywhere else in CLOZR.

import { supabase } from './supabase';
import { type Contact, type ContactLink, ilikeSafe, parseQuery, rankContacts } from './contact-search';
import { classify, type Existing } from './import-dedupe';
import { createBuyer, createSeller } from './crm-write';
import { loadDealForSeller } from './deal-sheet';

export type { Contact, ContactLink };

/** Up to `limit` matches across People, Buyers, Vendors and the team. */
export async function searchContacts(workspaceId: number, q: string, limit = 12): Promise<Contact[]> {
  if (!supabase) return [];
  const { terms, digits } = parseQuery(q);
  const word = ilikeSafe(terms.sort((a, b) => b.length - a.length)[0] ?? '');
  if (!word && !digits) return [];
  const like = `%${word}%`;
  const tail = digits ? `%${digits.slice(-4)}%` : null;
  const ors = (cols: string[]) => [...cols.map((c) => `${c}.ilike.${like}`), ...(tail ? [`phone.ilike.${tail}`] : [])].join(',');
  const [sellers, buyers, vendors, team] = await Promise.all([
    supabase.from('sellers').select('id, name, email, phone, property_address').eq('workspace_id', workspaceId).or(ors(['name', 'email'])).limit(25),
    supabase.from('buyers').select('id, name, company, email, phone').eq('workspace_id', workspaceId).or(ors(['name', 'company', 'email'])).limit(25),
    supabase.from('vendors').select('id, business_name, contact_name, email, phone, service_type').eq('workspace_id', workspaceId).or(ors(['business_name', 'contact_name', 'email'])).limit(15),
    supabase.from('workspace_roster').select('user_id, full_name, email, title').eq('workspace_id', workspaceId).limit(100),
  ]);
  const list: Contact[] = [
    ...((sellers.data ?? []) as { id: number; name: string; email: string | null; phone: string | null; property_address: string | null }[])
      .map((s) => ({ kind: 'seller' as const, id: s.id, name: s.name, email: s.email, phone: s.phone, sub: s.property_address })),
    ...((buyers.data ?? []) as { id: number; name: string; company: string | null; email: string | null; phone: string | null }[])
      .map((b) => ({ kind: 'buyer' as const, id: b.id, name: b.name, email: b.email, phone: b.phone, sub: b.company })),
    ...((vendors.data ?? []) as { id: number; business_name: string; contact_name: string | null; email: string | null; phone: string | null; service_type: string | null }[])
      .map((v) => ({ kind: 'vendor' as const, id: v.id, name: v.contact_name || v.business_name, email: v.email, phone: v.phone, sub: [v.contact_name ? v.business_name : null, v.service_type].filter(Boolean).join(' · ') || null })),
    ...((team.data ?? []) as { user_id: string; full_name: string | null; email: string | null; title: string | null }[])
      .filter((t) => t.full_name || t.email)
      .map((t) => ({ kind: 'team' as const, id: t.user_id, name: t.full_name || t.email || 'Teammate', email: t.email, phone: null, sub: t.title })),
  ];
  return rankContacts(list, q, limit);
}

/** `addr` (seller only): the property, which becomes the deal's property. */
type Person = { name: string; email?: string | null; phone?: string | null; addr?: string | null };
export type SavedContact = { ok: true; link: ContactLink; existing: boolean } | { ok: false; message: string };

/**
 * Save a typed-in recipient as a Person (seller) or a Buyer. An existing
 * record with the same email or phone (lib/import-dedupe rules) is linked
 * instead of making a second one.
 */
export async function saveRecipientToCrm(workspaceId: number, p: Person, kind: 'seller' | 'buyer', userId: string | null): Promise<SavedContact> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const name = p.name.trim();
  if (!name) return { ok: false, message: 'A name is needed to save them.' };
  const email = (p.email ?? '').trim().toLowerCase() || null;
  const phone = (p.phone ?? '').trim() || null;
  const digits = (phone ?? '').replace(/\D/g, '');
  const ors = [email ? `email.ilike.${ilikeSafe(email)}` : null, digits.length >= 7 ? `phone.ilike.%${digits.slice(-4)}%` : null].filter(Boolean).join(',');
  if (ors) {
    const table = kind === 'seller' ? 'sellers' : 'buyers';
    const { data } = await supabase.from(table).select('id, name, email, phone').eq('workspace_id', workspaceId).or(ors).limit(50);
    const existing: Existing[] = ((data ?? []) as { id: number; name: string; email: string | null; phone: string | null }[])
      .map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, address: null, sourceId: null, show: [] }));
    const [m] = classify([{ name, email, phone, address: null, sourceId: null }], existing);
    if (m?.kind === 'existing') return { ok: true, existing: true, link: kind === 'seller' ? { seller_id: m.id } : { buyer_id: m.id } };
  }
  if (kind === 'seller') {
    const r = await createSeller(workspaceId, { name, email: email ?? '', phone: phone ?? '', addr: (p.addr ?? '').trim(), source: 'Contract' }, userId);
    return r.ok && r.id ? { ok: true, existing: false, link: { seller_id: r.id } } : { ok: false, message: r.message ?? 'Could not save them to People.' };
  }
  const r = await createBuyer(workspaceId, { name, email, phone, source: 'Contract', criteria: {} }, userId);
  if (r.ok && r.id) return { ok: true, existing: false, link: { buyer_id: r.id } };
  // createBuyer refuses a duplicate but says which one it is.
  if (r.id) return { ok: true, existing: true, link: { buyer_id: r.id } };
  return { ok: false, message: r.message ?? 'Could not save them to Buyers.' };
}

/** A recipient's email or phone was corrected on a contract: carry it to the CRM record too. */
export async function updateCrmContact(workspaceId: number, link: ContactLink, patch: { email?: string | null; phone?: string | null }): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const row: Record<string, string | null> = {};
  if (patch.email !== undefined) row.email = (patch.email ?? '').trim().toLowerCase() || null;
  if (patch.phone !== undefined) row.phone = (patch.phone ?? '').trim() || null;
  if (!Object.keys(row).length) return { ok: true };
  const target = link.seller_id ? { table: 'sellers' as const, id: link.seller_id } : link.buyer_id ? { table: 'buyers' as const, id: link.buyer_id } : link.vendor_id ? { table: 'vendors' as const, id: link.vendor_id } : null;
  if (!target) return { ok: false, message: 'This recipient is not linked to a CRM record.' };
  const { error } = await supabase.from(target.table).update(row as never).eq('id', target.id).eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Which CRM list a link points at, in the words the app uses. */
export const linkLabel = (l: ContactLink | null | undefined) =>
  l?.seller_id ? 'People' : l?.buyer_id ? 'Buyers' : l?.vendor_id ? 'Vendors' : l?.user_id ? 'Team' : null;

/** A contract's people as the form holds them: who they are on the template and their CRM link. */
type Row = { role: string; party?: string | null; name?: string | null; email?: string | null; phone?: string | null } & ContactLink;
export type ContractIds = { sellerId: number | null; dealId: number | null; buyerId: number | null };

/**
 * Before a contract is created, make sure everyone on it is in the CRM and on
 * the deal, so the contract lands on the seller, the buyer and the deal:
 * - a seller or buyer typed in by hand is saved to People or Buyers (an
 *   existing record with the same email or phone is linked instead);
 * - no deal yet: the seller's live deal is used, or one is opened at New Lead;
 * - a buyer goes onto the deal when the deal has none.
 * The company's own signer and CC rows are left alone.
 */
export async function tieContractToCrm<T extends Row>(
  workspaceId: number, rows: T[], ids: ContractIds, userId: string | null,
): Promise<{ ok: true; rows: T[]; ids: ContractIds; saved: string[] } | { ok: false; message: string }> {
  const out = { ...ids };
  const saved: string[] = [];
  const next: T[] = [];
  for (const r of rows) {
    const kind = r.party === 'seller' || r.party === 'seller2' ? 'seller' : r.party === 'buyer' ? 'buyer' : null;
    const linked = !!(r.seller_id || r.buyer_id || r.vendor_id || r.user_id);
    if (!kind || linked || !(r.name ?? '').trim()) { next.push(r); continue; }
    const s = await saveRecipientToCrm(workspaceId, { name: String(r.name), email: r.email, phone: r.phone }, kind, userId);
    if (!s.ok) return { ok: false, message: `${r.name}: ${s.message}` };
    if (!s.existing) saved.push(String(r.name));
    next.push({ ...r, ...s.link });
  }
  const seller = next.find((r) => r.party === 'seller' && r.seller_id);
  const buyer = next.find((r) => r.party === 'buyer' && r.buyer_id);
  if (!out.sellerId && seller?.seller_id) out.sellerId = Number(seller.seller_id);
  if (!out.buyerId && buyer?.buyer_id) out.buyerId = Number(buyer.buyer_id);
  if (!out.dealId && out.sellerId) {
    const d = await loadDealForSeller(workspaceId, out.sellerId, userId, true);
    if (d.deal) out.dealId = d.deal.id;
  }
  if (out.dealId && out.buyerId && supabase) {
    await supabase.from('deals').update({ buyer_id: out.buyerId }).eq('id', out.dealId).is('buyer_id', null);
  }
  return { ok: true, rows: next, ids: out, saved };
}
