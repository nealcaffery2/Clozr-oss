// Picking up for reps on no answer (docs/voice-agent.md, "Picking up for reps").
//
// Talkr rings the rep; when they do not pick up it dials the caller on to the
// AI agent's line and first posts a `call.overflow` notice to our Talkr webhook,
// which lands here as a voice_agent_overflow row. /personalize reads that row
// (loadOverflow) so the agent greets as covering for the rep and hands the
// call back to them. Publish keeps Talkr's per-line overflow target in step
// with the agents that have the switch on (syncOverflowLines).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { phoneKey } from './voice-agent.ts';
import type { AgentSettings } from './voice-agent-settings.ts';
import { activeTalkrBinding } from './talkr-binding.ts';
import { loadTalkrConnections } from './talkr-connect.ts';
import { partnerToken, TALKR_DEFAULT_URL } from './talkr-outreach.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export type Team = 'acquisitions' | 'dispositions' | 'lead_manager';

/**
 * A teammate's team, read from their profile title ("Dispositions", "Acq
 * Manager", "Lead Manager"). Null for no title at all; 'other' for a title
 * that names none of the three (CEO, TC, Head of Partnerships).
 */
export function teamOfTitle(title: string | null | undefined): Team | 'other' | null {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/dispo/.test(t)) return 'dispositions';
  if (/acq/.test(t)) return 'acquisitions';
  if (/lead\s*(manager|mgr)/.test(t)) return 'lead_manager';
  return 'other';
}

/** The team an agent role covers; null for a role that picks up for nobody. */
export function teamOfRole(role: string): Team | null {
  if (role === 'buyer_assistant' || role === 'jr_dispo') return 'dispositions';
  if (role === 'acquisitions') return 'acquisitions';
  if (role === 'lead_manager') return 'lead_manager';
  return null;
}

/**
 * Does this agent pick up for a teammate with this title? Acquisitions and
 * dispo agents cover their own team; the lead manager covers teammates with
 * no team on their title. A title that names another job is covered by nobody.
 */
export function coversTitle(role: string, title: string | null | undefined): boolean {
  const team = teamOfRole(role);
  if (!team) return false;
  const theirs = teamOfTitle(title);
  return theirs === team || (team === 'lead_manager' && theirs === null);
}

export type OverflowSetting = AgentSettings['call_handling']['overflow'];
export type LinePatch = { phone_e164: string; overflow_to_e164: string; ring_timeout_seconds: number | null };

/**
 * What Talkr's per-line overflow should be after this publish: every covered
 * rep's line points at the agent's number while the switch is on; a line the
 * agent covered before (`prevLines`) and no longer does is cleared. A line
 * CLOZR tracks as an AI line is never a target.
 */
export function overflowLinePatches(
  on: OverflowSetting,
  agentNumber: string | null,
  covered: { phone_e164: string; label?: string | null }[],
  prevLines: string[],
): LinePatch[] {
  const now = new Set<string>();
  const out: LinePatch[] = [];
  if (on.enabled && agentNumber) {
    for (const l of covered) {
      if (/^AI\s*·/i.test(String(l.label ?? '').trim())) continue;
      if (now.has(l.phone_e164)) continue;
      now.add(l.phone_e164);
      out.push({ phone_e164: l.phone_e164, overflow_to_e164: agentNumber, ring_timeout_seconds: on.ring_seconds });
    }
  }
  for (const p of prevLines) if (!now.has(p)) out.push({ phone_e164: p, overflow_to_e164: '', ring_timeout_seconds: null });
  return out;
}

export type Overflow = { rep_id: string | null; rep_line: string | null; reason: string | null };

/** How long a Talkr overflow notice stays good for: the forwarded call connects within seconds of it. */
export const OVERFLOW_TTL_MS = 10 * 60_000;

/**
 * The overflow Talkr announced for this caller on this AI line, if it is
 * recent: /personalize then knows the agent is covering for `rep_id`.
 */
export async function loadOverflow(admin: SupabaseClient, ws: number, ours: string | null | undefined, theirs: string, nowMs = Date.now()): Promise<Overflow | null> {
  const o = phoneKey(ours);
  const t = phoneKey(theirs);
  if (!o || !t) return null;
  try {
    const { data, error } = await admin.from('voice_agent_overflow').select('rep_id, rep_line, reason, created_at').eq('workspace_id', ws).eq('caller_key', t).eq('line_key', o).maybeSingle();
    if (error || !data) return null;
    const at = Date.parse(String((data as Any).created_at ?? ''));
    if (!Number.isFinite(at) || nowMs - at > OVERFLOW_TTL_MS) return null;
    return { rep_id: (data as Any).rep_id ?? null, rep_line: (data as Any).rep_line ?? null, reason: (data as Any).reason ?? null };
  } catch {
    return null;
  }
}

const toE164Loose = (raw: string | null | undefined): string | null => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d.length >= 10 ? '+' + d : null;
};

export type OverflowNotice = { from?: string; to?: string; overflow_to?: string; partner_subject?: string | null; call_id?: string; reason?: string };

/** Talkr's call.overflow notice, as talkr-webhook stores it. The rep is the line's owner here, else the partner id Talkr sent. Returns a note on failure. */
export async function storeOverflow(admin: SupabaseClient, ws: number, n: OverflowNotice): Promise<string | null> {
  const caller = phoneKey(n.from);
  const line = phoneKey(n.overflow_to);
  if (!caller || !line) return 'overflow notice without a caller or an overflow line';
  let rep: string | null = null;
  const repLine = toE164Loose(n.to);
  if (repLine) {
    const { data } = await admin.from('rep_phone_numbers').select('user_id').eq('workspace_id', ws).eq('phone_e164', repLine).maybeSingle();
    rep = ((data as Any)?.user_id ?? null) as string | null;
  }
  if (!rep && n.partner_subject && /^[0-9a-f-]{36}$/i.test(n.partner_subject)) {
    const { data } = await admin.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', n.partner_subject).maybeSingle();
    rep = ((data as Any)?.user_id ?? null) as string | null;
  }
  const { error } = await admin.from('voice_agent_overflow').upsert({
    workspace_id: ws, caller_key: caller, line_key: line, rep_id: rep, rep_line: repLine, talkr_call_id: n.call_id ?? null, reason: n.reason ?? null, created_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,caller_key,line_key' });
  return error ? error.message : null;
}

/**
 * The lines this agent covers today: every rep_phone_numbers row of a
 * teammate whose title the agent's role covers.
 */
export async function coveredLines(admin: SupabaseClient, ws: number, role: string): Promise<{ phone_e164: string; label: string | null; user_id: string }[]> {
  const { data: members } = await admin.from('workspace_members').select('user_id').eq('workspace_id', ws);
  const ids = ((members ?? []) as Any[]).map((m) => String(m.user_id));
  if (!ids.length) return [];
  const { data: people } = await admin.from('profiles').select('id, title').in('id', ids);
  const covered = new Set(((people ?? []) as Any[]).filter((p) => coversTitle(role, p.title)).map((p) => String(p.id)));
  if (!covered.size) return [];
  const { data: lines } = await admin.from('rep_phone_numbers').select('phone_e164, label, user_id').eq('workspace_id', ws).in('user_id', [...covered]);
  return ((lines ?? []) as Any[]).map((l) => ({ phone_e164: String(l.phone_e164), label: l.label ?? null, user_id: String(l.user_id) }));
}

/** The agent's own live number: the first live local presence number it answers. */
export async function agentNumber(admin: SupabaseClient, ws: number, agentKey: string): Promise<string | null> {
  const { data } = await admin.from('voice_agent_numbers').select('phone_number').eq('workspace_id', ws).eq('answer_agent_key', agentKey).eq('status', 'active').not('phone_number', 'is', null).order('id').limit(1).maybeSingle();
  return ((data as Any)?.phone_number ?? null) as string | null;
}

export type SyncResult = { set: string[]; cleared: string[]; errors: string[] };

/**
 * Tell Talkr which lines overflow to this agent (PATCH /v1/numbers/:id with
 * the owner's partner token). `prev` is the agent's previous live settings,
 * so switching the pick-up off, or a title change, clears the lines it held.
 * Every failure is a note in `errors`; nothing here throws.
 */
export async function syncOverflowLines(admin: SupabaseClient, ws: number, agentKey: string, settings: AgentSettings, prev: AgentSettings | null): Promise<SyncResult> {
  const out: SyncResult = { set: [], cleared: [], errors: [] };
  const on = settings.call_handling.overflow;
  const wasOn = !!prev?.call_handling.overflow.enabled;
  if (!on.enabled && !wasOn) return out;
  try {
    const [number, covered, prevCovered] = await Promise.all([
      agentNumber(admin, ws, agentKey),
      on.enabled ? coveredLines(admin, ws, settings.identity.role) : Promise.resolve([]),
      wasOn ? coveredLines(admin, ws, prev!.identity.role) : Promise.resolve([]),
    ]);
    if (on.enabled && !number) { out.errors.push('This agent has no live number yet, so no line can overflow to it. Buy and wire a local presence number, then publish again.'); return out; }
    const patches = overflowLinePatches(on, number, covered, prevCovered.map((l) => l.phone_e164));
    if (!patches.length) return out;
    const { data: w } = await admin.from('workspaces').select('id, owner_id, settings').eq('id', ws).maybeSingle();
    if (!w) { out.errors.push('workspace not found'); return out; }
    const binding = activeTalkrBinding(w as Any, (await loadTalkrConnections(admin, [ws]))[0] ?? null);
    if (!binding) { out.errors.push('Talkr is not connected to this workspace, so the reps\' lines were not told to overflow.'); return out; }
    const { data: owner } = await admin.from('profiles').select('email').eq('id', (w as Any).owner_id).maybeSingle();
    const token = await partnerToken({ id: String((w as Any).owner_id), email: ((owner as Any)?.email ?? null) as string | null });
    if (!token) { out.errors.push('Talkr partner token unavailable (TALKR_PARTNER_JWT_SECRET), so the reps\' lines were not told to overflow.'); return out; }
    const base = String(((w as Any).settings as { talkr_url?: string } | null)?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const res = await fetch(`${base}/v1/numbers`, { headers });
    const body = await res.json().catch(() => ({})) as Any;
    if (!res.ok) { out.errors.push(`Talkr would not list the numbers (${res.status})`); return out; }
    const list: Any[] = Array.isArray(body) ? body : Array.isArray(body?.numbers) ? body.numbers : [];
    const idOf = new Map(list.map((n) => [String(n.phone_e164 ?? ''), String(n.id ?? '')]));
    for (const p of patches) {
      const id = idOf.get(p.phone_e164);
      if (!id) { if (p.overflow_to_e164) out.errors.push(`${p.phone_e164} is not on Talkr, so it cannot overflow.`); continue; }
      const r = await fetch(`${base}/v1/numbers/${encodeURIComponent(id)}`, { method: 'PATCH', headers, body: JSON.stringify({ overflow_to_e164: p.overflow_to_e164, ring_timeout_seconds: p.ring_timeout_seconds }) });
      if (!r.ok) { out.errors.push(`Talkr refused the overflow on ${p.phone_e164} (${r.status})`); continue; }
      (p.overflow_to_e164 ? out.set : out.cleared).push(p.phone_e164);
    }
  } catch (e) {
    out.errors.push(`Talkr overflow sync failed: ${String((e as Error)?.message ?? e)}`);
  }
  return out;
}
