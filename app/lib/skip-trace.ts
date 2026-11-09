// Skip trace from the CRM (People, Buyers, a seller or buyer record): the
// client for the skip-trace edge function and the writes that put found
// phones and emails on a buyer.
import { addBuyerEmail } from './buyer-contacts';
import type { Candidate as BaseCandidate, Kind, SkipHit, SkipPhone } from '../supabase/functions/_shared/property-data';
export type { SkipHit, SkipPhone };
import { tracePurchaseStub } from '../supabase/functions/_shared/property-data';
import { emptyBuyBox } from './buyer-profile';
import { createBuyer, tagBuyers } from './crm-write';
import { SKIPTRACE_TAG } from './data-runs';
import type { WriteResult } from './crm-write';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, supabase } from './supabase';
import { guardedFetch } from './read-only';
import { toE164 } from './talkr';

/** A found buyer, with the method that found them and its proof when a method ran (genius-methods.ts). */
export type Candidate = BaseCandidate;

export type PhoneMark = 'good' | 'wrong';

export type MarkedPhone = SkipPhone & { status?: PhoneMark };

export const KIND_COLOR: Record<Kind, string> = { flipper: '#ea580c', landlord: '#2563eb', builder: '#0d9488' };

type Res<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(body: Record<string, unknown>): Promise<Res<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('skip-trace', { body });
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

/** A CRM record to trace: a seller at their property, a buyer at a mailing or purchase address. */
export type TraceTarget = {
  key: string; owner_name: string; corporate: boolean; people: string[];
  mail_parts: { address: string; city: string; state: string; zip: string } | null; mailing: string | null;
};

/** The same skip trace for records that are not Genius candidates (People and Buyers bulk action). */
export const skipTraceTargets = (workspaceId: number, targets: TraceTarget[]) =>
  call<{ results: Record<string, { hits: SkipHit[]; cached: boolean; at: string } | { error: string }>; credits: Record<string, number> }>({
    workspace_id: workspaceId, action: 'skiptrace',
    targets: targets.slice(0, 100).map((t) => ({
      ...t,
      purchases: t.mail_parts ? [tracePurchaseStub(t.mail_parts)] : [],
    })),
  });

const phoneDigits = (n: string | null | undefined) => String(n ?? '').replace(/\D+/g, '').slice(-10);

export type TraceWrite = {
  /** Best dialable number, written onto buyers.phone only when that column is empty. */
  phone: string | null;
  /** First email, written onto buyers.email only when that column is empty. */
  email: string | null;
  /** Numbers the buyer does not already have. */
  insert: { phone: string; kind: string | null; dnc: boolean; verified: boolean }[];
};

/**
 * What a skip trace should write onto a buyer who is already in the CRM.
 * Re-adding a found owner used to stop at "already in buyers" and leave the
 * phones on the Genius card. Wrong numbers and duplicates are left out.
 */
export function traceWrites(c: Candidate, existing: { phone: string | null; email: string | null; phoneKeys: string[] }): TraceWrite {
  const phones = phonesOf(c).filter((p) => p.status !== 'wrong' && phoneDigits(p.number).length >= 10);
  const have = new Set(existing.phoneKeys.map(phoneDigits).filter((k) => k.length >= 10));
  const insert: TraceWrite['insert'] = [];
  for (const p of phones) {
    const k = phoneDigits(p.number);
    if (have.has(k)) continue;
    have.add(k);
    insert.push({ phone: p.number, kind: p.type ?? null, dnc: !!p.dnc, verified: p.status === 'good' });
    if (insert.length >= 6) break;
  }
  const email = emailsOf(c)[0] ?? null;
  return {
    phone: existing.phone ? null : (phones.find((p) => !p.dnc)?.number ?? phones[0]?.number ?? null),
    email: existing.email ? null : email,
    insert,
  };
}

/**
 * buyer_phones checks kind (mobile, landline, voip, unknown; never null) and
 * position (1 to 3). A trace says "Wireless", "W", "Landline", "L". Writing the
 * trace's words, or a 4th position, failed every Genius phone insert silently.
 */
export function phoneKind(t: string | null | undefined): 'mobile' | 'landline' | 'voip' | 'unknown' {
  const s = (t ?? '').trim();
  if (/^(w|wireless|mobile|cell)/i.test(s)) return 'mobile';
  if (/^(l|land)/i.test(s)) return 'landline';
  if (/^(v|voip)/i.test(s)) return 'voip';
  return 'unknown';
}

/** Add numbers to a buyer, numbered after the `start` rows they already have. Positions past 3 share slot 3. */
async function savePhones(workspaceId: number, buyerId: number, phones: TraceWrite['insert'], start: number) {
  if (!supabase || !phones.length) return;
  const { error } = await supabase.from('buyer_phones').upsert(phones.map((p, i) => ({
    workspace_id: workspaceId, buyer_id: buyerId, phone: toE164(p.phone) ?? p.phone, phone_key: toE164(p.phone) ?? null,
    position: Math.min(3, start + i + 1), kind: phoneKind(p.kind), source: 'genius', is_dnc: p.dnc, is_verified: p.verified,
  })), { onConflict: 'buyer_id,phone', ignoreDuplicates: true });
  if (error) console.warn('buyer_phones', error.message);
}

/** Put a skip trace onto a buyer row: fill a blank phone and email, and keep every new number. */
export async function applyTraceToBuyer(workspaceId: number, buyerId: number, c: Candidate): Promise<{ phones: number; email: boolean; phone: boolean }> {
  const none = { phones: 0, email: false, phone: false };
  if (!supabase) return none;
  const [{ data: buyer }, { data: rows }] = await Promise.all([
    supabase.from('buyers').select('phone, email').eq('id', buyerId).eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('buyer_phones').select('phone, phone_key').eq('workspace_id', workspaceId).eq('buyer_id', buyerId),
  ]);
  const write = traceWrites(c, {
    phone: buyer?.phone ?? null,
    email: buyer?.email ?? null,
    phoneKeys: (rows ?? []).flatMap((r) => [r.phone_key, r.phone].filter((x): x is string => !!x)),
  });
  const patch: { phone?: string; email?: string; updated_at: string } = { updated_at: new Date().toISOString() };
  if (write.phone) patch.phone = write.phone;
  if (write.email) patch.email = write.email;
  if (write.phone || write.email) {
    await supabase.from('buyers').update(patch).eq('id', buyerId).eq('workspace_id', workspaceId);
  }
  // The buyer has been traced now, whatever came back.
  if (c.contacts_at) await tagBuyers([String(buyerId)], SKIPTRACE_TAG);
  if (write.insert.length) await savePhones(workspaceId, buyerId, write.insert, (rows ?? []).length);
  // Every other address the trace found goes under the main one (buyer_emails). Best effort.
  const mainEmail = write.email ?? buyer?.email ?? null;
  for (const e of emailsOf(c).filter((x) => x && x.toLowerCase() !== String(mainEmail ?? '').toLowerCase()).slice(0, 5)) {
    await addBuyerEmail(workspaceId, buyerId, mainEmail, e, 'skip trace');
  }
  return { phones: write.insert.length, email: !!write.email, phone: !!write.phone };
}
export function phonesOf(c: Candidate): (MarkedPhone & { person: string | null })[] {
  const seen = new Set<string>();
  const out: (MarkedPhone & { person: string | null })[] = [];
  for (const h of c.contacts ?? []) for (const p of h.phones as MarkedPhone[]) {
    const k = p.number.replace(/\D+/g, '');
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ...p, person: h.name });
  }
  const rank = (p: MarkedPhone) => (p.status === 'wrong' ? 3 : p.dnc ? 2 : p.status === 'good' ? 0 : /wireless|mobile|cell/i.test(p.type ?? '') ? 0.5 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

export const emailsOf = (c: Candidate) => Array.from(new Set((c.contacts ?? []).flatMap((h) => h.emails)));
