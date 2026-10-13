// Offers: one call turns the underwriting into a number, an offers row, and
// the Acme Homes offer letter filled from the record — rendered, stored as a
// PDF and handed to the seller as their own signing link. Pricing rules and
// which template to fill live in workspace settings (Settings → Contracts and
// offers). PandaDoc is opt-in and needs an API key on the project.

import type { Offer } from './database.types';
import { supabase } from './supabase';
import { type ContractRow, type SignerLink, alsoByGmail } from './contracts';
import { type SendContext, type SendOutcome, textOne } from './sms';

export type OfferResult =
  | { ok: true; offer: Offer; contract: ContractRow | null; signers: SignerLink[]; emailed: number; amount: number; basis: string; note: string | null; provider: 'clozr' | 'pandadoc' | null; texted: SendOutcome | null }
  | { ok: false; message: string };

async function call<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await supabase.functions.invoke('offers', { body: { origin, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ok: true, data: data as T };
}

/** What the workspace rule would offer right now, without creating anything. */
export const priceOffer = (workspaceId: number, sellerId: number) =>
  call<{ amount: number | null; basis: string; deal: { arv: number | null; rehab: number | null; mao: number | null; offer_amount: number | null } | null }>({ workspace_id: workspaceId, action: 'price', seller_id: sellerId });

type Generated = {
  offer: Offer; contract: ContractRow | null; signers: SignerLink[]; emailed: number; amount: number; basis: string;
  /** Why the chosen document was not the one that went (e.g. PandaDoc without a seller email). */
  note: string | null; provider: 'clozr' | 'pandadoc' | null; delivery: { email: boolean; sms: boolean };
  /** The seller's signing link, when the offer was sent and Settings → Offers texts it. */
  sms_link: string | null; seller: { name: string; phone: string | null; address: string };
};

export async function generateOffer(workspaceId: number, sellerId: number, opts: { amount?: number | null; send?: boolean; message?: string | null; expiresDays?: number | null; textCtx?: SendContext; /** The submission the offer is on (a partner has several). */ dealId?: number | null } = {}): Promise<OfferResult> {
  const r = await call<Generated>({
    workspace_id: workspaceId, action: 'generate', seller_id: sellerId, deal_id: opts.dealId ?? null, amount: opts.amount ?? null, send: opts.send, message: opts.message ?? null, expires_days: opts.expiresDays ?? null,
  });
  if (!r.ok) return r;
  const d = r.data;
  // Same as a contract sent by hand: if the offer letter went out, let the
  // sender's own Gmail carry it when one is connected. PandaDoc mails its own.
  // Whether it went is the server's call — `send ?? settings.offers.send ?? false`
  // — and a Draft only told the TC it is ready, so nothing is emailed for it.
  const sent = opts.send ?? d.offer?.status === 'Sent';
  const emailed = d.contract && d.provider !== 'pandadoc' && d.delivery?.email !== false && sent
    ? await alsoByGmail(workspaceId, d.contract.id, opts.message ?? null, d.emailed)
    : d.emailed;
  // The text goes from the browser through Talkr as the rep, like every other
  // text, and lands on the record's timeline.
  const texted = d.sms_link
    ? await textOne(workspaceId, { sellerId, name: d.seller.name, phone: d.seller.phone, address: d.seller.address },
      `Hi {{first_name}}, here is our cash offer of ${offerMoney(d.amount)} for {{address}}. Review and sign here: ${d.sms_link}`, opts.textCtx)
    : null;
  return { ok: true, ...d, emailed, texted };
}

/** Outbound offers on a seller, newest first. */
export async function listSellerOffers(workspaceId: number, sellerId: number): Promise<Offer[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('offers').select('*').eq('workspace_id', workspaceId).eq('seller_id', sellerId).eq('direction', 'outbound').order('created_at', { ascending: false });
  return (data ?? []) as unknown as Offer[];
}

/** One line of a record's offer history: ours (outbound) and their counters (inbound, no buyer). */
export type OfferLine = { id: number; amount: number | null; direction: 'outbound' | 'inbound'; status: string | null; created_at: string; notes: string | null; basis: string | null };

/** Every offer and counter on a seller (or one of its submissions), newest first. */
export async function listRecordOffers(workspaceId: number, sellerId: number, dealId: number | null): Promise<OfferLine[]> {
  if (!supabase) return [];
  let q = supabase.from('offers').select('id,amount,direction,status,created_at,notes,basis')
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId).is('buyer_id', null);
  if (dealId != null) q = q.eq('deal_id', dealId);
  const { data } = await q.order('created_at', { ascending: false }).limit(50);
  return (data ?? []) as unknown as OfferLine[];
}

/**
 * An offer made on the record, logged: the outbound row is the whole write.
 * The database (offers_after_write) puts the amount on the deal as its offer
 * price, lines it on the timeline and moves the record to Offer Made. No
 * letter, no draft, nobody pinged.
 */
export async function logOffer(workspaceId: number, p: { sellerId: number; dealId: number | null; amount: number; basis?: string | null }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Not connected.' };
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.from('offers').insert({
    workspace_id: workspaceId, seller_id: p.sellerId, deal_id: p.dealId, direction: 'outbound', status: 'Sent',
    amount: p.amount, basis: p.basis ?? null, created_by: session?.user?.id ?? null,
  } as never);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Their counter: an inbound offers row on the seller and submission (migration 145 logs it on the timeline). */
export async function logCounter(workspaceId: number, p: { sellerId: number; dealId: number | null; amount: number; notes?: string | null }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Not connected.' };
  const { data: who } = await supabase.auth.getUser();
  const { error } = await supabase.from('offers').insert({
    workspace_id: workspaceId, seller_id: p.sellerId, deal_id: p.dealId, direction: 'inbound', status: 'countered',
    amount: p.amount, notes: p.notes ?? null, created_by: who.user?.id ?? null,
  } as never);
  return error ? { ok: false, message: error.message } : { ok: true };
}

export const offerMoney = (n: number | null | undefined) => (n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'));
