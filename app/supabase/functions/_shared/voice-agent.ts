// Pure helpers for the voice-agent function (ElevenLabs Agents webhooks):
// who is on the line, what the agent should know and say first, whether it
// may engage at all, the post-call transcript as a communications row, and
// the post-call HMAC check. No I/O here, so voice-agent.test.ts runs them
// under tsx or deno.
//
// Shapes are ElevenLabs' own, from their docs (fetched 2026-09-29):
//   Conversation initiation webhook request/response:
//     https://elevenlabs.io/docs/eleven-agents/customization/personalization.md
//     https://elevenlabs.io/docs/eleven-agents/customization/personalization/twilio-personalization.md
//   Dynamic variables (every variable the agent defines must be returned):
//     https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables.md
//   Post-call webhook payload (post_call_transcription, transcript turns,
//   metadata.phone_call, analysis.transcript_summary):
//     https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks.md
//     https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get.md
//   HMAC: the docs defer to the SDK's constructEvent. @elevenlabs/elevenlabs-js
//   2.70.0 wrapper/webhooks.js: header `ElevenLabs-Signature: t=<unix>,v0=<hex>`,
//   v0 = hex HMAC-SHA256(secret, `${t}.${rawBody}`), rejected when t is more
//   than 30 minutes old. https://elevenlabs.io/docs/eleven-api/resources/webhooks.md
import { isDoNotEngage as isBlockedRecord } from '../../../lib/blacklist.ts';
import type { LeadFacts } from '../../../lib/lead-memory.ts';
import { classifyCall, type CallFlags } from './voice-agent-classify.ts';

/** The last ten digits of a North American number: how sellers.phone_key / buyers.phone_key are compared (call-sync). */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.slice(-10);
}

/** +1XXXXXXXXXX for a North American number, else + and the digits; null when there is no number. */
export function toE164(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d.length >= 8 ? '+' + d : null;
}

/** Every stored spelling of one phone_key the database might hold. */
export function phoneKeyVariants(key: string): string[] {
  return [key, '1' + key, '+1' + key];
}

export type CallLeg = { direction: 'inbound' | 'outbound'; ours: string; theirs: string };

/**
 * Which end is us. Inbound: caller_id is them, called_number is our line.
 * Outbound (ElevenLabs dials): caller_id is our line and called_number is
 * them. `ourKeys` are phone keys of the workspace's caller_lines.
 */
export function callLeg(callerId: string | null | undefined, calledNumber: string | null | undefined, ourKeys: Set<string>): CallLeg | null {
  const caller = phoneKey(callerId);
  const called = phoneKey(calledNumber);
  if (called && ourKeys.has(called) && caller) return { direction: 'inbound', ours: called, theirs: caller };
  if (caller && ourKeys.has(caller) && called) return { direction: 'outbound', ours: caller, theirs: called };
  return null;
}

export type Candidate = {
  kind: 'seller' | 'buyer';
  id: number;
  name: string | null;
  tags?: string[] | null;
  /** Buyers: blacklisted from the Genius profile. */
  blacklisted_at?: string | null;
  /** buyer_phones.is_dnc on the matching number. */
  number_dnc?: boolean | null;
  archived_at?: string | null;
  assigned_to?: string | null;
  property_address?: string | null;
};

/** DNC tag, the secret blacklist, a blacklisted buyer or a DNC-flagged number. */
export function isDoNotEngage(c: Candidate): boolean {
  return isBlockedRecord(c) || !!c.number_dnc;
}

export type Resolution =
  | { status: 'blocked'; matches: Candidate[] }
  | { status: 'one'; match: Candidate }
  | { status: 'none' }
  | { status: 'many'; matches: Candidate[] };

/**
 * One person or not. Any match on a do-not-contact list blocks the whole
 * number: a shared line is still a line someone asked us not to call.
 * Archived sellers count toward the block but never as the match. A seller
 * wins over a buyer with the same number only when the seller is the sole
 * seller, since that is how call-sync files it.
 */
export function resolveCaller(candidates: Candidate[]): Resolution {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) seen.set(`${c.kind}:${c.id}`, { ...c, number_dnc: c.number_dnc || seen.get(`${c.kind}:${c.id}`)?.number_dnc });
  const all = [...seen.values()];
  const blocked = all.filter(isDoNotEngage);
  if (blocked.length) return { status: 'blocked', matches: blocked };
  const live = all.filter((c) => !c.archived_at);
  const sellers = live.filter((c) => c.kind === 'seller');
  if (sellers.length === 1) return { status: 'one', match: sellers[0] };
  if (sellers.length > 1) return { status: 'many', matches: sellers };
  if (live.length === 1) return { status: 'one', match: live[0] };
  if (live.length > 1) return { status: 'many', matches: live };
  return { status: 'none' };
}

export type Persona = {
  agentName: string | null; company: string; repName: string | null;
  /** 'virtual_assistant' says so in the first line ("a virtual assistant with X"). */
  introduceAs?: 'none' | 'virtual_assistant';
  /** Said at the end of the first line when the workspace's agent has the recording notice on. */
  recordingNotice?: string | null;
  /** Casual agents (formality 1 or 2) answer "how can I help ya?" instead of "Who am I speaking with?". */
  casual?: boolean;
};

/** The per-call values only some agents use (offer range, rep line, lead source). '' when unknown or not allowed. */
export type CallExtras = {
  rep_phone: string; lead_source: string; property_facts: string; mortgage_payoff_estimate: string;
  offer_low: string; offer_high: string; seller_asking_price: string;
  /** Why we are calling: the AI agent's plan step on a call it placed itself (ai-agent). Empty on every other call. */
  call_goal: string;
  /** 'yes' when the rep a warm transfer rings has a number and nothing on their calendar right now; 'no' otherwise ('' unknown caller). */
  rep_available: string;
};
export const NO_EXTRAS: CallExtras = { rep_phone: '', lead_source: '', property_facts: '', mortgage_payoff_estimate: '', offer_low: '', offer_high: '', seller_asking_price: '', call_goal: '', rep_available: '' };

export type MemoryForCall = { brief: string; facts: Pick<LeadFacts, 'first_name' | 'preferred_name' | 'property_address' | 'last_contact_summary' | 'next_step'> } | null;

/** Every dynamic variable the agent is configured with. The docs require all of them in every response. */
export const DYNAMIC_VARIABLES = [
  'first_name', 'property_address', 'lead_brief', 'last_contact_summary', 'next_step', 'rep_name', 'company', 'agent_name',
  'caller_known', 'do_not_engage', 'record_kind',
  'rep_phone', 'lead_source', 'property_facts', 'mortgage_payoff_estimate', 'offer_low', 'offer_high', 'seller_asking_price',
  'call_goal', 'rep_available',
] as const;

export type InitiationData = {
  type: 'conversation_initiation_client_data';
  dynamic_variables: Record<(typeof DYNAMIC_VARIABLES)[number], string | boolean>;
  conversation_config_override: { agent: { first_message: string } };
};

const clean = (s: string | null | undefined, max = 1200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function intro(p: Persona): string {
  const who = p.introduceAs === 'virtual_assistant' ? 'a virtual assistant with' : p.casual ? 'from' : 'with';
  return p.agentName ? `this is ${p.agentName}${p.introduceAs === 'virtual_assistant' ? ', ' : ' '}${who} ${p.company}` : `you've reached ${p.company}`;
}

/**
 * The conversation initiation response. Blocked: nothing about the person,
 * do_not_engage=true and a neutral opener; the agent prompt must end or
 * transfer on it. Unknown or ambiguous: no name, and the opener asks who is
 * calling. One match: their name, the brief and the next step.
 */
export function buildInitiation(res: Resolution, leg: CallLeg | null, mem: MemoryForCall, p: Persona, extras: CallExtras = NO_EXTRAS): InitiationData {
  const known = res.status === 'one';
  const facts = known && mem ? mem.facts : null;
  const first = known ? clean(facts?.preferred_name || facts?.first_name || firstWord(res.match.name), 40) : '';
  const vars: InitiationData['dynamic_variables'] = {
    first_name: first,
    property_address: known ? clean(facts?.property_address || res.match.property_address, 200) : '',
    lead_brief: known && mem ? clean(mem.brief, 1200) : '',
    last_contact_summary: known ? clean(facts?.last_contact_summary, 400) : '',
    next_step: known ? clean(facts?.next_step, 240) : '',
    rep_name: known ? clean(p.repName, 60) : '',
    company: p.company,
    agent_name: p.agentName ?? '',
    caller_known: known,
    do_not_engage: res.status === 'blocked',
    record_kind: known ? res.match.kind : '',
    // Nothing about the person, or an offer, for a caller we will not talk to.
    ...(res.status === 'blocked' ? NO_EXTRAS : extras),
  };
  const outbound = leg?.direction === 'outbound';
  let first_message: string;
  if (res.status === 'blocked') {
    first_message = outbound ? `Hi, ${intro(p)}. Sorry, I think I have the wrong number.` : `Thanks for calling ${p.company}. How can I help you today?`;
  } else if (known && first) {
    first_message = outbound
      ? `Hi, is this ${first}? ${cap(intro(p))}.`
      : p.casual ? `Hey ${first}! ${cap(intro(p))}, how can I help ya?` : `Hey ${first}, thanks for calling back, ${intro(p)}.`;
  } else {
    first_message = outbound
      ? `Hi, ${intro(p)}. Who do I have the pleasure of speaking with?`
      : p.casual ? `Hey, ${intro(p)}, how can I help ya?`
        : `Thanks for calling ${p.company}${p.agentName ? `, this is ${p.agentName}` : ''}. Who am I speaking with?`;
  }
  if (p.recordingNotice) first_message = `${first_message} ${p.recordingNotice}`;
  return { type: 'conversation_initiation_client_data', dynamic_variables: vars, conversation_config_override: { agent: { first_message } } };
}

function firstWord(name: string | null | undefined): string {
  const w = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  if (!w || /\d|@/.test(w) || /^(llc|inc|the|unknown|owner)$/i.test(w)) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- Post-call ------------------------------------------------------------

export type Segment = { start: number; end: number; speaker: 'rep' | 'contact'; text: string };

type Turn = { role?: string; message?: string | null; time_in_call_secs?: number | null };

/**
 * ElevenLabs transcript turns (role agent/user, time_in_call_secs) into the
 * flat Rep/Contact transcript and timed segments the call player reads
 * (migration 109). A turn's end is the next turn's start, the last one ends
 * at the call's duration. Tool-only turns (no message) are skipped.
 */
export function mapTranscript(turns: unknown, durationSecs: number | null): { text: string; segments: Segment[] | null } {
  const list = (Array.isArray(turns) ? turns : []) as Turn[];
  const rows = list
    .map((t) => ({ role: t?.role === 'agent' ? 'rep' as const : 'contact' as const, text: clean(t?.message, 4000), at: typeof t?.time_in_call_secs === 'number' && Number.isFinite(t.time_in_call_secs) ? t.time_in_call_secs : null }))
    .filter((t) => t.text);
  const text = rows.map((r) => `${r.role === 'rep' ? 'Rep' : 'Contact'}: ${r.text}`).join('\n');
  if (!rows.length || rows.some((r) => r.at === null)) return { text, segments: null };
  const segments = rows.map((r, i) => {
    const start = r.at as number;
    const next = rows[i + 1]?.at ?? (durationSecs != null && durationSecs >= start ? durationSecs : start);
    return { start, end: Math.max(start, next as number), speaker: r.role, text: r.text };
  });
  return { text, segments };
}

export type PostCall = {
  conversationId: string;
  agentId: string | null;
  direction: 'inbound' | 'outbound';
  ourNumber: string | null;
  theirNumber: string | null;
  occurredAt: string;
  durationS: number | null;
  transcript: string;
  segments: Segment[] | null;
  summary: string | null;
  status: string;
  /** Tools used and what the caller said, for voice_agent_calls (see voice-agent-classify.ts). */
  flags: CallFlags;
};

/**
 * A post_call_transcription event into what we store. Phones come from
 * metadata.phone_call (agent_number is ours, external_number theirs); a
 * payload without it falls back to the system__ dynamic variables, where
 * caller_id is the caller. Null for any other event type.
 */
export function parsePostCall(event: unknown): PostCall | null {
  const e = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
  if (e.type !== 'post_call_transcription') return null;
  const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
  const conversationId = typeof d.conversation_id === 'string' ? d.conversation_id : '';
  if (!conversationId) return null;
  const meta = (d.metadata && typeof d.metadata === 'object' ? d.metadata : {}) as Record<string, unknown>;
  const pc = (meta.phone_call && typeof meta.phone_call === 'object' ? meta.phone_call : null) as Record<string, unknown> | null;
  const dyn = ((d.conversation_initiation_client_data as Record<string, unknown> | undefined)?.dynamic_variables ?? {}) as Record<string, unknown>;
  let direction: 'inbound' | 'outbound' = 'inbound';
  let ours: string | null = null;
  let theirs: string | null = null;
  if (pc) {
    direction = pc.direction === 'outbound' ? 'outbound' : 'inbound';
    ours = toE164(String(pc.agent_number ?? ''));
    theirs = toE164(String(pc.external_number ?? ''));
  } else {
    ours = toE164(String(dyn.system__called_number ?? ''));
    theirs = toE164(String(dyn.system__caller_id ?? ''));
  }
  const start = Number(meta.start_time_unix_secs);
  const dur = Number(meta.call_duration_secs);
  const durationS = Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null;
  const { text, segments } = mapTranscript(d.transcript, durationS);
  const analysis = (d.analysis && typeof d.analysis === 'object' ? d.analysis : {}) as Record<string, unknown>;
  const title = clean(analysis.call_summary_title as string, 120);
  const sum = clean(analysis.transcript_summary as string, 3000);
  return {
    conversationId, agentId: typeof d.agent_id === 'string' ? d.agent_id : null, direction, ourNumber: ours, theirNumber: theirs,
    occurredAt: Number.isFinite(start) && start > 0 ? new Date(start * 1000).toISOString() : new Date().toISOString(),
    durationS, transcript: text, segments,
    summary: sum ? (title ? `${title}. ${sum}` : sum) : title || null,
    status: durationS === 0 || !text ? 'no-answer' : 'completed',
    flags: classifyCall(d.transcript),
  };
}

// ---- Auth -----------------------------------------------------------------

/** Constant-time string compare (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A shared secret sent as `X-Voice-Agent-Secret: <s>` or `Authorization: Bearer <s>`. */
export function headerSecretOk(headers: Headers, expected: string | null | undefined): boolean {
  if (!expected) return false;
  const direct = headers.get('x-voice-agent-secret')?.trim();
  const bearer = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  return (!!direct && safeEqual(direct, expected)) || (!!bearer && safeEqual(bearer, expected));
}

export const SIGNATURE_TOLERANCE_SECS = 30 * 60;

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

/**
 * ElevenLabs-Signature, exactly as the SDK's constructEvent checks it:
 * `t=<unix seconds>,v0=<hex>`, v0 = HMAC-SHA256(secret, `${t}.${rawBody}`),
 * and t no more than 30 minutes old. rawBody must be the bytes as received.
 */
export async function verifySignature(rawBody: string, header: string | null, secret: string, nowMs = Date.now()): Promise<SignatureCheck> {
  if (!header) return { ok: false, reason: 'missing' };
  const parts = header.split(',').map((s) => s.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v0 = parts.find((p) => p.startsWith('v0='));
  if (!t || !v0 || !/^\d+$/.test(t)) return { ok: false, reason: 'malformed' };
  if (Number(t) * 1000 < nowMs - SIGNATURE_TOLERANCE_SECS * 1000) return { ok: false, reason: 'stale' };
  const expected = 'v0=' + await hmacHex(secret, `${t}.${rawBody}`);
  return safeEqual(v0, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Per-workspace secrets (migration 111) --------------------------------

/** A voice_agent_secrets row, as far as the webhooks read it. */
export type SecretRow = {
  workspace_id: number;
  personalize_secret?: string | null;
  tool_secret?: string | null;
  webhook_secret?: string | null;
};
export type SecretField = 'personalize_secret' | 'tool_secret' | 'webhook_secret';

export type SecretMatch = { ok: true; workspaceId: number | null; source: 'row' | 'env' } | { ok: false };

/** Every credential a request presents: the header secret and the bearer token. */
export function presentedSecrets(headers: Headers): string[] {
  const direct = headers.get('x-voice-agent-secret')?.trim();
  const bearer = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  return [direct, bearer].filter((s): s is string => !!s);
}

/**
 * Which workspace a header secret belongs to. Every stored row is compared and
 * none short-circuits, so timing says nothing about which row (or whether any)
 * matched. A row match names the workspace; the env secret matches with no
 * workspace and the caller falls back to the caller_lines lookup, exactly as
 * before migration 111.
 */
export function matchSecret(headers: Headers, rows: SecretRow[], field: SecretField, envSecret: string | null | undefined): SecretMatch {
  const presented = presentedSecrets(headers);
  let rowHit: SecretRow | null = null;
  for (const r of rows) {
    const stored = r[field];
    if (!stored) continue;
    let hit = false;
    for (const p of presented) if (safeEqual(p, stored)) hit = true;
    if (hit && !rowHit) rowHit = r;
  }
  let envHit = false;
  if (envSecret) for (const p of presented) if (safeEqual(p, envSecret)) envHit = true;
  if (rowHit) return { ok: true, workspaceId: Number(rowHit.workspace_id), source: 'row' };
  if (envHit) return { ok: true, workspaceId: null, source: 'env' };
  return { ok: false };
}

/** True when this route has a secret anywhere, so an unconfigured route still answers the old 503. */
export function secretConfigured(rows: SecretRow[], field: SecretField, envSecret: string | null | undefined): boolean {
  return !!envSecret || rows.some((r) => !!r[field]);
}

type SignatureFailure = Exclude<SignatureCheck, { ok: true }>['reason'];
export type SignatureMatch = { ok: true; workspaceId: number | null; source: 'row' | 'env' } | { ok: false; reason: SignatureFailure };

/**
 * The post-call HMAC against every stored webhook secret and the env one.
 * Each is checked (no early exit); the first that verifies names the
 * workspace. A failure reports the most specific reason any candidate gave:
 * a well-formed header that matched nothing is a mismatch.
 */
export async function verifySignatureAny(rawBody: string, header: string | null, rows: SecretRow[], envSecret: string | null | undefined, nowMs = Date.now()): Promise<SignatureMatch> {
  const candidates: { secret: string; workspaceId: number | null; source: 'row' | 'env' }[] = [];
  for (const r of rows) if (r.webhook_secret) candidates.push({ secret: r.webhook_secret, workspaceId: Number(r.workspace_id), source: 'row' });
  if (envSecret) candidates.push({ secret: envSecret, workspaceId: null, source: 'env' });
  let hit: (typeof candidates)[number] | null = null;
  let reason: SignatureFailure = 'mismatch';
  for (const c of candidates) {
    const r = await verifySignature(rawBody, header, c.secret, nowMs);
    if (r.ok) { if (!hit) hit = c; } else if (r.reason !== 'mismatch') reason = r.reason;
  }
  if (hit) return { ok: true, workspaceId: hit.workspaceId, source: hit.source };
  return { ok: false, reason };
}

/** Name and company the agent introduces itself with: the workspace's saved settings, then the env vars, then the workspace name. */
export function pickPersona(
  saved: { agent_name?: string | null; company?: string | null } | null | undefined,
  env: { name?: string | null; company?: string | null },
  workspaceName: string | null | undefined,
): { agentName: string | null; company: string } {
  return {
    agentName: (saved?.agent_name || '').trim() || env.name || null,
    company: (saved?.company || '').trim() || env.company || String(workspaceName ?? '') || 'our office',
  };
}
