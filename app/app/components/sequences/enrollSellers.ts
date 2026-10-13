// Enroll CLOZR sellers in a Talkr text sequence.
//
// Talkr enrolls by phone: a number it already has as a contact is enrolled
// straight away. A seller Talkr has never seen comes back `unknown_phone`, so
// it is made a Talkr contact the same way the in-call quick add does it
// (createContact, and on a 409 the existing contact's id), then enrolled by
// contact id. Opt-outs and quiet hours are Talkr's to enforce when a text
// sends; what it refuses here is handed back as `skipped` for the caller to show.

import { ApiError, api as talkrApi, type CreateContactInput, type SequenceEnrollResultDto } from '@/lib/talkr-web/api';
import { toE164 } from '@/lib/talkr-web/time';

export type EnrollSeller = { name: string; phone: string; address?: { line1?: string; city?: string; state?: string; postal_code?: string } };
export type EnrollOutcome = { enrolled: number; already: number; skipped: Array<{ ref: string; reason: string }> };

type Api = {
  enrollInSequence: (id: string, input: { contact_ids?: string[]; phones?: string[] }) => Promise<SequenceEnrollResultDto>;
  createContact: (input: CreateContactInput) => Promise<{ contact: { id: string } }>;
};

export const SKIP_REASON: Record<string, string> = {
  no_phone: 'no phone number on the seller',
  unknown_phone: 'Talkr has no contact with this number',
  invalid_phone: 'not a valid number',
  lead_not_found: 'lead not found',
  contact_not_found: 'contact not found',
};

export async function enrollSellers(sequenceId: string, sellers: EnrollSeller[], api: Api = talkrApi): Promise<EnrollOutcome> {
  const skipped: EnrollOutcome['skipped'] = [];
  const byPhone = new Map<string, EnrollSeller>();
  for (const s of sellers) {
    const e164 = s.phone.trim() ? toE164(s.phone) : '';
    if (!e164) skipped.push({ ref: s.name, reason: 'no_phone' });
    else if (!byPhone.has(e164)) byPhone.set(e164, s);
  }
  if (!byPhone.size) return { enrolled: 0, already: 0, skipped };

  const first = await api.enrollInSequence(sequenceId, { phones: [...byPhone.keys()].slice(0, 500) });
  let enrolled = first.enrolled;
  let already = first.already_enrolled;
  const contactIds: string[] = [];
  for (const d of first.skipped_details) {
    const seller = byPhone.get(d.ref);
    if (d.reason !== 'unknown_phone' || !seller) {
      skipped.push({ ref: seller ? `${seller.name} ${d.ref}` : d.ref, reason: d.reason });
      continue;
    }
    try {
      const r = await api.createContact({ display_name: seller.name || d.ref, type: 'seller', phone: d.ref, source: 'clozr', ...(seller.address?.line1 ? { address: seller.address } : {}) });
      contactIds.push(r.contact.id);
    } catch (e) {
      const existing = e instanceof ApiError && e.status === 409 && typeof e.body?.contact_id === 'string' ? e.body.contact_id : null;
      if (existing) contactIds.push(existing);
      else skipped.push({ ref: `${seller.name} ${d.ref}`, reason: (e as Error).message || 'could not add to Talkr' });
    }
  }
  if (contactIds.length) {
    const second = await api.enrollInSequence(sequenceId, { contact_ids: contactIds });
    enrolled += second.enrolled;
    already += second.already_enrolled;
    skipped.push(...second.skipped_details);
  }
  return { enrolled, already, skipped };
}
