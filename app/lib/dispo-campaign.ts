// Dispo campaigns from the browser's side: what the builder reads, the AI
// intros, launch, results, and the "send due texts now" fallback.
//
// The rules (levels, probability, facts, fallbacks, splitting, timing) live in
// supabase/functions/_shared/dispo-rules.ts, shared with the edge functions.
// Sending on a schedule is server-side (migration 53 + dispo-campaign-tick).

import { BULK_BUYER_SOURCE } from './prospect-lists';
import { BLACKLIST_MESSAGE, loadBlocked, type BlacklistDb } from './blacklist';
import { supabase } from './supabase';
import { talkr, TalkrError, toE164 } from './talkr';
import type {
  BuyerAutomationRuleRow, DispoCampaignRow, DispoMessageRow, DispoRecipientRow, Json,
} from './database.types';
import {
  type BuyerFacts, type BuyerStats, type ClosedDealRow, type DealFacts, type GeniusRunRow, type PurchaseSource,
  buyerFacts, purchasesFor,
} from '../supabase/functions/_shared/dispo-rules';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const NO_DB = { ok: false as const, message: 'Campaigns run on a signed-in workspace.' };
const PAGE = 1000;

// ---- hand-off from the Buyers bulk bar and the Matches tab ---------------------
const prefillKey = (dealId: number) => `clozr:campaign:${dealId}`;

/** Remember buyers to include when this deal's builder next opens. */
export function prefillCampaign(dealId: number, buyerIds: number[]): void {
  try {
    const have = takePrefill(dealId, false);
    sessionStorage.setItem(prefillKey(dealId), JSON.stringify(Array.from(new Set([...have, ...buyerIds]))));
  } catch { /* storage blocked: the builder just opens without them */ }
}
export function takePrefill(dealId: number, clear = true): number[] {
  try {
    const raw = sessionStorage.getItem(prefillKey(dealId));
    if (clear) sessionStorage.removeItem(prefillKey(dealId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
  } catch { return []; }
}

// ---- what the builder reads ------------------------------------------------------
export type CampaignBuyer = {
  id: number; name: string; company: string | null; phone: string | null; email: string | null;
  status: string; vip: boolean; vetted: boolean; blacklisted: boolean; preferredChannel: string; wantsFollowUps: boolean;
  tags: string[]; markets: string[]; strategies: string[]; priceMin: number | null; priceMax: number | null;
  cities: string[]; zips: string[]; buyerType: string | null; notes: string | null; source: string | null; lastActivityAt: string | null;
  /** An AI agent is working this buyer (active or paused): campaigns leave them out (migration 185). */
  onAgent?: boolean;
};
export type MatchLite = { deal_id: number; buyer_id: number; score: number; reasons: string[]; status: string; sent_at: string | null; replied_at: string | null; updated_at: string };

export type CampaignData = {
  deal: DealFacts & { id: number; price: number | null; updatedAt: string; sellerId: number | null };
  buyers: CampaignBuyer[];
  matches: MatchLite[];
  offers: { buyer_id: number; deal_id: number | null; amount: number | null; sent_at: string }[];
  closed: ClosedDealRow[];
  runs: GeniusRunRow[];
  inbound: { buyer_id: number; occurred_at: string }[];
  photos: { id: number; name: string; url: string }[];
  templates: { id: number; name: string; channel: 'sms' | 'email'; category: string | null; subject: string | null; body_text: string; body_html: string | null }[];
  gmail: { id: number; email: string; user_id: string }[];
};

/**
 * Every row, a page at a time: the first page alone, then four pages at once
 * while pages keep coming back full (15,000 buyers was fifteen requests one
 * after another). Rows stay in order.
 */
async function all<T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0, wave = 1; ; wave = 4) {
    const pages = await Promise.all(Array.from({ length: wave }, (_, i) => make().range(from + i * PAGE, from + (i + 1) * PAGE - 1)));
    for (const r of pages) {
      if (r.error) throw new Error(r.error.message);
      rows.push(...(r.data ?? []));
      if ((r.data ?? []).length < PAGE) return rows;
    }
    from += wave * PAGE;
  }
}

/**
 * One read per deal at a time: the builder and the quick campaign opening
 * together share it. Nothing is kept once it lands, so a buyer blacklisted a
 * moment ago is never planned from a stale copy.
 */
const campaignCache = new Map<string, { at: number; p: Promise<Result<CampaignData>> }>();
/** Drop the cached builder data (after a launch, or when the deal's buyers change). */
export function forgetCampaignData(dealId?: number) {
  for (const k of campaignCache.keys()) if (dealId == null || k.endsWith(':' + dealId)) campaignCache.delete(k);
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function loadCampaignData(workspaceId: number, dealId: number): Promise<Result<CampaignData>> {
  const key = `${workspaceId}:${dealId}`;
  const hit = campaignCache.get(key);
  if (hit) return hit.p;
  const p = readCampaignData(workspaceId, dealId).finally(() => { if (campaignCache.get(key)?.p === p) campaignCache.delete(key); });
  campaignCache.set(key, { at: Date.now(), p });
  return p;
}

async function readCampaignData(workspaceId: number, dealId: number): Promise<Result<CampaignData>> {
  if (!supabase) return NO_DB;
  const sb = supabase;
  try {
    const { data: d, error } = await sb.from('deals').select('id, seller_id, property_id, marketed_price, sold_price, offer_amount, assignment_fee, updated_at').eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle();
    if (error || !d) return { ok: false, message: error?.message ?? 'Deal not found.' };
    const [propR, buyers, matches, offers, closedRaw, runsR, inbound, photosR, templatesR, gmailR, agentsR] = await Promise.all([
      d.property_id ? sb.from('properties').select('line1, city, zip, lat, lng, sqft, beds, baths, property_type').eq('id', d.property_id).maybeSingle() : Promise.resolve({ data: null }),
      all<Any>(() => sb.from('buyers').select('id, name, company, phone, email, status, vip, vetted_at, blacklisted_at, preferred_channel, wants_follow_ups, tags, markets, criteria, buyer_type, notes, source, last_activity_at').eq('workspace_id', workspaceId).isDistinct('source', BULK_BUYER_SOURCE).order('id')),
      all<MatchLite>(() => sb.from('deal_buyer_matches').select('deal_id, buyer_id, score, reasons, status, sent_at, replied_at, updated_at').eq('workspace_id', workspaceId).order('id')),
      all<Any>(() => sb.from('offers').select('buyer_id, deal_id, amount, sent_at').eq('workspace_id', workspaceId).eq('direction', 'inbound').not('buyer_id', 'is', null).order('id')),
      all<Any>(() => sb.from('deals').select('buyer_id, closed_on, stage, property_id').eq('workspace_id', workspaceId).not('buyer_id', 'is', null).order('id')),
      sb.from('discover_runs').select('deal_id, candidates').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(20),
      all<Any>(() => sb.from('communications').select('buyer_id, occurred_at').eq('workspace_id', workspaceId).eq('direction', 'inbound').not('buyer_id', 'is', null).order('id')),
      sb.from('deal_files').select('id, name, url, source').eq('deal_id', dealId).eq('kind', 'photo').not('url', 'is', null).order('id'),
      sb.from('message_templates').select('id, name, channel, category, subject, body_text, body_html').eq('workspace_id', workspaceId).is('archived_at', null).in('audience', ['buyer', 'general']).order('name'),
      sb.from('google_accounts').select('id, email, user_id, status, gmail_send').eq('workspace_id', workspaceId),
      // Buyers an AI agent is working: one thing reaches a buyer at a time (migration 185).
      all<Any>(() => sb.from('ai_agent_enrollments' as never).select('record_id').eq('workspace_id', workspaceId).eq('record_kind', 'buyer').in('status', ['active', 'paused']).order('id')),
    ]);
    const onAgent = new Set((agentsR as Any[]).map((x) => Number(x.record_id)));
    const closedDeals = (closedRaw as Any[]).filter((x) => x.closed_on || x.stage === 'Closed');
    const propIds = Array.from(new Set(closedDeals.map((x) => x.property_id).filter(Boolean)));
    const props = propIds.length ? ((await sb.from('properties').select('id, line1, city, zip, lat, lng, sqft').in('id', propIds)).data ?? []) : [];
    const pById = new Map((props as Any[]).map((p) => [p.id, p]));
    const p = (propR as { data: Any | null }).data;
    return {
      ok: true,
      data: {
        deal: {
          id: d.id, sellerId: d.seller_id, updatedAt: d.updated_at,
          price: d.marketed_price ?? d.sold_price ?? (d.offer_amount != null ? d.offer_amount + (d.assignment_fee ?? 0) : null),
          address: p?.line1 ?? '', city: p?.city ?? null, zip: p?.zip ?? null, lat: p?.lat ?? null, lng: p?.lng ?? null,
          sqft: p?.sqft ?? null, beds: p?.beds ?? null, baths: p?.baths ?? null, propertyType: p?.property_type ?? null,
        },
        buyers: (buyers as Any[]).map((b) => ({ ...toCampaignBuyer(b), onAgent: onAgent.has(Number(b.id)) })),
        matches: matches as MatchLite[],
        offers: offers as CampaignData['offers'],
        closed: closedDeals.map((x) => { const pp = pById.get(x.property_id) as Any | undefined; return { buyer_id: x.buyer_id, closed_on: x.closed_on, line1: pp?.line1 ?? null, city: pp?.city ?? null, zip: pp?.zip ?? null, lat: pp?.lat ?? null, lng: pp?.lng ?? null, sqft: pp?.sqft ?? null }; }),
        runs: ((runsR as { data: Any[] | null }).data ?? []) as GeniusRunRow[],
        inbound: inbound as CampaignData['inbound'],
        photos: (((photosR as { data: Any[] | null }).data ?? []) as Any[])
          .filter((x) => /^https:\/\//.test(x.url) && !/\/storage\/v1\/object\/(?:sign|authenticated)\//i.test(x.url))
          .sort((a, b) => Number(b.source === 'compr') - Number(a.source === 'compr'))
          .map((x) => ({ id: x.id, name: x.name, url: x.url })),
        templates: ((templatesR as { data: Any[] | null }).data ?? []) as CampaignData['templates'],
        gmail: (((gmailR as { data: Any[] | null }).data ?? []) as Any[]).filter((a) => a.status === 'active' && a.gmail_send).map((a) => ({ id: a.id, email: a.email, user_id: a.user_id })),
      },
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** A buyers row (or a search_free_agent_buyers row) as the builder reads it. */
function toCampaignBuyer(b: Any): CampaignBuyer {
  const c = (b.criteria ?? {}) as Any;
  const prefs = Array.isArray(c.location_prefs) ? (c.location_prefs as Any[]).filter((x) => !x.restricted) : [];
  return {
    id: b.id, name: b.name, company: b.company, phone: b.phone, email: b.email, status: b.status ?? 'Active',
    vip: !!b.vip, vetted: !!b.vetted_at, blacklisted: !!b.blacklisted_at, preferredChannel: b.preferred_channel ?? 'email_and_sms',
    wantsFollowUps: b.wants_follow_ups !== false, tags: b.tags ?? [], markets: b.markets ?? [],
    strategies: Array.isArray(c.strategies) ? c.strategies : [], priceMin: c.price?.min ?? null, priceMax: c.price?.max ?? null,
    cities: [...prefs.filter((x) => x.type === 'city').map((x) => String(x.name)), ...(c.locations?.cities ?? [])],
    zips: [...prefs.filter((x) => x.type === 'zip').map((x) => String(x.name)), ...(c.locations?.zips ?? [])],
    buyerType: b.buyer_type, notes: b.notes, source: b.source, lastActivityAt: b.last_activity_at,
  };
}

// ---- realtors as a segment of a push -----------------------------------------------
/** Tagged `realtors`, or buyer_type realtor(s): the Buyers › Realtors list. */
export const isRealtor = (b: Pick<CampaignBuyer, 'tags' | 'buyerType'>) =>
  /^realtors?$/i.test((b.buyerType ?? '').trim()) || b.tags.some((t) => /^realtors?$/i.test(t.trim()));

/** Works the deal's city or zip, by market, city preference or zip. */
export function realtorInMarket(b: Pick<CampaignBuyer, 'markets' | 'cities' | 'zips'>, deal: Pick<DealFacts, 'city' | 'zip'>): boolean {
  const city = (deal.city ?? '').trim().toLowerCase();
  const zip = (deal.zip ?? '').trim();
  if (city && [...b.markets, ...b.cities].some((m) => m.toLowerCase().includes(city))) return true;
  return !!zip && b.zips.some((z) => z.trim() === zip);
}

/** How many free-agent realtors one push reads at most. Pages of 100 through search_free_agent_buyers (migration 96). */
export const REALTOR_CAP = 500;

/**
 * Realtors who work this deal's market: the workspace's own Realtors list
 * (already in `data.buyers`) plus the free-agent corpus, which the shell never
 * loads, searched by the deal's city. The corpus is capped at REALTOR_CAP.
 */
export async function loadMarketRealtors(
  workspaceId: number, data: CampaignData,
): Promise<Result<{ realtors: CampaignBuyer[]; corpusTotal: number; capped: boolean }>> {
  const own = data.buyers.filter((b) => isRealtor(b) && realtorInMarket(b, data.deal));
  const city = (data.deal.city ?? '').trim();
  if (!supabase || !city) return { ok: true, data: { realtors: own, corpusTotal: 0, capped: false } };
  const seen = new Set(own.map((b) => b.id));
  const found: CampaignBuyer[] = [];
  let total = 0;
  for (let offset = 0; offset < REALTOR_CAP; offset += 100) {
    const { data: page, error } = await supabase.rpc('search_free_agent_buyers', { p_workspace_id: workspaceId, p_q: city, p_limit: 100, p_offset: offset });
    if (error) {
      if (!offset) return { ok: false, message: `Could not search the realtor list: ${error.message}` };
      break;
    }
    const payload = (page && typeof page === 'object' && !Array.isArray(page) ? page : {}) as { total?: number; rows?: unknown };
    const rows = Array.isArray(payload.rows) ? (payload.rows as Any[]) : [];
    total = Number(payload.total ?? 0);
    for (const r of rows) {
      const b = toCampaignBuyer({ ...r, buyer_type: r.buyer_type ?? 'realtors' });
      if (!seen.has(b.id) && realtorInMarket(b, data.deal)) { seen.add(b.id); found.push(b); }
    }
    if (rows.length < 100) break;
  }
  return { ok: true, data: { realtors: [...own, ...found], corpusTotal: total, capped: total > REALTOR_CAP } };
}

/**
 * Buyers handed to the builder (Buyers › Build campaign) that its pool does not
 * hold: realtors lassoed on the map come from the free-agent corpus, which the
 * pool leaves out. Read by id, 200 to a request, at most 5,000.
 */
export async function loadCampaignBuyersByIds(workspaceId: number, ids: number[]): Promise<CampaignBuyer[]> {
  if (!supabase || !ids.length) return [];
  const sb = supabase;
  const want = Array.from(new Set(ids)).slice(0, 5000);
  const chunks: number[][] = [];
  for (let i = 0; i < want.length; i += 200) chunks.push(want.slice(i, i + 200));
  const pages = await Promise.all(chunks.map((c) => sb.from('buyers')
    .select('id, name, company, phone, email, status, vip, vetted_at, blacklisted_at, preferred_channel, wants_follow_ups, tags, markets, criteria, buyer_type, notes, source, last_activity_at')
    .eq('workspace_id', workspaceId).in('id', c)));
  return pages.flatMap((r) => (r.data ?? []) as Any[]).map((r) => toCampaignBuyer(r.source === BULK_BUYER_SOURCE ? { ...r, buyer_type: r.buyer_type ?? 'realtors' } : r));
}

/** A buyer's stats, purchases and facts for this deal, from the loaded rows. */
/** Matches, offers and closings by buyer, built once per load: profileOf ran three full scans per buyer. */
type ByBuyer = { matches: Map<number, MatchLite[]>; offered: Map<number, Set<number>>; closed: Map<number, number> };
const byBuyerCache = new WeakMap<CampaignData, ByBuyer>();
function byBuyer(data: CampaignData): ByBuyer {
  const hit = byBuyerCache.get(data);
  if (hit) return hit;
  const idx: ByBuyer = { matches: new Map(), offered: new Map(), closed: new Map() };
  for (const m of data.matches) { const l = idx.matches.get(m.buyer_id); if (l) l.push(m); else idx.matches.set(m.buyer_id, [m]); }
  for (const o of data.offers) if (o.deal_id != null) { const s = idx.offered.get(o.buyer_id) ?? new Set<number>(); s.add(o.deal_id); idx.offered.set(o.buyer_id, s); }
  for (const c of data.closed) idx.closed.set(c.buyer_id, (idx.closed.get(c.buyer_id) ?? 0) + 1);
  byBuyerCache.set(data, idx);
  return idx;
}

export function profileOf(b: CampaignBuyer, data: CampaignData, now = new Date()): { stats: BuyerStats; purchases: PurchaseSource[]; facts: BuyerFacts; lastSentThisDeal: string | null; match: MatchLite | null } {
  const idx = byBuyer(data);
  const mine = idx.matches.get(b.id) ?? [];
  const sent = mine.filter((m) => m.sent_at);
  const offeredDeals = idx.offered.get(b.id) ?? new Set<number>();
  const purchases = purchasesFor({ id: b.id, name: b.name, company: b.company, notes: b.notes, source: b.source }, data.closed, data.runs, data.deal.id);
  const match = mine.find((m) => m.deal_id === data.deal.id) ?? null;
  return {
    stats: {
      dealsSent: sent.length, dealsReplied: sent.filter((m) => m.replied_at).length, dealsOffered: offeredDeals.size,
      closed: idx.closed.get(b.id) ?? 0, purchases: purchases.length,
      vip: b.vip, vetted: b.vetted, score: match?.score ?? null,
    },
    purchases,
    facts: buyerFacts({ name: b.name, strategies: b.strategies, buyerType: b.buyerType }, purchases, data.deal, now),
    lastSentThisDeal: match?.sent_at ?? null,
    match,
  };
}

// ---- AI ------------------------------------------------------------------------------
export type AiOptions = { tone: string; emoji: 'never' | 'sometimes' | 'frequently'; instructions: string; avoid: string[] };
export type AiResult = { buyer_id: number; text: string | null; reason?: string };

async function invokeError(error: { message: string }): Promise<string> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx) return ((await ctx.json()) as { error?: string }).error ?? error.message;
  } catch { /* keep the transport message */ }
  return error.message;
}

/** Personalized texts, 20 buyers per call. `onProgress` gets the running count. */
export async function writeWithAi(
  workspaceId: number, dealId: number, buyerIds: number[], kind: 'intro' | 'followup', options: AiOptions,
  templates: Record<number, string> = {}, onProgress?: (done: number) => void,
): Promise<Result<AiResult[]>> {
  if (!supabase) return NO_DB;
  const out: AiResult[] = [];
  for (let i = 0; i < buyerIds.length; i += 20) {
    const ids = buyerIds.slice(i, i + 20);
    const { data, error } = await supabase.functions.invoke('dispo-intro', {
      body: { workspace_id: workspaceId, deal_id: dealId, buyer_ids: ids, kind, options, templates: Object.fromEntries(ids.filter((id) => templates[id]).map((id) => [id, templates[id]])) },
    });
    if (error) return out.length ? { ok: true, data: out.concat(ids.map((id) => ({ buyer_id: id, text: null, reason: 'AI unavailable' }))) } : { ok: false, message: await invokeError(error) };
    out.push(...(((data as { results?: AiResult[] })?.results) ?? []));
    onProgress?.(out.length);
  }
  return { ok: true, data: out };
}

// ---- launch -------------------------------------------------------------------------
export type PlannedMessage = {
  /** rvm and ai_call: migration 192, sent by the tick as a voicemail drop and an AI agent call. */
  channel: 'sms' | 'email' | 'rvm' | 'ai_call'; kind: 'intro' | 'brief' | 'followup'; seq: number;
  subject: string | null; body: string; body_html: string | null; media_urls: string[]; send_at: string; only_if_no_reply: boolean;
};
export type PlannedRecipient = { buyer_id: number; level: number; probability: number | null; messages: PlannedMessage[] };

export async function launchCampaign(
  workspaceId: number, dealId: number, settings: Json,
  delivery: { from_phone_number_id: string | null; from_phone: string | null; email_account_id: number | null; from_name: string | null; timezone: string; starts_at: string; email_provider?: 'resend' | 'gmail'; email_sender_id?: number | null },
  recipients: PlannedRecipient[],
): Promise<Result<number>> {
  forgetCampaignData(dealId);
  if (!supabase) return NO_DB;
  const { data, error } = await supabase.rpc('dispo_campaign_launch', {
    p_workspace_id: workspaceId, p_deal_id: dealId, p_settings: settings, p_delivery: delivery as unknown as Json, p_recipients: recipients as unknown as Json,
  });
  return error ? { ok: false, message: error.message } : { ok: true, data: Number(data) };
}

// ---- results --------------------------------------------------------------------------
export type CampaignResults = { campaigns: DispoCampaignRow[]; recipients: DispoRecipientRow[]; messages: (Pick<DispoMessageRow, 'id' | 'campaign_id' | 'recipient_id' | 'buyer_id' | 'channel' | 'kind' | 'status' | 'send_at' | 'sent_at' | 'last_error' | 'body' | 'media_urls'> & { subject?: string | null; communication_id?: number | null; /** The address an email went out from (its communications row). */ from_email?: string | null })[]; offers: number };

export async function loadResults(workspaceId: number, dealId: number): Promise<Result<CampaignResults>> {
  if (!supabase) return NO_DB;
  const sb = supabase;
  try {
    const campaigns = (await sb.from('dispo_campaigns').select('*').eq('workspace_id', workspaceId).eq('deal_id', dealId).order('created_at', { ascending: false })).data ?? [];
    if (!campaigns.length) return { ok: true, data: { campaigns: [], recipients: [], messages: [], offers: 0 } };
    const ids = campaigns.map((c) => c.id);
    const recipients = await all<DispoRecipientRow>(() => sb.from('dispo_campaign_recipients').select('*').in('campaign_id', ids).order('id'));
    const messages = await all<CampaignResults['messages'][number]>(() => sb.from('dispo_campaign_messages').select('id, campaign_id, recipient_id, buyer_id, channel, kind, status, send_at, sent_at, last_error, subject, body, media_urls, communication_id').in('campaign_id', ids).order('id'));
    // Which address each email went out from, for the per-address results.
    const commIds = messages.filter((m) => m.channel === 'email' && m.communication_id).map((m) => m.communication_id!);
    if (commIds.length) {
      const fromById = new Map<number, string | null>();
      for (let i = 0; i < commIds.length; i += 200) {
        const { data } = await sb.from('communications').select('id, from_email').in('id', commIds.slice(i, i + 200));
        for (const c of (data ?? []) as { id: number; from_email: string | null }[]) fromById.set(c.id, c.from_email);
      }
      for (const m of messages) if (m.communication_id) m.from_email = fromById.get(m.communication_id) ?? null;
    }
    // Offers from anyone the campaigns reached. The deal's offers are few, so
    // read them all and count here: an `in` list stopped at 500 recipients.
    const reached = new Set(recipients.map((r) => r.buyer_id));
    const dealOffers = reached.size
      ? await all<{ buyer_id: number | null }>(() => sb.from('offers').select('buyer_id').eq('deal_id', dealId).eq('direction', 'inbound').not('buyer_id', 'is', null).order('id'))
      : [];
    const count = dealOffers.filter((o) => o.buyer_id != null && reached.has(o.buyer_id)).length;
    return { ok: true, data: { campaigns: campaigns as DispoCampaignRow[], recipients, messages, offers: count } };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function setCampaignStatus(id: number, status: DispoCampaignRow['status']): Promise<Result<null>> {
  if (!supabase) return NO_DB;
  const { error } = await supabase.from('dispo_campaigns').update({ status }).eq('id', id);
  if (!error && status === 'cancelled') await supabase.from('dispo_campaign_messages').update({ status: 'cancelled', last_error: 'campaign cancelled' }).eq('campaign_id', id).eq('status', 'queued');
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

/** A rep's read of a buyer on this deal: interested / not interested (the match status the automations read). */
export async function markInterest(dealId: number, buyerId: number, recipientId: number | null, interested: boolean): Promise<Result<null>> {
  if (!supabase) return NO_DB;
  const { error } = await supabase.from('deal_buyer_matches').update({ status: interested ? 'interested' : 'not_interested' }).eq('deal_id', dealId).eq('buyer_id', buyerId);
  if (error) return { ok: false, message: error.message };
  if (recipientId) {
    await supabase.from('dispo_campaign_recipients').update({ status: interested ? 'interested' : 'not_interested' }).eq('id', recipientId);
    await supabase.from('dispo_campaign_messages').update({ status: 'cancelled', last_error: interested ? 'marked interested' : 'marked not interested' }).eq('recipient_id', recipientId).eq('kind', 'followup').eq('status', 'queued');
  }
  return { ok: true, data: null };
}

/**
 * The fallback when server texting is not configured: send this campaign's
 * due texts from this browser, as the signed-in rep. Same claim (queued →
 * sending) as the server, so the two can never double-send.
 */
export async function sendDueTexts(workspaceId: number, campaign: DispoCampaignRow): Promise<Result<{ sent: number; failed: string[] }>> {
  if (!supabase) return NO_DB;
  const sb = supabase;
  const { data: due } = await sb.from('dispo_campaign_messages').select('id, recipient_id, buyer_id, body, media_urls, only_if_no_reply')
    .eq('campaign_id', campaign.id).eq('channel', 'sms').eq('status', 'queued').lte('send_at', new Date().toISOString()).order('send_at').limit(200);
  let sent = 0; const failed: string[] = [];
  for (const m of due ?? []) {
    const { data: r } = await sb.from('dispo_campaign_recipients').select('id, phone, status, replied_at, offered_at').eq('id', m.recipient_id).maybeSingle();
    const claim = await sb.from('dispo_campaign_messages').update({ status: 'sending' }).eq('id', m.id).eq('status', 'queued').select('id');
    if (!claim.data?.length) continue;
    if (!r || ['opted_out', 'stopped'].includes(r.status) || (m.only_if_no_reply && (r.replied_at || r.offered_at || r.status !== 'active'))) {
      await sb.from('dispo_campaign_messages').update({ status: 'skipped', last_error: 'buyer replied, offered or opted out' }).eq('id', m.id);
      continue;
    }
    const gate = await loadBlocked(sb as unknown as BlacklistDb, { buyerIds: [m.buyer_id] });
    if (!gate.ok) { await sb.from('dispo_campaign_messages').update({ status: 'queued', last_error: gate.message }).eq('id', m.id); failed.push(gate.message); continue; }
    if (m.buyer_id != null && gate.blocked.buyers.has(m.buyer_id)) { await sb.from('dispo_campaign_messages').update({ status: 'skipped', last_error: BLACKLIST_MESSAGE }).eq('id', m.id); continue; }
    const to = toE164(r.phone);
    if (!to) { await sb.from('dispo_campaign_messages').update({ status: 'failed', last_error: 'no textable number' }).eq('id', m.id); continue; }
    try {
      const res = await talkr.sendMessage({ to_number: to, body: m.body, ...(m.media_urls?.length ? { media_urls: m.media_urls } : {}), ...(campaign.from_phone_number_id ? { from_phone_number_id: campaign.from_phone_number_id } : {}) });
      const { data: comm } = await sb.from('communications').upsert({
        workspace_id: workspaceId, buyer_id: m.buyer_id, channel: 'sms', direction: 'outbound', occurred_at: new Date().toISOString(),
        to_phone: to, body: m.body, status: res.message.status || 'queued', source: 'talkr', source_id: 'msg:' + res.message.id,
      }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
      await sb.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: res.message.id, p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: res.conversation_id });
      sent++;
    } catch (err) {
      const code = err instanceof TalkrError ? err.code : '';
      const back = code === 'quiet_hours' || code === 'unreachable';
      await sb.from('dispo_campaign_messages').update({ status: back ? 'queued' : code === 'suppressed' ? 'skipped' : 'failed', last_error: (err as Error).message }).eq('id', m.id);
      failed.push((err as Error).message);
      if (back) break;
    }
  }
  return { ok: true, data: { sent, failed } };
}

// ---- buyer automations ------------------------------------------------------------------
export type RuleKey = BuyerAutomationRuleRow['rule'];
export const RULES: { rule: RuleKey; label: (n: number, pct: number) => string; n: number; pct?: number; tag: string; unit: string }[] = [
  { rule: 'no_response', label: (n) => `Not responded to the last ${n} deals sent`, n: 3, tag: 'unresponsive', unit: 'deals' },
  { rule: 'not_interested', label: (n) => `Not interested in the last ${n} deals sent`, n: 3, tag: 'not-interested', unit: 'deals' },
  { rule: 'not_sent', label: (n) => `Not sent a deal in the last ${n} days`, n: 30, tag: 'not-sent-recently', unit: 'days' },
  { rule: 'active_again', label: (n) => `${n} days from being an active buyer again`, n: 7, tag: 'active-again-soon', unit: 'days' },
  { rule: 'no_status', label: (n) => `Responding but no buyer status for the last ${n} deals`, n: 3, tag: 'needs-status', unit: 'deals' },
  { rule: 'lowball', label: (n, pct) => `Offered ≤ ${pct}% of asking on ${n} offers in a row`, n: 3, pct: 80, tag: 'lowballer', unit: 'offers' },
];

export async function loadRules(workspaceId: number): Promise<Result<BuyerAutomationRuleRow[]>> {
  if (!supabase) return NO_DB;
  const { data, error } = await supabase.from('buyer_automation_rules').select('*').eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true, data: (data ?? []) as BuyerAutomationRuleRow[] };
}

export async function saveRule(workspaceId: number, r: Pick<BuyerAutomationRuleRow, 'rule' | 'enabled' | 'n' | 'pct' | 'tag' | 'remove_when_false'>): Promise<Result<null>> {
  if (!supabase) return NO_DB;
  const { error } = await supabase.from('buyer_automation_rules').upsert({ workspace_id: workspaceId, ...r }, { onConflict: 'workspace_id,rule' });
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export async function runRules(workspaceId: number): Promise<Result<number>> {
  if (!supabase) return NO_DB;
  const { data, error } = await supabase.rpc('buyer_automations_apply', { p_workspace_id: workspaceId });
  return error ? { ok: false, message: error.message } : { ok: true, data: Number(data ?? 0) };
}
