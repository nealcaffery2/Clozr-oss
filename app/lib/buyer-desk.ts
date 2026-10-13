// Writes on a buyer record: notes, inbound offers, attaching a closed deal
// as a purchase, and the campaigns that already include this buyer.
//
// Offers and purchases are the same rows dispo reads (`offers`, `deals.buyer_id`),
// so the two screens stay in step without a second table.

import { logActivity } from './crm-write';
import type { DispoCampaignRow } from './database.types';
import { supabase } from './supabase';

export type WriteResult = { ok: boolean; message?: string; id?: number };

const fail = (e: { message: string } | null): WriteResult =>
  e ? { ok: false, message: e.message } : { ok: true };

/** A note on the buyer, same communications stream as texts and emails. */
export async function createBuyerNote(
  workspaceId: number, buyerId: number, body: string, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const text = body.trim();
  if (!text) return { ok: false, message: 'Type a note first.' };
  const { data, error } = await supabase.from('communications').insert({
    workspace_id: workspaceId, seller_id: null, buyer_id: buyerId,
    channel: 'note', direction: 'outbound', body: text,
    occurred_at: new Date().toISOString(), source: 'clozr',
    source_id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
  }).select('id').single();
  if (error) return fail(error);
  await logActivity(workspaceId, 'buyer', buyerId, 'note', 'Note added', text.slice(0, 240), userId);
  return { ok: true, id: data.id };
}

/**
 * The terms a buyer attaches to an offer. Same keys the seller offer letter
 * uses on `offers.terms` (emd, close_days), plus the contingency, so the dispo
 * offer desk can show them instead of a dash.
 */
export type BuyerOfferTerms = {
  emd?: number | null; close_days?: number | null; contingency?: string | null;
  /** Option period the buyer wants, in days; 0 is none (a qualified sale has none). */
  option_days?: number | null;
  /** The buyer's closing date, YYYY-MM-DD (checked against the AB contract's). */
  close_on?: string | null;
};

/** Proof of funds for an offer (migration 235): a link or an uploaded file, and whether someone checked it. */
export type OfferPof = { url?: string | null; path?: string | null; verified?: boolean };

/** The SOP's rule: no offer is logged without proof of funds. */
export const pofProblem = (pof: OfferPof | null | undefined): string | null =>
  pof && ((pof.url ?? '').trim() || (pof.path ?? '').trim()) ? null : 'Proof of funds is required. Paste a link or attach the file';

/** An inbound offer from this buyer on a deal — the same row the dispo offer board reads. */
export async function createBuyerOffer(
  workspaceId: number,
  opts: { buyerId: number; dealId: number; amount: number; notes?: string | null; terms?: BuyerOfferTerms | null; pof: OfferPof | null; userId: string | null },
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) return { ok: false, message: 'Enter an offer amount.' };
  const noPof = pofProblem(opts.pof);
  if (noPof) return { ok: false, message: noPof };
  const { data: deal } = await supabase.from('deals').select('seller_id').eq('id', opts.dealId).eq('workspace_id', workspaceId).maybeSingle();
  const { data, error } = await supabase.from('offers').insert({
    workspace_id: workspaceId,
    buyer_id: opts.buyerId,
    deal_id: opts.dealId,
    seller_id: deal?.seller_id ?? null,
    direction: 'inbound',
    amount: opts.amount,
    status: 'Submitted',
    notes: opts.notes?.trim() || null,
    // Only the terms someone actually filled in; an empty object reads as "none given".
    terms: opts.terms ? Object.fromEntries(Object.entries(opts.terms).filter(([, v]) => v != null && v !== '')) : null,
    sent_at: new Date().toISOString(),
    created_by: opts.userId,
    pof_url: opts.pof?.url?.trim() || null,
    pof_path: opts.pof?.path?.trim() || null,
    pof_verified: !!opts.pof?.verified,
  } as never).select('id').single();
  if (error) return fail(error);
  await logActivity(workspaceId, 'buyer', opts.buyerId, 'offer', `Offer ${money(opts.amount)} submitted`, opts.notes ?? undefined, opts.userId);
  await logActivity(workspaceId, 'deal', opts.dealId, 'offer', `Buyer offer ${money(opts.amount)}`, opts.notes ?? undefined, opts.userId);
  return { ok: true, id: data.id };
}

/** Point a deal at this buyer — that is how purchases and assigned deals stay in sync with dispo. */
export async function attachBuyerToDeal(
  workspaceId: number, buyerId: number, dealId: number, userId: string | null,
): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data: deal, error: readErr } = await supabase.from('deals')
    .select('id, stage, seller_id').eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
  if (readErr) return fail(readErr);
  if (!deal) return { ok: false, message: 'That deal is not on this workspace.' };
  const { error } = await supabase.from('deals').update({ buyer_id: buyerId }).eq('id', dealId).eq('workspace_id', workspaceId);
  if (error) return fail(error);
  const closed = /closed/i.test(deal.stage);
  await logActivity(workspaceId, 'buyer', buyerId, closed ? 'purchase' : 'deal',
    closed ? 'Purchase attached from a deal' : 'Assigned to a deal', deal.stage, userId);
  await logActivity(workspaceId, 'deal', dealId, 'buyer', 'Buyer attached from the buyer record', undefined, userId);
  return { ok: true, id: dealId };
}

export type BuyerCampaignRow = {
  id: number; name: string; status: string; deal_id: number; recipient_status: string; started: string | null;
};

/** Campaigns that already have this buyer on the list. */
export async function listBuyerCampaigns(workspaceId: number, buyerId: number): Promise<BuyerCampaignRow[]> {
  if (!supabase) return [];
  const { data: recips } = await supabase.from('dispo_campaign_recipients')
    .select('id, status, campaign_id, deal_id')
    .eq('buyer_id', buyerId)
    .order('id', { ascending: false })
    .limit(80);
  const ids = Array.from(new Set((recips ?? []).map((r) => r.campaign_id).filter((n): n is number => Number.isFinite(n))));
  if (!ids.length) return [];
  const { data: camps } = await supabase.from('dispo_campaigns')
    .select('id, status, deal_id, starts_at')
    .eq('workspace_id', workspaceId)
    .in('id', ids);
  const byId = new Map((camps ?? []).map((c) => [c.id, c as Pick<DispoCampaignRow, 'id' | 'status' | 'deal_id' | 'starts_at'>]));
  const dealIds = Array.from(new Set((camps ?? []).map((c) => c.deal_id).filter(Boolean)));
  const { data: deals } = dealIds.length
    ? await supabase.from('deals').select('id, properties(line1)').in('id', dealIds)
    : { data: [] };
  const addr = new Map<number, string>();
  for (const d of deals ?? []) {
    const p = (d as { id: number; properties?: { line1?: string } | { line1?: string }[] | null }).properties;
    const line = Array.isArray(p) ? p[0]?.line1 : p?.line1;
    addr.set(d.id, line || `Deal ${d.id}`);
  }
  return (recips ?? []).flatMap((r) => {
    const c = byId.get(r.campaign_id);
    if (!c) return [];
    return [{
      id: c.id, name: addr.get(c.deal_id) || `Campaign ${c.id}`, status: c.status,
      deal_id: c.deal_id, recipient_status: r.status, started: c.starts_at,
    }];
  });
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
