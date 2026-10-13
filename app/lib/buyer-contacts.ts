// A buyer's other numbers (buyer_phones) and other email addresses
// (buyer_emails, migration 162), for the buyer record's contact rows.
//
// buyers.phone and buyers.email stay the primary: what the record shows
// first, what a text or an email goes to, what dedupe matches on. The rows
// here are the rest, in the order to try them (position 2, 3, …). The seller
// record does the same with seller_phones (lib/seller-phones.ts).
//
// The pure half (cleaning, dedupe against the primary) is pinned by
// tools/buyer-contacts.test.ts. A failed read is "no other numbers / emails":
// the primary still works, as it did before any of this existed.

import type { BuyerEmailRow, BuyerPhoneRow } from './database.types';
import { nextPositions } from './seller-phones';
import { supabase } from './supabase';
import { toE164 } from './talkr';

type Result = { ok: boolean; added?: boolean; message?: string };

// ---- pure -------------------------------------------------------------------

/** The lower-cased address, or null when it is not an email address. */
export function emailKey(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** What the record lists under the primary email: in order, each address once, never the primary again. */
export function otherEmails<T extends { id: number; email: string; position: number | null }>(primary: string | null | undefined, rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const own = emailKey(primary);
  if (own) seen.add(own);
  return [...rows]
    .sort((a, b) => (a.position ?? 32767) - (b.position ?? 32767) || a.id - b.id)
    .filter((r) => {
      const k = emailKey(r.email) ?? r.email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Why a typed address cannot be added, or null when it can: not an address, the primary, or already on file. */
export function emailProblem(primary: string | null | undefined, existing: readonly { email: string }[], typed: string): string | null {
  const k = emailKey(typed);
  if (!k) return 'That is not an email address.';
  if (k === emailKey(primary)) return 'That is already their main email.';
  if (existing.some((r) => emailKey(r.email) === k)) return 'That email is already on file.';
  return null;
}

/** Why a typed number cannot be added, or null when it can: not a full number, the primary, or already on file. */
export function phoneProblem(primary: string | null | undefined, existing: readonly { phone: string }[], typed: string): string | null {
  const e = toE164(typed.trim());
  if (!e) return 'That is not a full phone number.';
  if (e === toE164(primary)) return 'That is already their main number.';
  if (existing.some((r) => toE164(r.phone) === e)) return 'That number is already on file.';
  return null;
}

/** buyer_phones.phone_key: the E.164 number, as every other writer stores it. */
export const phoneKeyOf = (e164: string) => e164;

// ---- reads and writes -------------------------------------------------------

export async function loadBuyerPhoneRows(workspaceId: number, buyerId: number): Promise<BuyerPhoneRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('buyer_phones').select('*').eq('workspace_id', workspaceId).eq('buyer_id', buyerId);
  if (error) { console.warn('buyer_phones', error.message); return []; }
  return data ?? [];
}

export async function addBuyerPhone(workspaceId: number, buyerId: number, primary: string | null | undefined, typed: string): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const have = await loadBuyerPhoneRows(workspaceId, buyerId);
  const problem = phoneProblem(primary, have, typed);
  if (problem) return { ok: problem.startsWith('That number is already') || problem.startsWith('That is already their main'), added: false, message: problem };
  const phone = toE164(typed.trim())!;
  const [position] = nextPositions(have, 1);
  const { error } = await supabase.from('buyer_phones').insert({
    workspace_id: workspaceId, buyer_id: buyerId, phone, phone_key: phoneKeyOf(phone), position, kind: 'mobile', source: 'manual', is_dnc: false,
  });
  return error ? { ok: false, message: error.message } : { ok: true, added: true };
}

export async function removeBuyerPhone(workspaceId: number, id: number): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('buyer_phones').delete().eq('id', id).eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** A database without migration 162 reads as no other emails. */
export async function loadBuyerEmails(workspaceId: number, buyerId: number): Promise<BuyerEmailRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('buyer_emails').select('*').eq('workspace_id', workspaceId).eq('buyer_id', buyerId);
  if (error) { console.warn('buyer_emails', error.message); return []; }
  return data ?? [];
}

export async function addBuyerEmail(workspaceId: number, buyerId: number, primary: string | null | undefined, typed: string, source = 'manual'): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const have = await loadBuyerEmails(workspaceId, buyerId);
  const problem = emailProblem(primary, have, typed);
  if (problem) return { ok: problem !== 'That is not an email address.', added: false, message: problem };
  const email = typed.trim();
  const [position] = nextPositions(have, 1);
  const { error } = await supabase.from('buyer_emails').insert({
    workspace_id: workspaceId, buyer_id: buyerId, email, email_key: emailKey(email)!, position, kind: null, source,
  });
  if (error) {
    if (/buyer_emails/.test(error.message) && /does not exist|schema cache/i.test(error.message)) return { ok: false, message: 'More than one email needs migration 162, which has not run on this database yet.' };
    return { ok: false, message: error.message };
  }
  return { ok: true, added: true };
}

export async function removeBuyerEmail(workspaceId: number, id: number): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('buyer_emails').delete().eq('id', id).eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/**
 * Make one of the other addresses the main one: the old main moves into its
 * row, so nothing is lost and the list keeps its length.
 */
export async function promoteBuyerEmail(workspaceId: number, buyerId: number, row: { id: number; email: string }, oldPrimary: string | null | undefined): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('buyers').update({ email: row.email, updated_at: new Date().toISOString() }).eq('id', buyerId).eq('workspace_id', workspaceId);
  if (error) return { ok: false, message: error.message };
  const old = emailKey(oldPrimary);
  const { error: e2 } = old
    ? await supabase.from('buyer_emails').update({ email: String(oldPrimary).trim(), email_key: old }).eq('id', row.id).eq('workspace_id', workspaceId)
    : await supabase.from('buyer_emails').delete().eq('id', row.id).eq('workspace_id', workspaceId);
  return e2 ? { ok: false, message: e2.message } : { ok: true };
}

/** Make one of the other numbers the main one: the old main moves into its row. */
export async function promoteBuyerPhone(workspaceId: number, buyerId: number, row: { id: number; phone: string }, oldPrimary: string | null | undefined): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('buyers').update({ phone: row.phone, updated_at: new Date().toISOString() }).eq('id', buyerId).eq('workspace_id', workspaceId);
  if (error) return { ok: false, message: /phone_uniq|duplicate/i.test(error.message) ? 'Another buyer already has that number as their main phone.' : error.message };
  const old = toE164(oldPrimary);
  const { error: e2 } = old
    ? await supabase.from('buyer_phones').update({ phone: old, phone_key: phoneKeyOf(old), kind: 'mobile', is_dnc: false }).eq('id', row.id).eq('workspace_id', workspaceId)
    : await supabase.from('buyer_phones').delete().eq('id', row.id).eq('workspace_id', workspaceId);
  return e2 ? { ok: false, message: e2.message } : { ok: true };
}

/** The buyer's company line; blank clears it. */
export async function setBuyerCompany(workspaceId: number, buyerId: number, company: string): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('buyers').update({ company: company.trim() || null, updated_at: new Date().toISOString() }).eq('id', buyerId).eq('workspace_id', workspaceId);
  return error ? { ok: false, message: error.message } : { ok: true };
}
