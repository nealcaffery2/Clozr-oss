// Quick Add's duplicate check. Before a seller or buyer typed in by hand is
// created, look for the same person in the workspace: by phone (as the
// database keys it, phone_key), by email, and for a seller by the property's
// address_key. A match is put to the person — add what they typed to the
// existing record, override it, or (a seller only) create a new one anyway —
// instead of a second record or a raw database error.
//
// The merge rules are the import's (lib/import-dedupe mergePatch): Add fills
// only the empty fields, Override writes every field that was filled in,
// neither ever blanks anything, and tags and notes are only ever added to.
// Every read and write is scoped to the workspace and goes through RLS as the
// signed-in user.

import { supabase } from './supabase';
import { dbPhoneKey, emailKey, mergePatch, sameName } from './import-dedupe';
import { buyerRow, logActivity, quickBuyerProfile, sellerWriteFail, setSellerAddress, type WriteResult } from './crm-write';
import { normalizeBuyBox, summarizeBuyBox, type BuyBox } from './buyer-profile';
import { normalizePlace } from './place-names';

export type QuickAddKind = 'seller' | 'buyer';
export type MergeMode = 'fill' | 'overwrite';
export type DupeBy = 'phone' | 'email' | 'address';

/** An existing record the one being typed matches, and what can be done about it. */
export type QuickDupe = {
  kind: QuickAddKind; id: number; name: string; by: DupeBy;
  /** Phone, email, address or company: what the record has, to show beside the name. */
  detail: string[];
  /** Matched on the address under a different name: a co-owner or an heir, most likely. */
  otherPerson: boolean;
  /** A seller can still be created anyway unless the phone is taken (sellers_phone_uniq); a buyer never is — a second buyer on the same phone or email would get every blast twice. */
  canCreate: boolean;
  /** The match is archived: adding to or overriding it brings it back. */
  archived?: boolean;
};

/** A row as the duplicate check reads it. */
export type DupeRow = { id: number; name: string | null; phone: string | null; email: string | null; property_address?: string | null; company?: string | null; archived_at?: string | null };

/**
 * The match to put to the person, from what each key found: phone first, then
 * email, then (sellers) the address — preferring, on a shared property, a
 * seller with the same name.
 */
export function pickDuplicate(
  kind: QuickAddKind, typedName: string,
  hits: { phone: DupeRow[]; email: DupeRow[]; address: DupeRow[] },
): QuickDupe | null {
  const sameAtAddress = hits.address.find((r) => sameName(r.name ?? '', typedName));
  const [row, by]: [DupeRow | undefined, DupeBy] = hits.phone[0] ? [hits.phone[0], 'phone']
    : hits.email[0] ? [hits.email[0], 'email']
      : [sameAtAddress ?? hits.address[0], 'address'];
  if (!row) return null;
  return {
    kind, id: row.id, name: row.name || 'No name', by,
    detail: [row.phone, row.email, kind === 'seller' ? row.property_address : row.company, row.archived_at ? 'archived' : null].filter((x): x is string => !!x && x.trim() !== ''),
    otherPerson: by === 'address' && !sameAtAddress,
    canCreate: kind === 'seller' && hits.phone.length === 0,
    archived: !!row.archived_at,
  };
}

const moneyOf = (v: string | undefined): number | null => {
  const t = (v ?? '').trim();
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
};
const text = (v: string | undefined) => (v ?? '').trim() || null;

/** The seller columns Quick Add's lead form fills, from what was typed. Empty fields are left out, so they never blank anything. */
export function sellerFields(f: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: text(f.name), phone: text(f.phone), email: text(f.email)?.toLowerCase() ?? null,
    asking_price: moneyOf(f.asking), motivation: text(f.motivation), source: text(f.source),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
}

/**
 * mergePatch for a record typed by hand: a phone or email that is the same as
 * the one on file in another spelling ("210-555-0100" / "+12105550100") is not
 * a change, so Override does not rewrite it.
 */
export function quickPatch(current: Record<string, unknown>, incoming: Record<string, unknown>, mode: MergeMode): Record<string, unknown> {
  const inc = { ...incoming };
  if (inc.phone != null && dbPhoneKey(String(inc.phone)) && dbPhoneKey(String(inc.phone)) === dbPhoneKey(current.phone as string | null)) delete inc.phone;
  if (inc.email != null && emailKey(String(inc.email)) === emailKey(current.email as string | null)) delete inc.email;
  return mergePatch(current, inc, mode);
}

const prefKey = (p: { type: string; name: string }) => `${p.type}:${p.name.trim().toLowerCase()}`;

/**
 * The update a buyer typed in Quick Add makes to the buyer already on file.
 * Contact fields and type follow quickPatch. The buy box is merged at its own
 * level, so the derived columns (markets, price range, the one-line summary)
 * stay in step with it: Add puts any new markets beside the ones on file and
 * fills an empty price end; Override replaces the markets and the price ends
 * that were typed. A buy-box summary a person wrote by hand is left alone.
 */
export function buyerMergePatch(
  current: { name?: string | null; company?: string | null; phone?: string | null; email?: string | null; buyer_type?: string | null; criteria?: unknown; buy_box?: string | null },
  f: Record<string, string>, mode: MergeMode,
): Record<string, unknown> {
  const p = quickBuyerProfile(f);
  const patch = quickPatch(current as Record<string, unknown>, {
    name: text(p.name), company: text(p.company ?? undefined), phone: text(p.phone ?? undefined),
    email: text(p.email ?? undefined)?.toLowerCase() ?? null, buyer_type: p.buyer_type ?? null,
  }, mode);

  const cur = normalizeBuyBox(current.criteria ?? {});
  const inc = normalizeBuyBox(p.criteria ?? {});
  const have = new Set(cur.location_prefs.map(prefKey));
  const box: BuyBox = {
    ...cur,
    location_prefs: mode === 'overwrite'
      ? (inc.location_prefs.length ? inc.location_prefs : cur.location_prefs)
      : [...cur.location_prefs, ...inc.location_prefs.filter((x) => !have.has(prefKey(x)))],
    price: mode === 'overwrite'
      ? { min: inc.price.min ?? cur.price.min ?? null, max: inc.price.max ?? cur.price.max ?? null }
      : { min: cur.price.min ?? inc.price.min ?? null, max: cur.price.max ?? inc.price.max ?? null },
  };
  if (JSON.stringify(box) !== JSON.stringify({ ...cur, price: { min: cur.price.min ?? null, max: cur.price.max ?? null } })) {
    const row = buyerRow({ name: p.name || 'Buyer', criteria: box });
    Object.assign(patch, { criteria: row.criteria, markets: row.markets, min_purchase_price: row.min_purchase_price, max_purchase_price: row.max_purchase_price });
    const summary = summarizeBuyBox(cur).oneLine;
    if (!current.buy_box || current.buy_box === summary) patch.buy_box = row.buy_box;
  }
  return patch;
}

const FIELD_WORDS: Record<string, string> = {
  asking_price: 'asking', buyer_type: 'type', min_purchase_price: 'min price', max_purchase_price: 'max price', buy_box: 'buy box summary', criteria: 'buy box',
};
/** The changed columns as words for the toast and the activity line; the buy box's derived columns go under "buy box". */
export function changedWords(keys: string[]): string[] {
  const derived = new Set(['markets', 'min_purchase_price', 'max_purchase_price', 'buy_box']);
  const hasBox = keys.includes('criteria');
  return [...new Set(keys.filter((k) => !(hasBox && derived.has(k))).map((k) => FIELD_WORDS[k] ?? k.replace(/_/g, ' ')))];
}

// ---- reads and writes ----------------------------------------------------------

/** "%" and "_" are wildcards to ILIKE; an email can carry an underscore. */
const likeExact = (v: string) => v.replace(/[\\%_]/g, (c) => '\\' + c);

/** Look for the record being typed in Quick Add. Null when there is none (or no database). */
export async function findQuickAddDuplicate(workspaceId: number, kind: QuickAddKind, f: Record<string, string>): Promise<QuickDupe | null> {
  if (!supabase) return null;
  const sb = supabase;
  const phone = dbPhoneKey(f.phone);
  const email = emailKey(f.email);
  const none = Promise.resolve([] as DupeRow[]);
  const rows = (q: PromiseLike<{ data: unknown }>) => Promise.resolve(q).then((r) => (r.data ?? []) as DupeRow[]);
  // An archived seller still holds its phone (sellers_phone_uniq), so it is matched and shown as archived.
  const cols = kind === 'seller' ? 'id, name, phone, email, property_address, archived_at' : 'id, name, company, phone, email, archived_at';
  const table = kind === 'seller' ? 'sellers' : 'buyers';

  const atAddress = async (): Promise<DupeRow[]> => {
    const line1 = (f.addr ?? '').trim();
    if (kind !== 'seller' || !line1) return [];
    // The key upsertProperty would file this address under.
    const place = normalizePlace({ city: f.city?.trim() || null, state: f.st?.trim() || null, zip: f.zip?.trim() || null });
    const { data: key } = await sb.rpc('address_key', { p_line1: line1, p_city: place.city ?? '', p_state: place.state ?? '', p_zip: place.zip ?? '' });
    if (!key) return [];
    const { data: props } = await sb.from('properties').select('id').eq('workspace_id', workspaceId).eq('address_key', key as string).limit(1);
    if (!props?.length) return [];
    return rows(sb.from('sellers').select(cols).eq('workspace_id', workspaceId).eq('property_id', props[0].id).order('id').limit(20));
  };

  const [byPhone, byEmail, byAddress] = await Promise.all([
    phone ? rows(sb.from(table as 'sellers').select(cols).eq('workspace_id', workspaceId).eq('phone_key', phone).order('id').limit(5)) : none,
    email ? rows(sb.from(table as 'sellers').select(cols).eq('workspace_id', workspaceId).ilike('email', likeExact(email)).order('id').limit(5)) : none,
    atAddress(),
  ]);
  return pickDuplicate(kind, f.name ?? '', { phone: byPhone, email: byEmail, address: byAddress });
}

/**
 * Add what was typed to an existing seller or buyer (`fill`), or override it
 * (`overwrite`). A seller's address: one without a property gets the typed
 * address either way; Override moves a seller to a different typed address,
 * with their open deals (setSellerAddress — just this seller, never the
 * co-sellers on the old property). Returns what changed, as words.
 */
export async function mergeQuickAdd(
  workspaceId: number, kind: QuickAddKind, id: number, f: Record<string, string>, mode: MergeMode, userId: string | null,
): Promise<WriteResult & { name?: string; changed?: string[] }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sb = supabase;
  const now = new Date().toISOString();

  if (kind === 'seller') {
    const { data: cur } = await sb.from('sellers')
      .select('id, name, phone, email, asking_price, motivation, source, tags, notes, property_id, property_address, archived_at')
      .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
    if (!cur) return { ok: false, message: 'That seller is no longer in this workspace.' };
    const { archived_at: wasArchived, ...curFields } = cur as typeof cur & { archived_at: string | null };
    const patch: Record<string, unknown> = quickPatch(curFields as unknown as Record<string, unknown>, sellerFields(f), mode);
    // Adding someone again means they are back: an archived match comes out of the archive.
    if (wasArchived) patch.archived_at = null;
    if (Object.keys(patch).length) {
      const { error } = await sb.from('sellers').update({ ...patch, updated_at: now } as never).eq('id', id).eq('workspace_id', workspaceId);
      if (error) return sellerWriteFail(error);
    }
    const changed = changedWords(Object.keys(patch).filter((k) => k !== 'archived_at'));
    if (wasArchived) changed.unshift('out of the archive');
    if ((f.addr ?? '').trim() && (!cur.property_id || mode === 'overwrite')) {
      const r = await setSellerAddress(workspaceId, 's' + id, f, userId, 'seller');
      if (!r.ok) return { ok: false, message: (changed.length ? `Saved ${changed.join(', ')}, but the address did not: ` : '') + (r.message ?? 'the address did not save.') };
      if (r.moved) changed.push('address');
    }
    if (changed.length) {
      await logActivity(workspaceId, 'seller', id, 'lead', mode === 'fill' ? 'New info from Quick Add' : 'Overridden from Quick Add', changed.join(', '), userId);
    }
    return { ok: true, id, name: (patch.name as string | undefined) ?? cur.name, changed };
  }

  // buyers.archived_at is newer than the generated row types.
  const { data: raw } = await sb.from('buyers')
    .select('id, name, company, phone, email, buyer_type, criteria, buy_box, archived_at' as 'id, name, company, phone, email, buyer_type, criteria, buy_box')
    .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
  if (!raw) return { ok: false, message: 'That buyer is no longer in this workspace.' };
  const { archived_at: buyerArchived, ...cur } = raw as typeof raw & { archived_at?: string | null };
  const patch: Record<string, unknown> = buyerMergePatch(cur as Parameters<typeof buyerMergePatch>[0], f, mode);
  if (buyerArchived) patch.archived_at = null;
  if (Object.keys(patch).length) {
    const { error } = await sb.from('buyers').update({ ...patch, updated_at: now } as never).eq('id', id).eq('workspace_id', workspaceId);
    if (error) return { ok: false, message: error.message };
    // A changed buy box changes who this buyer matches.
    if (patch.criteria) await sb.rpc('match_buyer', { p_buyer_id: id });
  }
  const changed = changedWords(Object.keys(patch).filter((k) => k !== 'archived_at'));
  if (buyerArchived) changed.unshift('out of the archive');
  if (changed.length) {
    await logActivity(workspaceId, 'buyer', id, 'buyer', mode === 'fill' ? 'New info from Quick Add' : 'Overridden from Quick Add', changed.join(', '), userId);
  }
  return { ok: true, id, name: (patch.name as string | undefined) ?? cur.name, changed };
}

/** The toast after a merge: "Added to Karen Daniels: email, asking", or why nothing changed. */
export function mergeToast(name: string, mode: MergeMode, changed: string[]): string {
  if (!changed.length) {
    return mode === 'fill'
      ? `Nothing added to ${name} — those fields are already filled (Override replaces them)`
      : `${name} already has exactly that — nothing changed`;
  }
  return `${mode === 'fill' ? 'Added to' : 'Overrode'} ${name}: ${changed.join(', ')}`;
}
