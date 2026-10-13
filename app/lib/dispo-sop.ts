// The dispo SOP: the checks Dispositions runs on a house before and while it
// sells it, and the writes behind the Offer desk's steps.
//
//   1. Read the acquisitions handoff (deal basics, property and access, selling
//      context): HandoffCard edits it in place.
//   2. Verify access: a vacant house within 24 hours, an occupied one within 48.
//   3. Validate: comps under 30 days old, a signed contract.
//   5. Market: VIP and A-list buyers get the first 24 hours, then the list.
//   6. Offers: every offer logged with proof of funds; VIPs get a buy-it-now
//      (BIN), the market the ask and the BIN; under the ask needs an owner or
//      admin's approval (migration 235 enforces it).
//   7. A qualified sale: verified buyer, POF, executed contract, EMD, no option
//      period, closing no later than the AB contract.
//   8. Mark Sold with the price and the buyer, and tell acquisitions.
//   9. Not sold in 6 days: list it on the MLS.
//
// The pure checks come first (tools/dispo-sop.test.ts); the writes after.

import { logActivity } from './crm-write';
import { supabase } from './supabase';

const DAY = 86_400_000;

/** Calendar days from `from` (YYYY-MM-DD or ISO) to `today`, never negative. */
export function daysSince(from: string | null | undefined, today = new Date()): number | null {
  if (!from) return null;
  const d = new Date(from.length === 10 ? from + 'T12:00:00' : from);
  if (Number.isNaN(d.getTime())) return null;
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((b - a) / DAY));
}

/** Days on market goes to the MLS after this many days unsold. */
export const MLS_AFTER_DAYS = 6;

/** Days on market from `marketing_started_on`, and whether it is MLS time. */
export function marketTiming(startedOn: string | null | undefined, opts: { sold?: boolean; today?: Date } = {}) {
  const dom = daysSince(startedOn, opts.today);
  return { dom, mlsDue: !opts.sold && dom != null && dom >= MLS_AFTER_DAYS };
}

export type CheckState = 'ok' | 'due' | 'late' | 'missing';
export type SopCheck = { key: string; label: string; state: CheckState; detail: string };

/**
 * Access: verified, or still inside its window from when marketing started
 * (24h vacant, 48h occupied), or late. Unknown occupancy is "missing": the
 * handoff has not said which window applies.
 */
export function accessCheck(d: { occupancy_status?: string | null; access_verified_at?: string | null; marketing_started_on?: string | null }, now = new Date()): SopCheck {
  const label = 'Access verified';
  if (d.access_verified_at) return { key: 'access', label, state: 'ok', detail: 'Verified ' + new Date(d.access_verified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
  const occ = d.occupancy_status === 'vacant' || d.occupancy_status === 'occupied' ? d.occupancy_status : null;
  if (!occ) return { key: 'access', label, state: 'missing', detail: 'Set vacant or occupied in the handoff' };
  const hours = occ === 'vacant' ? 24 : 48;
  if (!d.marketing_started_on) return { key: 'access', label, state: 'due', detail: `${occ === 'vacant' ? 'Vacant' : 'Occupied'}: verify within ${hours} hours` };
  const start = new Date(d.marketing_started_on.length === 10 ? d.marketing_started_on + 'T00:00:00' : d.marketing_started_on).getTime();
  const left = Math.round((start + hours * 3_600_000 - now.getTime()) / 3_600_000);
  return left >= 0
    ? { key: 'access', label, state: 'due', detail: `${left} hour${left === 1 ? '' : 's'} left of the ${hours}-hour window` }
    : { key: 'access', label, state: 'late', detail: `Past the ${hours}-hour window` };
}

/** Comps dated within 30 days. */
export function compsCheck(compsDatedOn: string | null | undefined, today = new Date()): SopCheck {
  const label = 'Comps under 30 days';
  const age = daysSince(compsDatedOn, today);
  if (age == null) return { key: 'comps', label, state: 'missing', detail: 'Add the date of the comps' };
  return age <= 30
    ? { key: 'comps', label, state: 'ok', detail: `${age} day${age === 1 ? '' : 's'} old` }
    : { key: 'comps', label, state: 'late', detail: `${age} days old. Pull new comps` };
}

/** The seller contract is signed: a contract date, or a contract status that says so. */
export function contractCheck(d: { contract_date?: string | null; contract_status?: string | null }): SopCheck {
  const label = 'Signed contract';
  const signed = !!d.contract_date || /signed|executed|under contract/i.test(d.contract_status ?? '');
  return signed
    ? { key: 'contract', label, state: 'ok', detail: d.contract_date ? 'Signed ' + new Date(d.contract_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : (d.contract_status ?? 'Signed') }
    : { key: 'contract', label, state: 'missing', detail: 'No signed contract on the deal' };
}

/** An offer under the ask (the deal's marketed price). No ask, nothing is under it. */
export const belowAsk = (amount: number | null | undefined, ask: number | null | undefined) =>
  amount != null && ask != null && ask > 0 && amount < ask;

/**
 * The ask an offer is judged against, exactly as migration 235's
 * offers_approval_guard judges it: the higher of the deal's ask when the offer
 * was logged and its ask now. An ask counts only when it is set and above
 * zero; if either is missing or zero there is no judged ask, and the offer
 * needs approval (fail closed), so lowering or clearing the ask never waves
 * an offer through.
 */
export const judgedAsk = (askNow: number | null | undefined, askAtOffer: number | null | undefined): number | null =>
  askNow != null && askNow > 0 && askAtOffer != null && askAtOffer > 0 ? Math.max(askNow, askAtOffer) : null;

/**
 * Needs an owner or admin's approval to accept: under the judged ask, or no
 * judged ask. An offer not logged yet will be stamped with today's ask.
 */
export const needsApproval = (amount: number | null | undefined, askNow: number | null | undefined, askAtOffer: number | null | undefined = askNow) => {
  const ask = judgedAsk(askNow, askAtOffer);
  return ask == null || amount == null || amount < ask;
};

/**
 * An approval is for one amount, one buyer, on one deal (migration 235): a
 * change to any of them by someone other than an owner or admin clears it.
 */
export const approvalSurvives = (
  before: { amount: number | null; deal_id: number | null; buyer_id: number | null },
  after: { amount: number | null; deal_id: number | null; buyer_id: number | null },
) => before.amount === after.amount && before.deal_id === after.deal_id && before.buyer_id === after.buyer_id;

type SoldFields = { sold_at: string | null; sold_price: number | null; buyer_id: number | null };
/**
 * Whether a write to a deal's sale may go through, as migration 236's
 * deals_sold_guard judges it; null when it may, else why not. Owners and
 * admins may always. Others mark a deal sold only to an accepted offer's buyer
 * at exactly its price, and cannot change the sale once it is marked.
 */
export function soldWriteProblem(
  before: SoldFields, after: SoldFields, accepted: { buyer_id: number; amount: number }[], admin: boolean,
): string | null {
  if (admin) return null;
  const changed = before.sold_at !== after.sold_at || before.sold_price !== after.sold_price || before.buyer_id !== after.buyer_id;
  if (!changed) return null;
  if (before.sold_at) return 'This deal is marked sold: its buyer and price are fixed. An owner or admin can change them.';
  if (!after.sold_at) return null;
  const ok = after.buyer_id != null && after.sold_price != null
    && accepted.some((o) => o.buyer_id === after.buyer_id && o.amount === after.sold_price);
  return ok ? null : 'Mark it sold at the accepted offer\'s price. An owner or admin can record a different sale.';
}

export type QualifiedInput = {
  buyerVerified: boolean;
  pof: boolean;
  executedContract: boolean;
  emd: number | null;
  /** Option period days the buyer asked for; 0 or null is none. */
  optionDays: number | null;
  /** The buyer's closing date (YYYY-MM-DD), and the AB (seller) contract's. */
  buyerClose: string | null;
  abClose: string | null;
};
export type QualifiedItem = { key: keyof QualifiedResult['flags']; label: string; ok: boolean; detail?: string };
export type QualifiedResult = {
  flags: { verified_buyer: boolean; pof: boolean; executed_contract: boolean; emd: boolean; no_option: boolean; close_by_ab: boolean };
  items: QualifiedItem[];
  qualified: boolean;
};

/** SOP step 7, as six ticks. Every one has to be true for a qualified sale. */
export function qualifiedSale(q: QualifiedInput): QualifiedResult {
  const closeByAb = !!q.buyerClose && !!q.abClose && q.buyerClose <= q.abClose;
  const flags = {
    verified_buyer: q.buyerVerified,
    pof: q.pof,
    executed_contract: q.executedContract,
    emd: (q.emd ?? 0) > 0,
    no_option: !q.optionDays,
    close_by_ab: closeByAb,
  };
  const items: QualifiedItem[] = [
    { key: 'verified_buyer', label: 'Verified buyer', ok: flags.verified_buyer, detail: flags.verified_buyer ? undefined : 'Vet the buyer on their record' },
    { key: 'pof', label: 'Proof of funds verified', ok: flags.pof },
    { key: 'executed_contract', label: 'Executed buyer contract', ok: flags.executed_contract },
    { key: 'emd', label: 'Earnest money', ok: flags.emd, detail: flags.emd ? undefined : 'No EMD on the offer' },
    { key: 'no_option', label: 'No option period', ok: flags.no_option, detail: flags.no_option ? undefined : `${q.optionDays}-day option` },
    {
      key: 'close_by_ab', label: 'Closes by the AB contract', ok: flags.close_by_ab,
      detail: !q.abClose ? 'The deal has no close date' : !q.buyerClose ? 'Set the buyer’s close date' : flags.close_by_ab ? undefined : 'Closes after the AB contract',
    },
  ];
  return { flags, items, qualified: items.every((i) => i.ok) };
}

/** "YYYY-MM-DD" `days` after today. */
export function closeDateIn(days: number | null, today = new Date()): string | null {
  if (!days || days <= 0) return null;
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- reads and writes ------------------------------------------------------

export type Result = { ok: true } | { ok: false; message: string };
const fail = (e: { message: string } | null | undefined, fallback = 'That did not save.'): Result => ({ ok: false, message: e?.message || fallback });

/** The deal's own row, every column, so the handoff reads columns added after the app's list query. */
export type DispoDeal = Record<string, unknown> & { id: number; workspace_id: number; seller_id: number | null; stage: string };

export async function loadDispoDeal(dealId: number): Promise<DispoDeal | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('deals').select('*').eq('id', dealId).maybeSingle();
  return (data as DispoDeal | null) ?? null;
}

export type DeskOffer = {
  id: number; buyer_id: number; amount: number; status: string; sent_at: string; notes: string | null;
  terms: { emd?: number | null; close_days?: number | null; contingency?: string | null; option_days?: number | null; close_on?: string | null } | null;
  pof_url: string | null; pof_path: string | null; pof_verified: boolean;
  approved_by: string | null; approved_at: string | null; qualified: Record<string, boolean> | null; override_reason: string | null;
  /** The deal's ask when the offer was logged (stamped by the database). */
  ask_at_offer: number | null;
};

/** Every buyer offer on one deal, newest first. Columns from 235 read as empty on an older database. */
export async function loadDeskOffers(dealId: number): Promise<DeskOffer[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('offers').select('*')
    .eq('deal_id', dealId).eq('direction', 'inbound').not('buyer_id', 'is', null)
    .order('id', { ascending: false }).limit(200);
  return ((data ?? []) as Record<string, unknown>[]).map((o) => ({
    id: Number(o.id), buyer_id: Number(o.buyer_id), amount: Number(o.amount ?? 0), status: String(o.status ?? ''),
    sent_at: String(o.sent_at ?? o.created_at ?? ''), notes: (o.notes as string | null) ?? null,
    terms: (o.terms as DeskOffer['terms']) ?? null,
    pof_url: (o.pof_url as string | null) ?? null, pof_path: (o.pof_path as string | null) ?? null, pof_verified: o.pof_verified === true,
    approved_by: (o.approved_by as string | null) ?? null, approved_at: (o.approved_at as string | null) ?? null,
    qualified: (o.qualified as Record<string, boolean> | null) ?? null, override_reason: (o.override_reason as string | null) ?? null,
    ask_at_offer: o.ask_at_offer == null ? null : Number(o.ask_at_offer),
  }));
}

/** A proof-of-funds file, kept with the deal's files and linked from the offer. */
export async function uploadPof(workspaceId: number, dealId: number, file: File): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Sign in to upload.' };
  if (file.size > 20 * 1024 * 1024) return { ok: false, message: `${file.name} is over 20 MB. Paste a link instead.` };
  const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'pof';
  const path = `ws/${workspaceId}/deals/${dealId}/pof-${Date.now()}-${safe}`;
  const up = await supabase.storage.from('deal-files').upload(path, file, { contentType: file.type || undefined });
  if (up.error) return { ok: false, message: up.error.message };
  const { error } = await supabase.from('deal_files').insert({
    workspace_id: workspaceId, deal_id: dealId, kind: 'file', name: 'Proof of funds · ' + file.name, storage_path: path,
    content_type: file.type || null, byte_size: file.size, source: 'upload', category: 'pof',
  } as never);
  if (error) {
    await supabase.storage.from('deal-files').remove([path]);
    return { ok: false, message: `${file.name}: ${error.message}` };
  }
  return { ok: true, path };
}

export async function pofLink(o: Pick<DeskOffer, 'pof_url' | 'pof_path'>): Promise<string | null> {
  if (o.pof_url) return o.pof_url;
  if (!supabase || !o.pof_path) return null;
  const { data } = await supabase.storage.from('deal-files').createSignedUrl(o.pof_path, 3600);
  return data?.signedUrl ?? null;
}

/** Proof of funds on an offer already logged (a link, a file, the verified tick). */
export async function setOfferPof(offerId: number, patch: { pof_url?: string | null; pof_path?: string | null; pof_verified?: boolean }): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Sign in to save.' };
  const { error } = await supabase.from('offers').update({ ...patch, updated_at: new Date().toISOString() } as never).eq('id', offerId);
  return error ? fail(error) : { ok: true };
}

/** An owner or admin approves taking an offer under the ask. The database refuses anyone else. */
export async function approveBelowAsk(
  workspaceId: number, o: { offerId: number; dealId: number; buyerId: number; amount: number; ask: number | null; note: string }, userId: string | null,
): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Sign in to approve.' };
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('offers').update({ approved_at: now, approved_by: userId, updated_at: now } as never)
    .eq('id', o.offerId).eq('workspace_id', workspaceId).select('id');
  if (error) return fail(error);
  if (!data?.length) return { ok: false, message: 'Could not approve that offer.' };
  const under = o.ask == null ? 'No ask set on the deal' : `$${Math.round(o.ask - o.amount).toLocaleString('en-US')} under the $${Math.round(o.ask).toLocaleString('en-US')} ask`;
  await logActivity(workspaceId, 'deal', o.dealId, 'offer', `Below-ask offer $${Math.round(o.amount).toLocaleString('en-US')} approved`, `${under}. ${o.note}`.trim(), userId);
  await logActivity(workspaceId, 'buyer', o.buyerId, 'offer', `Offer $${Math.round(o.amount).toLocaleString('en-US')} approved under the ask`, o.note || undefined, userId);
  return { ok: true };
}

/**
 * Accept a buyer's offer: the offer is Accepted, with the qualified-sale ticks
 * as they stood and the override reason when one was given. Nothing is
 * written to the deal: Mark Sold records the price and the buyer.
 */
export async function acceptQualified(
  workspaceId: number,
  o: { offerId: number; dealId: number; buyerId: number; amount: number; qualified: QualifiedResult['flags']; overrideReason: string | null },
  userId: string | null,
): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Sign in to accept.' };
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('offers')
    .update({ status: 'Accepted', responded_at: now, updated_at: now, qualified: o.qualified, override_reason: o.overrideReason } as never)
    .eq('id', o.offerId).eq('workspace_id', workspaceId).eq('deal_id', o.dealId).select('id');
  if (error) return fail(error);
  if (!data?.length) return { ok: false, message: 'Could not mark that offer accepted.' };
  // One accepted offer per deal: a buyer accepted earlier who fell through goes back to Submitted.
  await supabase.from('offers').update({ status: 'Submitted', responded_at: null, updated_at: now })
    .eq('workspace_id', workspaceId).eq('deal_id', o.dealId).eq('direction', 'inbound').neq('id', o.offerId).ilike('status', 'accepted');
  const money = '$' + Math.round(o.amount).toLocaleString('en-US');
  const note = o.overrideReason ? 'Not a qualified sale. Override: ' + o.overrideReason : 'Qualified sale';
  await logActivity(workspaceId, 'buyer', o.buyerId, 'offer', `Offer ${money} accepted`, note, userId);
  await logActivity(workspaceId, 'deal', o.dealId, 'offer', `Buyer offer ${money} accepted`, note, userId);
  return { ok: true };
}

/**
 * Mark Sold (SOP step 8): the deal takes the price and the buyer, moves to
 * Buyer Under Contract (never backwards from In Escrow or Closed), and
 * acquisitions hears about it: a notification to the deal's acquisitions rep
 * (its owner, else the seller's assigned rep) and a row on the deal and the
 * seller's activity.
 */
export async function markSold(
  workspaceId: number,
  o: { dealId: number; buyerId: number; buyerName: string; price: number; address: string },
  userId: string | null,
): Promise<Result & { notified?: boolean }> {
  if (!supabase) return { ok: false, message: 'Sign in to mark it sold.' };
  if (!(o.price > 0)) return { ok: false, message: 'Enter the sold price.' };
  const { data: deal, error: readErr } = await supabase.from('deals').select('id, stage, seller_id, owner_id').eq('id', o.dealId).eq('workspace_id', workspaceId).maybeSingle();
  if (readErr) return fail(readErr);
  if (!deal) return { ok: false, message: 'That deal is not on this workspace.' };
  const now = new Date().toISOString();
  const moveStage = ['Under Contract Seller', 'Ready To Market', 'Prospect'].includes(deal.stage);
  const { error } = await supabase.from('deals').update({
    buyer_id: o.buyerId, sold_price: o.price, sold_at: now, sold_by: userId, updated_at: now,
    ...(moveStage ? { stage: 'Buyer Under Contract' } : {}),
  } as never).eq('id', o.dealId).eq('workspace_id', workspaceId);
  if (error) return fail(error);
  const money = '$' + Math.round(o.price).toLocaleString('en-US');
  const title = `Sold: ${o.address} to ${o.buyerName} for ${money}`;
  await logActivity(workspaceId, 'deal', o.dealId, 'stage', title, moveStage ? 'Deal moved to Buyer Under Contract' : undefined, userId);
  if (deal.seller_id) await logActivity(workspaceId, 'seller', deal.seller_id, 'deal', title, 'Dispositions marked it sold', userId);
  await logActivity(workspaceId, 'buyer', o.buyerId, 'purchase', `Bought ${o.address} for ${money}`, undefined, userId);
  let acq = deal.owner_id as string | null;
  if (!acq && deal.seller_id) {
    const { data: s } = await supabase.from('sellers').select('assigned_to').eq('id', deal.seller_id).maybeSingle();
    acq = (s as { assigned_to?: string | null } | null)?.assigned_to ?? null;
  }
  let notified = false;
  if (acq) {
    const { error: nErr } = await supabase.from('notifications').insert({
      workspace_id: workspaceId, user_id: acq, category: 'Dispo', title, body: 'Dispositions marked your deal sold. TC takes it to closing.',
      seller_id: deal.seller_id ?? null, deal_id: o.dealId,
    } as never);
    notified = !nErr;
  }
  return { ok: true, notified };
}

/** Access verified now (or cleared). */
export async function setAccessVerified(dealId: number, on: boolean, userId: string | null): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Sign in to save.' };
  const { error } = await supabase.from('deals').update({ access_verified_at: on ? new Date().toISOString() : null, access_verified_by: on ? userId : null } as never).eq('id', dealId);
  return error ? fail(error) : { ok: true };
}

/** A buyer confirmed their walkthrough. */
export async function confirmWalkthrough(workspaceId: number, apptId: number, buyerId: number | null, label: string, userId: string | null): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Sign in to confirm.' };
  const { data, error } = await supabase.from('appointments').update({ confirmed_at: new Date().toISOString(), confirmed_by: userId } as never)
    .eq('id', apptId).eq('workspace_id', workspaceId).select('id');
  if (error) return fail(error);
  if (!data?.length) return { ok: false, message: 'That walkthrough is gone or not yours to change.' };
  if (buyerId) await logActivity(workspaceId, 'buyer', buyerId, 'walkthrough', 'Walkthrough confirmed', label, userId);
  return { ok: true };
}
