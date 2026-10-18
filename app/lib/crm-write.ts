// Writes. The other half of lib/crm.ts.
//
// Everything here takes the workspace id explicitly and returns
// `{ ok, message? }` rather than throwing: a failed save has to surface as a
// toast on the record you were looking at, not as a blank screen.
//
// RLS checks the workspace again on the server, so passing a workspace you are
// not a member of fails at the database rather than relying on this file being
// called correctly.

import { fridayOverrideNote } from './deal-close';
import { dbId } from './crm';
import { notificationDbIds } from './notif-dismiss';
import type { Seller } from './database.types';
import { supabase } from './supabase';
import { type BuyBox, buyerTypeCode, normalizeBuyBox, summarizeBuyBox } from './buyer-profile';
import { buyerContactProblem } from './buyer-contact';
import { isDealStage } from './stages';
import { parseDollars } from './money';
import { toE164 } from './talkr';
import { addSellerPhones } from './seller-phones';
import { nudgeGoogle } from './google';
import { remainingStepSchedule } from './plan-hold';
import { renderMerge } from './sms';
import { BLACKLIST_MESSAGE, blockReason, loadBlocked, type BlacklistDb, type BlockReason } from './blacklist';
import { checklistIdForTitle, checklistItemById, normTcTitle } from './tc-sync';
import { normalizeMarkets, normalizePlace, splitMarketCell, splitPlace, stateCodeOf } from './place-names';

export type WriteResult = { ok: boolean; message?: string; id?: number; dealId?: number };

/** A teammate picked on a Quick Add form: '' is the default, 'none' is nobody. */
const pickedUser = (v: string | undefined): string | null | undefined => (v === 'none' ? null : v?.trim() ? v.trim() : undefined);

/**
 * The deal that carries a lead's team before there is a contract: a TC adding
 * a seller ties it to the acquisitions rep (owner) and to herself (TC), and the
 * deal team (migration 46) lists both. Prospect is the placeholder stage, never
 * a pipeline column.
 */
async function teamDeal(workspaceId: number, sellerId: number, propertyId: number | null, owner: string | null, tc: string | null, userId: string | null): Promise<number | null> {
  if (!supabase || !tc) return null;
  const { data } = await supabase.from('deals').insert({
    workspace_id: workspaceId, seller_id: sellerId, property_id: propertyId, stage: 'Prospect',
    owner_id: owner, tc_rep_id: tc, created_by: userId, source: 'manual',
  }).select('id').single();
  return data?.id ?? null;
}

const fail = (e: { message: string } | null): WriteResult =>
  e ? { ok: false, message: e.message } : { ok: true };
/** A seller insert or update refused by sellers_phone_uniq, said the way a person reads it. */
export const sellerWriteFail = (e: { message: string } | null): WriteResult =>
  e && /sellers_phone_uniq/i.test(e.message) ? { ok: false, message: 'Another seller in this workspace already has that phone number.' } : fail(e);

/**
 * Assemble a one-line address from the separate fields the forms collect.
 *
 * The forms ask for street, city, state and ZIP separately because that is how
 * someone types an address; the database wants them separate too. This is only
 * for the display string stored on the seller.
 */
function joinAddress(f: Record<string, string>): string {
  const line = (f.addr || '').trim();
  if (!line) return '';
  const tail = [(f.city || '').trim(), [(f.st || '').trim().toUpperCase(), (f.zip || '').trim()].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return tail ? `${line}, ${tail}` : line;
}

/**
 * Dollars as typed, through lib/money: "$186,000", "186k" and "1.2m" are the
 * numbers they say (it used to strip "186k" to 186). Unreadable is null; the
 * callers that take a typed amount check `moneyError` first so it is refused,
 * not silently cleared.
 */
function money(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  return parseDollars(v).value;
}
const moneyError = (v: string | number | null | undefined): string | undefined =>
  v === null || v === undefined || v === '' ? undefined : parseDollars(v).error;

/** A phone as it is stored: E.164, or a message saying why it can't be. */
function phoneOf(raw: string | null | undefined): { value: string | null; error?: string } {
  const t = (raw ?? '').trim();
  if (!t) return { value: null };
  const e = toE164(t);
  return e ? { value: e } : { value: null, error: 'Enter a full phone number, area code first' };
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Turn what someone typed into a due timestamp.
 *
 * The Quick Add form takes free text ("Today", "Tomorrow", "Sept 30") because
 * that is how the prototype's field worked. Anything unrecognised is stored as
 * null rather than guessed at — a task with no due date is honest; one due on a
 * date nobody chose is not.
 */
export function parseDue(raw: string | undefined, now = new Date()): string | null {
  const t = (raw || '').trim();
  if (!t) return null;

  // "Today 1:30 PM", "tomorrow 10am", "Fri 2pm", "Sep 30 9:15 am", "9/30 3pm".
  // The time is optional and comes off first; the rest names a day.
  const tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(t) ?? /\b(\d{1,2}):(\d{2})\b/.exec(t);
  let hours = 9, minutes = 0;
  if (tm) {
    hours = Number(tm[1]) % 12;
    minutes = Number(tm[2] ?? 0);
    if (/pm/i.test(tm[3] ?? '')) hours += 12;
    else if (!tm[3] && Number(tm[1]) > 12) hours = Number(tm[1]);
  }
  const dayText = t.replace(tm?.[0] ?? '', '').replace(/\b(at|@)\b/gi, '').trim();

  const at = (d: Date) => { d.setHours(hours, minutes, 0, 0); return d.toISOString(); };
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = (n: number) => new Date(startOfToday.getTime() + n * 86_400_000);

  if (!dayText || /^(today|now|asap)$/i.test(dayText)) return at(days(0));
  if (/^tomorrow$/i.test(dayText)) return at(days(1));
  if (/^overdue/i.test(dayText)) return at(days(-1));
  const inN = /^in\s+(\d+)\s+(day|week|hour)s?$/i.exec(dayText);
  if (inN) {
    const n = Number(inN[1]);
    if (/hour/i.test(inN[2])) return new Date(now.getTime() + n * 3_600_000).toISOString();
    return at(days(/week/i.test(inN[2]) ? n * 7 : n));
  }
  // A weekday name means the next one, today included.
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].findIndex((w) => new RegExp('^' + w, 'i').test(dayText));
  if (wd >= 0 && /^[a-z]{3,9}$/i.test(dayText)) return at(days((wd - now.getDay() + 7) % 7));

  // Date.parse is lenient enough to read "nonsense 2026" as New Year's Day;
  // only try it on something that names a month or carries a digit.
  if (!/\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(dayText)) return null;
  const withYear = /\d{4}/.test(dayText) ? dayText : `${dayText} ${now.getFullYear()}`;
  const parsed = Date.parse(withYear);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  // "Jan 5" typed in December means next January, not eleven months ago.
  if (!/\d{4}/.test(dayText) && d.getTime() < startOfToday.getTime() - 30 * 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return at(d);
}

/**
 * Split "123 Oak St, San Antonio, TX 78254" into its parts, best effort. The
 * city, state and ZIP come back canonical (lib/place-names): "123 Oak St, San
 * Antonio Tx" is still city San Antonio, state TX.
 */
export function splitAddress(raw: string): { line1: string; city: string | null; state: string | null; zip: string | null } {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const line1 = parts[0] || raw.trim();
  const rest = splitPlace(parts.slice(1).join(', '));
  return { line1, city: rest.city, state: rest.state, zip: rest.zip };
}

/**
 * Find or create the property at this address.
 *
 * `address_key` is a generated column, so the database decides what counts as
 * the same address — "123 Oakview Drive" and "123 OAKVIEW DR." resolve to one
 * row here exactly as they do through the ingest door. That is the whole reason
 * the UI goes through this helper instead of inserting directly.
 */
export async function upsertProperty(
  workspaceId: number,
  address: string | { line1: string; city: string | null; state: string | null; zip: string | null },
  extra: Record<string, unknown> = {},
): Promise<number | null> {
  if (!supabase) return null;
  const given = typeof address === 'string' ? splitAddress(address) : address;
  if (!given.line1?.trim()) return null;
  // The city column holds only the city, the state is a code (lib/place-names).
  const parts = { line1: given.line1, ...normalizePlace(given) };

  // address_key is computed server-side, so ask the database for the key rather
  // than reimplementing its normalisation here and drifting from it — then look
  // it up on the indexed column instead of pulling every property down to
  // compare in the browser.
  const { data: key } = await supabase.rpc('address_key', {
    p_line1: parts.line1, p_city: parts.city ?? '', p_state: parts.state ?? '', p_zip: parts.zip ?? '',
  });
  if (key) {
    const { data: hit } = await supabase
      .from('properties').select('id')
      .eq('workspace_id', workspaceId).eq('address_key', key).limit(1);
    if (hit?.length) return hit[0].id;
  }

  const { data, error } = await supabase
    .from('properties')
    .insert({ workspace_id: workspaceId, ...parts, source: 'clozr', ...extra })
    .select('id')
    .single();
  return error ? null : data.id;
}

/** Record something that happened, for the record's Activity feed. */
export async function logActivity(
  workspaceId: number, entityType: string, entityId: number,
  kind: string, title: string, body?: string, actorId?: string | null,
): Promise<void> {
  if (!supabase) return;
  await supabase.from('activity').insert({
    workspace_id: workspaceId, entity_type: entityType, entity_id: entityId,
    kind, title, body: body ?? null, actor_id: actorId ?? null,
  });
}

/** logActivity's row for each of several records, in one insert. */
export async function logActivities(
  workspaceId: number, entityType: string, entityIds: number[],
  kind: string, title: string, body?: string, actorId?: string | null,
): Promise<void> {
  if (!supabase || !entityIds.length) return;
  await supabase.from('activity').insert(entityIds.map((entityId) => ({
    workspace_id: workspaceId, entity_type: entityType, entity_id: entityId,
    kind, title, body: body ?? null, actor_id: actorId ?? null,
  })));
}

// ---- creates ----------------------------------------------------------------

/**
 * A new lead: the seller and the property they own, in one step.
 *
 * The property is find-or-create on the normalised address, so a seller typed
 * in by hand and the same address arriving later from Deal Machine land on one
 * record rather than two.
 */
export async function createSeller(
  workspaceId: number, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  // Quick Add: checked before anything is written, so a bad field leaves no half-made lead.
  if (!f.name?.trim()) return { ok: false, message: 'A seller needs a name.' };
  const phone = phoneOf(f.phone);
  if (phone.error) return { ok: false, message: phone.error };
  const email = (f.email ?? '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) return { ok: false, message: 'That isn’t an email address.' };
  const askErr = moneyError(f.asking);
  if (askErr) return { ok: false, message: 'Asking price: ' + askErr };
  const address = joinAddress(f);
  const propertyId = f.addr?.trim()
    ? await upsertProperty(workspaceId, {
      line1: f.addr.trim(),
      city: f.city?.trim() || null,
      state: f.st?.trim().toUpperCase() || null,
      zip: f.zip?.trim() || null,
    })
    : null;
  const { data, error } = await supabase.from('sellers').insert({
    workspace_id: workspaceId,
    name: f.name.trim(),
    phone: phone.value,
    email: email || null,
    property_address: address || null,
    property_id: propertyId,
    asking_price: money(f.asking),
    motivation: f.motivation || null,
    lead_stage: f.stage || 'Lead',
    source: f.source || 'Manual',
    created_by: userId,
    // Left out when nobody was picked: the database gives a new lead to whoever added it.
    ...(pickedUser(f.assignTo) !== undefined ? { assigned_to: pickedUser(f.assignTo) } : {}),
  }).select('id').single();
  if (error) return sellerWriteFail(error);
  await logActivity(workspaceId, 'seller', data.id, 'lead', 'Lead added', address || undefined, userId);
  const dealId = await teamDeal(workspaceId, data.id, propertyId, pickedUser(f.assignTo) ?? userId, pickedUser(f.tc) ?? null, userId);
  return { ok: true, id: data.id, ...(dealId ? { dealId } : {}) };
}

/**
 * A property and the seller who owns it — the form collects both, because a
 * property with nobody attached is not a lead.
 */
export async function createProperty(
  workspaceId: number, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const propertyId = await upsertProperty(workspaceId, {
    line1: (f.addr || '').trim(),
    city: f.city?.trim() || null,
    state: f.st?.trim().toUpperCase() || null,
    zip: f.zip?.trim() || null,
  }, {
    beds: Number(f.beds) || null,
    baths: Number(f.baths) || null,
    sqft: Number(String(f.sqft || '').replace(/[^0-9]/g, '')) || null,
    year_built: Number(f.year) || null,
    property_type: f.type || null,
  });
  if (!propertyId) return { ok: false, message: 'Could not save that address.' };

  // Tied to a vendor: one of its submissions, on its one contact.
  if (f.vendorId) {
    const { addSubmission } = await import('./submission-import');
    const r = await addSubmission(workspaceId, userId, Number(f.vendorId), propertyId, { owner: pickedUser(f.assignTo) ?? userId, stage: 'New Submission' });
    if (!r.ok) return r;
    await logActivity(workspaceId, 'deal', r.dealId!, 'lead', 'Property added', joinAddress(f), userId);
    return r;
  }
  // Tied to a seller already in CLOZR: the house is theirs, with a deal for it.
  if (f.personId) {
    const sellerId = dbId(f.personId);
    if (!Number.isFinite(sellerId)) return { ok: false, message: 'Unknown seller.' };
    const { data: cur } = await supabase.from('sellers').select('property_id').eq('id', sellerId).maybeSingle();
    if (cur && !cur.property_id) await supabase.from('sellers').update({ property_id: propertyId, property_address: joinAddress(f) }).eq('id', sellerId);
    const { data: deal, error: e } = await supabase.from('deals').insert({
      workspace_id: workspaceId, seller_id: sellerId, property_id: propertyId, stage: 'Prospect',
      owner_id: pickedUser(f.assignTo) ?? userId, created_by: userId, source: 'manual',
    }).select('id').single();
    if (e) return fail(e);
    await logActivity(workspaceId, 'seller', sellerId, 'lead', 'Property added', joinAddress(f), userId);
    return { ok: true, id: sellerId, dealId: deal.id };
  }

  if (!f.name?.trim()) return { ok: true, id: propertyId };
  const { data, error } = await supabase.from('sellers').insert({
    workspace_id: workspaceId,
    name: f.name.trim(),
    phone: f.phone || null,
    email: f.email || null,
    property_address: joinAddress(f),
    property_id: propertyId,
    source: 'Manual',
    created_by: userId,
    ...(pickedUser(f.assignTo) !== undefined ? { assigned_to: pickedUser(f.assignTo) } : {}),
  }).select('id').single();
  if (error) return sellerWriteFail(error);
  await logActivity(workspaceId, 'seller', data.id, 'lead', 'Lead added', joinAddress(f), userId);
  return { ok: true, id: data.id };
}

/**
 * A co-owner, heir or spouse on a property that already has a seller. They
 * share the property row rather than creating a second address.
 */
export async function createCoSeller(
  workspaceId: number, f: Record<string, string>, hostPropertyId: number | null,
  hostAddress: string | null, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!f.name?.trim()) return { ok: false, message: 'A name is required.' };
  const { data, error } = await supabase.from('sellers').insert({
    workspace_id: workspaceId,
    name: f.name.trim(),
    phone: f.phone || null,
    email: f.email || null,
    property_id: hostPropertyId,
    property_address: hostAddress,
    notes: f.role ? 'Relationship: ' + f.role : null,
    source: 'Manual',
    created_by: userId,
  }).select('id').single();
  return error ? sellerWriteFail(error) : { ok: true, id: data.id };
}

/**
 * The full buyer profile: contact, type, the buy box (criteria) and how they
 * want to be reached. `markets`, `max_purchase_price` and the `buy_box` text
 * summary are derived from the criteria so the older screens keep reading
 * something sensible. Quick Add sends only name/company/phone/email/markets/
 * price and gets a profile with just those filled in.
 */
export type BuyerProfileInput = {
  name?: string; company?: string | null; phone?: string | null; email?: string | null;
  buyer_type?: string | null; entity_type?: string | null; website?: string | null; pof_url?: string | null; pof_verified?: boolean;
  preferred_channel?: string; wants_calls?: boolean; wants_follow_ups?: boolean; wants_sold_alerts?: boolean;
  vetted?: boolean; vip?: boolean; blacklisted?: boolean; active?: boolean; tags?: string[]; notes?: string | null; source?: string | null;
  /** Prospect keeps a discovered buyer off the real list and off deal matching. */
  status?: string | null;
  criteria?: unknown;
};

/** The flags whose date column says when they were set. */
const BUYER_STAMPS = { pof_verified: 'pof_verified_at', vetted: 'vetted_at', blacklisted: 'blacklisted_at' } as const;
/** The buyer columns buyerRow needs to know what an edit changed. */
export type BuyerBefore = { status?: string | null; pof_verified_at?: string | null; vetted_at?: string | null; blacklisted_at?: string | null };

/**
 * The buyers columns for the keys `p` carries, and only those, so saving the
 * buy box never touches the phone and saving the phone never touches the buy
 * box. With `before` (an edit), a date column (`pof_verified_at`, `vetted_at`,
 * `blacklisted_at`) moves only when its flag flips, and `status` only when
 * Active was switched: a Prospect stays a Prospect, a Qualified buyer keeps
 * its stage. Without `before` (a new buyer) every flag that is on is stamped now.
 */
export function buyerRow(p: BuyerProfileInput, before?: BuyerBefore | null, now: () => string = () => new Date().toISOString()) {
  const row: Record<string, unknown> = {};
  if ('name' in p) row.name = (p.name ?? '').trim();
  if ('company' in p) row.company = p.company?.trim() || null;
  if ('phone' in p) row.phone = p.phone?.trim() || null;
  if ('email' in p) row.email = p.email?.trim().toLowerCase() || null;
  if ('criteria' in p) {
    const box: BuyBox = normalizeBuyBox(p.criteria ?? {});
    const sm = summarizeBuyBox(box);
    row.criteria = box;
    row.markets = normalizeMarkets(sm.markets);
    row.min_purchase_price = box.price.min ?? null;
    row.max_purchase_price = box.price.max ?? null;
    row.buy_box = sm.oneLine || null;
  }
  if ('buyer_type' in p) row.buyer_type = p.buyer_type || null;
  if ('entity_type' in p) row.entity_type = p.entity_type || null;
  if ('website' in p) row.website = p.website?.trim() || null;
  if ('pof_url' in p) row.pof_url = p.pof_url?.trim() || null;
  for (const [flag, at] of Object.entries(BUYER_STAMPS) as [keyof typeof BUYER_STAMPS, string][]) {
    const v = p[flag];
    if (typeof v !== 'boolean') continue;
    const was = before ? !!before[at as keyof BuyerBefore] : false;
    if (!before) { if (v) row[at] = now(); continue; }
    if (v !== was) row[at] = v ? now() : null;
  }
  if (p.preferred_channel) row.preferred_channel = p.preferred_channel;
  for (const k of ['wants_calls', 'wants_follow_ups', 'wants_sold_alerts'] as const) if (typeof p[k] === 'boolean') row[k] = p[k];
  if (typeof p.vip === 'boolean') row.vip = p.vip;
  if (typeof p.active === 'boolean') {
    const wasInactive = /inactive/i.test(before?.status ?? '');
    // Only a real switch moves the stage, and switching on brings back Active.
    if (!before) row.status = p.active ? 'Active' : 'Inactive';
    else if (p.active && wasInactive) row.status = 'Active';
    else if (!p.active && !wasInactive) row.status = 'Inactive';
  }
  if (Array.isArray(p.tags)) row.tags = p.tags.map((t) => t.trim()).filter(Boolean);
  if ('notes' in p) row.notes = p.notes || null;
  if (p.source) row.source = p.source;
  return row;
}

/** Quick Add's compact form ("$100K – $350K", "DFW, Houston", a note) as a profile. */
export function quickBuyerProfile(f: Record<string, string>): BuyerProfileInput {
  const nums = (f.price || '').match(/[\d.,]+\s*[kKmM]?/g) ?? [];
  const vals = nums.map((n) => {
    const base = Number(n.replace(/[^0-9.]/g, ''));
    return /[kK]/.test(n) ? base * 1000 : /[mM]/.test(n) ? base * 1_000_000 : base;
  }).filter((n) => Number.isFinite(n) && n > 0);
  // "DFW, Houston" is two markets; "San Antonio, TX" is one, in its stored spelling.
  const markets = normalizeMarkets(splitMarketCell(f.markets));
  const pref = (m: string) => {
    if (/^\d{5}$/.test(m)) return { name: m, type: 'zip' as const };
    const st = stateCodeOf(m);
    if (st) return { name: st, type: 'state' as const };
    const [name, tail] = m.split(',').map((x) => x.trim());
    const tailState = stateCodeOf(tail);
    return { name, type: 'city' as const, ...(tailState ? { state: tailState } : {}) };
  };
  return {
    name: f.name, company: f.company, phone: f.phone, email: f.email, buyer_type: buyerTypeCode(f.type),
    criteria: { location_prefs: markets.map(pref), price: vals.length ? { min: vals.length > 1 ? Math.min(...vals) : null, max: Math.max(...vals) } : {} },
    // The form's Note (filled from a call when the dialer opened it): what has no field of its own here.
    ...(f.note?.trim() ? { notes: f.note.trim() } : {}),
    source: 'Manual',
  };
}

export async function createBuyer(
  workspaceId: number, f: Record<string, string> | BuyerProfileInput, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const profile: BuyerProfileInput = 'criteria' in f || 'buyer_type' in f ? (f as BuyerProfileInput) : quickBuyerProfile(f as Record<string, string>);
  if (!profile.name?.trim()) return { ok: false, message: 'Buyer name is required.' };
  const status = /prospect/i.test(profile.status ?? '') ? 'Prospect' : 'Active';
  // A buyer added by hand (Quick Add, the profile form) needs a phone and an
  // email. Prospects come from Genius and Buyr with whatever the trace found,
  // often only one, and wait on a list until someone fills them in.
  const contact = status === 'Prospect' ? null : buyerContactProblem(profile);
  if (contact) return { ok: false, message: contact };
  const row: Record<string, unknown> = { name: (profile.name ?? '').trim(), company: null, phone: null, email: null, ...buyerRow({ criteria: {}, ...profile }) };
  // Dedupe on email, then phone, inside the workspace.
  const email = row.email as string | null; const phone = row.phone as string | null;
  const dupe = email
    ? await supabase.from('buyers').select('id').eq('workspace_id', workspaceId).eq('email', email).limit(1).maybeSingle()
    : phone ? await supabase.from('buyers').select('id').eq('workspace_id', workspaceId).eq('phone', phone).limit(1).maybeSingle() : { data: null };
  if (dupe.data) return { ok: false, message: 'A buyer with that email or phone already exists.', id: dupe.data.id };
  const { data, error } = await supabase.from('buyers').insert({
    workspace_id: workspaceId, created_by: userId, ...row, status,
  } as never).select('id').single();
  if (error) return fail(error);
  // Its own write (migration 128), so a database without the column still adds the buyer.
  const owner = pickedUser((f as Record<string, string>).assignTo);
  if (owner) await supabase.from('buyers').update({ assigned_to: owner } as never).eq('id', data.id);
  await logActivity(workspaceId, 'buyer', data.id, 'buyer', status === 'Prospect' ? 'Buyer prospect added' : 'Buyer added', (row.buy_box as string | null) || undefined, userId);
  // Prospects wait on a list. Matching them would put them on a blast.
  if (status === 'Prospect') return { ok: true, id: data.id, message: 'Filed in Buyer Prospects' };
  const { data: matched } = await supabase.rpc('match_buyer', { p_buyer_id: data.id });
  return { ok: true, id: data.id, message: typeof matched === 'number' ? `${matched} active deal${matched === 1 ? '' : 's'} matched` : undefined };
}

export async function updateBuyer(workspaceId: number, buyerId: number, p: BuyerProfileInput): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if ('name' in p && !p.name?.trim()) return { ok: false, message: 'Buyer name is required.' };
  const { data: before, error: readErr } = await supabase.from('buyers')
    .select('status, pof_verified_at, vetted_at, blacklisted_at').eq('id', buyerId).eq('workspace_id', workspaceId).maybeSingle();
  if (readErr) return fail(readErr);
  if (!before) return { ok: false, message: 'That buyer is not on this workspace.' };
  const row = buyerRow(p, before);
  if (!Object.keys(row).length) return { ok: true, id: buyerId };
  const { error } = await supabase.from('buyers').update({ ...row, updated_at: new Date().toISOString() } as never).eq('id', buyerId).eq('workspace_id', workspaceId);
  if (error) return fail(error);
  // Re-match only what the matcher reads, and never a prospect: matching one
  // puts them on a blast before anyone has vetted them.
  const status = (row.status as string | undefined) ?? before.status ?? '';
  if (/prospect|inactive/i.test(status) || !('criteria' in row || 'status' in row || 'blacklisted_at' in row)) return { ok: true, id: buyerId };
  const { data: matched } = await supabase.rpc('match_buyer', { p_buyer_id: buyerId });
  return { ok: true, id: buyerId, message: typeof matched === 'number' ? `${matched} active deal${matched === 1 ? '' : 's'} matched` : undefined };
}

/** A buyer field the record edits in place (components/buyer/BuyerProfileFields). */
export type BuyerFieldKey = 'name' | 'company' | 'buyer_type' | 'entity_type' | 'vip' | 'vetted' | 'pof_url' | 'pof_verified' | 'website' | 'notes' | 'markets' | 'price_min' | 'price_max';

/**
 * Save one buyer field and return the row. Flags stamp their date only when
 * they flip (patchRecord's withStamps); the stage never moves; markets and the
 * price range write the buy box key (`criteria.location_prefs` /
 * `criteria.price`, atomically, migration 220) and the flat columns the older
 * screens read. Only what the matcher reads re-matches the buyer.
 */
export async function saveBuyerField(
  buyerId: number, key: BuyerFieldKey, value: string | number | boolean | null, before: Record<string, unknown>,
): Promise<PatchResult> {
  let r: PatchResult;
  if (key === 'vetted' || key === 'pof_verified') {
    const at = key === 'vetted' ? 'vetted_at' : 'pof_verified_at';
    const was = !!before[at];
    if (!!value === was) return { ok: true, row: before };
    r = await patchRecord('buyers', buyerId, { [at]: value ? new Date().toISOString() : null });
  } else if (key === 'vip') {
    r = await patchRecord('buyers', buyerId, { vip: !!value });
  } else if (key === 'name') {
    const name = String(value ?? '').trim();
    if (!name) return { ok: false, message: 'A buyer needs a name. Esc keeps the old one' };
    r = await patchRecord('buyers', buyerId, { name });
  } else if (key === 'markets') {
    const prefs = quickBuyerProfile({ name: '', markets: String(value ?? '') }).criteria as { location_prefs: unknown[] };
    const j = await patchJsonKey('buyers', buyerId, 'criteria', 'location_prefs', prefs.location_prefs);
    if (!j.ok) return j;
    const box = normalizeBuyBox((j.row as { criteria?: unknown }).criteria ?? {});
    r = await patchRecord('buyers', buyerId, { markets: normalizeMarkets(summarizeBuyBox(box).markets), buy_box: summarizeBuyBox(box).oneLine || null });
  } else if (key === 'price_min' || key === 'price_max') {
    const crit = normalizeBuyBox(before.criteria ?? {});
    const price = { min: crit.price.min ?? null, max: crit.price.max ?? null, [key === 'price_min' ? 'min' : 'max']: value == null ? null : Number(value) };
    if (price.min != null && price.max != null && price.min > price.max) return { ok: false, message: 'The low end is above the high end' };
    const j = await patchJsonKey('buyers', buyerId, 'criteria', 'price', price);
    if (!j.ok) return j;
    const box = normalizeBuyBox((j.row as { criteria?: unknown }).criteria ?? {});
    r = await patchRecord('buyers', buyerId, { min_purchase_price: price.min, max_purchase_price: price.max, buy_box: summarizeBuyBox(box).oneLine || null });
  } else {
    const v = typeof value === 'string' ? value.trim() || null : value;
    r = await patchRecord('buyers', buyerId, { [key]: v });
  }
  if (!r.ok) return r;
  const status = String((r.row as { status?: string }).status ?? '');
  if (['markets', 'price_min', 'price_max', 'buyer_type', 'vip'].includes(key) && !/prospect|inactive/i.test(status) && supabase) {
    await supabase.rpc('match_buyer', { p_buyer_id: buyerId });
  }
  return r;
}

/** Score every buyer against one deal; the Matches tab reads the result. */
export async function matchDeal(dealId: number): Promise<WriteResult & { count?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('match_deal', { p_deal_id: dealId });
  return error ? fail(error) : { ok: true, count: typeof data === 'number' ? data : 0 };
}

/** Re-score every deal in the workspace after buy-box or matcher rules change. */
export async function rematchWorkspace(workspaceId: number): Promise<WriteResult & { count?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('rematch_workspace', { p_workspace_id: workspaceId });
  return error ? fail(error) : { ok: true, count: typeof data === 'number' ? data : 0 };
}

export async function createVendor(
  workspaceId: number, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.from('vendors').insert({
    workspace_id: workspaceId,
    business_name: f.name.trim(),
    contact_name: f.contact || null,
    phone: f.phone || null,
    email: f.email || null,
    service_type: f.kind || null,
    markets: normalizeMarkets(splitMarketCell(f.market)),
    notes: f.note || null,
    created_by: userId,
    // Where the office is (migration 80): the address box fills street, city and state.
    ...(f.addr?.trim() ? { office_address: joinAddress(f) } : {}),
    ...(f.city?.trim() || f.st?.trim() ? (({ city, state }) => ({ city, state }))(normalizePlace({ city: f.city?.trim() || null, state: f.st?.trim() || null })) : {}),
  }).select('id').single();
  return error ? fail(error) : { ok: true, id: data.id };
}

export async function createDeal(
  workspaceId: number, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sellerId = f.personId ? dbId(f.personId) : null;
  // The deal's own house when the form named one, else the seller's.
  const propertyId = f.addr?.trim()
    ? await upsertProperty(workspaceId, { line1: f.addr.trim(), city: f.city?.trim() || null, state: f.st?.trim().toUpperCase() || null, zip: f.zip?.trim() || null })
    : sellerId != null && Number.isFinite(sellerId)
      ? (await supabase.from('sellers').select('property_id').eq('id', sellerId).maybeSingle()).data?.property_id ?? null
      : null;
  const { data, error } = await supabase.from('deals').insert({
    workspace_id: workspaceId,
    seller_id: Number.isFinite(sellerId) ? sellerId : null,
    property_id: propertyId,
    stage: f.stage && isDealStage(f.stage) ? f.stage : 'Under Contract Seller',
    offer_amount: money(f.contract),
    arv: money(f.arv),
    rehab: money(f.rehab),
    assignment_fee: money(f.assignment),
    close_date: parseDue(f.close)?.slice(0, 10) ?? null,
    owner_id: pickedUser(f.assignTo) ?? userId,
    tc_rep_id: pickedUser(f.tc) ?? null,
    created_by: userId,
  }).select('id').single();
  if (error) return fail(error);
  // A Friday close the person kept on purpose: the reason they typed goes on the deal (lib/deal-close).
  const closeIso = parseDue(f.close)?.slice(0, 10) ?? null;
  if (closeIso && f.fridayReason?.trim()) {
    void logActivity(workspaceId, 'deal', data.id, 'tc', 'Friday close kept', fridayOverrideNote(closeIso, f.fridayReason.trim(), 'new deal'), userId).catch(() => {});
  }
  // Sent by a vendor (Offerpad, a wholesaler): it is on that vendor's list.
  if (f.vendorId && Number.isFinite(Number(f.vendorId))) {
    const { data: v } = await supabase.from('vendors').select('business_name').eq('id', Number(f.vendorId)).maybeSingle();
    await supabase.from('deal_parties').insert({ workspace_id: workspaceId, deal_id: data.id, role: 'wholesaler', vendor_id: Number(f.vendorId), company: v?.business_name ?? null, source: 'manual' });
  }
  return { ok: true, id: data.id, dealId: data.id };
}

/** An open TC file. The triggers write 'open'; a row that took the column default may read 'Open'. */
const TX_OPEN = ['open', 'Open'];

export async function createTask(
  workspaceId: number, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sellerId = f.personId ? dbId(f.personId) : null;
  // A buyer's task ('b' + buyers.id), when there is no seller: a Compr call's follow-up.
  const buyerId = !f.personId && f.buyerId ? dbId(f.buyerId) : null;
  const { data, error } = await supabase.from('tasks').insert({
    workspace_id: workspaceId,
    seller_id: Number.isFinite(sellerId) ? sellerId : null,
    ...(buyerId != null && Number.isFinite(buyerId) ? { buyer_id: buyerId } : {}),
    title: f.title.trim(),
    task_type: f.type || 'Call',
    priority: f.priority || 'Medium',
    // A task nobody dated is due today: that is where the person who made it
    // will look for it, and a task with no date shows up on no list at all.
    // `dueAt` is an exact instant (a call outcome's follow-up) and is taken as
    // it is: parseDue would read the "15:00" out of a UTC string as a local time.
    due_at: f.dueAt || (parseDue(f.due) ?? parseDue('today')),
    assigned_to: userId,
    created_by: userId,
  }).select('id').single();
  if (error) return fail(error);
  // A dated task is a calendar entry for whoever connected Google. Fire and
  // forget: the next sync would pick it up anyway, this just makes it instant.
  nudgeGoogle(workspaceId);
  const sid = sellerId != null && Number.isFinite(sellerId) ? sellerId : null;
  const itemId = sid != null ? checklistIdForTitle(f.title.trim()) : null;
  if (itemId && sid != null) {
    // A seller can have more than one TC file: the newest open one (maybeSingle on several errored, and the tick was lost).
    const { data: tx } = await supabase.from('transactions')
      .select('id, checklist').eq('workspace_id', workspaceId).eq('seller_id', sid).in('status', TX_OPEN)
      .order('id', { ascending: false }).limit(1).maybeSingle();
    if (tx) {
      const cur = ((tx as { checklist?: Record<string, boolean> }).checklist ?? {});
      if (!cur[itemId]) {
        await supabase.from('transactions').update({
          checklist: { ...cur, [itemId]: false },
          updated_at: new Date().toISOString(),
        }).eq('id', tx.id);
      }
    }
  }
  return { ok: true, id: data.id };
}

export async function createAppointment(
  workspaceId: number, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const day = parseDue(f.day) ?? new Date().toISOString();
  // The form takes a day and a time separately; combine them, and fall back to
  // the day at 9am when the time is not something we can read. A call
  // outcome's walkthrough arrives as one exact instant, `startsAt`.
  const t = f.startsAt ? null : /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(f.time || '');
  const when = new Date(f.startsAt || day);
  if (t) {
    let h = Number(t[1]) % 12;
    if (/pm/i.test(t[3] || '')) h += 12;
    when.setHours(h, Number(t[2]), 0, 0);
  }
  // The seller and buyer it is with, when the form knows them: a walkthrough
  // is only listed on the dispo screen when it names both.
  const sellerId = f.personId ? dbId(f.personId) : NaN;
  const buyerId = f.buyerId ? dbId(f.buyerId) : NaN;
  // The house it is at (a dispo walkthrough), so a seller with several houses
  // sees each one's walkthroughs on that house only.
  const propertyId = f.propertyId ? Number(f.propertyId) : NaN;
  const { data, error } = await supabase.from('appointments').insert({
    workspace_id: workspaceId,
    title: f.title.trim(),
    kind: f.type || 'Appointment',
    starts_at: when.toISOString(),
    seller_id: Number.isFinite(sellerId) ? sellerId : null,
    buyer_id: Number.isFinite(buyerId) ? buyerId : null,
    ...(Number.isFinite(propertyId) ? { property_id: propertyId } : {}),
    created_by: userId,
  }).select('id').single();
  if (error) return fail(error);
  nudgeGoogle(workspaceId);
  return { ok: true, id: data.id };
}

/**
 * A note, or anything typed into a record's composer.
 *
 * It goes in `communications` beside the calls and texts rather than in its own
 * table, because the record timeline is one stream and splitting it would mean
 * merging it back on every read.
 */
export async function createCommunication(
  workspaceId: number,
  opts: { sellerId: number | null; buyerId?: number | null; dealId?: number | null; channel: string; direction: 'inbound' | 'outbound'; body: string; subject?: string },
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  // The signed-in rep wrote it, so the leaderboard credits them (migration 85).
  const repId = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  const { data, error } = await supabase.from('communications').insert({
    workspace_id: workspaceId,
    seller_id: opts.sellerId,
    buyer_id: opts.buyerId ?? null,
    ...(opts.dealId != null ? { deal_id: opts.dealId } : {}),
    channel: opts.channel,
    direction: opts.direction,
    body: opts.body,
    subject: opts.subject ?? null,
    occurred_at: new Date().toISOString(),
    ...(repId ? { rep_id: repId } : {}),
    // Written here rather than received from a sender, and the pair is what
    // ingest_apply dedupes on — a UUID keeps a double-click from double-posting
    // under a key that could collide with a real delivery.
    source: 'clozr',
    source_id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
  }).select('id').single();
  return error ? fail(error) : { ok: true, id: data.id };
}

/** Quick Add, dispatched by kind. Mirrors the eight entries in the menu. */
export async function saveAdd(
  workspaceId: number, kind: string, f: Record<string, string>, userId: string | null,
): Promise<WriteResult> {
  switch (kind) {
    case 'seller': return createSeller(workspaceId, f, userId);
    case 'coseller': return createCoSeller(
      workspaceId, f,
      Number.isFinite(Number(f.hostPropertyId)) ? Number(f.hostPropertyId) : null,
      f.hostAddress || null, userId,
    );
    case 'property': return createProperty(workspaceId, f, userId);
    case 'address': return setSellerAddress(workspaceId, f.personId || '', f, userId, f.scope === 'everyone' ? 'everyone' : 'seller');
    case 'buyer': return createBuyer(workspaceId, f, userId);
    case 'vendor': return createVendor(workspaceId, f, userId);
    case 'deal': return createDeal(workspaceId, f, userId);
    case 'task': return createTask(workspaceId, f, userId);
    case 'appointment': return createAppointment(workspaceId, f, userId);
    case 'note': return createCommunication(workspaceId, {
      sellerId: f.personId ? dbId(f.personId) : null,
      channel: 'note', direction: 'outbound', body: f.body || '',
    });
    default: return { ok: false, message: 'Unknown record type.' };
  }
}

// ---- updates ----------------------------------------------------------------

/**
 * Move a seller to a new stage.
 *
 * Only the seller is written. The database keeps the deal in step: Under
 * Contract - Seller creates the deal (in active dispo inventory) when there is
 * none, Closed / Terminated / Referred to Realtor move it, and a deal moved
 * from the pipeline writes the seller back (migration 26).
 */
export async function setStage(
  workspaceId: number, personId: string, stage: string, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sellerId = dbId(personId);
  if (!Number.isFinite(sellerId)) return { ok: false, message: 'Unknown record.' };
  const { error } = await supabase.from('sellers').update({ lead_stage: stage }).eq('id', sellerId).eq('workspace_id', workspaceId);
  if (error) return fail(error);
  // The stage is saved; the log and the TC ping follow without holding the
  // screen, as setDealStage already does.
  void logActivity(workspaceId, 'seller', sellerId, 'stage', 'Stage → ' + stage, undefined, userId).catch(() => {});
  if (stage === 'Make Offer') {
    void notifyTc(workspaceId, {
      title: 'Offer requested',
      body: 'Stage moved to Make Offer — the TC needs to send the offer.',
      sellerId,
      category: 'TC',
    }).catch(() => {});
  }
  return { ok: true };
}

/**
 * Move many sellers to one stage (People's bulk bar): one update per batch of
 * ids instead of one per seller, and one activity row each, written together.
 * The database triggers still run per row, so a contract stage opens a deal
 * for every seller moved; the bulk bar asks twice before that.
 */
export async function setStageMany(
  workspaceId: number, personIds: string[], stage: string, userId: string | null, reason: string | null = null,
): Promise<WriteResult & { moved?: number; movedIds?: number[] }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  let moved = 0;
  const movedIds: number[] = [];
  // The TC roster, read once for the whole move instead of once per seller.
  let tcs: Promise<string[]> | null = null;
  for (const b of batches(personIds)) {
    const { data, error } = await supabase.from('sellers').update({ lead_stage: stage })
      .eq('workspace_id', workspaceId).in('id', b).select('id');
    if (error) return { ...fail(error), moved, movedIds };
    const done = (data ?? []).map((r) => r.id);
    moved += done.length;
    movedIds.push(...done);
    // As setStage: Make Offer asks the TC to send each offer, one insert per batch.
    if (stage === 'Make Offer' && done.length) {
      tcs ??= tcUserIds(workspaceId);
      void notifyTc(workspaceId, done.map((sellerId) => ({ title: 'Offer requested', body: 'Stage moved to Make Offer — the TC needs to send the offer.', sellerId, category: 'TC' })), tcs).catch(() => {});
    }
    if (done.length) {
      void supabase.from('activity').insert(done.map((id) => ({
        workspace_id: workspaceId, entity_type: 'seller', entity_id: id, kind: 'stage', title: 'Stage → ' + stage, body: reason ? 'Bulk move. Reason: ' + reason : 'Bulk move', actor_id: userId,
      }))).then(() => {}, () => {});
    }
  }
  return { ok: true, moved, movedIds };
}

/**
 * The deal for one house of a seller, for Offer accepted: their open deal on
 * that property (with no property, their open deal with none), else a new one
 * at Prospect on it. Prospect is where a deal waits before the contract; the
 * database moves it to Under Contract Seller when the seller signs. Never
 * picks a deal on another of the seller's houses.
 */
export async function openDealOnProperty(
  workspaceId: number, sellerId: number, propertyId: number | null, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  let q = supabase.from('deals').select('id').eq('workspace_id', workspaceId).eq('seller_id', sellerId)
    .not('stage', 'in', CLOSED_DEAL_STAGES).is('archived_at', null);
  q = propertyId != null ? q.eq('property_id', propertyId) : q.is('property_id', null);
  const { data: found, error: findErr } = await q.order('id', { ascending: false }).limit(1);
  if (findErr) return fail(findErr);
  if (found?.length) return { ok: true, id: found[0].id };
  const { data, error } = await supabase.from('deals').insert({
    workspace_id: workspaceId, seller_id: sellerId, property_id: propertyId, stage: 'Prospect',
    owner_id: userId, created_by: userId, source: 'manual',
  }).select('id').single();
  return error ? fail(error) : { ok: true, id: data.id };
}

export { eachLimited } from './each-limited';

/** Move a deal on the pipeline. The seller's stage follows in the database. */
/**
 * What COMPR just painted, onto the seller's deal.
 *
 * The rep ran (or opened) the underwrite inside the embedded COMPR on the
 * record, so COMPR has the report and the deal only needs the numbers and the
 * link back. Keyed by the seller: the deal is found or created the same way
 * the compr-underwrite function does it. A run still in progress carries no
 * numbers and is skipped; the finished paint follows a minute later.
 */
export async function applyComprReport(
  workspaceId: number, sellerId: number, userId: string | null,
  r: { leadId: string | null; status: string; arv: number | null; rehab: number | null; mao: number | null;
       wholesale: number | null; institutional: number | null; confidence: number | null; reportUrl: string | null;
       condition?: string | null; arvLow?: number | null; arvHigh?: number | null; compCount?: number | null;
       beds?: number | null; baths?: number | null;
       redFlags?: { description?: string }[] },
  /** The submission the record is on: a partner contact has one deal per house, and the report is that house's. */
  dealId?: number | null,
): Promise<WriteResult & { changed?: boolean }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (r.status === 'running' || (r.arv === null && r.mao === null)) return { ok: true };
  const { comprNote } = await import('./compr-sync');
  const { bandOfRow, offerBand, offerBandColumns } = await import('./offer-band');
  // The band a person set stays (migration 184). Before that migration the
  // two set_at columns are not there, and the read goes without them.
  const cols = 'id, arv, rehab, mao, wholesale_offer, institutional_offer, underwriting_url, condition_notes, property_id';
  const read = (withSet: boolean) => {
    const q = supabase!.from('deals').select(withSet ? cols + ', offer_low_set_at, offer_high_set_at' : cols)
      .eq('workspace_id', workspaceId).eq('seller_id', sellerId);
    return (dealId != null ? q.eq('id', dealId) : q).limit(1);
  };
  let res = await read(true);
  if (res.error) res = await read(false);
  type Cur = {
    id: number; arv: number | null; rehab: number | null; mao: number | null;
    wholesale_offer: number | null; institutional_offer: number | null; underwriting_url: string | null;
    condition_notes: string | null; property_id: number | null; offer_low_set_at?: string | null; offer_high_set_at?: string | null;
  };
  const cur = (res.data?.[0] ?? undefined) as Cur | undefined;
  if (dealId != null && !cur) return { ok: false, message: 'That submission is not on this record.' };
  const band = offerBand({ ...bandOfRow(cur), mao: r.mao });
  const note = comprNote({ ...r, wholesale: band.low, institutional: band.high });
  const num = (v: number | string | null | undefined) => (v == null ? null : Number(v));
  const replacing = (c: Cur | undefined) =>
    !!c && (num(c.arv) !== r.arv || num(c.rehab) !== r.rehab || num(c.mao) !== band.mao
      || (band.low != null && num(c.wholesale_offer) !== band.low)
      || (band.high != null && num(c.institutional_offer) !== band.high));
  // Re-opening a report the deal already carries is not news.
  if (cur && !replacing(cur) && (!r.reportUrl || cur.underwriting_url === r.reportUrl)) return { ok: true };
  const writeNote = !!note && (!cur?.condition_notes || cur.condition_notes.startsWith('COMPR ·') || replacing(cur));
  const patch = {
    arv: r.arv, rehab: r.rehab, mao: band.mao,
    ...offerBandColumns(band),
    ...(r.reportUrl ? { underwriting_url: r.reportUrl } : {}),
    ...(writeNote ? { condition_notes: note } : {}),
    updated_at: new Date().toISOString(),
  };
  const { data: sellerRow } = await supabase.from('sellers').select('property_id, condition').eq('id', sellerId).maybeSingle();
  // On a submission the house is the deal's, and the partner's own condition is not this house's.
  const seller = dealId != null && sellerRow ? { property_id: cur?.property_id ?? null, condition: 'n/a' } : sellerRow;
  if (cur) {
    const { error } = await supabase.from('deals').update(patch).eq('id', cur.id);
    if (error) return fail(error);
  } else {
    const { error } = await supabase.from('deals').insert({
      workspace_id: workspaceId, seller_id: sellerId, property_id: seller?.property_id ?? null,
      stage: 'Prospect', ...patch, owner_id: userId, created_by: userId, source: 'compr',
    });
    if (error) return fail(error);
  }
  // Condition lands on the seller (What we know) and the property when the
  // record has none, or when the underwriting numbers themselves are changing.
  if (r.condition && seller && (!seller.condition || replacing(cur) || dealId != null)) {
    if (dealId == null) await supabase.from('sellers').update({ condition: r.condition }).eq('id', sellerId).eq('workspace_id', workspaceId);
    if (seller.property_id) {
      const { data: prop } = await supabase.from('properties').select('condition').eq('id', seller.property_id).maybeSingle();
      if (!prop?.condition || replacing(cur)) {
        await supabase.from('properties').update({ condition: r.condition }).eq('id', seller.property_id);
      }
    }
  }
  // Beds / baths from COMPR fill the property when it has none. A value COMPR
  // filled before (compr_filled, migration 201) follows a re-run that moved
  // the MAO; a value the seller gave is never replaced, since compr-underwrite
  // sends it to COMPR as the submitter's. What COMPR writes is marked, so the
  // next run leaves it off and COMPR looks it up again. Before 201 the mark
  // is skipped and only blanks are filled.
  if (seller?.property_id && (r.beds != null || r.baths != null)) {
    type Facts = { beds: number | null; baths: number | null; compr_filled?: string[] | null };
    let read = await supabase.from('properties').select('beds, baths, compr_filled').eq('id', seller.property_id).maybeSingle();
    const marked = !read.error;
    if (read.error) read = await supabase.from('properties').select('beds, baths').eq('id', seller.property_id).maybeSingle();
    const prop = read.data as Facts | null;
    const owned = new Set(prop?.compr_filled ?? []);
    const takes = (k: 'beds' | 'baths') => r[k] != null && (!prop?.[k] || (owned.has(k) && replacing(cur)));
    const keys = (['beds', 'baths'] as const).filter(takes);
    if (keys.length) {
      const bedsPatch: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, r[k]]));
      if (marked) {
        bedsPatch.compr_filled = [...new Set([...owned, ...keys])];
        bedsPatch.compr_filled_at = new Date().toISOString();
      }
      await supabase.from('properties').update(bedsPatch as never).eq('id', seller.property_id);
    }
  }
  const money = (n: number | null) => (n === null ? '—' : '$' + n.toLocaleString('en-US'));
  await logActivity(
    workspaceId, dealId != null ? 'deal' : 'seller', dealId ?? sellerId, 'compr',
    `COMPR: ARV ${money(r.arv)} · rehab ${money(r.rehab)} · MAO ${money(band.mao)}${r.condition ? ` · ${r.condition}` : ''}${r.status !== 'underwritten' && r.status !== 'complete' ? ` · ${r.status}` : ''}`,
    [
      `MAO ${money(band.mao)} — low ${money(band.low)}, high ${money(band.high)}${band.lowSet || band.highSet ? ' (set by hand, kept)' : ''}.`,
      r.arvLow != null && r.arvHigh != null ? `ARV range ${money(r.arvLow)}–${money(r.arvHigh)}.` : null,
      r.compCount != null ? `${r.compCount} comps.` : null,
      r.confidence !== null ? `Confidence ${r.confidence}%.` : null,
      r.reportUrl ? `Report: ${r.reportUrl}` : null,
      r.leadId ? `Lead id ${r.leadId}.` : null,
      note || null,
    ].filter((l): l is string => !!l).join('\n'),
    userId,
  );
  return { ok: true, changed: true };
}

/**
 * A person typed the low or the high offer on the record (or cleared it).
 * Typing owns that side, so no COMPR sync moves it again; clearing hands it
 * back to the MAO. Both columns are written, because the side nobody set
 * follows the other (a hand-set high pulls its low along).
 */
export async function saveOfferBand(
  workspaceId: number, dealId: number, which: 'low' | 'high', amount: number | null, userId: string | null,
): Promise<WriteResult & { band?: import('./offer-band').Band }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { bandOfRow, editOfferBand } = await import('./offer-band');
  const cols = 'id, mao, wholesale_offer, institutional_offer';
  let res = await supabase.from('deals').select(cols + ', offer_low_set_at, offer_high_set_at').eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
  const flags = !res.error;
  if (!flags) res = await supabase.from('deals').select(cols).eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
  const cur = res.data as { mao: number | null; wholesale_offer: number | null; institutional_offer: number | null; offer_low_set_at?: string | null; offer_high_set_at?: string | null } | null;
  if (!cur) return { ok: false, message: 'That deal is not in this workspace.' };
  const band = editOfferBand(bandOfRow(cur), which, amount);
  const now = new Date().toISOString();
  const patch = {
    wholesale_offer: band.low, institutional_offer: band.high, updated_at: now,
    ...(flags ? {
      offer_low_set_at: band.lowSet ? (which === 'low' ? now : cur.offer_low_set_at ?? now) : null,
      offer_high_set_at: band.highSet ? (which === 'high' ? now : cur.offer_high_set_at ?? now) : null,
    } : {}),
  };
  const { error } = await supabase.from('deals').update(patch).eq('id', dealId);
  if (error) return fail(error);
  const money = (n: number | null) => (n === null ? '—' : '$' + n.toLocaleString('en-US'));
  void logActivity(
    workspaceId, 'deal', dealId, 'offer',
    amount == null ? `${which === 'low' ? 'Low' : 'High'} offer back on COMPR's offer` : `${which === 'low' ? 'Low' : 'High'} offer set to ${money(amount)}`,
    `Low ${money(band.low)} · high ${money(band.high)}${band.mao != null ? ` · MAO ${money(band.mao)}` : ''}.`,
    userId,
  ).catch(() => {});
  return { ok: true, band };
}

// ---- the TC file ------------------------------------------------------------

/** Workspace members with the TC role — never a hardcoded name. */
export async function tcUserIds(workspaceId: number): Promise<string[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).eq('role', 'tc');
  return (data ?? []).map((r) => r.user_id);
}

type TcPing = { title: string; body?: string; sellerId?: number | null; dealId?: number | null; category?: string };

/**
 * Ping every TC on the roster. Used for offer requests and docs the TC just
 * sent. Several pings go in one insert; `tcIds` is a roster read already made
 * (a bulk stage move reads it once for all its batches).
 */
export async function notifyTc(workspaceId: number, opts: TcPing | TcPing[], tcIds?: Promise<string[]>): Promise<void> {
  if (!supabase) return;
  const ids = await (tcIds ?? tcUserIds(workspaceId));
  const pings = Array.isArray(opts) ? opts : [opts];
  if (!ids.length || !pings.length) return;
  await supabase.from('notifications').insert(pings.flatMap((p) => ids.map((user_id) => ({
    workspace_id: workspaceId,
    user_id,
    category: p.category ?? 'TC',
    title: p.title,
    body: p.body ?? null,
    seller_id: p.sellerId ?? null,
    deal_id: p.dealId ?? null,
  }))));
}

async function logTc(
  workspaceId: number, sellerId: number | null, title: string, body: string | undefined, actorId?: string | null,
): Promise<void> {
  if (sellerId == null) return;
  await logActivity(workspaceId, 'seller', sellerId, 'tc', title, body, actorId);
}

/** Keep a CRM task in step with a checklist tick (same title, assigned to the TC). */
async function syncChecklistToTask(
  workspaceId: number, sellerId: number, taskId: string, done: boolean, actorId?: string | null,
): Promise<void> {
  if (!supabase) return;
  const item = checklistItemById(taskId);
  if (!item) return;
  const { data: tasks } = await supabase.from('tasks')
    .select('id, title, done')
    .eq('workspace_id', workspaceId)
    .eq('seller_id', sellerId);
  const match = (tasks ?? []).find((t) => normTcTitle(t.title) === normTcTitle(item.t) || checklistIdForTitle(t.title) === taskId);
  const now = new Date().toISOString();
  if (match) {
    if (match.done === done) return;
    await supabase.from('tasks').update({ done, completed_at: done ? now : null }).eq('id', match.id);
    return;
  }
  const assignees = await tcUserIds(workspaceId);
  await supabase.from('tasks').insert({
    workspace_id: workspaceId,
    seller_id: sellerId,
    title: item.t,
    task_type: 'TC',
    priority: 'Medium',
    due_at: parseDue('today'),
    assigned_to: assignees[0] ?? actorId ?? null,
    created_by: actorId ?? null,
    done,
    completed_at: done ? now : null,
    notes: 'Synced from the contract-to-close checklist',
  });
  nudgeGoogle(workspaceId);
}

/** One tick on the contract-to-close checklist or the HUD/CD block (migration 36). */
export async function setTcTick(
  transactionId: number, block: 'checklist' | 'hud', taskId: string, done: boolean, actorId?: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  // Read-merge-write on the jsonb: two TCs ticking different boxes at once
  // both keep their tick, because each merge starts from the row as it is.
  const { data: row, error: readErr } = await supabase.from('transactions')
    .select('workspace_id, seller_id, ' + block).eq('id', transactionId).maybeSingle();
  if (readErr) return fail(readErr);
  const rec = row as { workspace_id?: number; seller_id?: number | null; checklist?: Record<string, boolean>; hud?: Record<string, boolean> } | null;
  const cur = (block === 'checklist' ? rec?.checklist : rec?.hud) ?? {};
  const next = { ...cur, [taskId]: done };
  const patch = block === 'checklist' ? { checklist: next } : { hud: next };
  const { error } = await supabase.from('transactions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', transactionId);
  if (error) return fail(error);
  const item = checklistItemById(taskId);
  const label = item?.t || taskId;
  const ws = rec?.workspace_id;
  const sellerId = rec?.seller_id ?? null;
  if (ws && sellerId) {
    await logTc(ws, sellerId,
      block === 'hud'
        ? (done ? 'HUD line verified' : 'HUD line reopened')
        : (done ? 'TC checklist · done' : 'TC checklist · reopened'),
      label, actorId);
    if (block === 'checklist') await syncChecklistToTask(ws, sellerId, taskId, done, actorId);
  }
  return { ok: true };
}

/** The T-2 gate: who walked the lines, and an owner's explicit sign-off. */
export async function setTcGate(
  transactionId: number, field: 'tc_review' | 'signoff', value: string | null, actorId?: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: row, error: readErr } = await supabase.from('transactions')
    .select('workspace_id, seller_id').eq('id', transactionId).maybeSingle();
  if (readErr) return fail(readErr);
  const patch = field === 'tc_review' ? { tc_review: value } : { signoff: value };
  const { error } = await supabase.from('transactions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', transactionId);
  if (error) return fail(error);
  const rec = row as { workspace_id?: number; seller_id?: number | null } | null;
  if (rec?.workspace_id && rec.seller_id) {
    await logTc(rec.workspace_id, rec.seller_id,
      field === 'tc_review' ? 'TC review recorded' : 'Owner HUD sign-off recorded',
      value || undefined, actorId);
  }
  return { ok: true };
}

/** The file's own fields: track, dates, title rep, buyer financing. */
export async function updateTcFile(
  transactionId: number,
  patch: Partial<Pick<import('./database.types').TransactionRow,
    'deal_type' | 'contract_date' | 'ctc_target' | 'close_date' | 'title_company' | 'escrow_officer' | 'title_email' | 'title_phone'
    | 'emd_amount' | 'emd_received_at' | 'buyer_financing' | 'lender' | 'structure' | 'option_ends_on'>>,
  actorId?: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: row, error: readErr } = await supabase.from('transactions')
    .select('workspace_id, seller_id, deal_id').eq('id', transactionId).maybeSingle();
  if (readErr) return fail(readErr);
  const { error } = await supabase.from('transactions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', transactionId);
  if (error) return fail(error);
  const rec = row as { workspace_id?: number; seller_id?: number | null; deal_id?: number | null } | null;
  // The deal's close date is the one the board, the calendar and the Deal
  // Sheet show (and the TC screen reads first), so a close date set on the
  // file moves the deal with it, as Lane's applied date updates already do.
  if ('close_date' in patch && rec?.deal_id) {
    await supabase.from('deals').update({ close_date: patch.close_date ?? null, updated_at: new Date().toISOString() }).eq('id', rec.deal_id);
  }
  if (patch.emd_received_at && rec?.workspace_id && rec.seller_id) {
    await logTc(rec.workspace_id, rec.seller_id, 'EMD marked received', undefined, actorId);
  }
  return { ok: true };
}

export async function setDealStage(
  workspaceId: number, dealId: string, stage: string, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const id = dbId(dealId);
  if (!Number.isFinite(id)) return { ok: false, message: 'Unknown deal.' };
  // Prospect is a real deal stage (deal_stages): a deal can go back to it from the board.
  if (!isDealStage(stage) && stage !== 'Prospect') return { ok: false, message: 'Unknown stage.' };
  const { error } = await supabase.from('deals').update({ stage, updated_at: new Date().toISOString() }).eq('id', id).eq('workspace_id', workspaceId);
  if (error) return fail(error);
  void logActivity(workspaceId, 'deal', id, 'stage', 'Deal → ' + stage, undefined, userId).catch(() => {});
  return { ok: true };
}

/**
 * A submission's own acquisitions stage (deals.lead_stage): Offerpad's 123 Main
 * St moves without moving Offerpad or its other forty houses. The database
 * notifies the underwriter, the owner on Underwriting Complete / Declined, and
 * Dispo and TC on Offer Accepted (migration 130).
 */
export async function setSubmissionStage(
  workspaceId: number, dealIds: string[], stage: string, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(dealIds)) {
    const { error } = await supabase.from('deals').update({ lead_stage: stage, updated_at: new Date().toISOString() }).in('id', b).eq('workspace_id', workspaceId);
    if (error) return fail(error);
    void logActivities(workspaceId, 'deal', b, 'stage', 'Stage → ' + stage, undefined, userId).catch(() => {});
  }
  return { ok: true };
}

/** Who owns these submissions (deals.owner_id): the rep who makes the offer once underwriting is done. */
export async function assignDeals(dealIds: string[], userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(dealIds)) {
    const { error } = await supabase.from('deals').update({ owner_id: userId }).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/** Who underwrites these submissions (deals.underwriter_id, migration 130); null clears it. */
export async function setDealUnderwriter(dealIds: string[], userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(dealIds)) {
    const { error } = await supabase.from('deals').update({ underwriter_id: userId } as never).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/** Move a task's due time (Reschedule on the record's Next action). */
export async function setTaskDue(taskId: string, dueAt: string): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const id = dbId(taskId);
  if (!Number.isFinite(id)) return { ok: false, message: 'Unknown task.' };
  const { error } = await supabase.from('tasks').update({ due_at: dueAt }).eq('id', id);
  return fail(error);
}

export async function setTaskDone(taskId: string, done: boolean, actorId?: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const id = dbId(taskId);
  if (!Number.isFinite(id)) return { ok: false, message: 'Unknown task.' };
  const { data: task, error: readErr } = await supabase.from('tasks')
    .select('id, title, seller_id, deal_id, workspace_id').eq('id', id).maybeSingle();
  if (readErr) return fail(readErr);
  const { error } = await supabase.from('tasks')
    .update({ done, completed_at: done ? new Date().toISOString() : null }).eq('id', id);
  if (error) return fail(error);
  await tickTcLine(task, done, actorId);
  return { ok: true };
}

type TcTaskRow = { title: string; seller_id: number | null; deal_id: number | null; workspace_id: number | null };

/** A TC checklist task, closed or re-opened, ticks its line on the file it belongs to. */
async function tickTcLine(task: TcTaskRow | null, done: boolean, actorId?: string | null): Promise<void> {
  if (!supabase) return;
  const sellerId = task?.seller_id ?? null;
  const itemId = task?.title ? checklistIdForTitle(task.title) : null;
  if ((sellerId || task?.deal_id) && itemId && task?.workspace_id) {
    // The task's own deal's file when it names one (a deal task may have no seller),
    // else the seller's newest open file: with two files maybeSingle errored and
    // finishing the task never ticked the line.
    let q = supabase.from('transactions').select('id, checklist').eq('workspace_id', task.workspace_id).in('status', TX_OPEN);
    q = task.deal_id ? q.eq('deal_id', task.deal_id) : q.eq('seller_id', sellerId as number);
    const { data: tx } = await q.order('id', { ascending: false }).limit(1).maybeSingle();
    if (tx) {
      const cur = ((tx as { checklist?: Record<string, boolean> }).checklist ?? {});
      if (!!cur[itemId] !== done) {
        await supabase.from('transactions').update({
          checklist: { ...cur, [itemId]: done },
          updated_at: new Date().toISOString(),
        }).eq('id', tx.id);
        await logTc(task.workspace_id, sellerId,
          done ? 'TC checklist · done' : 'TC checklist · reopened',
          task.title, actorId);
      }
    }
  }
}

/**
 * setTaskDone for many tasks at once (the Tasks screen's "Complete all
 * shown"): one update per 500 ids, one after another, writing the same
 * columns, and a TC checklist task still ticks its line. `failed` is every id
 * that did not save: an unknown id, a batch the database refused, or a row the
 * update did not come back with (gone, or not this user's to change).
 */
export async function setTasksDone(taskIds: string[], done: boolean, actorId?: string | null): Promise<{ failed: string[]; message?: string }> {
  if (!supabase) return { failed: [...taskIds], message: 'Supabase is not configured.' };
  const byNum = new Map(taskIds.map((id) => [dbId(id), id] as const));
  const failed = taskIds.filter((id) => !Number.isFinite(dbId(id)));
  let message: string | undefined;
  const completedAt = done ? new Date().toISOString() : null;
  for (const b of batches(taskIds, 500)) {
    const { data, error } = await supabase.from('tasks').update({ done, completed_at: completedAt })
      .in('id', b).select('id, title, seller_id, deal_id, workspace_id');
    if (error) message ??= error.message;
    const back = new Set((error ? [] : data ?? []).map((r) => r.id));
    for (const n of b) if (!back.has(n)) failed.push(byNum.get(n)!);
    // ponytail: one checklist read per TC task; batch by file if bulk TC closes get common.
    for (const t of error ? [] : data ?? []) await tickTcLine(t, done, actorId);
  }
  return { failed, message };
}

/** Pin or unpin a timeline entry: 'ct12' (a communication, ':b' copy included) or 'a34' (an activity row). */
export async function pinTimelineEntry(entryId: string, pin: boolean, userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const m = /^(ct|a)(\d+)/.exec(entryId);
  if (!m) return { ok: false, message: 'That entry cannot be pinned.' };
  const { error } = await supabase.from(m[1] === 'ct' ? 'communications' : 'activity')
    .update({ pinned_at: pin ? new Date().toISOString() : null, pinned_by: pin ? userId : null } as never)
    .eq('id', Number(m[2]));
  return fail(error);
}

export async function markNotificationsRead(ids: string[]): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const nums = notificationDbIds(ids);
  if (!nums.length) return { ok: true };
  const { error } = await supabase.from('notifications')
    .update({ read_at: new Date().toISOString() }).in('id', nums);
  return fail(error);
}

/** Every unread notification of this member in this workspace, read. */
export async function markAllNotificationsRead(workspaceId: number, userId: string): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('user_id', userId).is('read_at', null);
  return fail(error);
}

export async function markNotificationRead(notificationId: string): Promise<WriteResult> {
  return markNotificationsRead([notificationId]);
}

const STEP_COLS = 'id, position, channel, delay_minutes, title, body, config';
type Row = Record<string, unknown>;

/** A step's config as an object (jsonb, so anything can be stored there). */
const stepCfg = (st: { config: unknown }) =>
  (st.config && typeof st.config === 'object' && !Array.isArray(st.config) ? st.config : {}) as Record<string, unknown>;

/** One record for enrollMany: its id, extra enrolment columns, and its task and drop rows for an enrolment id and a clock. */
export type EnrollJob = {
  key: number;
  extra?: Row;
  tasks: (enrollmentId: number, now: number) => Row[];
  drops: (enrollmentId: number, now: number) => Row[];
};
/** One record's outcome: already on the plan, refused (`error`), or enrolled with `queued` tasks (0 with `tasksError` when the tasks were refused). */
export type EnrollOutcome = { id?: number; already?: boolean; queued: number; error?: { message: string }; tasksError?: { message: string } };

/**
 * Enrol many records in one plan. Per 200 records: one read of who is already
 * on it, one enrolment insert, one task upsert and one ringless drop insert,
 * where a record at a time made those four requests (and its reads) for each.
 * The rows are the ones the one-at-a-time path wrote. When the database
 * refuses a batch, who is on the plan is read again and the rest are tried
 * one record at a time, so one bad record fails alone; with `stopAtError`,
 * nothing after the first failure is tried, as a loop that returns on its
 * first error does. A key listed twice is enrolled once; the second is
 * `already`.
 *
 * Nothing is written for a record unless the already-on read for it
 * succeeded: there is no unique guard on running enrolments, so a failed
 * read taken as "nobody is on it" would enrol everyone again, with a second
 * set of texts and drops. A failed read fails its batch with that error.
 */
export async function enrollMany(
  workspaceId: number, plan: number, column: 'seller_id' | 'buyer_id', jobs: EnrollJob[], userId: string | null,
  stopAtError = false, db = supabase,
): Promise<EnrollOutcome[]> {
  if (!db) return jobs.map(() => ({ queued: 0, error: { message: 'Supabase is not configured.' } }));
  const out: EnrollOutcome[] = jobs.map(() => ({ queued: 0 }));
  const first = new Map<number, number>();
  const todo: number[] = [];
  jobs.forEach((j, i) => {
    if (!Number.isFinite(j.key)) out[i] = { queued: 0, error: { message: 'Unknown record.' } };
    else if (!first.has(j.key)) { first.set(j.key, i); todo.push(i); }
  });
  const keyOf = (r: { seller_id: number | null; buyer_id?: number | null }) => (column === 'seller_id' ? r.seller_id : r.buyer_id) ?? null;
  /** Who of `idx` is on this plan now (enrolment id by key), or the read's error. */
  const runningOf = async (idx: number[]) => {
    const { data, error } = await db.from('enrollments').select('id, seller_id, buyer_id')
      .eq('workspace_id', workspaceId).eq('plan_id', plan).in(column, idx.map((i) => jobs[i]!.key))
      .neq('status', 'done').order('id');
    const on = new Map<number, number>();
    for (const r of data ?? []) { const k = keyOf(r); if (k != null && !on.has(k)) on.set(k, r.id); }
    return { on, error };
  };
  let stopped: { message: string } | null = null;
  for (let at = 0; at < todo.length; at += 200) {
    const chunk = todo.slice(at, at + 200);
    if (stopped) { for (const i of chunk) out[i] = { queued: 0, error: stopped }; continue; }
    // Already on this plan? Say so and change nothing: enrolling twice made a
    // second enrolment with its own tasks, and every touch went out twice.
    const check = await runningOf(chunk);
    if (check.error) {
      for (const i of chunk) out[i] = { queued: 0, error: check.error };
      if (stopAtError) stopped = check.error;
      continue;
    }
    const fresh: number[] = [];
    for (const i of chunk) {
      const id = check.on.get(jobs[i]!.key);
      if (id != null) out[i] = { id, already: true, queued: 0 };
      else fresh.push(i);
    }
    if (!fresh.length) continue;

    const row = (i: number) => ({ workspace_id: workspaceId, plan_id: plan, [column]: jobs[i]!.key, ...jobs[i]!.extra, created_by: userId });
    const made = new Map<number, number>();
    const ins = await db.from('enrollments').insert(fresh.map(row) as never).select('id, seller_id, buyer_id');
    if (!ins.error) {
      const byKey = new Map<number | null, number>((ins.data ?? []).map((r) => [keyOf(r), r.id]));
      for (const i of fresh) {
        const id = byKey.get(jobs[i]!.key);
        if (id != null) made.set(i, id); else out[i] = { queued: 0, error: { message: 'The enrolment was not saved.' } };
      }
    } else {
      // Read again before going one by one: an answer lost on the way back may
      // have left the batch saved. Anyone on the plan now is left alone.
      const again = await runningOf(fresh);
      for (const i of fresh) {
        const id = again.on.get(jobs[i]!.key);
        if (stopped || again.error) { out[i] = { queued: 0, error: stopped ?? again.error! }; continue; }
        if (id != null) { out[i] = { id, already: true, queued: 0 }; continue; }
        const one = await db.from('enrollments').insert(row(i) as never).select('id').single();
        if (one.error) { out[i] = { queued: 0, error: one.error }; if (stopAtError) stopped = one.error; }
        else made.set(i, (one.data as { id: number }).id);
      }
      if (again.error && stopAtError) stopped = again.error;
    }

    // Ignore duplicate tasks rather than failing: a second enrolment should be
    // a no-op on the queue (tasks are keyed to the enrolment and the step).
    const now = Date.now();
    const rows = new Map<number, Row[]>();
    for (const [i, id] of made) { out[i] = { id, queued: 0 }; rows.set(i, jobs[i]!.tasks(id, now)); }
    const upsert = (r: Row[]) => db.from('tasks').upsert(r as never, { onConflict: 'enrollment_id,plan_step_id', ignoreDuplicates: true });
    const all = [...rows.values()].flat();
    const { error: batchError } = all.length ? await upsert(all) : { error: null };
    for (const [i, r] of rows) {
      if (!r.length) continue;
      const error = batchError ? (await upsert(r)).error : null;
      if (error) out[i]!.tasksError = error; else out[i]!.queued = r.length;
    }
    const drops = [...made].flatMap(([i, id]) => (out[i]!.queued ? jobs[i]!.drops(id, now) : []));
    if (drops.length) await db.from('rvm_drops').insert(drops as never);
  }
  jobs.forEach((j, i) => {
    const f = first.get(j.key);
    if (f != null && f !== i) out[i] = out[f]!.error ? { ...out[f]! } : { id: out[f]!.id, already: true, queued: 0 };
  });
  return out;
}

/**
 * Rows of `table` by id, 200 ids a read, the reads at once, or the first
 * read's error. The caller enrols nobody on an error: a record read as blank
 * loses its blacklist and do-not-call flags and its owner.
 */
async function rowsById<T extends { id: number }>(
  table: 'sellers' | 'buyers', cols: string, ids: number[],
): Promise<{ rows: Map<number, T>; error: { message: string } | null }> {
  const sb = supabase;
  const all = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!sb || !all.length) return { rows: new Map(), error: null };
  const parts: number[][] = [];
  for (let i = 0; i < all.length; i += 200) parts.push(all.slice(i, i + 200));
  const reads = await Promise.all(parts.map((p) => sb.from(table).select(cols).in('id', p)));
  const error = reads.find((r) => r.error)?.error ?? null;
  return { rows: new Map(reads.flatMap((r) => (r.data ?? []) as unknown as T[]).map((r) => [r.id, r])), error };
}

type SellerForPlan = {
  id: number; name: string | null; phone: string | null; tags: string[] | null; assigned_to: string | null; property_address: string | null;
  properties: { line1: string; city: string | null; state: string | null; zip: string | null } | null;
};

/**
 * Enrol someone in an action plan, and put its steps on the calendar.
 *
 * The enrolment row on its own did nothing. The plan was a promise the app
 * never kept. Each step now becomes a task dated from its delay, carrying the
 * message with the seller's own details filled in, assigned to whoever owns
 * the lead. In a Compr workspace, and on any plan with auto_send turned on,
 * a due email or text goes out on its own (plan-tick, migration 284). A call
 * or a manual task stays for a person. On every other plan a text waits until
 * someone presses send, which is what Talkr and the carrier expect. The
 * sequence shows up in Tasks and on the calendar like the rest of the work.
 *
 * Enrolling the same person in the same plan twice does not double the
 * touches: the tasks are keyed to the enrolment and the step (migration 31).
 */
export async function enrollInPlan(
  workspaceId: number, planId: string, personId: string, userId: string | null,
): Promise<WriteResult & { queued?: number; already?: boolean }> {
  return (await enrollSellersInPlan(workspaceId, planId, [personId], userId))[0]!;
}

/**
 * enrollInPlan for many sellers (People's bulk bar, an import): the steps and
 * the sellers read once, then enrollMany. One result per id, in order. A
 * failed read enrols nobody: no steps would enrol them with nothing queued,
 * and a blank seller loses their do-not-call flags and owner.
 */
export async function enrollSellersInPlan(
  workspaceId: number, planId: string, personIds: string[], userId: string | null,
): Promise<(WriteResult & { queued?: number; already?: boolean })[]> {
  if (!supabase) return personIds.map(() => ({ ok: false, message: 'Supabase is not configured.' }));
  const plan = dbId(planId);
  const sellerIds = personIds.map(dbId);
  const [{ data: steps, error: stepsError }, { rows: sellers, error: sellersError }] = await Promise.all([
    supabase.from('action_plan_steps').select(STEP_COLS).eq('plan_id', plan).order('position'),
    rowsById<SellerForPlan>('sellers', 'id, name, phone, tags, assigned_to, property_address, properties(line1, city, state, zip)', sellerIds),
  ]);
  const readError = stepsError ?? sellersError;
  if (readError) return personIds.map(() => fail(readError));
  const jobs = sellerIds.map((sellerId): EnrollJob => {
    const seller = sellers.get(sellerId);
    const who = (seller?.name ?? '').trim();
    const first = who.split(/\s+/)[0] || who;
    const prop = seller?.properties;
    const fields: Record<string, string> = {
      first_name: first,
      name: who,
      contact_name: who,
      address: prop?.line1 ?? seller?.property_address ?? '',
      city: prop?.city ?? '',
      state: prop?.state ?? '',
      zip: prop?.zip ?? '',
      postal_code: prop?.zip ?? '',
    };
    return {
      key: sellerId,
      // Delays are minutes after the previous step (migration 34), so the due
      // time is the running total; a `wait` step adds to it and queues nothing.
      tasks: (enrollmentId, now) => {
        let offset = 0;
        return (steps ?? []).flatMap((st) => {
          offset += st.delay_minutes ?? 0;
          if (st.channel === 'wait') return [];
          const cfg = stepCfg(st);
          const assignee = typeof cfg.assignee === 'string' && cfg.assignee ? cfg.assignee : null;
          const priority = cfg.priority === 'low' || cfg.priority === 'high' ? cfg.priority : 'normal';
          return [{
            workspace_id: workspaceId,
            seller_id: sellerId,
            title: taskTitle(st.channel, st.title, first, cfg),
            task_type: taskTypeFor(st.channel),
            priority,
            due_at: new Date(now + offset * 60_000).toISOString(),
            assigned_to: assignee ?? seller?.assigned_to ?? userId,
            notes: st.body ? renderMerge(st.body, fields) : null,
            enrollment_id: enrollmentId,
            plan_step_id: st.id,
            created_by: userId,
          }];
        });
      },
      drops: (enrollmentId, now) => planRvmRows(workspaceId, steps ?? [], { seller_id: sellerId }, e164ish(seller?.phone), blockReason(seller), fields, enrollmentId, userId, now),
    };
  });
  const res = await enrollMany(workspaceId, plan, 'seller_id', jobs, userId);
  // A whole sequence of dated work just appeared; put it on the calendar of
  // whoever connected Google, same as a task typed by hand.
  if (res.some((r) => r.queued)) nudgeGoogle(workspaceId);
  return res.map((r) => {
    if (r.error) return fail(r.error);
    if (r.already) return { ok: true, id: r.id, queued: 0, already: true };
    if (r.tasksError) console.error('enrolled, but the steps were not queued', r.tasksError.message);
    return { ok: true, id: r.id, queued: r.queued };
  });
}

/**
 * The Compr rep replies come back to: the named lifecycle rep, else the SDR.
 * Null outside a Compr workspace.
 */
async function comprRep(workspaceId: number): Promise<{ id: string; first: string } | null> {
  return (await comprRepRead(workspaceId)).rep;
}

/** comprRep, with the error of a failed read (bulk enrol assigns nobody on a guess). */
async function comprRepRead(workspaceId: number): Promise<{ rep: { id: string; first: string } | null; error: { message: string } | null }> {
  if (!supabase) return { rep: null, error: null };
  const { data: ws, error } = await supabase.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle();
  if (error) return { rep: null, error };
  const settings = (ws?.settings ?? {}) as { buyer_profile?: string; compr_lifecycle?: { rep_user_id?: string } };
  if (settings.buyer_profile !== 'compr') return { rep: null, error: null };
  const { data: roster, error: rosterError } = await supabase.from('workspace_roster').select('user_id, full_name, role').eq('workspace_id', workspaceId);
  if (rosterError) return { rep: null, error: rosterError };
  const rows = (roster ?? []) as { user_id: string; full_name: string | null; role: string | null }[];
  const named = settings.compr_lifecycle?.rep_user_id;
  const hit = (named ? rows.find((r) => r.user_id === named) : undefined) ?? rows.find((r) => r.role === 'sdr');
  if (!hit) return { rep: null, error: null };
  return { rep: { id: hit.user_id, first: (hit.full_name ?? '').trim().split(/\s+/)[0] || '' }, error: null };
}

type BuyerForPlan = {
  id: number; name: string | null; company: string | null; phone: string | null; email: string | null;
  tags: string[] | null; blacklisted_at: string | null; wants_calls: boolean | null; assigned_to: string | null;
};

/**
 * Put one buyer on an action plan (no deal required). Same queueing as
 * enrollInPlan / enrollBuyersInPlan: each step becomes a dated task on the
 * buyer. Already-on-plan is a no-op. In Compr the steps belong to the rep,
 * so a reply comes back to them.
 */
export async function enrollBuyerInPlan(
  workspaceId: number, planId: string, buyerId: string, userId: string | null,
  fields: Record<string, string> = {},
): Promise<WriteResult & { queued?: number; already?: boolean }> {
  return (await enrollManyBuyers(workspaceId, planId, [{ id: buyerId, fields }], userId))[0]!;
}

/**
 * enrollBuyerInPlan for many buyers (Buyers' bulk bar): the steps, the buyers
 * and the Compr rep read once, then enrollMany. One result per buyer, in
 * order; `stopAtError` tries nothing after the first refused enrolment. A
 * failed read enrols nobody (no steps, a blank buyer, or no rep to own them).
 */
export async function enrollManyBuyers(
  workspaceId: number, planId: string, buyers: { id: string; fields?: Record<string, string> }[], userId: string | null,
  stopAtError = false,
): Promise<(WriteResult & { queued?: number; already?: boolean })[]> {
  if (!supabase) return buyers.map(() => ({ ok: false, message: 'Supabase is not configured.' }));
  const sb = supabase;
  const plan = dbId(planId);
  const ids = buyers.map((b) => dbId(b.id));
  const [{ data: steps, error: stepsError }, { rows, error: buyersError }, { rep, error: repError }] = await Promise.all([
    sb.from('action_plan_steps').select(STEP_COLS).eq('plan_id', plan).order('position'),
    rowsById<BuyerForPlan>('buyers', 'id, name, company, phone, email, tags, blacklisted_at, wants_calls, assigned_to', ids),
    comprRepRead(workspaceId),
  ]);
  const readError = stepsError ?? buyersError ?? repError;
  if (readError) return buyers.map(() => fail(readError));
  const jobs = buyers.map(({ fields = {} }, n): EnrollJob => {
    const bid = ids[n]!;
    const buyer = rows.get(bid);
    const who = (buyer?.name ?? fields.name ?? '').trim();
    const first = who.split(/\s+/)[0] || who;
    const merge = {
      first_name: first,
      name: who,
      contact_name: who,
      company: buyer?.company ?? fields.company ?? '',
      phone: buyer?.phone ?? fields.phone ?? '',
      email: buyer?.email ?? fields.email ?? '',
      ...fields,
      ...(rep?.first ? { rep_name: rep.first } : {}),
    };
    const ownerId = buyer?.assigned_to || rep?.id || userId;
    return {
      key: bid,
      tasks: (enrollmentId, now) => {
        let offset = 0;
        return (steps ?? []).flatMap((st) => {
          offset += st.delay_minutes ?? 0;
          if (st.channel === 'wait') return [];
          const cfg = stepCfg(st);
          return [{
            workspace_id: workspaceId,
            buyer_id: bid,
            title: taskTitle(st.channel, st.title, first, cfg),
            task_type: taskTypeFor(st.channel),
            priority: cfg.priority === 'low' || cfg.priority === 'high' ? cfg.priority : 'normal',
            due_at: new Date(now + offset * 60_000).toISOString(),
            assigned_to: typeof cfg.assignee === 'string' && cfg.assignee ? cfg.assignee : ownerId,
            notes: st.body ? renderMerge(st.body, merge) : null,
            enrollment_id: enrollmentId,
            plan_step_id: st.id,
            created_by: userId,
          }];
        });
      },
      drops: (enrollmentId, now) => planRvmRows(
        workspaceId, steps ?? [], { buyer_id: bid }, e164ish(buyer?.phone),
        blockReason(buyer) ?? (buyer?.wants_calls === false ? 'do_not_call' : null),
        merge, enrollmentId, rep?.id ?? userId, now,
      ),
    };
  });
  const res = await enrollMany(workspaceId, plan, 'buyer_id', jobs, userId, stopAtError);
  // In Compr an unassigned buyer whose steps were queued becomes the rep's,
  // so replies come back to them.
  if (rep) {
    const unowned = [...new Set(res.flatMap((r, n) => (r.queued && !rows.get(ids[n]!)?.assigned_to ? [ids[n]!] : [])))];
    for (let i = 0; i < unowned.length; i += 200) {
      const { data: given } = await sb.from('buyers').update({ assigned_to: rep.id }).in('id', unowned.slice(i, i + 200)).is('assigned_to', null).select('id');
      await logActivities(workspaceId, 'buyer', (given ?? []).map((g) => g.id), 'plan', `Assigned to ${rep.first || 'the Compr rep'}`, 'Enrolled in an action plan, so replies come back to them.', userId);
    }
  }
  if (res.some((r) => r.queued)) nudgeGoogle(workspaceId);
  return res.map((r) => {
    if (r.error) return fail(r.error);
    if (r.already) return { ok: true, id: r.id, queued: 0, already: true };
    if (r.tasksError) console.error('buyer enrolled, but the steps were not queued', r.tasksError.message);
    return { ok: true, id: r.id, queued: r.queued };
  });
}

/**
 * Hold one enrolment. Open steps come off the task list so nothing fires
 * while it is paused. Done steps stay, so play can pick up the rest.
 */
export async function pauseEnrollment(enrollmentId: number, reason = 'manual'): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.from('enrollments')
    .update({ status: 'paused', stopped_reason: reason })
    .eq('id', enrollmentId).eq('status', 'active')
    .select('id');
  if (error) return fail(error);
  if (!data?.length) return { ok: false, message: 'That plan is not running.' };
  await supabase.from('tasks').delete().eq('enrollment_id', enrollmentId).eq('done', false);
  return { ok: true };
}

/**
 * pauseEnrollment for many (the bulk bars): one update and one task delete
 * per 200 ids instead of two requests each. `done` counts the enrolments that
 * were running and are paused now; a refused batch leaves its ids out and
 * its message in `message`, and the others still go.
 */
export async function pauseEnrollments(enrollmentIds: number[], reason = 'manual'): Promise<{ done: number; message?: string }> {
  if (!supabase) return { done: 0, message: 'Supabase is not configured.' };
  let done = 0;
  let message: string | undefined;
  for (let i = 0; i < enrollmentIds.length; i += 200) {
    const { data, error } = await supabase.from('enrollments')
      .update({ status: 'paused', stopped_reason: reason })
      .in('id', enrollmentIds.slice(i, i + 200)).eq('status', 'active')
      .select('id');
    if (error) { message ??= error.message; continue; }
    const held = (data ?? []).map((r) => r.id);
    if (held.length) await supabase.from('tasks').delete().in('enrollment_id', held).eq('done', false);
    done += held.length;
  }
  return { done, message: message ?? (done ? undefined : 'That plan is not running.') };
}

/** Put a paused enrolment back on, and queue only the steps that are not done yet. */
export async function resumeEnrollment(enrollmentId: number): Promise<WriteResult & { queued?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: en, error } = await supabase.from('enrollments')
    .select('id, workspace_id, plan_id, seller_id, buyer_id, status, created_by')
    .eq('id', enrollmentId).maybeSingle();
  if (error) return fail(error);
  if (!en || en.status !== 'paused') return { ok: false, message: 'That plan is not paused.' };
  const { error: upErr } = await supabase.from('enrollments')
    .update({ status: 'active', stopped_reason: null }).eq('id', enrollmentId);
  if (upErr) return fail(upErr);
  const queued = en.seller_id
    ? await queueRemainingSteps(en.workspace_id, en.plan_id, en.seller_id, en.id, en.created_by)
    : en.buyer_id
      ? await queueRemainingBuyerSteps(en.workspace_id, en.plan_id, en.buyer_id, en.id, en.created_by)
      : 0;
  if (queued > 0) nudgeGoogle(en.workspace_id);
  return { ok: true, queued };
}

/** Steps with no task yet, timed from the first one still open. */
async function queueRemainingSteps(
  workspaceId: number, planId: number, sellerId: number, enrollmentId: number, actor: string | null,
): Promise<number> {
  if (!supabase) return 0;
  const [{ data: steps }, { data: seller }, { data: existing }] = await Promise.all([
    supabase.from('action_plan_steps')
      .select('id, position, channel, delay_minutes, title, body, config')
      .eq('plan_id', planId).order('position'),
    supabase.from('sellers')
      .select('name, phone, tags, assigned_to, property_address, properties(line1, city, state, zip)')
      .eq('id', sellerId).maybeSingle(),
    supabase.from('tasks').select('plan_step_id').eq('enrollment_id', enrollmentId),
  ]);
  if (!steps?.length) return 0;
  const have = new Set((existing ?? []).map((t) => t.plan_step_id).filter((id): id is number => id != null));
  const who = (seller?.name ?? '').trim();
  const first = who.split(/\s+/)[0] || who;
  const prop = (seller as unknown as { properties: { line1: string; city: string | null; state: string | null; zip: string | null } | null } | null)?.properties;
  const fields: Record<string, string> = {
    first_name: first, name: who, contact_name: who,
    address: prop?.line1 ?? seller?.property_address ?? '',
    city: prop?.city ?? '', state: prop?.state ?? '', zip: prop?.zip ?? '', postal_code: prop?.zip ?? '',
  };
  const now = Date.now();
  const due = new Map(remainingStepSchedule(steps, have).map((s) => [s.id, s.offsetMinutes]));
  const rows = steps.flatMap((st) => {
    if (!due.has(st.id)) return [];
    const offset = due.get(st.id) ?? 0;
    const cfg = (st.config && typeof st.config === 'object' && !Array.isArray(st.config) ? st.config : {}) as Record<string, unknown>;
    const assignee = typeof cfg.assignee === 'string' && cfg.assignee ? cfg.assignee : null;
    const priority = cfg.priority === 'low' || cfg.priority === 'high' ? cfg.priority : 'normal';
    return [{
      workspace_id: workspaceId,
      seller_id: sellerId,
      title: taskTitle(st.channel, st.title, first, cfg),
      task_type: taskTypeFor(st.channel),
      priority,
      due_at: new Date(now + offset * 60_000).toISOString(),
      assigned_to: assignee ?? seller?.assigned_to ?? actor,
      notes: st.body ? renderMerge(st.body, fields) : null,
      enrollment_id: enrollmentId,
      plan_step_id: st.id,
      created_by: actor,
    }];
  });
  if (!rows.length) return 0;
  const { error } = await supabase.from('tasks')
    .upsert(rows, { onConflict: 'enrollment_id,plan_step_id', ignoreDuplicates: true });
  if (error) {
    console.error('resumed, but the remaining steps were not queued', error.message);
    return 0;
  }
  await queuePlanRvm(
    workspaceId, steps, { seller_id: sellerId }, e164ish((seller as { phone?: string | null } | null)?.phone),
    blockReason(seller as { tags?: string[] } | null), fields, enrollmentId, actor, now, due,
  );
  return rows.length;
}

/** The buyer version of queueRemainingSteps. Pause deletes open tasks; play puts the rest back on the Compr rep. */
async function queueRemainingBuyerSteps(
  workspaceId: number, planId: number, buyerId: number, enrollmentId: number, actor: string | null,
): Promise<number> {
  if (!supabase) return 0;
  const [{ data: steps }, { data: buyer }, { data: existing }, rep] = await Promise.all([
    supabase.from('action_plan_steps')
      .select('id, position, channel, delay_minutes, title, body, config')
      .eq('plan_id', planId).order('position'),
    supabase.from('buyers').select('name, company, phone, email, tags, blacklisted_at, wants_calls, assigned_to').eq('id', buyerId).maybeSingle(),
    supabase.from('tasks').select('plan_step_id').eq('enrollment_id', enrollmentId),
    comprRep(workspaceId),
  ]);
  if (!steps?.length || !buyer) return 0;
  const have = new Set((existing ?? []).map((t) => t.plan_step_id).filter((id): id is number => id != null));
  const who = (buyer.name ?? '').trim();
  const first = who.split(/\s+/)[0] || who;
  const fields: Record<string, string> = {
    first_name: first, name: who, contact_name: who,
    company: buyer.company ?? '', phone: buyer.phone ?? '', email: buyer.email ?? '',
    ...(rep?.first ? { rep_name: rep.first } : {}),
  };
  const ownerId = buyer.assigned_to || rep?.id || actor;
  const now = Date.now();
  const due = new Map(remainingStepSchedule(steps, have).map((s) => [s.id, s.offsetMinutes]));
  const rows = steps.flatMap((st) => {
    if (!due.has(st.id)) return [];
    const offset = due.get(st.id) ?? 0;
    const cfg = (st.config && typeof st.config === 'object' && !Array.isArray(st.config) ? st.config : {}) as Record<string, unknown>;
    const assignee = typeof cfg.assignee === 'string' && cfg.assignee ? cfg.assignee : null;
    const priority = cfg.priority === 'low' || cfg.priority === 'high' ? cfg.priority : 'normal';
    return [{
      workspace_id: workspaceId,
      buyer_id: buyerId,
      title: taskTitle(st.channel, st.title, first, cfg),
      task_type: taskTypeFor(st.channel),
      priority,
      due_at: new Date(now + offset * 60_000).toISOString(),
      assigned_to: assignee ?? ownerId,
      notes: st.body ? renderMerge(st.body, fields) : null,
      enrollment_id: enrollmentId,
      plan_step_id: st.id,
      created_by: actor,
    }];
  });
  if (!rows.length) return 0;
  const { error } = await supabase.from('tasks')
    .upsert(rows as never, { onConflict: 'enrollment_id,plan_step_id', ignoreDuplicates: true });
  if (error) {
    console.error('resumed, but the remaining buyer steps were not queued', error.message);
    return 0;
  }
  await queuePlanRvm(
    workspaceId, steps, { buyer_id: buyerId }, e164ish(buyer.phone),
    blockReason(buyer) ?? (buyer.wants_calls === false ? 'do_not_call' : null),
    fields, enrollmentId, rep?.id ?? actor, now, due,
  );
  return rows.length;
}

function taskTypeFor(channel: string): string {
  if (channel === 'sms') return 'text';
  if (channel === 'call' || channel === 'email' || channel === 'compr_report' || channel === 'rvm') return channel;
  return 'todo';
}

function e164ish(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

/** Write planRvmRows' drops. */
async function queuePlanRvm(...args: Parameters<typeof planRvmRows>): Promise<void> {
  if (!supabase) return;
  const rows = planRvmRows(...args);
  if (rows.length) await supabase.from('rvm_drops').insert(rows as never);
}

/** One rvm_drops row per RVM step, on the same clock as the task it queues. */
function planRvmRows(
  workspaceId: number,
  steps: { id: number; channel: string; delay_minutes: number | null; body: string | null; config: unknown }[],
  who: { seller_id?: number; buyer_id?: number },
  phone: string | null,
  /** Why no drop goes out, or null. Blacklisted rows are written as skipped, never queued. */
  block: BlockReason | null,
  fields: Record<string, string>,
  enrollmentId: number,
  userId: string | null,
  now: number,
  only?: Map<number, number>,
): Record<string, unknown>[] {
  let offset = 0;
  const rows = [];
  for (const st of steps) {
    const minutes = only ? only.get(st.id) : (offset += st.delay_minutes ?? 0, offset);
    if (only && !only.has(st.id)) continue;
    if (st.channel !== 'rvm' || minutes == null) continue;
    const cfg = (st.config && typeof st.config === 'object' && !Array.isArray(st.config) ? st.config : {}) as Record<string, unknown>;
    const libRaw = cfg.library_id;
    const libraryId = typeof libRaw === 'number' ? libRaw : typeof libRaw === 'string' && /^\d+$/.test(libRaw) ? Number(libRaw) : null;
    rows.push({
      workspace_id: workspaceId,
      ...who,
      phone_e164: phone,
      library_id: libraryId,
      script: st.body ? renderMerge(st.body, fields) : null,
      variant_group: typeof cfg.variant_group === 'string' && cfg.variant_group ? cfg.variant_group : 'default',
      status: !phone || block ? 'skipped' : 'queued',
      skip_reason: !phone ? 'no_phone' : block,
      scheduled_at: new Date(now + minutes * 60_000).toISOString(),
      enrollment_id: enrollmentId,
      plan_step_id: st.id,
      created_by: userId,
    });
  }
  return rows;
}

/** A queued drop row without the columns a database before migrations 135 / 194 lacks. */
const withoutCols = (row: Record<string, unknown>, cols: ReadonlySet<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !cols.has(k)));

/**
 * Queue a ringless drop for each person, then kick rvm-tick so the blast goes
 * out now rather than on the next minute (rvm_send_now, migration 194). The
 * tick still applies every rule at send time and rotates the RVM pool.
 * `queued` names exactly who got a drop, so the composer reports the right people.
 */
export async function queueBulkRvm(
  workspaceId: number,
  userId: string | null,
  rows: { sellerId?: number | null; buyerId?: number | null; phone: string; script: string; dealId?: number | null }[],
  /** A dispo push's own recording (lib/rvm-recording.ts): its group holds only that clip, so every drop plays it. */
  clip?: { libraryId: number; variantGroup: string } | null,
  /** The deal the whole send is about, when every row shares one. A row's own dealId wins. */
  dealId?: number | null,
): Promise<{ ok: true; queued: number; blocked: number; sellerIds: number[]; buyerIds: number[]; blastId: string } | { ok: false; message: string; queued: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.', queued: 0 };
  // The tick checks again at send time; this keeps a blacklisted person out of
  // the queue and tells the rep, instead of a drop that quietly skips later.
  const guard = await loadBlocked(supabase as unknown as BlacklistDb, { sellerIds: rows.map((r) => r.sellerId), buyerIds: rows.map((r) => r.buyerId) });
  if (!guard.ok) return { ok: false, message: guard.message, queued: 0 };
  const now = new Date().toISOString();
  // One id for the whole send, so the RVM tab's Blast results can add it up.
  const blastId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let blocked = 0;
  const payload: Record<string, unknown>[] = rows.flatMap((r) => {
    const phone = e164ish(r.phone);
    const seller = r.sellerId ?? null;
    const buyer = r.buyerId ?? null;
    if (!phone || (seller == null) === (buyer == null)) return [];
    if ((seller != null && guard.blocked.sellers.has(seller)) || (buyer != null && guard.blocked.buyers.has(buyer))) { blocked++; return []; }
    const deal = r.dealId ?? dealId ?? null;
    return [{
      workspace_id: workspaceId,
      seller_id: seller,
      buyer_id: buyer,
      phone_e164: phone,
      script: r.script.slice(0, 4500),
      library_id: clip && clip.libraryId > 0 ? clip.libraryId : null,
      variant_group: clip && clip.libraryId > 0 ? clip.variantGroup : 'default',
      status: 'queued' as const,
      scheduled_at: now,
      created_by: userId,
      blast_id: blastId,
      ...(deal ? { deal_id: deal } : {}),
    }];
  });
  let queued = 0;
  const sellerIds: number[] = [];
  const buyerIds: number[] = [];
  // Columns the database turned out not to have: dropped from the rest of the send.
  const missing = new Set<string>();
  for (let i = 0; i < payload.length; i += 200) {
    const chunk = payload.slice(i, i + 200);
    let error: { message: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      ({ error } = await supabase.from('rvm_drops').insert(chunk.map((r) => withoutCols(r, missing)) as never));
      const col = error ? ['blast_id', 'deal_id'].find((c) => !missing.has(c) && error!.message.includes(c)) : undefined;
      if (!col) break;
      missing.add(col);
    }
    if (error) return { ok: false, message: error.message, queued };
    queued += chunk.length;
    for (const r of chunk) {
      if (r.seller_id != null) sellerIds.push(Number(r.seller_id));
      else if (r.buyer_id != null) buyerIds.push(Number(r.buyer_id));
    }
  }
  if (!queued && blocked) return { ok: false, message: `${BLACKLIST_MESSAGE} (${blocked})`, queued: 0 };
  // Best effort: without it the minute cron sends them anyway.
  if (queued) await supabase.rpc('rvm_send_now', { p_ws: workspaceId }).then(() => undefined, () => undefined);
  return { ok: true, queued, blocked, sellerIds, buyerIds, blastId };
}

/** "Text Maria — day 2 follow-up", or just the step's own title. */
function taskTitle(channel: string, title: string | null, first: string, cfg: Record<string, unknown> = {}): string {
  const verb = channel === 'sms' ? 'Text' : channel === 'call' ? 'Call' : channel === 'email' ? 'Email' : channel === 'rvm' ? 'RVM' : null;
  if (verb) return title ? `${verb} ${first} — ${title}` : `${verb} ${first}`;
  if (channel === 'stage') return `Move ${first} to ${typeof cfg.stage === 'string' && cfg.stage ? cfg.stage : 'stage'}`;
  if (channel === 'tag') return `Tag ${first} "${typeof cfg.tag === 'string' ? cfg.tag : ''}"`;
  if (channel === 'assign') return `Reassign ${first}`;
  if (channel === 'ai_agent') return `AI agent starts on ${first}`;
  if (channel === 'compr_report') return cfg.audience === 'buyer' ? `Send Compr buyer report for ${first}` : `Send Compr seller report to ${first}`;
  return title || `Follow up with ${first}`;
}


// ---- bulk actions on People ----------------------------------------------

/** Deals still being worked, as a PostgREST `not in` list (lib/import-dedupe isOpenDealStage). */
const CLOSED_DEAL_STAGES = '("Closed","Terminated","Realtor Referral")';

/**
 * Re-point open deals at a seller's new property: the deals of `sellerIds` on
 * `from` (or, with `from` null, their deals with no property), or with
 * `sellerIds` null every open deal on `from`. Closed and terminated deals keep
 * the address they closed on. Returns how many moved.
 */
export async function moveOpenDeals(
  workspaceId: number, sellerIds: number[] | null, from: number | null, to: number,
): Promise<{ ok: boolean; moved: number; message?: string }> {
  if (!supabase) return { ok: false, moved: 0, message: 'Supabase is not configured.' };
  if (from === to || (!sellerIds && from == null)) return { ok: true, moved: 0 };
  let q = supabase.from('deals').update({ property_id: to, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).not('stage', 'in', CLOSED_DEAL_STAGES);
  q = from != null ? q.eq('property_id', from) : q.is('property_id', null);
  if (sellerIds) q = q.in('seller_id', sellerIds);
  const { data, error } = await q.select('id');
  return error ? { ok: false, moved: 0, message: error.message } : { ok: true, moved: data?.length ?? 0 };
}

/**
 * Put a seller at an address: a seller created without one gets it, and an
 * edit moves them.
 *
 * The property row is never edited in place. address_key is unique per
 * workspace, and the old property can carry co-sellers, deals and COMPR's
 * records, so the new address is found or created through upsertProperty (the
 * same canonical city / state / ZIP the database triggers write) and the seller
 * is re-pointed at it, with their open deals on the old property — the deal
 * sheet and COMPR read the deal's property. `scope: 'everyone'` moves every
 * seller on the old property, and every open deal on it, instead. The old
 * property row stays. Each moved seller gets an activity line saying from
 * where to where.
 */
export async function setSellerAddress(
  workspaceId: number, personId: string, f: Record<string, string>,
  userId: string | null = null, scope: 'seller' | 'everyone' = 'seller',
): Promise<WriteResult & { moved?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sb = supabase;
  const sellerId = dbId(personId);
  // A whole address in the street field ("1803 Cypress Ln, Houston, TX 77008", what an
  // edit prefills for a seller whose address was only ever text) is split into its parts.
  const typed = (f.addr || '').trim();
  const whole = typed.includes(',') && !f.city?.trim() && !f.st?.trim() && !f.zip?.trim() ? splitAddress(typed) : null;
  const line1 = whole?.line1 ?? typed;
  if (!line1) return { ok: false, message: 'A street address is required.' };
  const { data: seller } = await sb.from('sellers').select('id, property_id, property_address')
    .eq('id', sellerId).eq('workspace_id', workspaceId).maybeSingle();
  if (!seller) return { ok: false, message: 'That seller is not in this workspace.' };

  const place = normalizePlace(whole ?? { city: f.city?.trim() || null, state: f.st?.trim() || null, zip: f.zip?.trim() || null });
  const propertyId = await upsertProperty(workspaceId, { line1, city: place.city, state: place.state, zip: place.zip });
  if (!propertyId) return { ok: false, message: 'Could not save that address.' };
  const to = joinAddress({ addr: line1, city: place.city ?? '', st: place.state ?? '', zip: place.zip ?? '' });
  const old = seller.property_id;
  const was = old ? (await sb.from('properties').select('line1, city, state, zip').eq('id', old).maybeSingle()).data : null;
  const from = was ? joinAddress({ addr: was.line1, city: was.city ?? '', st: was.state ?? '', zip: was.zip ?? '' }) : seller.property_address ?? '';

  if (old === propertyId) {
    // The same property by the database's key: nothing moves, the seller's line just reads like it.
    if (seller.property_address !== to) {
      const { error } = await sb.from('sellers').update({ property_address: to }).eq('id', sellerId).eq('workspace_id', workspaceId);
      if (error) return fail(error);
    }
    return { ok: true, id: propertyId, moved: 0, message: 'Same address — nothing moved' };
  }

  let ids = [sellerId];
  if (scope === 'everyone' && old) {
    const { data: on } = await sb.from('sellers').select('id').eq('workspace_id', workspaceId).eq('property_id', old);
    ids = [...new Set([sellerId, ...(on ?? []).map((r) => r.id)])];
  }
  const { error } = await sb.from('sellers').update({ property_id: propertyId, property_address: to })
    .eq('workspace_id', workspaceId).in('id', ids);
  if (error) return fail(error);

  // Open deals follow: the ones on the old property (every one of them when
  // everyone moves), or, for a seller who had no property, their deals without one.
  const deals = await moveOpenDeals(workspaceId, scope === 'everyone' && old ? null : ids, old, propertyId);
  if (!deals.ok) return { ok: false, message: 'The address is saved, but the open deals did not move with it: ' + deals.message };

  await logActivities(
    workspaceId, 'seller', ids, 'lead', from ? 'Address changed' : 'Address set',
    from ? `Address changed from ${from} to ${to}` : to, userId,
  );
  const n = deals.moved;
  return {
    ok: true, id: propertyId, moved: ids.length,
    message: `${from ? 'Address changed' : 'Address saved'}${ids.length > 1 ? ` for ${ids.length} sellers` : ''}${n ? ` · ${n} open deal${n === 1 ? '' : 's'} moved with it` : ''}`,
  };
}

/** The other sellers on this seller's property: whom an address edit could move too. */
export async function sellersSharingProperty(workspaceId: number, personId: string): Promise<{ id: number; name: string }[]> {
  if (!supabase) return [];
  const sellerId = dbId(personId);
  const { data: me } = await supabase.from('sellers').select('property_id').eq('id', sellerId).eq('workspace_id', workspaceId).maybeSingle();
  if (!me?.property_id) return [];
  const { data } = await supabase.from('sellers').select('id, name')
    .eq('workspace_id', workspaceId).eq('property_id', me.property_id).neq('id', sellerId).order('id').limit(50);
  return (data ?? []).map((r) => ({ id: r.id, name: r.name || 'No name' }));
}

/** The seller record's Details card. Anything else is refused, not guessed at. */
type SellerDetailField = 'name' | 'motivation' | 'timeline' | 'condition' | 'occupancy' | 'mortgage' | 'asking_price' | 'desired_close' | 'decision_makers' | 'notes';
const SELLER_DETAIL_FIELDS: ReadonlySet<string> = new Set<SellerDetailField>([
  'name', 'motivation', 'timeline', 'condition', 'occupancy', 'mortgage', 'asking_price', 'desired_close', 'decision_makers', 'notes',
]);

/** What a click-to-edit field hands a writer: text, a number already read (money), or null for cleared. */
export type FieldValue = string | number | null;
const asText = (v: FieldValue): string => (v === null ? '' : String(v));

/**
 * Save one field of the seller record, edited in place.
 *
 * Text fields store what was typed, trimmed; an emptied field stores null so
 * the card shows "—" again rather than an empty string. Notes keep their line
 * breaks. asking_price is a number column read through lib/money ("186k" is
 * 186,000); anything that is not an amount is refused with a message instead
 * of being saved as null. The update is scoped to the workspace and must touch
 * the row, so a seller RLS hides is a failure, not a silent success.
 */
export async function updateSellerDetails(
  workspaceId: number, sellerId: number, field: string, value: FieldValue,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!SELLER_DETAIL_FIELDS.has(field)) return { ok: false, message: `Unknown field "${field}".` };
  const key = field as SellerDetailField;
  const text = key === 'notes' ? asText(value).trim() : asText(value).replace(/\s+/g, ' ').trim();
  const patch: Partial<Pick<Seller, SellerDetailField>> = {};
  if (key === 'name') {
    if (!text) return { ok: false, message: 'A seller needs a name.' };
    patch.name = text.slice(0, 200);
  } else if (key === 'asking_price') {
    const err = moneyError(value);
    if (err) return { ok: false, message: err };
    patch.asking_price = money(value);
  } else {
    patch[key] = text || null;
  }
  const { data, error } = await supabase.from('sellers')
    .update(patch)
    .eq('workspace_id', workspaceId).eq('id', sellerId).select('id');
  if (error) return fail(error);
  return data?.length ? { ok: true, id: sellerId } : { ok: false, message: 'That seller could not be saved. It may have been archived, or you may not have access.' };
}

/**
 * A seller's main phone or email, edited on the record. A phone is stored in
 * E.164 (+12105550100), the form every dialer, text and match reads; the
 * number it replaces stays on file as one of their other numbers
 * (seller_phones), so changing the main number never loses one. An email is
 * stored lower case. Blank clears an email; a phone is never blanked here.
 */
export async function saveSellerContact(
  workspaceId: number, sellerId: number, field: 'phone' | 'email', value: FieldValue,
): Promise<WriteResult & { stored?: string | null }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const raw = asText(value).trim();
  if (field === 'email') {
    const email = raw.toLowerCase();
    if (email && !EMAIL_RE.test(email)) return { ok: false, message: 'That isn’t an email address' };
    const { data, error } = await supabase.from('sellers').update({ email: email || null })
      .eq('workspace_id', workspaceId).eq('id', sellerId).select('id');
    if (error) return fail(error);
    return data?.length ? { ok: true, stored: email || null } : { ok: false, message: 'That seller could not be saved.' };
  }
  const phone = phoneOf(raw);
  if (phone.error || !phone.value) return { ok: false, message: phone.error ?? 'A phone number can’t be blank. Esc keeps the old one' };
  const { data: before, error: readErr } = await supabase.from('sellers').select('phone')
    .eq('workspace_id', workspaceId).eq('id', sellerId).maybeSingle();
  if (readErr) return fail(readErr);
  if (!before) return { ok: false, message: 'That seller is not in this workspace.' };
  const { data, error } = await supabase.from('sellers').update({ phone: phone.value })
    .eq('workspace_id', workspaceId).eq('id', sellerId).select('id');
  if (error) return sellerWriteFail(error);
  if (!data?.length) return { ok: false, message: 'That seller could not be saved.' };
  const old = before.phone;
  if (old && toE164(old) !== phone.value) {
    const kept = await addSellerPhones(workspaceId, sellerId, phone.value, [{ phone: old }], 'replaced');
    if (!kept.ok) return { ok: true, stored: phone.value, message: 'Saved, but the old number was not kept: ' + kept.message };
  }
  return { ok: true, stored: phone.value };
}

/** Intake keys a rep may type. ARV and rehab are COMPR's (the deal's), shown read-only. */
const INTAKE_KEYS = new Set([
  'entity', 'disposition', 'location', 'portfolio', 'garage', 'photos',
  'lease_end', 'mls', 'investorlift', 'lease_amount', 'contract', 'data_tape',
]);
const INTAKE_MONEY = new Set(['lease_amount']);
const PROPERTY_FIELDS = new Set(['beds', 'baths', 'sqft', 'year', 'type']);

/** Reads `{ ok, row }` and `{ ok, message }` as a WriteResult. */
const fromPatch = (r: { ok: boolean; message?: string }): WriteResult => (r.ok ? { ok: true } : { ok: false, message: r.message });

/**
 * Save one What we know row. Seller columns, the disposition intake bag and
 * property facts all go through here so a typed edit and a Jotform
 * submission land on the same fields.
 *
 * Intake keys are written one key at a time in the database
 * (`patchJsonKey`, migration 220), so a blur never overwrites a key someone
 * else (or the Jotform / Podio sync) saved a moment before. ARV and rehab are
 * refused: they are the deal's numbers, set in COMPR, and the record shows
 * them read-only, so clearing a field can never wipe `deals.arv`.
 */
export async function saveWhatWeKnow(
  workspaceId: number,
  sellerId: number,
  propertyId: number | null,
  dealId: number | null,
  field: string,
  value: FieldValue,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const text = asText(value).replace(/\s+/g, ' ').trim();

  if (field.startsWith('intake.')) {
    const key = field.slice('intake.'.length);
    if (key === 'arv' || key === 'rehab') return { ok: false, message: 'ARV and rehab come from COMPR. Change them there.' };
    if (!INTAKE_KEYS.has(key)) return { ok: false, message: `Unknown field "${field}".` };
    let stored: string | number | null = text || null;
    if (INTAKE_MONEY.has(key)) {
      const err = moneyError(value);
      if (err) return { ok: false, message: err };
      stored = money(value);
    }
    return fromPatch(await patchJsonKey('sellers', sellerId, 'intake', key, stored));
  }

  if (field.startsWith('property.')) {
    const key = field.slice('property.'.length);
    if (!PROPERTY_FIELDS.has(key)) return { ok: false, message: `Unknown field "${field}".` };
    const intakeKey = key === 'type' ? 'property_type' : key === 'year' ? 'year_built' : key;
    const patch: {
      property_type?: string | null;
      beds?: number | null;
      baths?: number | null;
      sqft?: number | null;
      year_built?: number | null;
    } = {};
    let mirror: string | number | null = text || null;
    if (key === 'type') patch.property_type = text || null;
    else {
      const n = typeof value === 'number' ? value : text ? Number(text.replace(/[^0-9.]/g, '')) : null;
      if (text && (n == null || !Number.isFinite(n))) return { ok: false, message: 'That needs a number.' };
      if (key === 'beds') {
        if (n != null && (n < 0.5 || n > 20)) return { ok: false, message: 'Bedrooms should be between 1 and 20.' };
        patch.beds = n == null ? null : Math.trunc(n);
      } else if (key === 'baths') {
        if (n != null && (n < 0.5 || n > 20)) return { ok: false, message: 'Bathrooms should be between 1 and 20.' };
        patch.baths = n;
      } else if (key === 'sqft') {
        if (n != null && (n < 200 || n > 50000)) return { ok: false, message: 'Square footage looks off.' };
        patch.sqft = n == null ? null : Math.round(n);
      } else {
        const yearNow = new Date().getFullYear() + 1;
        if (n != null && (n < 1800 || n > yearNow)) return { ok: false, message: 'Year built looks off.' };
        patch.year_built = n == null ? null : Math.round(n);
      }
      mirror = (key === 'beds' ? patch.beds : key === 'baths' ? patch.baths : key === 'sqft' ? patch.sqft : patch.year_built) ?? null;
    }
    const mirrored = await patchJsonKey('sellers', sellerId, 'intake', intakeKey, mirror === '' ? null : mirror);
    if (!mirrored.ok) return fromPatch(mirrored);
    if (!propertyId) return { ok: true };
    const { error } = await supabase.from('properties').update(patch)
      .eq('workspace_id', workspaceId).eq('id', propertyId);
    return fail(error);
  }

  // The submission's asking price lives on the deal (Podio's "what price are
  // you asking"); keep it in step with the seller's so both screens agree.
  if (field === 'asking_price' && dealId) {
    const err = moneyError(value);
    if (err) return { ok: false, message: err };
    const { error } = await supabase.from('deals').update({ asking_price: money(value) })
      .eq('workspace_id', workspaceId).eq('id', dealId);
    if (error) return fail(error);
  }

  return updateSellerDetails(workspaceId, sellerId, field, value);
}

const ids = (personIds: string[]) => personIds.map(dbId).filter((n) => Number.isFinite(n));

/**
 * Ids in URL-safe batches. PostgREST puts `.in('id', …)` in the query string,
 * and a few thousand ids overflow it (400 Bad Request on a 3,686-lead assign).
 */
function batches(personIds: string[], size = 200): number[][] {
  const all = ids(personIds);
  const out: number[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

/**
 * Claim an unassigned lead for the rep who dialled it. Guarded on
 * `assigned_to is null`, so two reps dialling the same new lead cannot both
 * take it: the second write matches no row. `claimed` says whether this rep
 * holds it now; when they do not, `owner` is who does.
 */
export async function claimSeller(
  workspaceId: number, personId: string, userId: string | null,
): Promise<WriteResult & { claimed?: boolean; owner?: string | null }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!userId) return { ok: false, message: 'Sign in to claim a lead.' };
  const id = dbId(personId);
  if (!Number.isFinite(id)) return { ok: false, message: 'Unknown record.' };
  const { data, error } = await supabase.from('sellers').update({ assigned_to: userId })
    .eq('id', id).eq('workspace_id', workspaceId).is('assigned_to', null).select('id');
  if (error) return fail(error);
  if (data?.length) return { ok: true, claimed: true };
  const { data: row, error: readErr } = await supabase.from('sellers').select('assigned_to')
    .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
  if (readErr) return fail(readErr);
  const owner = (row as { assigned_to: string | null } | null)?.assigned_to ?? null;
  return { ok: true, claimed: owner === userId, owner };
}

export async function assignSellers(personIds: string[], userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(personIds)) {
    const { error } = await supabase.from('sellers').update({ assigned_to: userId }).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/** Who underwrites these leads (migration 121); null clears it. */
export async function setSellerUnderwriter(personIds: string[], userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(personIds)) {
    const { error } = await supabase.from('sellers').update({ underwriter_id: userId }).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/**
 * A row's tags after adding or removing one, or null when they would not
 * change: exact match, an add goes on the end once, a remove takes every
 * copy, null tags read as none. crm_edit_tags (migration 302) applies the
 * same rules in the database.
 */
export function nextTags(tags: string[] | null, tag: string, add: boolean): string[] | null {
  const have = tags ?? [];
  if (have.includes(tag) === add) return null;
  return add ? [...have, tag] : have.filter((t) => t !== tag);
}

const missingFn = (e: { message: string; code?: string }) => /PGRST202|could not find the function/i.test(`${e.code ?? ''} ${e.message}`);

/**
 * Add or remove one tag on sellers or buyers: one crm_edit_tags call per 500
 * rows, which touches only rows that change (a tag update fires webhooks and
 * plan triggers). A database without migration 302 gets the old way: read,
 * then one update per row that changes.
 */
async function editTags(table: 'sellers' | 'buyers', rowIds: string[], tag: string, add: boolean): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const clean = tag.trim();
  if (!clean) return { ok: false, message: 'A tag needs a name.' };
  for (const b of batches(rowIds, 500)) {
    const { error: rpcError } = await supabase.rpc('crm_edit_tags' as never, {
      p_ws: null, p_table: table, p_ids: b, p_add: add ? [clean] : [], p_remove: add ? [] : [clean],
    } as never);
    if (!rpcError) continue;
    if (!missingFn(rpcError)) return fail(rpcError);
    const r = await supabase.from(table).select('id, tags').in('id', b);
    if (r.error) return fail(r.error);
    for (const row of (r.data ?? []) as { id: number; tags: string[] | null }[]) {
      const next = nextTags(row.tags, clean, add);
      if (!next) continue;
      const { error } = await supabase.from(table).update({ tags: next } as never).eq('id', row.id);
      if (error) return fail(error);
    }
  }
  return { ok: true };
}

export const tagSellers = (personIds: string[], tag: string) => editTags('sellers', personIds, tag, true);
export const untagSellers = (personIds: string[], tag: string) => editTags('sellers', personIds, tag, false);

/** Archive deals (or bring them back). They leave the Deals board, the deal list and Dispo (migration 118). */
export async function archiveDeals(dealDbIds: number[], archive = true, reason: string | null = null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(dealDbIds.map(String))) {
    const { error } = await supabase.from('deals')
      .update({ archived_at: archive ? new Date().toISOString() : null, archived_reason: archive ? reason ?? 'Archived' : null } as never).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

export async function archiveSellers(personIds: string[], archive = true): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(personIds)) {
    const { error } = await supabase.from('sellers')
      .update({ archived_at: archive ? new Date().toISOString() : null }).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/** Archive buyers (or bring them back, migration 131): they leave every list, nothing is deleted. */
export async function archiveBuyers(buyerIds: string[], archive = true): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(buyerIds)) {
    const { error } = await supabase.from('buyers')
      .update({ archived_at: archive ? new Date().toISOString() : null, updated_at: new Date().toISOString() } as never).in('id', b);
    if (error) {
      if (/archived_at/.test(error.message)) return { ok: false, message: 'Buyer archiving is not set up yet: migration 131 has not run on this database.' };
      return fail(error);
    }
  }
  return { ok: true };
}

/** Vendors have no archived_at; status 'archived' drops them from every list (lib/crm.ts leaves it out). */
export async function archiveVendors(vendorIds: string[]): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(vendorIds)) {
    const { error } = await supabase.from('vendors').update({ status: 'archived' }).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/**
 * Star a vendor as their company's main contact in their state (migration 80).
 * The database un-stars whoever held it, so there is one per company and state.
 */
export async function setVendorMainPoc(vendorDbId: number, on: boolean): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('vendor_set_main_poc', { p_vendor: vendorDbId, p_on: on });
  return error ? fail(error) : { ok: true };
}

/** Where a vendor contact works. "Texas", "tx" and "TX" all store TX; either may be cleared. */
export async function setVendorLocation(vendorDbId: number, city: string | null, state: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (state?.trim() && !stateCodeOf(state) && !splitPlace(state).state) return { ok: false, message: 'Use a state, like TX or Texas.' };
  const place = normalizePlace({ city, state });
  const { error } = await supabase.from('vendors')
    .update({ city: place.city, state: place.state, updated_at: new Date().toISOString() }).eq('id', vendorDbId);
  return error ? fail(error) : { ok: true };
}

// ---- action plans -----------------------------------------------------------

export type PlanStepInput = { channel: string; delay: string; title: string; content: string };

/** "Immediately" / "2 hours" / "Day 3" / "1 week" → hours. */
export function delayToHours(delay: string): number {
  const d = delay.trim().toLowerCase();
  if (!d || /^(immediately|now|0)$/.test(d)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day|week|wk)s?/.exec(d) ?? /^day\s*(\d+)/.exec(d);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] ?? 'day';
  if (/min/.test(unit)) return Math.round(n / 60);
  if (/h/.test(unit)) return n;
  if (/w/.test(unit)) return n * 24 * 7;
  // "Day 3" is two days after enrolment, the way GoHighLevel counts it.
  return /^day\s*\d+/.test(d) ? Math.max(0, n - 1) * 24 : n * 24;
}

/**
 * Create or replace a plan and its steps. Steps are replaced wholesale — a
 * plan is edited as one thing in the builder, and diffing steps buys nothing
 * but the chance to leave a stale one behind.
 */
export async function savePlan(
  workspaceId: number, plan: { id: string | null; name: string; trigger: string; active: boolean; steps: PlanStepInput[] },
  userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  let planId = plan.id && /^ap\d+$/.test(plan.id) ? dbId(plan.id) : null;
  if (planId) {
    const { error } = await supabase.from('action_plans')
      .update({ name: plan.name, trigger_event: plan.trigger, active: plan.active, updated_at: new Date().toISOString() })
      .eq('id', planId);
    if (error) return fail(error);
    await supabase.from('action_plan_steps').delete().eq('plan_id', planId);
  } else {
    const { data, error } = await supabase.from('action_plans')
      .insert({ workspace_id: workspaceId, name: plan.name, trigger_event: plan.trigger, active: plan.active, created_by: userId })
      .select('id').single();
    if (error) return fail(error);
    planId = data.id;
  }
  if (plan.steps.length) {
    // delay_hours is cumulative since enrolment; delay_minutes (migration 34)
    // is the wait after the previous step, so it is the difference.
    let last = 0;
    const { error } = await supabase.from('action_plan_steps').insert(plan.steps.map((st, i) => {
      const hours = delayToHours(st.delay);
      const minutes = Math.max(0, hours - last) * 60;
      last = Math.max(last, hours);
      return {
        workspace_id: workspaceId, plan_id: planId!, position: i,
        channel: st.channel, delay_hours: hours, delay_minutes: minutes, title: st.title || null, body: st.content || null,
      };
    }));
    if (error) return fail(error);
  }
  return { ok: true, id: planId! };
}

export async function deletePlan(planId: string): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('action_plans').delete().eq('id', dbId(planId));
  return fail(error);
}

// ---- the call wrap-up ---------------------------------------------------------

/**
 * What a call taught us about the seller, written back to the record. Only
 * the fields the call actually produced are touched; the previous values of
 * anything the seller did not bring up are left alone. Notes are appended,
 * never replaced — a summary is a new fact, not a correction.
 */
export async function applyCallFacts(
  sellerId: number,
  facts: { motivation?: string | null; asking_price?: number | null; timeline?: string | null; condition?: string | null; note?: string | null },
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const patch: Partial<Pick<Seller, 'motivation' | 'asking_price' | 'timeline' | 'condition' | 'notes'>> = {};
  if (facts.motivation) patch.motivation = facts.motivation;
  // The due-diligence four: timeline and condition land too, not just in the note.
  if (facts.timeline) patch.timeline = facts.timeline;
  if (facts.condition) patch.condition = facts.condition;
  if (typeof facts.asking_price === 'number' && Number.isFinite(facts.asking_price)) patch.asking_price = facts.asking_price;
  if (facts.note) {
    const { data } = await supabase.from('sellers').select('notes').eq('id', sellerId).maybeSingle();
    const prev = (data?.notes ?? '').trim();
    patch.notes = prev ? `${prev}\n\n${facts.note}` : facts.note;
  }
  if (Object.keys(patch).length === 0) return { ok: true };
  const { error } = await supabase.from('sellers').update(patch).eq('id', sellerId);
  return error ? fail(error) : { ok: true, id: sellerId };
}

// ---- buyers, in bulk ----------------------------------------------------------

/**
 * Delete buyers. A buyer a deal, an offer, a deal party, a transaction or a
 * contract still names is made Inactive instead: those rows would lose their
 * buyer (the foreign keys set null) and the deal's history with it.
 */
export async function deleteBuyers(buyerIds: string[]): Promise<WriteResult & { deleted?: number; deactivated?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const db = supabase;
  let deleted = 0;
  let deactivated = 0;
  let refused = 0;
  for (const b of batches(buyerIds)) {
    const refs = await Promise.all((['deals', 'offers', 'deal_parties', 'transactions', 'contracts'] as const)
      .map((t) => db.from(t).select('buyer_id').in('buyer_id', b)));
    const bad = refs.find((r) => r.error);
    if (bad?.error) return fail(bad.error);
    const named = new Set(refs.flatMap((r) => ((r.data ?? []) as { buyer_id: number | null }[]).map((x) => x.buyer_id)));
    const keep = b.filter((id) => named.has(id));
    const drop = b.filter((id) => !named.has(id));
    if (keep.length) {
      const { data, error } = await db.from('buyers').update({ status: 'Inactive', updated_at: new Date().toISOString() } as never).in('id', keep).select('id');
      if (error) return fail(error);
      deactivated += data?.length ?? 0;
    }
    if (drop.length) {
      const { data, error } = await db.from('buyers').delete().in('id', drop).select('id');
      if (error) return fail(error);
      deleted += data?.length ?? 0;
      refused += drop.length - (data?.length ?? 0);
    }
  }
  // RLS filters a refused delete to zero rows rather than raising.
  if (refused) {
    const done = [deleted ? `${deleted} deleted` : '', deactivated ? `${deactivated} set Inactive` : ''].filter(Boolean).join(', ');
    return { ok: false, message: `Only owners and admins can delete buyers.${done ? ` ${done}.` : ''}` };
  }
  return { ok: true, deleted, deactivated };
}

/** Add a tag to buyers (e.g. 'genius', the priority pool), skipping those that have it. */
export const tagBuyers = (buyerIds: string[], tag: string) => editTags('buyers', buyerIds, tag, true);

/** Move buyers to a stage (buyers.status, lib/stages BUYER_STAGES). */
export async function setBuyerStage(buyerIds: string[], stage: string): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(buyerIds)) {
    const { error } = await supabase.from('buyers').update({ status: stage, updated_at: new Date().toISOString() }).in('id', b);
    if (error) return fail(error);
  }
  return { ok: true };
}

/** Who these buyers are assigned to (migration 128); null clears it. */
export async function assignBuyers(buyerIds: string[], userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  for (const b of batches(buyerIds)) {
    const { error } = await supabase.from('buyers').update({ assigned_to: userId, updated_at: new Date().toISOString() }).in('id', b);
    if (error) {
      if (/assigned_to/.test(error.message)) return { ok: false, message: 'Buyer assignment is not set up yet: migration 128 has not run on this database.' };
      return fail(error);
    }
  }
  return { ok: true };
}

/** Rename a buyer and nothing else (updateBuyer rewrites the whole profile). */
export async function renameBuyer(workspaceId: number, buyerId: number, name: string): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const clean = name.trim();
  if (!clean) return { ok: false, message: 'A buyer needs a name.' };
  const { error } = await supabase.from('buyers').update({ name: clean, updated_at: new Date().toISOString() }).eq('id', buyerId).eq('workspace_id', workspaceId);
  return error ? fail(error) : { ok: true };
}

/** The selected buyers as a CSV file the browser downloads. */
export async function exportBuyersCsv(buyerIds: string[]): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const rows: Record<string, unknown>[] = [];
  for (const b of batches(buyerIds)) {
    const { data, error } = await supabase.from('buyers').select('name, company, phone, email, status, buyer_type, entity_type, markets, min_purchase_price, max_purchase_price, tags, created_at').in('id', b);
    if (error) return fail(error);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  const cols = ['name', 'company', 'phone', 'email', 'status', 'buyer_type', 'entity_type', 'markets', 'min_purchase_price', 'max_purchase_price', 'tags', 'created_at'];
  const cell = (v: unknown) => { const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `buyers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return { ok: true };
}
export const untagBuyers = (buyerIds: string[], tag: string) => editTags('buyers', buyerIds, tag, false);

/**
 * Which of these buyers fit a deal: re-runs the database matcher (match_deal,
 * migration 27, which skips blacklisted and inactive buyers) and reads back the
 * selected buyers' scores at or above `min`.
 */
export async function buyerFitsForDeal(
  dealId: number, buyerIds: string[], min = 55,
): Promise<WriteResult & { fits?: { buyerId: number; score: number }[] }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const m = await matchDeal(dealId);
  if (!m.ok) return m;
  const fits: { buyerId: number; score: number }[] = [];
  for (const b of batches(buyerIds)) {
    const { data, error } = await supabase.from('deal_buyer_matches')
      .select('buyer_id, score').eq('deal_id', dealId).gte('score', min).in('buyer_id', b);
    if (error) return fail(error);
    fits.push(...(data ?? []).map((r) => ({ buyerId: r.buyer_id, score: r.score })));
  }
  return { ok: true, fits };
}

/** Stamp a deal as sent to these buyers on the match rows that exist. */
export async function markDealSent(dealId: number, buyerIds: number[]): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const at = new Date().toISOString();
  for (let i = 0; i < buyerIds.length; i += 200) {
    const b = buyerIds.slice(i, i + 200);
    const { error } = await supabase.from('deal_buyer_matches').update({ sent_at: at }).eq('deal_id', dealId).in('buyer_id', b);
    if (error) return fail(error);
    await supabase.from('deal_buyer_matches').update({ status: 'sent' }).eq('deal_id', dealId).eq('status', 'matched').in('buyer_id', b);
  }
  return { ok: true };
}

/**
 * Put buyers on an action plan for a deal (migration 50: enrollments.buyer_id,
 * deal_id; tasks.buyer_id). Same queueing as enrollInPlan: each step becomes a
 * dated task with the merge fields filled from the buyer and the deal. A buyer
 * already on the plan is left alone.
 */
export async function enrollBuyersInPlan(
  workspaceId: number, planId: string, dealId: number,
  buyers: { id: number; name: string }[], dealFields: Record<string, string>, userId: string | null,
): Promise<WriteResult & { enrolled?: number; already?: number; queued?: number }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const plan = dbId(planId);
  const [{ data: steps, error: stepsError }, { rows: buyerById, error: buyersError }] = await Promise.all([
    supabase.from('action_plan_steps').select(STEP_COLS).eq('plan_id', plan).order('position'),
    rowsById<{ id: number; phone: string | null; tags: string[] | null; blacklisted_at: string | null; wants_calls: boolean | null }>(
      'buyers', 'id, phone, tags, blacklisted_at, wants_calls', buyers.map((b) => b.id)),
  ]);
  // Unread blacklist and do-not-call flags would queue drops for those buyers: enrol nobody.
  const readError = stepsError ?? buyersError;
  if (readError) return fail(readError);
  const jobs = buyers.map((b): EnrollJob => {
    const who = b.name.trim();
    const first = who.split(/\s+/)[0] || who;
    const fields = { ...dealFields, first_name: first, name: who, contact_name: who };
    const info = buyerById.get(b.id);
    return {
      key: b.id,
      extra: { deal_id: dealId },
      tasks: (enrollmentId, now) => {
        let offset = 0;
        return (steps ?? []).flatMap((st) => {
          offset += st.delay_minutes ?? 0;
          if (st.channel === 'wait') return [];
          const cfg = stepCfg(st);
          return [{
            workspace_id: workspaceId, buyer_id: b.id, deal_id: dealId,
            title: taskTitle(st.channel, st.title, first, cfg),
            task_type: taskTypeFor(st.channel),
            priority: cfg.priority === 'low' || cfg.priority === 'high' ? cfg.priority : 'normal',
            due_at: new Date(now + offset * 60_000).toISOString(),
            assigned_to: typeof cfg.assignee === 'string' && cfg.assignee ? cfg.assignee : userId,
            notes: st.body ? renderMerge(st.body, fields) : null,
            enrollment_id: enrollmentId, plan_step_id: st.id, created_by: userId,
          }];
        });
      },
      drops: (enrollmentId, now) => planRvmRows(
        workspaceId, steps ?? [], { buyer_id: b.id }, e164ish(info?.phone),
        blockReason(info) ?? (info?.wants_calls === false ? 'do_not_call' : null),
        fields, enrollmentId, userId, now,
      ),
    };
  });
  const res = await enrollMany(workspaceId, plan, 'buyer_id', jobs, userId, true);
  if (res.some((r) => r.queued)) nudgeGoogle(workspaceId);
  // Counted as the one-at-a-time loop counted them, up to the first refusal.
  let enrolled = 0; let already = 0; let queued = 0;
  for (const r of res) {
    if (r.error) return { ...fail(r.error), enrolled, already, queued };
    if (r.already) { already++; continue; }
    enrolled++;
    if (r.tasksError) return { ...fail(r.tasksError), enrolled, already, queued };
    queued += r.queued;
  }
  return { ok: true, enrolled, already, queued };
}


// ---- One field, one row ------------------------------------------------------
// The save path for click-to-edit (components/ds/InlineField): update the
// columns that changed on one row and hand back the row the database now
// holds. The caller patches its own copy (useCrm's `patchLocal`, lib/use-crm) — never a
// `reload()`, which re-reads every table to change one cell.

/** Tables an inline field may write. RLS still decides who may write which row. */
export type PatchTable = 'sellers' | 'deals' | 'buyers' | 'properties' | 'vendors' | 'tasks' | 'transactions' | 'offers' | 'appointments';

export type PatchResult<T = Record<string, unknown>> = { ok: true; row: T } | { ok: false; message: string };

/**
 * `{ flagColumn: stampColumn }` pairs, e.g. `{ is_dnc: 'dnc_at' }`. A stamp is
 * written only when its flag actually changes in this patch (to now when it
 * turns on, to null when it turns off), and a stamp the caller put in the
 * patch is dropped when its flag did not flip, so saving an unrelated field
 * never moves a date. Without `before` nothing is known to have flipped, so
 * no stamp is written: pass the row as it was to get one.
 */
export function withStamps(
  patch: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined,
  stamps: Record<string, string> = {},
  now: () => string = () => new Date().toISOString(),
): Record<string, unknown> {
  const out = { ...patch };
  for (const [flag, at] of Object.entries(stamps)) {
    const flipped = !!before && flag in patch && !!patch[flag] !== !!before[flag];
    if (flipped) out[at] = patch[flag] ? now() : null;
    else delete out[at];
  }
  return out;
}

/**
 * Update one row and return it. `id` is the database id or the prefixed id
 * the screens use ('s42'). A row RLS hides, or that no longer exists, is a
 * failure with a message, never a silent success.
 *
 *   const r = await patchRecord('sellers', person.id, { asking: 185000 });
 *   if (r.ok) crm.patchLocal('people', { id: person.id, asking: '$185,000' });
 */
export async function patchRecord<T = Record<string, unknown>>(
  table: PatchTable,
  id: number | string,
  patch: Record<string, unknown>,
  opts?: { before?: Record<string, unknown> | null; stamps?: Record<string, string> },
): Promise<PatchResult<T>> {
  if (!supabase) return { ok: false, message: 'Sign in to save changes.' };
  const rowId = typeof id === 'number' ? id : dbId(id);
  if (!Number.isFinite(rowId)) return { ok: false, message: 'That record has no id yet.' };
  const body = withStamps(patch, opts?.before, opts?.stamps);
  if (!Object.keys(body).length) return { ok: false, message: 'Nothing to save.' };
  const { data, error } = await supabase.from(table as 'sellers').update(body as never).eq('id', rowId).select('*').maybeSingle();
  if (error) return { ok: false, message: sellerWriteFail(error).message ?? error.message };
  if (!data) return { ok: false, message: 'That record could not be saved. It may have been archived, or you may not have access.' };
  return { ok: true, row: data as unknown as T };
}

/**
 * Set one key of a jsonb column (migration 220 `jsonb_set_key`), or remove it
 * with `value === null`. The merge happens in the database, so two people
 * saving different keys of the same record never overwrite each other.
 */
export async function patchJsonKey<T = Record<string, unknown>>(
  table: PatchTable,
  id: number | string,
  column: string,
  key: string,
  value: unknown,
): Promise<PatchResult<T>> {
  if (!supabase) return { ok: false, message: 'Sign in to save changes.' };
  const rowId = typeof id === 'number' ? id : dbId(id);
  if (!Number.isFinite(rowId)) return { ok: false, message: 'That record has no id yet.' };
  const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'jsonb_set_key', { p_table: table, p_id: rowId, p_column: column, p_key: key, p_value: value === undefined ? null : value },
  );
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: 'That record could not be saved. It may have been archived, or you may not have access.' };
  return { ok: true, row: data as T };
}
