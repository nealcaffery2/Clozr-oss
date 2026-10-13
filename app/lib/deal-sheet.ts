// The deal sheet: one deal, every field Acme Homes tracks on it in Podio.
//
// Kept apart from lib/crm.ts on purpose. The CRM screens read a compact Deal
// shape shared with the sample graph; this sheet is forty-odd columns that
// only one screen edits, so it loads its own row and saves its own row rather
// than threading all of that through the shared graph.
//
// The arithmetic — wholesale fee, agent commissions, total COGS, net and final
// profit — is generated columns in Postgres. The client sends inputs and reads
// the results back; it never computes money itself, so a screen can't show a
// total the database would disagree with.

import type { Deal, DealGenerated } from './database.types';
import { keysetRead } from './keyset';
import { supabase } from './supabase';
import { dbId, dealRank } from './crm';
import { tcChecklistFor } from './deal-types';
import { BULK_BUYER_SOURCE } from './prospect-lists';

export type DealSheet = Deal;

/** Fields the sheet lets a person edit — every column but the generated ones and the keys. */
export type DealInputs = Omit<
  Deal,
  'id' | 'workspace_id' | 'created_by' | 'created_at' | 'updated_at' | 'source' | 'source_id' | DealGenerated
>;

const SELECT = '*';

const TERMINAL_STAGES = new Set(['Closed', 'Terminated', 'Realtor Referral']);

/**
 * A contract status typed on the deal sheet should move a lead's deal onto
 * the pipeline the dispo list reads. A deal already marketing stays there.
 * Closed and terminated deals are left where they are.
 */
export function stageForContractStatus(current: string | null | undefined, status: string | null | undefined): string | null {
  const s = String(status ?? '').trim();
  if (!s) return null;
  const cur = String(current ?? '').trim() || 'Prospect';
  if (TERMINAL_STAGES.has(cur)) return null;
  if (/^terminated$/i.test(s)) return cur === 'Terminated' ? null : 'Terminated';
  if (/^buyer executed$/i.test(s)) {
    if (cur === 'Buyer Under Contract' || cur === 'In Escrow') return null;
    if (cur === 'Prospect' || cur === 'Under Contract Seller' || cur === 'Ready To Market') return 'Buyer Under Contract';
    return null;
  }
  if (/^(under contract|fully executed|executed)$/i.test(s)) {
    if (['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed', 'Terminated', 'Realtor Referral'].includes(cur)) return null;
    return 'Under Contract Seller';
  }
  if (/^(amended|addendum executed)$/i.test(s)) {
    if (cur === 'Prospect') return 'Under Contract Seller';
    return null;
  }
  return null;
}

/**
 * The deal for a seller. Opening the deal sheet only reads: a seller with no
 * deal shows "Start a deal" rather than getting one just for looking. `start`
 * creates one at Prospect (the deal_stages placeholder; a seller stage is
 * never a deal stage) when there is none, for the paths that need a deal
 * to hang their work on (a contract going out, that button).
 */
export async function loadDealForSeller(
  workspaceId: number, sellerId: number, userId: string | null, start = false,
): Promise<{ deal: DealSheet | null; message?: string }> {
  if (!supabase) return { deal: null, message: 'Supabase is not configured.' };
  // The contact's live contract first, not merely its newest submission (lib/crm dealRank).
  const { data: all, error } = await supabase.from('deals').select('id, stage, contract_date, submitted_at')
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId).limit(1000);
  if (error) return { deal: null, message: error.message };
  const best = (all ?? []).reduce<(typeof all extends (infer T)[] | null ? T : never) | null>((a, d) => (!a || dealRank(d) > dealRank(a) ? d : a), null);
  if (best) {
    const deal = await loadDeal(best.id);
    if (deal) return { deal };
  }
  if (!start) return { deal: null };

  const { data: seller } = await supabase.from('sellers').select('property_id, source')
    .eq('id', sellerId).maybeSingle();
  const { data: created, error: cErr } = await supabase.from('deals').insert({
    workspace_id: workspaceId, seller_id: sellerId,
    property_id: seller?.property_id ?? null,
    stage: 'Prospect',
    lead_source: seller?.source?.trim() || null,
    owner_id: userId, created_by: userId,
  }).select(SELECT).single();
  if (cErr) return { deal: null, message: cErr.message };
  return { deal: created as DealSheet };
}

/** One deal by id — to re-read columns a trigger changed (the deal team sync, migration 46). */
export async function loadDeal(dealId: number): Promise<DealSheet | null> {
  if (!supabase) return null;
  return ((await supabase.from('deals').select(SELECT).eq('id', dealId).maybeSingle()).data as DealSheet | null) ?? null;
}

/**
 * Fields whose save writes beyond the deal row: the TC file's close date and
 * option, the checklist for a transaction type, the stage a contract status
 * moves to (and what triggers hang off a stage), the buyer and title that feed
 * the buyer's history and the TC file. A save of one of these re-reads the
 * workspace; any other field re-reads only the deal and its seller.
 */
const LINKED_FIELDS = ['close_date', 'option_ends_on', 'transaction_type', 'contract_status', 'stage', 'contract_date', 'buyer_id', 'title_vendor_id'];
export function touchesLinkedRows(patch: object): boolean {
  return LINKED_FIELDS.some((k) => k in patch);
}

export async function saveDeal(
  dealId: number, patch: Partial<DealInputs>,
): Promise<{ ok: boolean; deal?: DealSheet; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  let next = patch;
  if ('contract_status' in patch && !('stage' in patch)) {
    const { data: cur } = await supabase.from('deals').select('stage').eq('id', dealId).maybeSingle();
    const stage = stageForContractStatus(cur?.stage, patch.contract_status);
    if (stage) next = { ...patch, stage };
  }
  const { data, error } = await supabase.from('deals')
    .update({ ...next, updated_at: new Date().toISOString() })
    .eq('id', dealId).select(SELECT).single();
  if (error) return { ok: false, message: error.message };
  // The TC file's copies of the contract and close dates, the option and the
  // buyer follow the deal in the database (migration 239), whoever writes it.
  // Novation runs the novation checklist. Assignment, JV, and double close
  // run the assignment checklist. The label on the deal stays the full type.
  if ('transaction_type' in patch) {
    const track = tcChecklistFor(patch.transaction_type);
    if (track) {
      await supabase.from('transactions')
        .update({ deal_type: track, updated_at: new Date().toISOString() })
        .eq('deal_id', dealId);
    }
    // Novation's round robin writes dispo_rep_id in a follow-up update, after
    // this statement's row has already been returned. Read it back.
    const fresh = await loadDeal(dealId);
    if (fresh) return { ok: true, deal: fresh };
  }
  return { ok: true, deal: data as DealSheet };
}

/** Pickers the sheet needs: teammates, vendors, buyers. Empty when the role cannot read one. */
/** Lead sources for the dropdown: the common ones, then every one already in use, each once (any case), A to Z after the common ones. */
export const COMMON_LEAD_SOURCES = ['Direct mail', 'Cold call', 'Texting', 'PPC', 'PPL', 'Website', 'Referral', 'Wholesaler', 'Agent', 'Driving for dollars'];
export function leadSourceOptions(used: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = String(v ?? '').trim();
    if (!t || t.length > 80 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  COMMON_LEAD_SOURCES.forEach(add);
  [...used].sort((a, b) => String(a ?? '').localeCompare(String(b ?? ''))).forEach(add);
  return out;
}

/**
 * The assignment fee, worked out instead of typed: what the buyer pays less
 * what we pay the seller now. The seller price is the under contract price,
 * which an amendment updates in place (deal_price_changes logs it). A deal
 * imported with its drop typed into Price drop and no amendment on file keeps
 * the original price there, so that drop comes off here; once the contract
 * price has been amended, the drop is already in it and is not taken twice.
 * The buyer price is the sold price, else the marketed price (projected).
 */
export type FeeBreakdown = { fee: number | null; buyer: number | null; contract: number | null; drop: number; projected: boolean };
export function assignmentFee(
  d: { offer_amount?: number | null; price_drop?: number | null; sold_price?: number | null; marketed_price?: number | null },
  contractAmended: boolean,
): FeeBreakdown {
  const n = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const offer = n(d.offer_amount);
  const drop = !contractAmended && n(d.price_drop) ? Math.abs(n(d.price_drop)!) : 0;
  const contract = offer == null ? null : offer - drop;
  const sold = n(d.sold_price);
  const marketed = n(d.marketed_price);
  const buyer = sold && sold > 0 ? sold : marketed && marketed > 0 ? marketed : null;
  return { fee: buyer != null && contract != null && contract > 0 ? Math.round(buyer - contract) : null, buyer, contract, drop, projected: !(sold && sold > 0) };
}

export type SheetBuyerOption = { id: number; label: string; at?: number };

/**
 * The deal sheet's Buyer field. These are the buyers already on the Buyers
 * list (not a second read, and not a holding list). A buyer already saved on
 * the deal stays in the menu even if they are not on that list.
 */
export function sheetBuyerOptions(
  buyers: readonly { id: string; name: string; company?: string | null; prospectList?: string | null; createdAt?: string | null }[],
  selectedId?: number | null,
): SheetBuyerOption[] {
  const out: SheetBuyerOption[] = [];
  const seen = new Set<number>();
  const add = (id: number, label: string, at?: number) => {
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, ...(at != null && Number.isFinite(at) ? { at } : {}) });
  };
  for (const b of buyers) {
    if (b.prospectList) continue;
    const id = dbId(b.id);
    const name = (b.name && b.name !== '—' ? b.name : '').trim();
    const company = (b.company && b.company !== '—' ? b.company : '').trim();
    const at = b.createdAt ? Date.parse(b.createdAt) : NaN;
    add(id, company && name ? `${company} · ${name}` : company || name || `Buyer ${id}`, Number.isFinite(at) ? at : undefined);
  }
  if (selectedId != null && !seen.has(selectedId)) add(selectedId, `Buyer ${selectedId}`);
  return out;
}

type DealPickers = Awaited<ReturnType<typeof readDealPickers>>['picked'];
/** How long one read of the pickers serves every deal sheet and deal team that asks. */
const PICKERS_TTL_MS = 60_000;
const pickerCache = new Map<number, { at: number; p: Promise<DealPickers> }>();
/** Pages of a picker read, by keyset (lib/keyset.ts): one read stopped at PostgREST's 1,000 rows. */
const pickerPage = <T,>(page: () => PromiseLike<T>) => Promise.resolve(page());

/**
 * Team, vendors, buyers and lead sources for the deal sheet's pickers. The
 * deal sheet and its deal team both ask on open; they share one read for a
 * minute. Every buyer and vendor comes back (a single read stopped at 1,000,
 * the first thousand by name), and the lead sources are the distinct values
 * (migration 226, deal_lead_sources) rather than 10,000 rows of them.
 */
export function loadDealPickers(workspaceId: number): Promise<DealPickers> {
  const hit = pickerCache.get(workspaceId);
  if (hit && Date.now() - hit.at < PICKERS_TTL_MS) return hit.p;
  const p = readDealPickers(workspaceId);
  const entry = { at: Date.now(), p: p.then((r) => r.picked) };
  pickerCache.set(workspaceId, entry);
  // A read that failed (a timeout comes back as an error, not a throw) is not kept.
  const drop = () => { if (pickerCache.get(workspaceId) === entry) pickerCache.delete(workspaceId); };
  p.then((r) => { if (!r.ok) drop(); }, drop);
  return entry.p;
}

async function readDealPickers(workspaceId: number) {
  if (!supabase) return { ok: true, picked: { team: [] as { id: string; label: string; role: string; email: string | null }[], vendors: [], buyers: [], sources: [] as string[] } };
  const sb = supabase;
  const [t, v, b, sources] = await Promise.all([
    sb.from('workspace_roster').select('user_id, full_name, email, role').eq('workspace_id', workspaceId),
    keysetRead(() => sb.from('vendors').select('id, business_name, contact_name, email, phone, service_type, state').eq('workspace_id', workspaceId).neq('status', 'archived').isDistinct('source', BULK_BUYER_SOURCE).order('business_name').order('id'),
      [{ col: 'business_name', asc: true }, { col: 'id', asc: true }], { pageSize: 1000, fetchPage: pickerPage }),
    keysetRead(() => sb.from('buyers').select('id, name, company, email, phone, last_activity_at').eq('workspace_id', workspaceId).isDistinct('source', BULK_BUYER_SOURCE).order('name').order('id'),
      [{ col: 'name', asc: true }, { col: 'id', asc: true }], { pageSize: 1000, fetchPage: pickerPage }),
    loadLeadSources(workspaceId),
  ]);
  type V = { id: number; business_name: string; contact_name: string | null; email: string | null; phone: string | null; service_type: string | null; state: string | null };
  type B = { id: number; name: string; company: string | null; email: string | null; phone: string | null; last_activity_at: string | null };
  return { ok: !t.error && !v.error && !b.error, picked: {
    team: (t.data ?? []).map((r) => ({ id: r.user_id, label: r.full_name || r.email || r.user_id.slice(0, 8), role: r.role, email: r.email })),
    vendors: ((v.data ?? []) as V[]).map((r) => ({ id: r.id, label: r.business_name, contact: r.contact_name, email: r.email, phone: r.phone, kind: r.service_type, state: r.state })),
    buyers: ((b.data ?? []) as B[]).map((r) => ({ id: r.id, label: r.company ? `${r.company} · ${r.name}` : r.name, name: r.name, company: r.company, email: r.email, phone: r.phone, at: r.last_activity_at ? Date.parse(r.last_activity_at) : 0 })),
    sources,
  } };
}

/** Lead sources already in use, for the Lead source dropdown: on deals, then on sellers. */
async function loadLeadSources(workspaceId: number): Promise<string[]> {
  if (!supabase) return [];
  const rpc = await supabase.rpc('deal_lead_sources' as never, { p_workspace: workspaceId } as never);
  if (!rpc.error) return leadSourceOptions(((rpc.data ?? []) as { source: string | null }[]).map((r) => r.source));
  // A database without the function reads the columns themselves.
  const [ds, ss] = await Promise.all([
    supabase.from('deals').select('lead_source').eq('workspace_id', workspaceId).not('lead_source', 'is', null).limit(5000),
    supabase.from('sellers').select('source').eq('workspace_id', workspaceId).not('source', 'is', null).limit(5000),
  ]);
  return leadSourceOptions([...(ds.data ?? []).map((r) => r.lead_source), ...(ss.data ?? []).map((r) => r.source)]);
}

export const money = (n: number | null | undefined) =>
  n == null || Number.isNaN(Number(n)) ? '—' : (Number(n) < 0 ? '−' : '') + '$' + Math.abs(Math.round(Number(n))).toLocaleString('en-US');

/**
 * What the Ready To Market gate checks, read fresh when the move is asked
 * for (lib/deal-close readyToMarketChecks): a photo on the deal, access or
 * lockbox written down, a title company, and an executed seller contract
 * (a completed contract in CLOZR, or the deal's contract status says so).
 */
export async function readyToMarketFacts(dealId: number): Promise<{ photos: number; access: boolean; titleVendor: boolean; executedContract: boolean } | null> {
  if (!supabase) return null;
  const [d, f, c] = await Promise.all([
    supabase.from('deals').select('property_access, access_instructions, title_vendor_id, title_contact, hero_image_url, contract_status').eq('id', dealId).maybeSingle(),
    supabase.from('deal_files').select('id', { count: 'exact', head: true }).eq('deal_id', dealId).eq('kind', 'photo'),
    supabase.from('contracts').select('id', { count: 'exact', head: true }).eq('deal_id', dealId).eq('status', 'completed').in('kind', ['psa', 'addendum']),
  ]);
  if (d.error || !d.data) return null;
  const row = d.data as { property_access: string | null; access_instructions: string | null; title_vendor_id: number | null; title_contact: string | null; hero_image_url: string | null; contract_status: string | null };
  return {
    photos: (f.count ?? 0) + (row.hero_image_url ? 1 : 0),
    access: !!(row.property_access?.trim() || row.access_instructions?.trim()),
    titleVendor: !!(row.title_vendor_id || row.title_contact?.trim()),
    executedContract: (c.count ?? 0) > 0 || /executed|under contract|amended/i.test(row.contract_status ?? ''),
  };
}
