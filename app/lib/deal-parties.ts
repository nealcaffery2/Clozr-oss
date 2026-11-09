// Everyone on a deal (migration 40): seller, buyer, title, photographer,
// wholesaler, agents, TC and reps. A small loader rather than part of the
// shared CRM graph — three cards read it, each for one record.

import { ilikeSafe } from './contact-search';
import { titleRoute } from './deal-close';
import type { DealParty } from './database.types';
import { supabase } from './supabase';

export const PARTY_ROLE_LABEL: Record<string, string> = {
  seller: 'Seller', buyer: 'Buyer', title: 'Title', photographer: 'Photographer', wholesaler: 'Wholesaler',
  listing_agent: 'Listing agent', buyers_agent: "Buyer's agent", realtor: 'Realtor', tc: 'Transaction coordinator',
  acquisitions: 'Acquisitions', dispositions: 'Dispositions', lender: 'Lender', contractor: 'Contractor',
  inspector: 'Inspector', attorney: 'Attorney', second_title: 'Second title', transactional_funder: 'Transactional funder', other: 'Other',
};

/** Roles offered when adding someone, in picker order. Seller and realtor stay readable but aren't offered. */
export const ADDABLE_ROLES: DealParty['role'][] = [
  'acquisitions', 'dispositions', 'tc', 'title', 'buyer', 'wholesaler', 'listing_agent', 'buyers_agent',
  'photographer', 'lender', 'second_title', 'transactional_funder', 'contractor', 'inspector', 'attorney', 'other',
];
const ORDER = Object.keys(PARTY_ROLE_LABEL);

/** Daisy-chain positions (migration 186), owner first. */
export const CHAIN_POSITIONS = [
  { code: 'OOR', label: 'Owner of record' },
  { code: 'W1', label: 'Wholesaler 1' },
  { code: 'W2', label: 'Wholesaler 2' },
  { code: 'W3', label: 'Wholesaler 3' },
] as const;
export type ChainPosition = (typeof CHAIN_POSITIONS)[number]['code'];
const CHAIN_ORDER: string[] = CHAIN_POSITIONS.map((c) => c.code);

/** The people in a chain, owner first: OOR → W1 → W2 → W3. */
export function chainOf<T extends { chain_position?: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.chain_position && CHAIN_ORDER.includes(r.chain_position))
    .sort((a, b) => CHAIN_ORDER.indexOf(a.chain_position!) - CHAIN_ORDER.indexOf(b.chain_position!));
}

/** The deal a seller's team belongs to: the latest past Prospect, else the latest. Null when there is none. */
export async function resolveSellerDeal(sellerId: number): Promise<number | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('deals').select('id, stage').eq('seller_id', sellerId).order('created_at', { ascending: false });
  return (data?.find((d) => d.stage !== 'Prospect') ?? data?.[0])?.id ?? null;
}

export type PartyInput = Pick<DealParty, 'role' | 'user_id' | 'vendor_id' | 'buyer_id' | 'name' | 'company' | 'email' | 'phone' | 'chain_position' | 'is_poc'>
  & Partial<Pick<DealParty, 'seller_id'>>;

/** A vendor's trade to the role they take on a deal, first match wins. */
const TRADE_ROLE: [RegExp, DealParty['role']][] = [
  [/title/i, 'title'], [/attorney|law/i, 'attorney'], [/fund/i, 'transactional_funder'], [/lend/i, 'lender'],
  [/wholesal/i, 'wholesaler'], [/photo|notary/i, 'photographer'], [/inspect/i, 'inspector'], [/contract/i, 'contractor'],
  [/realtor|agent/i, 'listing_agent'], [/seller/i, 'seller'],
];

/**
 * The role someone picked from contacts starts with: a person (seller record)
 * is the Seller, a buyer the Buyer, a vendor by their trade, a teammate by
 * their seat (TC, dispositions, else acquisitions). Editable after.
 */
export function roleForContact(kind: 'seller' | 'buyer' | 'vendor' | 'team', trade?: string | null): DealParty['role'] {
  if (kind === 'seller') return 'seller';
  if (kind === 'buyer') return 'buyer';
  if (kind === 'team') return trade === 'tc' ? 'tc' : trade === 'dispositions' ? 'dispositions' : 'acquisitions';
  return TRADE_ROLE.find(([re]) => re.test(trade ?? ''))?.[1] ?? 'other';
}

/** Add (no id) or edit a party. The database keeps the deal's rep/buyer/title columns in step (migration 46). */
export async function saveDealParty(workspaceId: number, dealId: number, p: PartyInput, id?: number): Promise<string | null> {
  if (!supabase) return 'Supabase is not configured.';
  const { error } = id
    ? await supabase.from('deal_parties').update(p).eq('id', id)
    : await supabase.from('deal_parties').insert({
      ...p, workspace_id: workspaceId, deal_id: dealId, source: 'clozr',
      // The dedupe index (migration 40) is per linked row; typed people each get their own key so two contractors can coexist.
      source_id: p.user_id || p.vendor_id || p.buyer_id || p.seller_id ? null : `manual:${crypto.randomUUID()}`,
    });
  return error ? (error.code === '23505' ? 'Already on the team in that role.' : error.message) : null;
}

/** Star or unstar someone as the deal's point of contact for the TC. */
export async function setDealPartyPoc(id: number, on: boolean): Promise<string | null> {
  if (!supabase) return 'Supabase is not configured.';
  const { error } = await supabase.from('deal_parties').update({ is_poc: on }).eq('id', id);
  return error?.message ?? null;
}

export async function removeDealParty(id: number): Promise<string | null> {
  if (!supabase) return 'Supabase is not configured.';
  const { error } = await supabase.from('deal_parties').delete().eq('id', id);
  return error?.message ?? null;
}

export type DealPartyWithDeal = DealParty & { deal_address?: string | null; deal_seller_id?: number | null };

/** The team on a deal, or on every deal a seller/buyer/vendor is part of. */
export async function loadDealParties(q: { dealId?: number | null; sellerId?: number | null; buyerId?: number | null; vendorId?: number | null }): Promise<DealPartyWithDeal[]> {
  if (!supabase) return [];
  let dealIds: number[] = [];
  if (q.dealId) dealIds = [q.dealId];
  else if (q.sellerId) dealIds = ((await supabase.from('deals').select('id').eq('seller_id', q.sellerId)).data ?? []).map((d) => d.id);
  if (q.buyerId || q.vendorId) {
    const col = q.buyerId ? 'buyer_id' : 'vendor_id';
    const rows = (await supabase.from('deal_parties').select('*').eq(col, (q.buyerId ?? q.vendorId)!)).data ?? [];
    const ids = [...new Set(rows.map((r) => r.deal_id))];
    const { data: deals } = ids.length ? await supabase.from('deals').select('id, seller_id, property_id').in('id', ids) : { data: [] };
    const propIds = (deals ?? []).map((d) => d.property_id).filter((x): x is number => !!x);
    const { data: props } = propIds.length ? await supabase.from('properties').select('id, line1').in('id', propIds) : { data: [] };
    const dealOf = new Map((deals ?? []).map((d) => [d.id, d]));
    const line1 = (id: number | null | undefined) => (props ?? []).find((p) => p.id === id)?.line1 ?? null;
    return rows.map((r) => ({ ...r, deal_address: line1(dealOf.get(r.deal_id)?.property_id), deal_seller_id: dealOf.get(r.deal_id)?.seller_id ?? null }));
  }
  if (!dealIds.length) return [];
  const { data } = await supabase.from('deal_parties').select('*').in('deal_id', dealIds);
  return (data ?? []).sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role) || a.id - b.id);
}

/** Stages where a deal is live enough that it needs a title company on it. */
const NEEDS_TITLE = /under contract|escrow|ready to market|buyer under contract|marketing|assigned|closing/i;

export type TitleSuggestion = {
  vendor_id: number; company: string; name: string | null; email: string | null; phone: string | null;
  state: string | null; main: boolean; why: string;
};

/**
 * Title companies that could go on a deal with none, by the routing table in
 * lib/deal-close (TITLE_ROUTING): a state routed to a company puts that
 * company first, a `decide` state names who picks and nothing is put first,
 * everywhere else gets the fallback company. Then the main contacts
 * who cover the state, then anyone else there. Only this workspace's vendors.
 * Null when the deal already has title or is not live yet.
 */
export async function titleSuggestions(dealId: number): Promise<{ state: string | null; list: TitleSuggestion[]; decide: string | null } | null> {
  if (!supabase) return null;
  const { data: deal } = await supabase.from('deals').select('id, workspace_id, stage, property_id').eq('id', dealId).maybeSingle();
  if (!deal || !NEEDS_TITLE.test(deal.stage ?? '')) return null;
  const { data: prop } = deal.property_id
    ? await supabase.from('properties').select('state').eq('id', deal.property_id).maybeSingle()
    : { data: null };
  const st = (prop?.state ?? '').trim().toUpperCase() || null;
  const { data: vendors } = await supabase.from('vendors')
    .select('id, business_name, contact_name, email, phone, state, markets, is_main_poc, status')
    .eq('workspace_id', deal.workspace_id).eq('service_type', 'Title Company').neq('status', 'archived');
  const all = vendors ?? [];
  const route = titleRoute(st);
  const serves = (v: (typeof all)[number]) => !!st && (v.state === st || (v.markets ?? []).includes(st));
  const playbook = (v: (typeof all)[number]) => route.kind === 'vendor'
    && (new RegExp(route.contact.replace(/\s+/g, '\\s+'), 'i').test(v.contact_name ?? '') || new RegExp(route.company, 'i').test(v.business_name ?? ''));
  const score = (v: (typeof all)[number]) => (serves(v) ? 4 : 0) + (v.is_main_poc ? 2 : 0) + (playbook(v) ? 3 : 0);
  const list = all.filter((v) => serves(v) || playbook(v))
    .sort((a, b) => score(b) - score(a) || a.business_name.localeCompare(b.business_name))
    .slice(0, 4)
    .map((v) => ({
      vendor_id: v.id, company: v.business_name, name: v.contact_name, email: v.email, phone: v.phone, state: v.state,
      main: !!v.is_main_poc,
      why: playbook(v) ? route.why : serves(v) ? `${v.is_main_poc ? 'Main contact' : 'Covers'} ${st}` : 'Playbook default',
    }));
  return { state: st, list, decide: route.kind === 'decide' ? `${route.why}. Nothing is picked for them.` : null };
}

export type SeatVendor = { vendor_id: number; company: string; name: string | null; email: string | null; phone: string | null; kind: string | null };
type VendorRow = { id: number; business_name: string; contact_name: string | null; email: string | null; phone: string | null; service_type: string | null };
const seatVendor = (v: VendorRow): SeatVendor =>
  ({ vendor_id: v.id, company: v.business_name, name: v.contact_name, email: v.email, phone: v.phone, kind: v.service_type });
const SEAT_VENDOR_COLS = 'id, business_name, contact_name, email, phone, service_type';

/**
 * Vendors for one deal team seat, by name, company, email or phone (trigram
 * indexed; there are 100k+ realtors, so this searches rather than lists).
 * Vendors whose service type fits the seat come first.
 */
export async function searchSeatVendors(workspaceId: number, q: string, fits: RegExp): Promise<SeatVendor[]> {
  if (!supabase) return [];
  const word = ilikeSafe(q);
  const digits = q.replace(/\D/g, '');
  if (word.length < 2 && digits.length < 4) return [];
  const ors = ['business_name', 'contact_name', 'email'].map((c) => `${c}.ilike.%${word}%`);
  if (digits.length >= 4) ors.push(`phone.ilike.%${digits.slice(-4)}%`);
  const { data } = await supabase.from('vendors').select(SEAT_VENDOR_COLS).eq('workspace_id', workspaceId).neq('status', 'archived').or(ors.join(',')).limit(30);
  return ((data ?? []) as VendorRow[]).map(seatVendor)
    .sort((a, b) => Number(fits.test(b.kind ?? '')) - Number(fits.test(a.kind ?? '')))
    .slice(0, 8);
}

/** Acme Homes' go-to transactional funders, offered first on a liquid double close. */
export const FAVORITE_FUNDERS = ['Peter Rowe', 'David Cross'];

/** The favorite funders as this workspace's vendors, one each (the oldest row when a name is in twice). */
export async function favoriteFunders(workspaceId: number): Promise<SeatVendor[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('vendors').select(SEAT_VENDOR_COLS).eq('workspace_id', workspaceId).neq('status', 'archived')
    .in('contact_name', FAVORITE_FUNDERS).order('id');
  const seen = new Set<string>();
  return ((data ?? []) as VendorRow[]).filter((v) => {
    const k = (v.contact_name ?? '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(seatVendor);
}
