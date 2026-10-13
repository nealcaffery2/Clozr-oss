// Bulk skip trace for People (sellers) and Buyers. The trace itself is Genius
// Mode's: genius-discover's `skiptrace` action (individuals on RealEstateAPI,
// LLCs on BatchData), 90-day cache,
// the workspace's monthly credit cap. This file picks the address to trace each
// record at, says what it will cost, and writes what comes back onto the row:
// a blank phone and email are filled, and every other number is kept (a
// buyer's go to buyer_phones, a seller's to seller_phones), with the whole
// trace in a note on the record.

import type { Candidate } from '../supabase/functions/_shared/genius-core';
import { applyTraceToBuyer, skipTraceTargets, traceWrites, type SkipHit, type TraceTarget } from './genius';
import { logActivity, tagBuyers, tagSellers } from './crm-write';
import { SKIPTRACE_TAG, logRun, notifyUser } from './data-runs';
import { addSellerPhones } from './seller-phones';
import { supabase } from './supabase';

export type TraceRecord = {
  kind: 'seller' | 'buyer';
  dbId: number;
  name: string;
  company?: string | null;
  /** Where to trace: the property for a seller. Buyers are looked up (findBuyerAddresses). */
  address?: { address: string; city: string; state: string; zip: string } | null;
  mailing?: string | null;
};

export type TracePlan = {
  targets: (TraceTarget & { rec: TraceRecord })[];
  /** No address to trace at, so they are skipped. */
  noAddress: TraceRecord[];
  /** Traced in the last 90 days: free. */
  cached: number;
  /** What the run can cost at most, one credit per fresh trace. */
  credits: number;
};

export type TraceSummary = { traced: number; found: number; phones: number; emails: number; failed: number; message?: string; credits: number };

const ENTITY = /\b(llc|l\.l\.c|inc|corp|co|company|ltd|lp|llp|trust|holdings|properties|investments|capital|group|homes|realty|partners|fund|ventures|enterprises)\b\.?/i;
const keyOf = (r: TraceRecord) => `crm-${r.kind === 'seller' ? 's' : 'b'}${r.dbId}`;
const SKIP_TTL_MS = 90 * 864e5;

/** A full US address with a 5-digit ZIP, or null. */
function parseAddress(line: string): TraceRecord['address'] {
  const m = line.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2}),?\s*(\d{5})/);
  return m ? { address: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] } : null;
}

/**
 * Buyers carry no address column. Genius-found buyers keep their mailing
 * address in notes ("Mailing: …"); anyone who bought a deal from us owns that
 * property. Mailing first, since an LLC is traced where its person gets mail.
 */
export async function findBuyerAddresses(workspaceId: number, recs: TraceRecord[]): Promise<TraceRecord[]> {
  if (!supabase || !recs.length) return recs;
  const ids = recs.map((r) => r.dbId);
  const notes = new Map<number, string>();
  const bought = new Map<number, NonNullable<TraceRecord['address']>>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [b, d] = await Promise.all([
      supabase.from('buyers').select('id, notes').eq('workspace_id', workspaceId).in('id', chunk),
      supabase.from('deals').select('buyer_id, property_id').eq('workspace_id', workspaceId).in('buyer_id', chunk).not('property_id', 'is', null),
    ]);
    for (const r of b.data ?? []) if (r.notes) notes.set(r.id, r.notes);
    const props = [...new Set((d.data ?? []).map((x) => x.property_id).filter((x): x is number => x != null))];
    if (props.length) {
      const { data: p } = await supabase.from('properties').select('id, line1, city, state, zip').in('id', props);
      const byId = new Map((p ?? []).map((x) => [x.id, x]));
      for (const x of d.data ?? []) {
        const pr = x.property_id != null ? byId.get(x.property_id) : undefined;
        if (x.buyer_id != null && pr?.line1 && pr.city && pr.state && pr.zip && !bought.has(x.buyer_id)) {
          bought.set(x.buyer_id, { address: pr.line1, city: pr.city, state: pr.state, zip: pr.zip });
        }
      }
    }
  }
  return recs.map((r) => {
    const mail = notes.get(r.dbId)?.match(/Mailing:\s*([^\n]+?)\.?\s*(?:$|\n)/)?.[1] ?? null;
    return { ...r, mailing: mail && parseAddress(mail) ? mail : null, address: r.address ?? bought.get(r.dbId) ?? null };
  });
}

/** Who can be traced, and how many of them are already cached (free). */
export async function planTrace(workspaceId: number | null, recs: TraceRecord[]): Promise<TracePlan> {
  const targets: TracePlan['targets'] = [];
  const noAddress: TraceRecord[] = [];
  for (const rec of recs) {
    const where = rec.address && rec.address.address && rec.address.zip ? rec.address : null;
    if (!where && !rec.mailing) { noAddress.push(rec); continue; }
    const owner = (rec.company && ENTITY.test(rec.company) ? rec.company : rec.name).trim();
    const corporate = ENTITY.test(owner);
    targets.push({
      rec, key: keyOf(rec), owner_name: owner, corporate,
      // The person behind an entity, when the record names one.
      people: corporate ? (rec.name && !ENTITY.test(rec.name) ? [rec.name] : []) : [rec.name],
      mail_parts: rec.mailing ? null : where, mailing: rec.mailing ?? null,
    });
  }
  let cached = 0;
  if (supabase && workspaceId != null && targets.length) {
    const since = new Date(Date.now() - SKIP_TTL_MS).toISOString();
    for (let i = 0; i < targets.length; i += 100) {
      const chunk = targets.slice(i, i + 100);
      const { data } = await supabase.from('genius_skip_cache').select('owner_key')
        .eq('workspace_id', workspaceId).gte('fetched_at', since).likeAnyOf('owner_key', chunk.map((t) => `${t.key}|%`));
      cached += new Set((data ?? []).map((r) => r.owner_key.split('|')[0])).size;
    }
  }
  return { targets, noAddress, cached, credits: Math.max(0, targets.length - cached) };
}

/**
 * Fill a seller's blank phone and email, and keep every other number found on
 * their numbers (seller_phones, after the ones there, for the record and the
 * dialer). The full trace still goes in a note on the record.
 */
async function writeSeller(workspaceId: number, sellerId: number, hits: SkipHit[], userId: string | null): Promise<{ phones: number; emails: number }> {
  if (!supabase) return { phones: 0, emails: 0 };
  const { data: row } = await supabase.from('sellers').select('phone, email').eq('id', sellerId).eq('workspace_id', workspaceId).maybeSingle();
  const w = traceWrites({ contacts: hits } as unknown as Candidate, { phone: row?.phone ?? null, email: row?.email ?? null, phoneKeys: row?.phone ? [row.phone] : [] });
  const patch: { phone?: string; email?: string } = {};
  if (w.phone) patch.phone = w.phone;
  if (w.email) patch.email = w.email;
  if (Object.keys(patch).length) await supabase.from('sellers').update(patch).eq('id', sellerId).eq('workspace_id', workspaceId);
  // Not the primary (old or just filled); a registry DNC flag comes along, so the dialer skips that number.
  const kept = await addSellerPhones(workspaceId, sellerId, patch.phone ?? row?.phone ?? null,
    w.insert.map((p) => ({ phone: p.phone, kind: p.kind ? p.kind.toLowerCase() : null, dnc: p.dnc })), 'skip_trace');
  const lines = [
    ...hits.flatMap((h) => h.phones.map((p) => `${p.number}${p.type ? ` (${p.type})` : ''}${p.dnc ? ' DNC' : ''}${h.name ? `, ${h.name}` : ''}`)),
    ...hits.flatMap((h) => h.emails),
  ];
  if (lines.length) await logActivity(workspaceId, 'seller', sellerId, 'note', 'Skip trace', lines.join('\n'), userId);
  return { phones: (w.phone ? 1 : 0) + (kept.ok ? kept.added : 0), emails: w.email ? 1 : 0 };
}

/** Run the plan in batches of 10 so progress is real, writing each result back as it lands. */
export async function runTrace(
  workspaceId: number, plan: TracePlan, userId: string | null,
  onProgress: (done: number, total: number) => void,
): Promise<TraceSummary> {
  const sum: TraceSummary = { traced: 0, found: 0, phones: 0, emails: 0, failed: 0, credits: 0 };
  const total = plan.targets.length;
  // Everyone the trace reached, found or not, is tagged so the list shows who has been traced.
  const reached: { seller: string[]; buyer: string[] } = { seller: [], buyer: [] };
  for (let i = 0; i < total; i += 10) {
    const batch = plan.targets.slice(i, i + 10);
    const r = await skipTraceTargets(workspaceId, batch.map((t) => ({ key: t.key, owner_name: t.owner_name, corporate: t.corporate, people: t.people, mail_parts: t.mail_parts, mailing: t.mailing })));
    if (!r.ok) {
      // A refused key, no credits or the monthly cap stops the run; say so with the count reached.
      sum.failed += total - i;
      sum.message = r.message;
      break;
    }
    sum.credits += r.data.credits?.skiptrace ?? 0;
    for (const t of batch) {
      const res = r.data.results[t.key];
      sum.traced++;
      if (!res || 'error' in res) { sum.failed++; if (res && 'error' in res) sum.message ??= res.error; continue; }
      reached[t.rec.kind].push(String(t.rec.dbId));
      if (!res.hits.length) continue;
      sum.found++;
      if (t.rec.kind === 'buyer') {
        const w = await applyTraceToBuyer(workspaceId, t.rec.dbId, { contacts: res.hits } as unknown as Candidate);
        sum.phones += w.phones + (w.phone && !w.phones ? 1 : 0);
        sum.emails += w.email ? 1 : 0;
        const lines = [...res.hits.flatMap((h) => h.phones.map((p) => `${p.number}${p.type ? ` (${p.type})` : ''}${p.dnc ? ' DNC' : ''}${h.name ? `, ${h.name}` : ''}`)), ...res.hits.flatMap((h) => h.emails)];
        if (lines.length) await logActivity(workspaceId, 'buyer', t.rec.dbId, 'note', 'Skip trace', lines.join('\n'), userId);
      } else {
        const w = await writeSeller(workspaceId, t.rec.dbId, res.hits, userId);
        sum.phones += res.hits.reduce((a, h) => a + h.phones.length, 0) || w.phones;
        sum.emails += w.emails;
      }
    }
    onProgress(Math.min(i + batch.length, total), total);
  }
  if (reached.seller.length) await tagSellers(reached.seller, SKIPTRACE_TAG);
  if (reached.buyer.length) await tagBuyers(reached.buyer, SKIPTRACE_TAG);
  const entity = plan.targets[0]?.rec.kind ?? null;
  const who = entity === 'buyer' ? 'buyer' : 'seller';
  const n = sum.traced - sum.failed;
  await logRun(workspaceId, {
    kind: 'skiptrace', entity, label: `Skip trace · ${total} ${who}${total === 1 ? '' : 's'}`, total, succeeded: n, failed: sum.failed, credits: sum.credits,
    detail: { found: sum.found, phones: sum.phones, emails: sum.emails, ...(sum.message ? { message: sum.message } : {}) },
  });
  const single = total === 1 ? plan.targets[0].rec : null;
  await notifyUser(workspaceId, userId, {
    category: 'Skip trace',
    title: sum.traced && n ? `Skip trace finished · ${single ? single.name : `${n} ${who}${n === 1 ? '' : 's'}`}` : 'Skip trace did not run',
    body: n ? `${sum.found} with contacts found · ${sum.phones} phone${sum.phones === 1 ? '' : 's'} · ${sum.emails} email${sum.emails === 1 ? '' : 's'}${sum.failed ? ` · ${sum.failed} failed` : ''}. Tagged "${SKIPTRACE_TAG}".` : sum.message ?? 'Nothing was traced.',
    sellerId: single?.kind === 'seller' ? single.dbId : null, buyerId: single?.kind === 'buyer' ? single.dbId : null,
  });
  return sum;
}
