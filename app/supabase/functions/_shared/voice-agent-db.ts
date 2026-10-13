// Database reads the voice agent shares between /personalize (a real call)
// and voice-agent-admin's test_session (a rep hearing what the agent will
// say). One copy, so the test cannot drift from the call: the same
// candidates, DNC resolution, memory read, rep name and buildInitiation.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { rowToMemory } from '../../../lib/lead-memory.ts';
import {
  buildInitiation, NO_EXTRAS, phoneKey, phoneKeyVariants,
  type Candidate, type CallExtras, type CallLeg, type InitiationData, type MemoryForCall, type Persona, type Resolution, type SecretRow,
} from './voice-agent.ts';
import { leadSourceLabel, offerRange, pickAgent } from './voice-agent-calls.ts';
import { settingsFromRow, type AgentSettings } from './voice-agent-settings.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export const missingRelation = (msg: string) => /does not exist|schema cache|PGRST20[25]|42P01/i.test(msg);

/** Every seller and buyer on the number, with what the DNC check needs. */
export async function loadCandidates(admin: SupabaseClient, ws: number, theirs: string): Promise<Candidate[]> {
  const keys = phoneKeyVariants(theirs);
  const [s, b, bp] = await Promise.all([
    admin.from('sellers').select('id, name, tags, archived_at, assigned_to, property_address, phone, phone_key').eq('workspace_id', ws).in('phone_key', keys).limit(20),
    admin.from('buyers').select('id, name, tags, blacklisted_at, phone, phone_key, assigned_to, owner_id').eq('workspace_id', ws).in('phone_key', keys).limit(20),
    admin.from('buyer_phones').select('buyer_id, is_dnc, phone, phone_key').eq('workspace_id', ws).in('phone_key', keys).limit(20),
  ]);
  const out: Candidate[] = [];
  const sellers = ((s.data ?? []) as Any[]).filter((r) => phoneKey(r.phone_key ?? r.phone) === theirs);
  // The rep who switched the AI agent on for the seller works the call (transfer, booking), else the assigned rep.
  const starters = await agentStarters(admin, ws, 'seller', sellers.map((r) => Number(r.id)));
  for (const r of sellers) {
    out.push({ kind: 'seller', id: r.id, name: r.name, tags: r.tags, archived_at: r.archived_at, assigned_to: starters.get(Number(r.id)) ?? r.assigned_to, property_address: r.property_address });
  }
  const buyerDnc = new Map<number, boolean>();
  for (const r of (bp.data ?? []) as Any[]) {
    if (phoneKey(r.phone_key ?? r.phone) !== theirs) continue;
    buyerDnc.set(Number(r.buyer_id), (buyerDnc.get(Number(r.buyer_id)) ?? false) || !!r.is_dnc);
  }
  const buyers = ((b.data ?? []) as Any[]).filter((r) => phoneKey(r.phone_key ?? r.phone) === theirs);
  const missing = [...buyerDnc.keys()].filter((id) => !buyers.some((r) => Number(r.id) === id));
  if (missing.length) {
    const { data } = await admin.from('buyers').select('id, name, tags, blacklisted_at, assigned_to, owner_id').eq('workspace_id', ws).in('id', missing);
    buyers.push(...((data ?? []) as Any[]));
  }
  const dispo = await agentStarters(admin, ws, 'buyer', buyers.map((r) => Number(r.id)));
  for (const r of buyers) {
    out.push({
      kind: 'buyer', id: Number(r.id), name: r.name, tags: r.tags, blacklisted_at: r.blacklisted_at, number_dnc: buyerDnc.get(Number(r.id)) ?? false,
      assigned_to: dispo.get(Number(r.id)) ?? r.assigned_to ?? r.owner_id ?? null,
    });
  }
  return out;
}

/**
 * The rep working each record with an AI agent: whoever last switched an
 * agent on for it (ai_agent_enrollments.started_by). The warm transfer rings
 * them and a booking lands on their calendar. A buyer has no "assigned rep"
 * the way a seller does, so without this a buyer's booking landed in the
 * unassigned pool and a transfer rang the workspace owner; a seller falls
 * back to its assigned rep.
 */
export async function agentStarters(admin: SupabaseClient, ws: number, kind: 'seller' | 'buyer', ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  try {
    const { data } = await admin.from('ai_agent_enrollments').select('record_id, started_by, started_at').eq('workspace_id', ws).eq('record_kind', kind)
      .in('record_id', ids).not('started_by', 'is', null).order('started_at', { ascending: false }).limit(200);
    for (const r of (data ?? []) as Any[]) if (!out.has(Number(r.record_id))) out.set(Number(r.record_id), String(r.started_by));
  } catch { /* best effort: the buyer's own rep or owner is used instead */ }
  return out;
}

export async function loadMemory(admin: SupabaseClient, ws: number, c: Candidate) {
  const { data } = await admin.from('lead_memory').select('*').eq('workspace_id', ws).eq('record_kind', c.kind).eq('record_id', c.id).maybeSingle();
  return rowToMemory(data);
}

/** The assigned rep's first name and phone (profiles), for {{rep_name}} and a rep-assigned transfer. */
export async function loadRep(admin: SupabaseClient, userId: string | null | undefined): Promise<{ name: string | null; phone: string | null }> {
  if (!userId) return { name: null, phone: null };
  const { data } = await admin.from('profiles').select('full_name, phone').eq('id', userId).maybeSingle();
  const first = String(data?.full_name ?? '').trim().split(/\s+/)[0];
  const phone = String(data?.phone ?? '').replace(/[^\d+]/g, '');
  return { name: first || null, phone: phone || null };
}

/** A US number as E.164 for the transfer ("5125550100" and "15125550100" become "+15125550100"); null when it is not one. */
export function e164(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (String(raw ?? '').trim().startsWith('+') && d.length >= 10 && d.length <= 15) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

/**
 * A member's own line from rep_phone_numbers (migration 153: their smrtPhone
 * number), for when their profile has no phone. A "Main" line wins, a "test"
 * line loses. Null when they have none (or the table is not there).
 */
export async function loadRepLine(admin: SupabaseClient, ws: number, userId: string): Promise<string | null> {
  const { data, error } = await admin.from('rep_phone_numbers').select('phone_e164, label').eq('workspace_id', ws).eq('user_id', userId).limit(10);
  if (error) { if (!missingRelation(error.message)) console.error('voice-agent rep line', error.message); return null; }
  const rank = (l: unknown) => (/\bmain\b/i.test(String(l ?? '')) ? 0 : /\btest\b/i.test(String(l ?? '')) ? 2 : 1);
  const best = ((data ?? []) as Any[]).filter((r) => r.phone_e164).sort((a, b) => rank(a.label) - rank(b.label))[0];
  return best ? String(best.phone_e164) : null;
}

/**
 * Who a live transfer to "the assigned rep" rings, and on what number: the
 * rep (their profile phone, else their own line), else the workspace owner
 * (the same fallback a booking's notification uses), so a lead with no rep
 * can still be handed to a person. Null when nobody has a number.
 */
export async function loadTransferTarget(admin: SupabaseClient, ws: number, assignedTo: string | null | undefined): Promise<{ userId: string; phone: string } | null> {
  const reach = async (userId: string) => e164((await loadRep(admin, userId)).phone) ?? await loadRepLine(admin, ws, userId);
  if (assignedTo) {
    const phone = await reach(assignedTo);
    if (phone) return { userId: assignedTo, phone };
  }
  const { data: w } = await admin.from('workspaces').select('owner_id').eq('id', ws).maybeSingle();
  const owner = ((w as Any)?.owner_id ?? null) as string | null;
  if (!owner || owner === assignedTo) return null;
  const phone = await reach(owner);
  return phone ? { userId: owner, phone } : null;
}

/**
 * Whether the rep can take a warm transfer now: nothing on their calendar
 * from 5 minutes ago to 10 minutes ahead. A read error says yes; the
 * transfer's own no-answer fallback (book a time) still covers them.
 */
export async function repFreeNow(admin: SupabaseClient, ws: number, userId: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const ahead = new Date(nowMs + 10 * 60_000).toISOString();
    const back = new Date(nowMs - 5 * 60_000).toISOString();
    // No end time reads as 30 minutes long.
    const backOpen = new Date(nowMs - 35 * 60_000).toISOString();
    // Any appointment overlapping the window, however long ago it started (an all-day block too).
    // Values in an or() tree are double-quoted: a timestamp's ':' and '.' are PostgREST syntax there.
    const { data, error } = await admin.from('appointments').select('id').eq('workspace_id', ws).eq('assigned_to', userId).is('deleted_at', null)
      .lte('starts_at', ahead).or(`ends_at.gt."${back}",and(ends_at.is.null,starts_at.gt."${backOpen}")`).limit(1);
    if (error) return true;
    return !(data ?? []).length;
  } catch {
    return true;
  }
}

/** The ceiling the Compr underwrite left on the seller's latest deal. */
export async function loadDealMao(admin: SupabaseClient, ws: number, sellerId: number): Promise<number | null> {
  const { data } = await admin.from('deals').select('mao').eq('workspace_id', ws).eq('seller_id', sellerId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  const n = Number((data as Any)?.mao);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const fmtMoney = (n: unknown) => { const x = Number(n); return Number.isFinite(x) && x > 0 ? '$' + Math.round(x).toLocaleString('en-US') : ''; };

/**
 * The initiation payload for a resolved caller: reads the memory, the assigned
 * rep and (for a seller, when the agent may make offers) the offer range only
 * when exactly one person matched, then buildInitiation. /personalize and the
 * admin test both end here. `agent` is the agent's LIVE settings, or null for
 * a caller no agent claims (env-secret path): then nothing agent-specific is
 * added and the output is what it was before agents existed. `callGoal` is
 * the AI agent's reason for a call it placed itself (ai-agent); empty otherwise.
 */
export async function initiationFor(
  admin: SupabaseClient, ws: number, res: Resolution, leg: CallLeg | null, persona: Omit<Persona, 'repName'>, agent: AgentSettings | null = null,
  callGoal = '',
): Promise<InitiationData> {
  let mem: MemoryForCall = null;
  let extras: CallExtras = NO_EXTRAS;
  let repName: string | null = null;
  if (res.status === 'one') {
    const c = res.match;
    const [m, rep, target, mao, src] = await Promise.all([
      loadMemory(admin, ws, c), loadRep(admin, c.assigned_to), loadTransferTarget(admin, ws, c.assigned_to),
      agent && agent.offer_authority.mode !== 'none' && c.kind === 'seller' ? loadDealMao(admin, ws, c.id) : Promise.resolve(null),
      c.kind === 'seller' ? admin.from('sellers').select('lead_source').eq('id', c.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    mem = m;
    repName = rep.name;
    const facts = m?.facts as unknown as { asking_price?: number | null } | undefined;
    extras = {
      ...NO_EXTRAS,
      rep_phone: target?.phone ?? '',
      rep_available: target && await repFreeNow(admin, ws, target.userId) ? 'yes' : 'no',
      lead_source: leadSourceLabel((src.data as Any)?.lead_source, leg?.direction ?? 'inbound'),
      seller_asking_price: fmtMoney(facts?.asking_price),
      ...(agent ? offerRange(agent.offer_authority, mao) : { offer_low: '', offer_high: '' }),
      call_goal: callGoal.replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  }
  return buildInitiation(res, leg, mem, { ...persona, repName, casual: persona.casual ?? (!!agent && agent.personality.formality <= 2) }, extras);
}

export type AgentRow = {
  workspace_id: number; agent_key: string; agent_id: string | null; status: string; enabled: boolean; live_version: number;
  live_settings: AgentSettings | null;
};

/**
 * The agent a webhook payload is for (see pickAgent), with its LIVE settings:
 * what was last published, never an unpublished draft. Null when no agent
 * claims the call, which callers treat as "behave as before agents existed".
 */
export async function loadAgentFor(admin: SupabaseClient, agentId: string | null | undefined, pinnedWs: number | null): Promise<AgentRow | null> {
  try {
    const cols = 'workspace_id, agent_key, agent_id, status, enabled, live_version, live_settings';
    const byId = agentId ? await admin.from('voice_agent_settings').select(cols).eq('agent_id', agentId).limit(5) : { data: [], error: null };
    const inWs = pinnedWs != null && !(byId.data ?? []).length ? await admin.from('voice_agent_settings').select(cols).eq('workspace_id', pinnedWs).limit(20) : { data: [], error: null };
    if (byId.error || inWs.error) {
      const msg = (byId.error ?? inWs.error)!.message;
      if (!missingRelation(msg)) console.error('voice-agent agent lookup', msg);
      return null;
    }
    const norm = (r: Any): AgentRow => ({
      workspace_id: Number(r.workspace_id), agent_key: String(r.agent_key), agent_id: r.agent_id ?? null, status: String(r.status ?? 'draft'), enabled: r.enabled !== false,
      live_version: Number(r.live_version ?? 0), live_settings: r.live_settings ? settingsFromRow(r.live_settings) : null,
    });
    return pickAgent(((byId.data ?? []) as Any[]).map(norm), ((inWs.data ?? []) as Any[]).map(norm), pinnedWs);
  } catch (e) {
    console.error('voice-agent agent lookup', String(e));
    return null;
  }
}

/**
 * Every stored secret row. A database without migration 111 (or an error)
 * reads as no rows, so the env-var secrets keep working exactly as before.
 */
export async function loadSecretRows(admin: SupabaseClient): Promise<SecretRow[]> {
  try {
    const { data, error } = await admin.from('voice_agent_secrets').select('workspace_id, personalize_secret, tool_secret, webhook_secret');
    if (error) {
      if (!missingRelation(error.message)) console.error('voice-agent secrets', error.message);
      return [];
    }
    return ((data ?? []) as Any[]).map((r) => ({
      workspace_id: Number(r.workspace_id), personalize_secret: r.personalize_secret, tool_secret: r.tool_secret, webhook_secret: r.webhook_secret,
    }));
  } catch (e) {
    console.error('voice-agent secrets', String(e));
    return [];
  }
}
