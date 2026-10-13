// The rows behind "Clozr for today" (lib/focus.ts), read as the caller.
//
// Every query runs on the caller's JWT, so RLS decides what a rep can see;
// the rules in lib/focus.ts turn the rows into the list. clozr-today shows
// it, and ask-clozr's todays_focus tool answers from the same list, so the
// Today screen and "what should I focus on today" never disagree.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { COLD_DAYS, STALE_DEAL_DAYS, CLOSING_DAYS, focusCandidates, type FocusDealRow, type FocusItem, type FocusLeadRow } from '../../../lib/focus.ts';
import { isDoNotEngage } from '../../../lib/blacklist.ts';
import { localMidnightIso } from '../../../lib/rvm.ts';
import { ACTIVE_DEAL_STAGES, sellerStageGroup } from '../../../lib/stages.ts';
import { notMine, workPool } from '../../../lib/seat.ts';

export const FOCUS_TZ = 'America/Chicago';

// lib/today.ts's new-lead stages (call-outcomes NEW_LIVE), as ask-clozr keeps them.
const NEW_STAGES = ['None', 'Self Generated', 'Lead'];
/** Deal stages before a buyer is on it: a deal sitting here is a deal nobody is selling. */
const NO_BUYER_STAGES = ['Under Contract Seller', 'Ready To Market'];
const POOL_HOURS = 72;
const WORKING = new Set(['lead', 'working', 'offer']);

type Row = Record<string, unknown>;
const one = <T,>(v: unknown): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) as T | null;
const addressOf = (p: { line1?: string | null; city?: string | null } | null) => [p?.line1, p?.city].filter(Boolean).join(', ') || null;

/**
 * Every focus candidate for this rep, in the rules' order (lib/focus.ts
 * focusCandidates). Only their own work: their tasks, appointments and leads;
 * deals they own, sell (dispo_rep_id) or close (tc_rep_id). The unassigned
 * new-lead pool only for an acquisitions seat (lib/today workPool).
 */
export async function loadFocus(db: SupabaseClient, ws: number, userId: string, now = new Date(), tz = FOCUS_TZ, role: string | null = null): Promise<FocusItem[]> {
  const mineDeal = `owner_id.eq.${userId},dispo_rep_id.eq.${userId},tc_rep_id.eq.${userId}`;
  const dayStart = localMidnightIso(now, tz);
  // ponytail: midnight + 24h is an hour off on DST change days.
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const closeBy = new Date(now.getTime() + (CLOSING_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);

  const [tasks, appts, fresh, mine, closings, stale] = await Promise.all([
    db.from('tasks').select('id, title, task_type, due_at, seller_id, deal_id, sellers(name, tags)')
      .eq('workspace_id', ws).eq('done', false).eq('assigned_to', userId)
      .not('due_at', 'is', null).lt('due_at', dayEnd).order('due_at', { ascending: true }).limit(100),
    db.from('appointments').select('id, title, starts_at, seller_id, location, sellers(name, tags)')
      .eq('workspace_id', ws).is('deleted_at', null).gte('starts_at', dayStart).lt('starts_at', dayEnd)
      .or(`assigned_to.eq.${userId},and(assigned_to.is.null,created_by.eq.${userId})`)
      .order('starts_at', { ascending: true }).limit(20),
    workPool(role)
      ? db.from('sellers').select('id, name, lead_stage, motivation, property_address, source, tags, created_at')
        .eq('workspace_id', ws).is('archived_at', null).is('assigned_to', null).in('lead_stage', NEW_STAGES)
        .gte('created_at', iso(POOL_HOURS * 3_600_000)).order('created_at', { ascending: true }).limit(40)
      : Promise.resolve({ data: [], error: null }),
    db.from('sellers').select('id, name, lead_stage, motivation, property_address, tags, created_at')
      .eq('workspace_id', ws).is('archived_at', null).eq('assigned_to', userId)
      .lt('created_at', iso(COLD_DAYS * 86_400_000))
      .order('stage_entered_at', { ascending: false }).limit(400),
    db.from('deals').select('id, stage, close_date, stage_entered_at, offer_amount, seller_id, properties(line1, city), sellers(name)')
      .eq('workspace_id', ws).eq('terminated', false).is('archived_at', null).in('stage', ACTIVE_DEAL_STAGES).or(mineDeal)
      .not('close_date', 'is', null).lte('close_date', closeBy).order('close_date', { ascending: true }).limit(15),
    db.from('deals').select('id, stage, close_date, stage_entered_at, offer_amount, seller_id, properties(line1, city), sellers(name)')
      .eq('workspace_id', ws).eq('terminated', false).is('archived_at', null).in('stage', NO_BUYER_STAGES).is('buyer_id', null).or(mineDeal)
      .lt('stage_entered_at', iso(STALE_DEAL_DAYS * 86_400_000)).order('stage_entered_at', { ascending: true }).limit(15),
  ]);
  for (const r of [tasks, appts, fresh, mine, closings, stale]) if (r.error) throw r.error;

  const sellerOf = (r: Row) => one<{ name?: string; tags?: string[] }>(r.sellers);
  const dne = (r: Row) => { const s = sellerOf(r); return !!s && isDoNotEngage({ ...s, tags: s.tags ?? [] }); };

  // New leads: nobody has ever contacted them.
  const freshRows = ((fresh.data ?? []) as Row[]).filter((p) => !isDoNotEngage(p as { tags?: string[] }));
  const { data: freshComms } = freshRows.length
    ? await db.from('communications').select('seller_id').eq('workspace_id', ws).in('seller_id', freshRows.map((p) => p.id as number)).neq('channel', 'note')
    : { data: [] };
  const contacted = new Set((freshComms ?? []).map((c: Row) => c.seller_id));
  const newLeads: FocusLeadRow[] = freshRows.filter((p) => !contacted.has(p.id)).map((p) => ({
    id: p.id as number, name: String(p.name ?? ''), lead_stage: p.lead_stage as string, motivation: p.motivation as string | null,
    property_address: p.property_address as string | null, last_touch_at: null, created_at: p.created_at as string, source: p.source as string | null,
  }));

  // Going cold: mine, still being worked, nothing in the last three days.
  const working = ((mine.data ?? []) as Row[]).filter((p) => WORKING.has(sellerStageGroup(String(p.lead_stage ?? ''))) && !isDoNotEngage(p as { tags?: string[] }));
  let coldLeads: FocusLeadRow[] = [];
  if (working.length) {
    const ids = working.map((p) => p.id as number);
    const { data: recent } = await db.from('communications').select('seller_id')
      .eq('workspace_id', ws).in('seller_id', ids).neq('channel', 'note').gte('occurred_at', iso(COLD_DAYS * 86_400_000));
    const warm = new Set((recent ?? []).map((c: Row) => c.seller_id));
    const quiet = working.filter((p) => !warm.has(p.id)).slice(0, 80);
    const last = new Map<number, string>();
    if (quiet.length) {
      const { data: comms } = await db.from('communications').select('seller_id, occurred_at')
        .eq('workspace_id', ws).in('seller_id', quiet.map((p) => p.id as number)).neq('channel', 'note')
        .order('occurred_at', { ascending: false }).limit(1000);
      for (const c of (comms ?? []) as Row[]) if (!last.has(c.seller_id as number)) last.set(c.seller_id as number, c.occurred_at as string);
    }
    coldLeads = quiet.map((p) => ({
      id: p.id as number, name: String(p.name ?? ''), lead_stage: p.lead_stage as string, motivation: p.motivation as string | null,
      property_address: p.property_address as string | null, last_touch_at: last.get(p.id as number) ?? null, created_at: p.created_at as string,
    }));
  }

  const deal = (r: Row): FocusDealRow => ({
    id: r.id as number, stage: String(r.stage ?? ''), close_date: r.close_date as string | null, stage_entered_at: r.stage_entered_at as string | null,
    address: addressOf(one(r.properties)), seller_id: r.seller_id as number | null, seller_name: sellerOf(r)?.name ?? null, offer_amount: r.offer_amount as number | null,
  });

  return focusCandidates({
    now, tz,
    tasks: ((tasks.data ?? []) as Row[]).filter((t) => !notMine(role).test(String(t.task_type ?? '')) && !dne(t)).map((t) => ({
      id: t.id as number, title: String(t.title ?? 'Task'), task_type: t.task_type as string | null, due_at: t.due_at as string | null,
      seller_id: t.seller_id as number | null, deal_id: t.deal_id as number | null, seller_name: sellerOf(t)?.name ?? null,
    })),
    appointments: ((appts.data ?? []) as Row[]).filter((a) => !dne(a)).map((a) => ({
      id: a.id as number, title: String(a.title ?? 'Appointment'), starts_at: String(a.starts_at), seller_id: a.seller_id as number | null,
      seller_name: sellerOf(a)?.name ?? null, location: a.location as string | null,
    })),
    newLeads, coldLeads,
    closings: ((closings.data ?? []) as Row[]).map(deal),
    staleDeals: ((stale.data ?? []) as Row[]).map(deal),
  });
}
