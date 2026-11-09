// A contact saved from the dialer (Talkr's Add contact) lands in CLOZR too:
// a seller as a seller lead, a buyer as a buyer, everything else (title,
// company, vendor, other) as a vendor. Someone already on file in CLOZR by
// phone or email is left as is, so saving twice never makes a second record.

import { createBuyer, createSeller, createVendor, type WriteResult } from './crm-write';
import { findQuickAddDuplicate } from './quick-add-dupes';
import { supabase } from './supabase';
import type { CreateContactInput } from './talkr-web/api';

const VENDOR_KIND: Record<string, string> = { title: 'Title Company', company: 'Company', vendor: 'Vendor', other: 'Other' };

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * `extra`: what CLOZR's record has a field for and the dialer's contact does
 * not (lib/crm-write's quick-add keys): a seller's `asking`, a buyer's `type`
 * (BUYER_TYPES code), `markets` and `price`, a vendor's `kind` and `market`,
 * and `assignTo` (a teammate's user id) for a hand-off.
 */
export async function mirrorContactToClozr(
  workspaceId: number, userId: string | null, c: CreateContactInput, extra: Record<string, string> = {},
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const name = c.display_name.trim();
  const f: Record<string, string> = {
    name, phone: c.phone ?? '', email: c.email ?? '', company: c.company ?? '',
    addr: c.address?.line1 ?? '', city: c.address?.city ?? '', st: c.address?.state ?? '', zip: c.address?.postal_code ?? '',
    note: c.notes ?? '',
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v.trim())),
  };

  if (c.type === 'seller' || c.type === 'buyer') {
    const dupe = await findQuickAddDuplicate(workspaceId, c.type, f);
    if (dupe) return { ok: true, id: dupe.id };
    return c.type === 'seller' ? createSeller(workspaceId, { ...f, source: 'Dialer' }, userId) : createBuyer(workspaceId, f, userId);
  }

  const or = [c.phone && `phone.eq.${c.phone}`, c.email && `email.eq.${c.email.trim().toLowerCase()}`].filter(Boolean).join(',');
  if (or) {
    const { data } = await supabase.from('vendors').select('id').eq('workspace_id', workspaceId).or(or).limit(1).maybeSingle();
    if (data) return { ok: true, id: data.id };
  }
  // A lender tagged "lender" files as a Lender, not a generic Vendor.
  const kind = f.kind || (c.type === 'vendor' && c.tags?.[0] ? titleCase(c.tags[0]) : VENDOR_KIND[c.type] ?? 'Other');
  const company = c.company?.trim();
  return createVendor(workspaceId, { ...f, name: company || name, contact: company && name !== company ? name : '', kind }, userId);
}
