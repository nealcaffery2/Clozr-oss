// A seller's other numbers (migration 129), and the dial list a CLOZR
// power-dialer session walks for each person.
//
// sellers.phone stays the number: what the record shows first, what a text
// goes to, what dedupe and call-sync match on. seller_phones holds the rest in
// the order to try them (position 2, 3, …). A buyer's are buyer_phones, which
// lib/genius.ts writes; the dialer reads both the same way, through
// dialNumbers.
//
// The pure half (order, dedupe against the primary, the dial list, splicing a
// person's numbers into a running session) is pinned by
// tools/seller-phones.test.ts. The reads and writes after it are small, and a
// failed read is "no other numbers": the record's own phone still rings, which
// is what the dialer did before any of this existed.

import type { SellerPhoneRow } from './database.types';
import { supabase } from './supabase';
import { toE164 } from './talkr';

/** The columns the dialer and the record need, from either table. A buyer's bad number is kind 'wrong' (genius.ts markPhone). */
export type OtherPhone = {
  id: number; phone: string; position: number | null;
  kind?: string | null; is_dnc?: boolean | null; is_wrong?: boolean | null;
};
/** One number to ring, as E.164, and the row it came from: null for the record's own phone. */
export type DialNumber = { phone: string; phoneId: number | null };
/** A number an import or a skip trace found, before it is checked against what is on file. */
export type FoundPhone = { phone: string | null | undefined; kind?: string | null; dnc?: boolean };

// ---- how many numbers a session tries per person ---------------------------

export type QueueDepth = 1 | 2 | 3 | 'all';
export const QUEUE_DEPTHS: { id: QueueDepth; label: string; hint: string }[] = [
  { id: 1, label: '1', hint: 'Their main number only' },
  { id: 2, label: '2', hint: 'Their main number, then one more if nobody answers' },
  { id: 3, label: '3', hint: 'Up to three numbers each before moving on' },
  { id: 'all', label: 'All', hint: 'Every good number on file before moving on' },
];
export const QUEUE_DEPTH_KEY = 'clozr.queueDepth';

/** The rep's last pick. 1 until they choose: the record's own number, as the dialer always did. */
export function readQueueDepth(): QueueDepth {
  try {
    const v = localStorage.getItem(QUEUE_DEPTH_KEY);
    return v === 'all' ? 'all' : v === '2' ? 2 : v === '3' ? 3 : 1;
  } catch {
    return 1;
  }
}
export function saveQueueDepth(d: QueueDepth): void {
  try { localStorage.setItem(QUEUE_DEPTH_KEY, String(d)); } catch { /* private mode */ }
}

// ---- pure -------------------------------------------------------------------

/** Position order, then the order they were added in. */
export function byPosition<T extends { id: number; position: number | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.position ?? 32767) - (b.position ?? 32767) || a.id - b.id);
}

/** Never dialled: marked do not call, or wrong (a seller's is_wrong, a buyer's kind 'wrong'). */
export const isBadNumber = (r: OtherPhone): boolean => !!r.is_dnc || !!r.is_wrong || (r.kind ?? '').toLowerCase() === 'wrong';

/** What the record lists under the primary: in order, each number once, never the primary again. Bad ones stay, with their badge. */
export function otherNumbers<T extends OtherPhone>(primary: string | null | undefined, rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const own = toE164(primary);
  if (own) seen.add(own);
  return byPosition(rows).filter((r) => {
    const e = toE164(r.phone) ?? r.phone;
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
}

/**
 * Who to ring for one person, in order: the record's own phone, then the
 * others by position, each number once, none that is marked do not call or
 * wrong (in any spelling on file) or is not a dialable number, and at most
 * `depth` of them. A blank or broken primary is left out, so their first good
 * other number is number 1.
 */
export function dialNumbers(primary: string | null | undefined, rows: readonly OtherPhone[], depth: QueueDepth): DialNumber[] {
  const out: DialNumber[] = [];
  const own = toE164(primary);
  const seen = new Set<string>();
  const bad = new Set(rows.filter(isBadNumber).map((r) => toE164(r.phone)).filter((e): e is string => !!e));
  // A primary found wrong while the seller had other numbers (primaryWrong) is skipped like any bad one.
  if (own && !bad.has(own)) {
    out.push({ phone: own, phoneId: null });
    seen.add(own);
  }
  for (const r of byPosition(rows)) {
    const e = toE164(r.phone);
    if (!e || seen.has(e) || bad.has(e)) continue;
    seen.add(e);
    out.push({ phone: e, phoneId: r.id });
  }
  return depth === 'all' ? out : out.slice(0, depth);
}

/** How the record's own phone stands in seller_phones: marked wrong or do not call there, or fine. */
export function primaryFlag(primary: string | null | undefined, rows: readonly OtherPhone[]): 'wrong' | 'dnc' | null {
  const own = toE164(primary);
  if (!own) return null;
  const hit = rows.find((r) => toE164(r.phone) === own && isBadNumber(r));
  return !hit ? null : hit.is_dnc ? 'dnc' : 'wrong';
}

/** The numbers worth keeping from what was found: dialable, not the primary, not on file yet, each once, as E.164. */
export function freshNumbers(primary: string | null | undefined, existing: readonly { phone: string }[], found: readonly FoundPhone[]): (FoundPhone & { phone: string })[] {
  const have = new Set([primary, ...existing.map((r) => r.phone)].map((p) => toE164(p)).filter((e): e is string => !!e));
  const out: (FoundPhone & { phone: string })[] = [];
  for (const f of found) {
    const e = toE164(f.phone);
    if (!e || have.has(e)) continue;
    have.add(e);
    out.push({ ...f, phone: e });
  }
  return out;
}

/** Positions for `n` new numbers after those on file. The primary is 1, so the first other number is 2. */
export function nextPositions(existing: readonly { position: number | null }[], n: number): number[] {
  const top = Math.max(1, ...existing.map((r) => r.position ?? 1));
  return Array.from({ length: n }, (_, i) => top + 1 + i);
}

// ---- a session walking several numbers per person ---------------------------

type WalkTarget = { phone: string; personId?: string | null; buyerId?: string | null; phoneId?: number | null };
/** The shape of a session row this needs (useClozr's QueueRunItem). `n` of `of` once a person has several numbers. */
export type WalkRow = { target: WalkTarget; claim?: boolean; n?: number; of?: number };

/** Who a session row rings: the seller or buyer, or null for a row with no record (a vendor). */
export const walkKey = (t: { personId?: string | null; buyerId?: string | null }): string | null =>
  t.personId ? 'p:' + t.personId : t.buyerId ? 'b:' + t.buyerId : null;

/**
 * A session's list with each person's numbers in it: their row becomes one row
 * per number (`n` of `of`), side by side in dialling order, so the walk tries
 * every number of one person before the next person. Only rows from `pos - 1`
 * on change. The row at `pos - 1` has just been dialled: its number stays
 * first and the rest of theirs follow it. Rows before it are behind the walk.
 * A row `numbersOf` has nothing for (no record, no good number, already
 * spliced) stays as it is, so the walk skips or dials it exactly as before.
 * Only a person's first row claims a pool lead.
 */
export function spliceNumbers<T extends WalkRow>(list: readonly T[], pos: number, numbersOf: (row: T) => DialNumber[] | undefined): T[] {
  const from = Math.max(0, pos - 1);
  const out: T[] = list.slice(0, from);
  list.slice(from).forEach((row, k) => {
    const nums = (row.of ?? 1) > 1 ? undefined : numbersOf(row);
    const dialled = from + k === pos - 1;
    const own = toE164(row.target.phone);
    const all: DialNumber[] = !nums ? []
      : dialled ? [{ phone: row.target.phone, phoneId: row.target.phoneId ?? null }, ...nums.filter((x) => x.phone !== own)]
        : nums;
    if (all.length < (dialled ? 2 : 1)) {
      out.push(row);
      return;
    }
    all.forEach((x, j) => {
      out.push({ ...row, target: { ...row.target, phone: x.phone, phoneId: x.phoneId }, claim: j === 0 ? row.claim : false, n: j + 1, of: all.length });
    });
  });
  return out;
}

/**
 * People a session has not started on: those with a row from `pos` on, each
 * once, less `except` (the person being walked, anyone already reached). A row
 * with no record is a person of its own.
 */
export function peopleLeft(list: readonly WalkRow[], pos: number, except: readonly string[]): number {
  const done = new Set(except);
  const keys = new Set<string>();
  let loose = 0;
  for (const r of list.slice(pos)) {
    const k = walkKey(r.target);
    if (!k) loose++;
    else if (!done.has(k)) keys.add(k);
  }
  return keys.size + loose;
}

// ---- reads and writes -------------------------------------------------------

const chunks = <T,>(xs: readonly T[], n = 200): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const ids = (xs: readonly number[]) => [...new Set(xs.filter((n) => Number.isFinite(n)))];

/** Other numbers for these sellers, by seller id, 200 ids a read. A failed read is none for those sellers. */
export async function loadSellerPhones(workspaceId: number, sellerIds: readonly number[]): Promise<Map<number, SellerPhoneRow[]>> {
  const out = new Map<number, SellerPhoneRow[]>();
  const want = ids(sellerIds);
  if (!supabase || !want.length) return out;
  const sb = supabase;
  const reads = await Promise.all(chunks(want).map((part) => sb.from('seller_phones').select('*').eq('workspace_id', workspaceId).in('seller_id', part)));
  for (const { data, error } of reads) {
    if (error) { console.warn('seller_phones', error.message); continue; }
    for (const r of data ?? []) out.set(r.seller_id, [...(out.get(r.seller_id) ?? []), r]);
  }
  return out;
}

/**
 * Other numbers for these buyers (buyer_phones), by buyer id. Its row security
 * is the buyers rule, so a role that cannot read buyers gets none, and the
 * buyer's own phone is all the session rings, as before.
 */
export async function loadBuyerPhones(workspaceId: number, buyerIds: readonly number[]): Promise<Map<number, OtherPhone[]>> {
  const out = new Map<number, OtherPhone[]>();
  const want = ids(buyerIds);
  if (!supabase || !want.length) return out;
  const sb = supabase;
  const reads = await Promise.all(chunks(want).map((part) => sb.from('buyer_phones').select('id, buyer_id, phone, position, kind, is_dnc').eq('workspace_id', workspaceId).in('buyer_id', part)));
  for (const { data, error } of reads) {
    if (error) { console.warn('buyer_phones', error.message); continue; }
    for (const r of data ?? []) out.set(r.buyer_id, [...(out.get(r.buyer_id) ?? []), r]);
  }
  return out;
}

/**
 * Keep numbers found for a seller (an import's second phone column, a skip
 * trace's hits, one typed on the record): each dialable one that is not the
 * primary and not on file goes after the ones there. A number already on file
 * is left as it is, flags and all.
 */
export async function addSellerPhones(
  workspaceId: number, sellerId: number, primary: string | null | undefined, found: readonly FoundPhone[], source: string,
): Promise<{ ok: boolean; added: number; message?: string }> {
  if (!supabase) return { ok: false, added: 0, message: 'Supabase is not configured.' };
  if (!found.some((f) => toE164(f.phone))) return { ok: true, added: 0 };
  const { data: have, error: readError } = await supabase.from('seller_phones').select('phone, position')
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId);
  if (readError) return { ok: false, added: 0, message: readError.message };
  const fresh = freshNumbers(primary, have ?? [], found);
  if (!fresh.length) return { ok: true, added: 0 };
  const at = nextPositions(have ?? [], fresh.length);
  // Every row names every column: a bulk insert fills a key one row lacks with null, not the default.
  const { error } = await supabase.from('seller_phones').upsert(fresh.map((f, i) => ({
    workspace_id: workspaceId, seller_id: sellerId, phone: f.phone, position: at[i]!,
    kind: f.kind || 'mobile', source, is_dnc: !!f.dnc,
  })), { onConflict: 'seller_id,phone', ignoreDuplicates: true });
  return error ? { ok: false, added: 0, message: error.message } : { ok: true, added: fresh.length };
}

/**
 * What a file's do-not-call flags change on numbers already on file: rows
 * not yet marked are marked (a flag is never taken off by an import), and the
 * seller's own phone, flagged in the file, gets a row marked do not call so
 * the dialer skips it (primaryFlag) — sellers.phone itself has no flag.
 */
export function dncUpdates(
  primary: string | null | undefined, rows: readonly { id: number; phone: string; is_dnc: boolean }[], found: readonly FoundPhone[],
): { flag: number[]; primary: (FoundPhone & { phone: string }) | null } {
  const dnc = new Map<string, FoundPhone>();
  for (const f of found) { const e = toE164(f.phone); if (e && f.dnc && !dnc.has(e)) dnc.set(e, f); }
  const flag = rows.filter((r) => !r.is_dnc && dnc.has(toE164(r.phone) ?? r.phone)).map((r) => r.id);
  const own = toE164(primary);
  const ownFound = own ? dnc.get(own) : undefined;
  const onFile = own ? rows.some((r) => toE164(r.phone) === own) : true;
  return { flag, primary: own && ownFound && !onFile ? { ...ownFound, phone: own } : null };
}

/**
 * Every number an import row carries, kept (addSellerPhones: the primary and
 * numbers on file are skipped, the rest go after them in file order) and its
 * do-not-call flags applied (dncUpdates).
 */
export async function keepImportPhones(
  workspaceId: number, sellerId: number, primary: string | null | undefined, found: readonly FoundPhone[], source: string,
): Promise<{ ok: boolean; added: number; flagged: number; message?: string }> {
  const r = await addSellerPhones(workspaceId, sellerId, primary, found, source);
  if (!r.ok || !supabase || !found.some((f) => f.dnc)) return { ...r, flagged: 0 };
  const { data: rows, error } = await supabase.from('seller_phones').select('id, phone, is_dnc, position')
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId);
  if (error) return { ok: false, added: r.added, flagged: 0, message: error.message };
  const plan = dncUpdates(primary, rows ?? [], found);
  let flagged = 0;
  if (plan.flag.length) {
    const { error: e } = await supabase.from('seller_phones').update({ is_dnc: true }).eq('workspace_id', workspaceId).in('id', plan.flag);
    if (e) return { ok: false, added: r.added, flagged: 0, message: e.message };
    flagged += plan.flag.length;
  }
  if (plan.primary) {
    const [position] = nextPositions(rows ?? [], 1);
    const { error: e } = await supabase.from('seller_phones').upsert({
      workspace_id: workspaceId, seller_id: sellerId, phone: plan.primary.phone, position, kind: plan.primary.kind || 'mobile', source, is_dnc: true, is_wrong: false,
    }, { onConflict: 'seller_id,phone', ignoreDuplicates: true });
    if (e) return { ok: false, added: r.added, flagged, message: e.message };
    flagged++;
  }
  return { ok: true, added: r.added, flagged };
}

export async function removeSellerPhone(workspaceId: number, id: number): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('seller_phones').delete().eq('id', id).eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Flag one number: wrong (the Wrong number outcome on it) or do not call. Either keeps the dialer off it. */
/**
 * "Wrong number" on the record's own phone while the seller has other numbers:
 * kept as a seller_phones row marked wrong, so every dial list skips it, and
 * the lead keeps its stage. The primary column itself is left as it is; a rep
 * changes it on the record.
 */
export async function markPrimaryWrong(workspaceId: number, sellerId: number, primary: string | null | undefined): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const phone = toE164(primary);
  if (!phone) return { ok: true };
  const { data: have, error: readError } = await supabase.from('seller_phones').select('phone, position')
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId);
  if (readError) return { ok: false, message: readError.message };
  const [position] = nextPositions(have ?? [], 1);
  const { error } = await supabase.from('seller_phones').upsert({
    workspace_id: workspaceId, seller_id: sellerId, phone, position, kind: 'mobile', source: 'wrong_primary', is_dnc: false, is_wrong: true,
  }, { onConflict: 'seller_id,phone' });
  return error ? { ok: false, message: error.message } : { ok: true };
}

export async function markSellerPhone(workspaceId: number, id: number, patch: { is_wrong?: boolean; is_dnc?: boolean }): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('seller_phones').update(patch).eq('id', id).eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Count a ring on one of a record's other numbers. Best effort: a refused write (a role that cannot edit buyers) changes nothing else. */
export async function noteDialled(workspaceId: number, kind: 'seller' | 'buyer', id: number): Promise<void> {
  if (!supabase) return;
  const at = new Date().toISOString();
  if (kind === 'seller') {
    const { data } = await supabase.from('seller_phones').select('call_count').eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
    if (data) await supabase.from('seller_phones').update({ call_count: data.call_count + 1, last_called_at: at }).eq('id', id).eq('workspace_id', workspaceId);
    return;
  }
  const { data } = await supabase.from('buyer_phones').select('call_count').eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
  if (data) await supabase.from('buyer_phones').update({ call_count: (data.call_count ?? 0) + 1, last_contacted_at: at }).eq('id', id).eq('workspace_id', workspaceId);
}
