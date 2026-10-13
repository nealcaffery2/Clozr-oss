// CLOZR sellers into a Talkr dialer campaign (People → Actions → Send to Talkr campaign).
//
// Talkr campaigns enrol Talkr leads, and a Talkr lead hangs off a Talkr
// contact. So a send is: import the sellers as Talkr contacts (dedupe
// 'merge', so a number Talkr already has lands on that contact, never a
// second one), tagged with a one-off tag so the contacts this send touched can
// be listed back, then enrol them:
//
//  - a new campaign: Talkr's own dial list (/v1/contacts/bulk/dial-list),
//    which makes the lead for a contact without one, builds a power campaign
//    and enrols them (500 a call: the first 500 build it, the rest attach);
//  - an existing campaign: /v1/campaigns/:id/leads with the contacts' lead ids.
//    Import makes a lead only for a contact with an address, so a seller with
//    neither a Talkr lead nor a property address is counted, not enrolled.
//
// Every good number a seller has goes (lib/seller-phones dialNumbers 'all', as
// the power dialer does since #183): the record's phone and seller_phones, no
// do-not-call or wrong number. Talkr's import row takes two numbers, so the
// third on are extra rows pairing the first number with the next, which merge
// into the same contact. A seller tagged DNC or blacklisted is left out.
//
// The row building is pure and pinned by tools/talkr-campaign-send.test.ts.

import { api, type ContactDto } from './talkr-web/api';
import { dialNumbers, loadSellerPhones, type OtherPhone } from './seller-phones';

export type SendSeller = {
  dbId: number;
  name: string;
  phone: string;
  dnc?: boolean;
  blacklisted?: boolean;
  fields?: Partial<Record<'address' | 'city' | 'state' | 'zip', string>>;
};

export type ImportRow = Record<'name' | 'phone' | 'phone2' | 'address' | 'city' | 'state' | 'zip', string>;

const MAPPING = {
  display_name: 'name', phone: 'phone', phone2: 'phone2',
  address_line1: 'address', city: 'city', state: 'state', postal_code: 'zip',
};

/** Talkr import rows for these sellers, and who was left out and why. */
export function importRows(sellers: readonly SendSeller[], others: ReadonlyMap<number, readonly OtherPhone[]>): { rows: ImportRow[]; dnc: number; noNumber: number } {
  const rows: ImportRow[] = [];
  let dnc = 0;
  let noNumber = 0;
  for (const s of sellers) {
    if (s.dnc || s.blacklisted) { dnc++; continue; }
    const nums = dialNumbers(s.phone, others.get(s.dbId) ?? [], 'all').map((n) => n.phone);
    if (!nums.length) { noNumber++; continue; }
    const f = s.fields ?? {};
    const name = s.name.trim() || nums[0]!;
    rows.push({ name, phone: nums[0]!, phone2: nums[1] ?? '', address: f.address ?? '', city: f.city ?? '', state: f.state ?? '', zip: f.zip ?? '' });
    for (const extra of nums.slice(2)) {
      rows.push({ name, phone: nums[0]!, phone2: extra, address: '', city: '', state: '', zip: '' });
    }
  }
  return { rows, dnc, noNumber };
}

const chunk = <T,>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export type SendResult = { campaignId: string; campaignName: string; enrolled: number; dnc: number; noNumber: number; noLead: number };

export async function sendSellersToCampaign({
  workspaceId,
  sellers,
  target,
  progress = () => undefined,
}: {
  workspaceId: number;
  sellers: readonly SendSeller[];
  /** No campaignId: a new campaign by this name. */
  target: { name: string; campaignId?: string };
  progress?: (step: string) => void;
}): Promise<SendResult> {
  const real = sellers.filter((s) => s.dbId > 0);
  progress('Reading numbers…');
  const others = await loadSellerPhones(workspaceId, real.map((s) => s.dbId));
  const { rows, dnc, noNumber } = importRows(real, others);
  if (!rows.length) throw new Error('None of them has a number Talkr can call.');

  const tag = `clozr-send-${Date.now().toString(36)}`;
  progress('Matching Talkr contacts…');
  for (const part of chunk(rows, 1000)) {
    await api.importContacts({ rows: part, mapping: MAPPING, defaults: { type: 'seller', source: 'clozr', tags: [tag] }, dedupe: 'merge' });
  }
  const contacts: ContactDto[] = [];
  for (let total = Infinity; contacts.length < total;) {
    const page = await api.listContacts({ tag, limit: 200, offset: contacts.length });
    contacts.push(...page.contacts);
    total = page.total;
    if (!page.contacts.length) break;
  }

  let campaignId: string;
  let campaignName: string;
  let enrolled = 0;
  let rest = contacts;
  if (!target.campaignId) {
    progress('Building the dial list…');
    const r = await api.bulkDialList({ ids: contacts.slice(0, 500).map((c) => c.id), name: target.name });
    if (!('campaign_id' in r)) throw new Error('Talkr made the leads but no campaign. Attach them from Dialer → Campaigns.');
    campaignId = r.campaign_id;
    campaignName = r.campaign_name ?? target.name;
    enrolled += r.enrolled;
    rest = contacts.slice(500);
  } else {
    campaignId = target.campaignId;
    campaignName = target.name;
  }

  const leadIds = rest.map((c) => c.lead_id).filter((id): id is string => !!id);
  if (leadIds.length) progress('Enrolling…');
  for (const part of chunk(leadIds, 5000)) {
    const r = await api.attachCampaignLeads(campaignId, { lead_ids: part });
    enrolled += r.attached + r.revived;
  }
  return { campaignId, campaignName, enrolled, dnc, noNumber, noLead: rest.length - leadIds.length };
}
