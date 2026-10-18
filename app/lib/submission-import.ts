// A partner's list of submissions, imported as one vendor and one deal per house.
//
// Offerpad, iFinder and Mark Spain email a sheet of the properties they want
// offers on. Each row is a house, not a person: importing it as sellers made a
// seller per row named after the partner (the Offerpad ×881 that migration 49
// had to merge back). Here the partner is found or created once, as a vendor
// with the type the importer picked, and as the one contact its deals hang on;
// every row becomes a deal on its own property with the stage, owner and
// underwriter picked before the import (migration 130 notifies the
// underwriter). A house CLOZR already has from that partner (the same row id,
// or the same property on the same partner) is not a second deal: the sheet
// fills that deal's blanks, and COMPR is not pulled for it again
// (lib/submission-match).
//
// A sheet that names its partner per row (Podio "Entity Name", Chris's
// "Vendor Entity Name") puts each row on that partner. Spellings fold the
// same way Podio does ("Mark Spain - NC", "CHH") onto the vendor already in
// CLOZR. Rows with no partner go to the vendor picked for the file.

import { DISPLAY, cleanEntity, entityKey } from '../supabase/functions/_shared/podio-keys';
import { supabase } from './supabase';
import { logActivity } from './crm-write';
import { logRun, notifyUser } from './data-runs';
import { type ImportRecord, type ImportResult, type ReportRow, importProperty, resolveImportProperties } from './import';
import { factRows } from './import-extras';
import { attachPhotoLinks } from './deal-files';
import { toE164 } from './talkr';
import { patchFor } from './import-dedupe';
import { normalizePlace } from './place-names';
import { type ExistingSubmission, type SubmissionIndex, addSubmission as indexDeal, indexSubmissions, matchSubmission } from './submission-match';

/** The vendor types a submission list comes from, as vendors.service_type stores them. */
export const SUBMITTER_TYPES = [
  { value: 'Institutional seller', label: 'Institutional partner (Offerpad, Opendoor…)' },
  { value: 'Wholesaler', label: 'Wholesaler' },
  { value: 'Realtor', label: 'Realtor / agent' },
  { value: 'Other', label: 'Other' },
] as const;

export type SubmissionOptions = {
  label: string;
  /** An existing vendor's id, or null to find one by name and create it if there is none. */
  vendorId: number | null;
  vendorName: string;
  /** vendors.service_type; an existing vendor is moved to it. */
  vendorType: string;
  /** Deal owners. One: all to them. Several: round-robin in file order. None: the importer. */
  owners: string[];
  /** 'same' follows the owner row by row, a user id puts every house on them, null leaves it empty. */
  underwriter: 'same' | string | null;
  /** deals.lead_stage for every row; the file's own stage column is kept in the notes. */
  stage: string;
};

export type SubmissionResult = {
  result: ImportResult; report: ReportRow[]; vendorId: number | null; sellerId: number | null; dealIds: number[];
  /** Each new deal's contact (the partner's seller), in dealIds order: a file can name several partners. */
  dealSellerIds: number[];
  /** Deals already in CLOZR the file filled in. Never queued for COMPR. */
  updatedDealIds: number[];
};

const usd = (n: number | null) => (n ? '$' + n.toLocaleString('en-US') : null);

/** The owner and underwriter of each row, decided up front so parallel batches cannot reorder a rotation. */
export function planOwners(n: number, owners: string[], underwriter: SubmissionOptions['underwriter'], fallback: string | null) {
  return Array.from({ length: n }, (_, i) => {
    const owner = owners.length ? owners[i % owners.length] : fallback;
    return { owner, underwriter: underwriter === 'same' ? owner : underwriter || null };
  });
}

/**
 * What a row says that has no column on the deal: who owns the house (every
 * phone and email, a second owner, their mailing address), the partner's own
 * stage, what the list says about the house, and every column kept as extra
 * info — so nothing on the partner's sheet is lost. The house's own facts also
 * land on the property (importProperty).
 */
export function submissionNotes(r: ImportRecord): string | null {
  // On a partner's own form (Podio) the name, phone and email are the partner's contact, not the owner's.
  const owner = [r.name, r.phone, r.email].filter(Boolean).join(' · ');
  const who = r.submitter ? 'Partner contact' : 'Owner';
  // Older callers (and tests) build a record without the newer fields.
  const otherPhones = (r.otherPhones ?? []).map((p) => {
    const n = toE164(p.phone) ?? p.phone ?? '';
    return [n, p.kind, p.dnc ? 'DNC' : ''].filter(Boolean).join(' ');
  }).filter(Boolean);
  const mail = r.mailing ? [r.mailing.line1, r.mailing.city, [r.mailing.st, r.mailing.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  const facts = factRows(r.facts).map((f) => `${f.k}: ${f.v}`);
  return [
    owner ? `${who}: ${owner}` : null,
    r.phoneDnc ? `${who} phone is marked DNC on the list` : null,
    otherPhones.length ? `Other phones: ${otherPhones.join(', ')}` : null,
    r.otherEmails?.length ? `Other emails: ${r.otherEmails.join(', ')}` : null,
    r.owner2 ? `Owner 2: ${r.owner2}` : null,
    mail ? `Mailing address: ${mail}${r.doNotMail ? ' (do not mail)' : ''}` : null,
    r.stage ? `Partner stage: ${r.stage}` : null,
    r.motivation ? `Motivation: ${r.motivation}` : null,
    r.notes,
    ...facts,
    ...Object.entries(r.extra ?? {}).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean).join('\n') || null;
}

type PartnerCell = Pick<ImportRecord, 'submitter'> & { extra?: Record<string, string> | null };

/** A column Chris leaves as extra info that is still the vendor on that row. */
function extraPartner(extra: Record<string, string> | null | undefined): string {
  for (const [k, v] of Object.entries(extra ?? {})) {
    const n = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    const val = (v ?? '').trim().replace(/\s+/g, ' ');
    if (!val) continue;
    if (n === 'entityname' || n === 'vendorentityname' || n === 'vendorentity' || n.endsWith('entityname') || n === 'submittedby' || n === 'vendorname') return val;
  }
  return '';
}

/** The partner a row names. "NA" and the other empty entity values are nobody. */
export function partnerOnRow(r: PartnerCell): string {
  const raw = ((r.submitter ?? '').trim().replace(/\s+/g, ' ') || extraPartner(r.extra));
  if (!raw) return '';
  return entityKey(cleanEntity(raw).name) ? raw : '';
}

/** The vendor each row goes to: the partner it names, else the one picked for the file. Trimmed; '' when neither. */
export function vendorNamesOf(records: PartnerCell[], fallback: string): string[] {
  return records.map((r) => partnerOnRow(r) || fallback.trim());
}

/** The partner a file is mostly from, to prefill the vendor: the most common "Submitted by" value, '' when none. */
export function mainSubmitter(records: PartnerCell[]): string {
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of records) {
    const name = partnerOnRow(r);
    if (!name) continue;
    const k = name.toLowerCase();
    counts.set(k, { name: counts.get(k)?.name ?? name, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.name ?? '';
}

type VendorHit = { id: number; business_name: string; service_type: string | null };

/** Existing vendors keyed the way Podio entity names fold, so "Mark Spain - NC" is Mark Spain. */
export function indexVendors(rows: VendorHit[]) {
  const exact = new Map<string, VendorHit>();
  const byKey = new Map<string, VendorHit>();
  // Lowest id wins, so a duplicate Offerpad row does not beat the original.
  for (const v of [...rows].sort((a, b) => a.id - b.id)) {
    const low = v.business_name.trim().toLowerCase();
    if (low && !exact.has(low)) exact.set(low, v);
    const k = entityKey(cleanEntity(v.business_name).name);
    if (k && !byKey.has(k)) byKey.set(k, v);
  }
  return { exact, byKey };
}

/** The vendor already on file for this entity name, or null when it is a new partner. */
export function findIndexedVendor(index: ReturnType<typeof indexVendors>, raw: string): VendorHit | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const exact = index.exact.get(name.toLowerCase());
  if (exact) return exact;
  const k = entityKey(cleanEntity(name).name);
  return k ? index.byKey.get(k) ?? null : null;
}

/** The name a new vendor is created under: market suffixes and known spellings folded. */
export function canonicalVendorName(raw: string): string {
  const cleaned = (cleanEntity(raw).name ?? raw).trim().replace(/\s+/g, ' ');
  const k = entityKey(cleaned);
  return (k && DISPLAY[k]) || cleaned || raw.trim();
}

/** One key per partner, so "Mark Spain - NC" and "mark spain" resolve once. */
function foldKey(name: string): string {
  return entityKey(cleanEntity(name).name) || name.trim().toLowerCase();
}

type VendorContact = { name: string | null; phone: string | null; email: string | null };

/**
 * Find the vendor by id or name (any type), or create it; set the type picked
 * (`retype`: only the vendor picked for the file is moved to it, a partner a
 * row names keeps its own). A new vendor takes the row's contact.
 */
async function resolveVendor(
  workspaceId: number, userId: string | null, opts: SubmissionOptions,
  index: ReturnType<typeof indexVendors>, contact?: VendorContact, retype = true,
): Promise<{ id: number; name: string }> {
  const sb = supabase!;
  const name = opts.vendorName.trim();
  let row: VendorHit | null = null;
  if (opts.vendorId != null) {
    const { data } = await sb.from('vendors').select('id, business_name, service_type').eq('id', opts.vendorId).eq('workspace_id', workspaceId).maybeSingle();
    row = data;
  }
  if (!row && name) row = findIndexedVendor(index, name);
  if (row) {
    if (retype && opts.vendorType && row.service_type !== opts.vendorType) {
      await sb.from('vendors').update({ service_type: opts.vendorType }).eq('id', row.id);
    }
    return { id: row.id, name: row.business_name };
  }
  if (!name) throw new Error('Name the vendor that sent this list.');
  const createdName = canonicalVendorName(name);
  const { data, error } = await sb.from('vendors').insert({
    workspace_id: workspaceId, business_name: createdName, service_type: opts.vendorType || 'Institutional seller', source: 'import', created_by: userId,
    ...(contact?.name ? { contact_name: contact.name } : {}),
    ...(contact?.phone ? { phone: toE164(contact.phone) ?? contact.phone } : {}),
    ...(contact?.email ? { email: contact.email.toLowerCase() } : {}),
  } as never).select('id').single();
  if (error) throw new Error(error.message);
  const created: VendorHit = { id: (data as { id: number }).id, business_name: createdName, service_type: opts.vendorType || 'Institutional seller' };
  index.exact.set(createdName.toLowerCase(), created);
  index.exact.set(name.toLowerCase(), created);
  const k = entityKey(cleanEntity(createdName).name);
  if (k) index.byKey.set(k, created);
  return { id: created.id, name: createdName };
}

/**
 * The partner's one contact (migration 49): the seller its submissions already
 * hang on, else a seller with its name, else a new one.
 */
async function resolveContact(workspaceId: number, userId: string | null, vendor: { id: number; name: string }, owner: string | null): Promise<number> {
  const found = await findContact(workspaceId, vendor);
  if (found != null) return found;
  const { data, error } = await supabase!.from('sellers').insert({
    workspace_id: workspaceId, name: vendor.name, lead_stage: 'New Submission', source: vendor.name,
    tags: ['Partner'], created_by: userId, assigned_to: owner,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

/** The partner's contact if it has one yet; null when the import would create it. Reads only. */
async function findContact(workspaceId: number, vendor: { id: number; name: string }): Promise<number | null> {
  const sb = supabase!;
  const { data: parties } = await sb.from('deal_parties').select('deals(seller_id)')
    .eq('workspace_id', workspaceId).eq('vendor_id', vendor.id).eq('role', 'wholesaler').limit(50);
  const counts = new Map<number, number>();
  for (const p of (parties ?? []) as unknown as { deals: { seller_id: number | null } | null }[]) {
    const id = p.deals?.seller_id;
    if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top != null) return top;
  const { data: named } = await sb.from('sellers').select('id').eq('workspace_id', workspaceId).is('archived_at', null)
    .ilike('name', vendor.name).order('id').limit(1);
  return named?.[0]?.id ?? null;
}

/** Every deal already on these partner contacts, 1000 at a time (PostgREST caps a read). */
async function existingSubmissions(workspaceId: number, sellerIds: number[]): Promise<ExistingSubmission[]> {
  const out: ExistingSubmission[] = [];
  if (!supabase || !sellerIds.length) return out;
  for (let from = 0; ; from += 1000) {
    // deals.archived_at (migration 118) is newer than the generated row types.
    const { data } = await supabase.from('deals').select('id, seller_id, property_id, source_id, archived_at' as 'id, seller_id, property_id, source_id')
      .eq('workspace_id', workspaceId).in('seller_id', sellerIds).order('id').range(from, from + 999);
    const rows = (data ?? []) as unknown as { id: number; seller_id: number | null; property_id: number | null; source_id: string | null; archived_at: string | null }[];
    for (const d of rows) out.push({ id: d.id, sellerId: d.seller_id, propertyId: d.property_id, sourceId: d.source_id, archived: !!d.archived_at });
    if (rows.length < 1000) return out;
  }
}

/** The property already filed under each row's address (address_key, as importProperty files it), or null. Reads only. */
async function propertiesOf(workspaceId: number, records: ImportRecord[]): Promise<(number | null)[]> {
  const looked = await resolveImportProperties(workspaceId, records.flatMap((r, i) => (r.addr ? [{ i, r, mode: 'fill' as const }] : [])), false);
  if (looked) return records.map((_, i) => looked.get(i)?.propertyId ?? null);
  const sb = supabase!;
  const keys: (string | null)[] = [];
  for (let i = 0; i < records.length; i += 20) {
    keys.push(...await Promise.all(records.slice(i, i + 20).map(async (r) => {
      if (!r.addr) return null;
      const place = normalizePlace({ city: r.city, state: r.st, zip: r.zip });
      const { data } = await sb.rpc('address_key', { p_line1: r.addr, p_city: place.city ?? '', p_state: place.state ?? '', p_zip: place.zip ?? '' });
      return (data as string | null) || null;
    })));
  }
  const wanted = [...new Set(keys.filter((k): k is string => !!k))];
  const idOf = new Map<string, number>();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data } = await sb.from('properties').select('id, address_key').eq('workspace_id', workspaceId).in('address_key', wanted.slice(i, i + 200)).order('id');
    for (const p of (data ?? []) as { id: number; address_key: string | null }[]) if (p.address_key && !idOf.has(p.address_key)) idOf.set(p.address_key, p.id);
  }
  return keys.map((k) => (k ? idOf.get(k) ?? null : null));
}

/**
 * Before the import, nothing written: which rows CLOZR already has (the deal
 * each one will fill in) and which are new. A partner not in CLOZR yet has
 * nothing to match.
 */
export async function previewSubmissions(
  workspaceId: number, records: ImportRecord[], opts: Pick<SubmissionOptions, 'vendorId' | 'vendorName'>,
): Promise<({ id: number; by: 'record id' | 'address' } | null)[]> {
  if (!supabase) return records.map(() => null);
  const sb = supabase;
  const names = vendorNamesOf(records, opts.vendorName);
  const keys = names.map(foldKey);
  const { data: vendors } = await sb.from('vendors').select('id, business_name, service_type').eq('workspace_id', workspaceId).limit(8000);
  const index = indexVendors(vendors ?? []);
  const contactOf = new Map<string, number | null>();
  for (let i = 0; i < records.length; i++) {
    const key = keys[i];
    if (!key || contactOf.has(key)) continue;
    const picked = opts.vendorId != null && !!opts.vendorName.trim() && key === foldKey(opts.vendorName);
    const hit = picked ? (vendors ?? []).find((v) => v.id === opts.vendorId) ?? null : findIndexedVendor(index, names[i]);
    contactOf.set(key, hit ? await findContact(workspaceId, { id: hit.id, name: hit.business_name }) : null);
  }
  const contacts = [...new Set([...contactOf.values()].filter((x): x is number => x != null))];
  if (!contacts.length) return records.map(() => null);
  const [existing, props] = await Promise.all([existingSubmissions(workspaceId, contacts), propertiesOf(workspaceId, records)]);
  const idx = indexSubmissions(existing);
  return records.map((r, i) => (r.addr ? matchSubmission(idx, { sellerId: contactOf.get(keys[i]) ?? null, propertyId: props[i], sourceId: r.source_id }) : null));
}

export async function runSubmissionImport(
  workspaceId: number, userId: string | null, records: ImportRecord[], opts: SubmissionOptions,
  onProgress?: (done: number) => void,
): Promise<SubmissionResult> {
  const result: ImportResult = { created: 0, updated: 0, cosellers: 0, skipped: 0, errors: [] };
  const report: ReportRow[] = [];
  const dealIds: number[] = [];
  const dealSellerIds: number[] = [];
  const updatedDealIds: number[] = [];
  if (!supabase) { result.errors.push('Supabase is not configured.'); return { result, report, vendorId: null, sellerId: null, dealIds, dealSellerIds, updatedDealIds }; }
  const sb = supabase;

  const plan = planOwners(records.length, opts.owners, opts.underwriter, userId);
  // Every partner the file names, resolved once before the parallel batches: one vendor and one contact each.
  const names = vendorNamesOf(records, opts.vendorName);
  const keys = names.map(foldKey);
  const { data: existingVendors } = await sb.from('vendors').select('id, business_name, service_type').eq('workspace_id', workspaceId).limit(8000);
  const vendorIndex = indexVendors(existingVendors ?? []);
  const byName = new Map<string, { vendor: { id: number; name: string }; sellerId: number; count: number }>();
  const errorOf = new Map<string, string>();
  for (let i = 0; i < records.length; i++) {
    const key = keys[i];
    if (!key || !records[i].addr || byName.has(key) || errorOf.has(key)) continue;
    const picked = !!opts.vendorName.trim() && key === foldKey(opts.vendorName);
    try {
      const r = records[i];
      const vendor = await resolveVendor(workspaceId, userId, { ...opts, vendorId: picked ? opts.vendorId : null, vendorName: names[i] },
        vendorIndex, r.submitter ? { name: r.name || null, phone: r.phone, email: r.email } : undefined, picked);
      const sellerId = await resolveContact(workspaceId, userId, vendor, plan[i]?.owner ?? userId);
      byName.set(key, { vendor, sellerId, count: 0 });
    } catch (e) {
      errorOf.set(key, (e as Error).message);
      result.errors.push(`${names[i]}: ${(e as Error).message}`);
    }
  }
  if (!byName.size) {
    if (!result.errors.length) result.errors.push(records.some((r) => r.addr) ? 'Name the vendor that sent this list.' : 'No row has a property address.');
    return { result, report, vendorId: null, sellerId: null, dealIds, dealSellerIds, updatedDealIds };
  }
  const main = byName.get(foldKey(opts.vendorName)) ?? [...byName.values()][0];
  const now = new Date().toISOString();
  // What each partner already has here, so a resent house fills its deal instead of making a second one.
  const known: SubmissionIndex = indexSubmissions(await existingSubmissions(workspaceId, [...new Set([...byName.values()].map((v) => v.sellerId))]));
  // Only rows one() will import: a row whose partner failed to resolve is skipped and leaves no property behind.
  const propertyHits = await resolveImportProperties(workspaceId, records.flatMap((r, i) => (r.addr && byName.has(keys[i]) ? [{ i, r, mode: 'fill' as const }] : [])), true);

  async function one(i: number) {
    const r = records[i];
    const base = { row: i + 1, name: r.addr || r.name || '—' };
    if (!r.addr) {
      result.skipped++;
      report.push({ ...base, action: 'create', result: 'skipped', id: null, detail: 'No property address' });
      return;
    }
    const to = byName.get(keys[i]);
    if (!to) {
      result.skipped++;
      report.push({ ...base, action: 'create', result: 'skipped', id: null, detail: errorOf.get(keys[i]) ?? 'No vendor for this row' });
      return;
    }
    const { vendor, sellerId } = to;
    try {
      // The house's facts fill what the property does not have yet; a partner's sheet never overrides it.
      const propertyHit = propertyHits?.get(i);
      const propertyId = propertyHit ? propertyHit.propertyId : await importProperty(workspaceId, r, 'fill');
      const { owner, underwriter } = plan[i];
      const hit = matchSubmission(known, { sellerId, propertyId, sourceId: r.source_id });
      if (hit) {
        // Already here: the sheet fills what the deal is missing, never its stage, owner or anything set.
        const { data: cur } = await sb.from('deals').select('asking_price, arv, rehab, offer_amount, notes, source_id' as 'arv, rehab, offer_amount, notes, source_id')
          .eq('id', hit.id).eq('workspace_id', workspaceId).maybeSingle();
        const patch = patchFor((cur ?? {}) as Record<string, unknown>, {
          asking_price: r.asking, arv: r.arv, rehab: r.rehab, offer_amount: r.offer, notes: submissionNotes(r), source_id: r.source_id,
        }, 'fill');
        if (Object.keys(patch).length) {
          const { error } = await sb.from('deals').update({ ...patch, updated_at: now } as never).eq('id', hit.id).eq('workspace_id', workspaceId);
          if (error) throw new Error(error.message);
        }
        await attachPhotoLinks(workspaceId, hit.id, r.photos);
        updatedDealIds.push(hit.id);
        result.updated++;
        report.push({ ...base, action: 'update', result: 'updated', id: hit.id, detail: `Already in CLOZR (same ${hit.by})` + (Object.keys(patch).length ? ' · filled ' + Object.keys(patch).map((k) => k.replace(/_/g, ' ')).join(', ') : ' · nothing new') });
        return;
      }
      const { data: deal, error } = await sb.from('deals').insert({
        workspace_id: workspaceId, seller_id: sellerId, property_id: propertyId, stage: 'Prospect',
        lead_stage: opts.stage, asking_price: r.asking, arv: r.arv, rehab: r.rehab, offer_amount: r.offer,
        notes: submissionNotes(r), submitted_at: r.created ?? now,
        owner_id: owner, created_by: userId, source: opts.label || vendor.name, source_id: r.source_id,
        // Only when chosen, so a database without migration 130 still imports.
        ...(underwriter ? { underwriter_id: underwriter } : {}),
      } as never).select('id').single();
      if (error) throw new Error(error.message);
      const dealId = (deal as { id: number }).id;
      dealIds.push(dealId);
      dealSellerIds.push(sellerId);
      // A later row of this file sending the same house again finds this one.
      indexDeal(known, { id: dealId, sellerId, propertyId, sourceId: r.source_id, archived: false });
      await sb.from('deal_parties').insert({
        workspace_id: workspaceId, deal_id: dealId, role: 'wholesaler', vendor_id: vendor.id, company: vendor.name, source: 'import',
      });
      // An image is a photo. A Drive / Dropbox folder or a listing page is a link under photos (the folder is read into its images).
      await attachPhotoLinks(workspaceId, dealId, r.photos);
      to.count++;
      await logActivity(workspaceId, 'deal', dealId, 'lead', 'Submitted by ' + vendor.name,
        [opts.label, usd(r.asking) ? 'Asking ' + usd(r.asking) : null].filter(Boolean).join(' · '), userId);
      result.created++;
      report.push({ ...base, action: 'create', result: 'created', id: dealId, detail: [owner ? 'owner set' : '', underwriter ? 'underwriter set' : ''].filter(Boolean).join(' · ') });
    } catch (e) {
      result.errors.push(`${base.name}: ${(e as Error).message}`);
      report.push({ ...base, action: 'create', result: 'error', id: null, detail: (e as Error).message });
    }
  }

  let done = 0;
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map((_, k) => i + k);
    await Promise.all(batch.map(one));
    done += batch.length;
    onProgress?.(done);
  }
  report.sort((x, y) => x.row - y.row);
  for (const to of byName.values()) {
    if (to.count) await logActivity(workspaceId, 'seller', to.sellerId, 'lead', `${to.count} submission${to.count === 1 ? '' : 's'} imported`, `${to.vendor.name} · ${opts.label}`, userId);
  }
  const who = byName.size > 1 ? `${byName.size} partners` : main.vendor.name;
  await logRun(workspaceId, {
    kind: 'import', entity: 'vendor', label: `${who} submissions · ${opts.label}`, total: records.length, succeeded: result.created + result.updated,
    failed: result.errors.length, credits: 0,
    detail: {
      created: result.created, updated: result.updated, skipped: result.skipped, stage: opts.stage, vendor_id: main.vendor.id,
      ...(byName.size > 1 ? { vendor_ids: [...byName.values()].map((v) => v.vendor.id) } : {}),
      ...(result.errors.length ? { errors: result.errors.slice(0, 20) } : {}),
    },
  });
  await notifyUser(workspaceId, userId, {
    category: 'Import', title: `Import finished · ${who} submissions`, sellerId: main.sellerId,
    body: `${result.created} submissions at ${opts.stage}${result.updated ? ` · ${result.updated} already in CLOZR (updated)` : ''}${result.skipped ? ` · ${result.skipped} skipped` : ''}${result.errors.length ? ` · ${result.errors.length} failed` : ''}`,
  });
  return { result, report, vendorId: main.vendor.id, sellerId: main.sellerId, dealIds, dealSellerIds, updatedDealIds };
}

/** One house added by hand to a vendor's submissions (Quick Add › New property, tied to a vendor). */
export async function addSubmission(
  workspaceId: number, userId: string | null, vendorId: number, propertyId: number,
  opts: { owner: string | null; stage: string },
): Promise<{ ok: boolean; message?: string; id?: number; dealId?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: v } = await supabase.from('vendors').select('id, business_name').eq('id', vendorId).eq('workspace_id', workspaceId).maybeSingle();
  if (!v) return { ok: false, message: 'That vendor is not in this workspace.' };
  try {
    const vendor = { id: v.id, name: v.business_name };
    const sellerId = await resolveContact(workspaceId, userId, vendor, opts.owner);
    const { data: deal, error } = await supabase.from('deals').insert({
      workspace_id: workspaceId, seller_id: sellerId, property_id: propertyId, stage: 'Prospect', lead_stage: opts.stage,
      submitted_at: new Date().toISOString(), owner_id: opts.owner, created_by: userId, source: vendor.name,
    }).select('id').single();
    if (error) return { ok: false, message: error.message };
    await supabase.from('deal_parties').insert({ workspace_id: workspaceId, deal_id: deal.id, role: 'wholesaler', vendor_id: vendor.id, company: vendor.name, source: 'manual' });
    return { ok: true, id: sellerId, dealId: deal.id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
