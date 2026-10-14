// voice-agent-admin's ElevenLabs side: the request bodies built from an agent's
// settings, the Connect/Publish sequence, and the small reads (voices, preview,
// signed URL). Pure apart from an injected fetch, so voice-agent-admin.test.ts
// runs under tsx or deno with no network and no Supabase.
//
// Settings live in voice-agent-settings.ts and the prompt in
// voice-agent-prompt.ts; this file only maps them onto ElevenLabs' API.
//
// ElevenLabs endpoints and body shapes, from their API reference (read
// 2026-09-29, the .md version of each page):
//   Create agent   POST  /v1/convai/agents/create
//                  https://elevenlabs.io/docs/eleven-agents/api-reference/agents/create
//   Update agent   PATCH /v1/convai/agents/{agent_id}
//                  https://elevenlabs.io/docs/eleven-agents/api-reference/agents/update
//   Create tool    POST  /v1/convai/tools    PATCH /v1/convai/tools/{tool_id}
//                  https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create
//                  https://elevenlabs.io/docs/eleven-agents/api-reference/tools/update
//   Transfer tool  transfer_to_number system tool: transfers[] of
//                  {transfer_destination, condition, transfer_type}
//                  https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number
//   Voicemail      voicemail_detection system tool, optional voicemail_message
//                  https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/voicemail-detection
//   Workspace convai settings (the workspace-wide initiation webhook and
//   post-call webhook; this code uses the per-agent platform_settings
//   .workspace_overrides copy of the same two objects instead, so it never
//   touches another agent in the ElevenLabs workspace):
//                  https://elevenlabs.io/docs/eleven-agents/api-reference/workspace/update
//   Webhooks       POST /v1/workspace/webhooks (returns webhook_secret),
//                  PATCH/DELETE /v1/workspace/webhooks/{webhook_id}
//                  https://elevenlabs.io/docs/api-reference/webhooks/create
//                  https://elevenlabs.io/docs/api-reference/webhooks/update
//   Signed URL     GET /v1/convai/conversation/get-signed-url?agent_id=
//                  https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url
//                  https://elevenlabs.io/docs/eleven-agents/customization/authentication
//   Voices         GET /v2/voices
//                  https://elevenlabs.io/docs/api-reference/voices/search
//   Text to speech POST /v1/text-to-speech/{voice_id}
//                  https://elevenlabs.io/docs/api-reference/text-to-speech/convert
//   Models         https://elevenlabs.io/docs/overview/models
import type { Candidate, MemoryForCall } from './voice-agent.ts';
import { EXPRESSIVE_TTS_MODEL, TOOL_AVAILABLE, toolOn, type AgentSettings, type Destination, type Thinking, type TtsModel } from './voice-agent-settings.ts';
import { WRITE_TOOLS, writeToolBody, type WriteTool } from './voice-agent-tools.ts';
import { assemblePrompt, transferTriggers, ROLE_LABEL, type TemplateRegistry } from './voice-agent-prompt.ts';

// ---- Tuning defaults, model fallback ------------------------------------------------

/**
 * eleven_v4_turbo is the agents default and in the create/update enum (checked
 * 2026-10-13). A model ElevenLabs ever rejects for agents is still retried once
 * on FALLBACK_TTS_MODEL (see withModelFallback), and publish says so.
 */
export const FALLBACK_TTS_MODEL: TtsModel = 'eleven_flash_v2_5';
/** conversation_config.tts defaults in the agents reference: stability 0.5, similarity_boost 0.8, speed 1. */
export const VOICE_DEFAULTS = { stability: 0.5, similarity: 0.8, speed: 1 } as const;
/** Unset stability on an Expressive agent: lower is more emotional range on v3, and 0.5 reads flat on a call. */
export const EXPRESSIVE_STABILITY = 0.3;

/** reasoning_effort per Thinking setting; auto sends none and the model thinks as it likes. ElevenLabs advises low effort for live calls. */
export const REASONING_EFFORT: Record<Thinking, 'low' | 'medium' | null> = { auto: null, light: 'low', deep: 'medium' };

/**
 * What a caller says while the agent talks that is only listening, not a turn
 * ("uh huh", "yeah"): turn.interruption_ignore_terms, by the Interruptions
 * scale (1 hard to interrupt … 5 easy). "Wait", "no", "hold on" and any real
 * sentence always cut in.
 */
const BACKCHANNEL = ['uh huh', 'uh-huh', 'mm hmm', 'mm-hmm', 'mhm', 'hmm'];
// "Yes" and "sure" are left out: they answer a question, so they always cut in.
const AGREEING = ['yeah', 'yep', 'okay', 'ok', 'right', 'gotcha', 'got it', 'i see'];
const REACTIONS = ['alright', 'cool', 'oh', 'wow', 'true', 'nice', 'oh okay', 'makes sense'];
export function ignoreTerms(sensitivity: number): string[] {
  if (sensitivity >= 4) return [];
  if (sensitivity === 3) return BACKCHANNEL;
  if (sensitivity === 2) return [...BACKCHANNEL, ...AGREEING];
  return [...BACKCHANNEL, ...AGREEING, ...REACTIONS];
}

/** The agent's own first line, used where no initiation webhook runs (Preview). Calls override it per caller. */
export const DEFAULT_FIRST_MESSAGE = 'Hi, this is {{agent_name}} with {{company}}. Who am I speaking with?';

/** Placeholder values for every dynamic variable, so ElevenLabs Preview (which does not call the webhook) works. */
export const DYNAMIC_VARIABLE_PLACEHOLDERS: Record<string, string | boolean> = {
  first_name: 'Sam', property_address: '123 Main St', lead_brief: 'A new lead, nothing on file yet.', last_contact_summary: '',
  next_step: '', rep_name: 'Alex', company: 'Acme Homes', agent_name: 'Riley', caller_known: false, do_not_engage: false, record_kind: 'seller',
  rep_phone: '+15125550100', lead_source: 'form', property_facts: '3 bed, 2 bath, about 1,450 sqft', mortgage_payoff_estimate: '$120,000',
  offer_low: '$150,000', offer_high: '$170,000', seller_asking_price: '$180,000', call_goal: '', rep_available: 'yes',
  record_id: '', record_token: '',
};

// ---- URLs and secrets -----------------------------------------------------------

export type WebhookUrls = { personalize: string; tool: string; post_call: string };

export function webhookUrls(supabaseUrl: string): WebhookUrls {
  const base = supabaseUrl.replace(/\/+$/, '') + '/functions/v1/voice-agent';
  return { personalize: `${base}/personalize`, tool: `${base}/tool/lead-context`, post_call: `${base}/post-call` };
}

export const SECRET_HEADER = 'X-Voice-Agent-Secret';

/** 32 random bytes as 64 hex characters. */
export function generateSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---- ElevenLabs request bodies -------------------------------------------------

export type Wiring = {
  toolId: string | null; webhookId: string | null; personalizeUrl: string; personalizeSecret: string;
  /** ElevenLabs ids of the write tools (book_appointment, save_qualification, mark_do_not_contact), shared by the workspace's agents. */
  writeToolIds?: Partial<Record<WriteTool, string>>;
  /** First names of the workspace's team, so speech recognition hears "Is Casey there?" right. */
  teamNames?: string[];
};

/** The write tools that are built, in a fixed order. Read at call time, so flipping TOOL_AVAILABLE takes effect. */
export const builtWriteTools = () => (Object.keys(WRITE_TOOLS) as WriteTool[]).filter((k) => TOOL_AVAILABLE[k]);

/** Every webhook tool id this agent should carry: lead_context and each write tool that is on, built and created. */
export function agentToolIds(s: AgentSettings, w: Pick<Wiring, 'toolId' | 'writeToolIds'>): string[] {
  const ids: string[] = [];
  if (w.toolId && toolOn(s, 'lead_context')) ids.push(w.toolId);
  for (const k of builtWriteTools()) {
    const id = w.writeToolIds?.[k];
    if (id && toolOn(s, k)) ids.push(id);
  }
  return ids;
}

/** A setting ElevenLabs' API cannot express (or that needs something outside it): stored and reported, never faked. */
export type Unapplied = { setting: string; value: string; reason: string };

const DEFAULT_RING = 25;

function hoursText(h: NonNullable<Destination['hours']>): string {
  return `Only between ${h.start} and ${h.end} ${h.tz} on ${h.days.join(', ')}; outside those hours do not transfer and follow the fallback.`;
}

/** The transfer_to_number system tool for these settings, plus what ElevenLabs cannot do about it. */
export function transferTool(s: AgentSettings): { tool: Record<string, unknown> | null; unapplied: Unapplied[]; timezone?: string } {
  const unapplied: Unapplied[] = [];
  if (!toolOn(s, 'transfer')) return { tool: null, unapplied };
  const lt = s.live_transfer;
  const triggers = transferTriggers(s);
  const when = triggers.length ? `Transfer when: ${triggers.join('; ')}.` : 'Transfer when the caller asks for a person.';
  let timezone: string | undefined;
  const transfers = lt.destinations.map((d) => {
    const parts = [`${when} Send them to ${d.label}.`];
    if (d.hours) { parts.push(hoursText(d.hours)); timezone ??= d.hours.tz; }
    return {
      transfer_destination: d.type === 'rep_assigned' ? { type: 'phone_dynamic_variable', phone_number: 'rep_phone' } : { type: 'phone', phone_number: d.number },
      condition: parts.join(' '),
      // Warm is the conference transfer. Blind is only offered by ElevenLabs on its native Twilio integration; this
      // account is on a SIP trunk, where the direct hand-off is SIP REFER.
      transfer_type: lt.mode === 'warm' ? 'conference' : 'sip_refer',
    };
  });
  if (lt.mode === 'cold') unapplied.push({ setting: 'live_transfer.mode', value: 'cold', reason: 'ElevenLabs offers blind transfer only on its native Twilio integration. A SIP trunk uses SIP REFER, which needs the trunk to allow REFER; a cold transfer is sent that way.' });
  if (lt.whisper_message_template.trim()) unapplied.push({ setting: 'live_transfer.whisper_message_template', value: lt.whisper_message_template, reason: "A message read to the person receiving the call is only supported on ElevenLabs' native Twilio integration, not on SIP trunks. The agent still briefs them in its own words (see the prompt)." });
  for (const d of lt.destinations) {
    if (d.type === 'ring_group') unapplied.push({ setting: `live_transfer.destinations.${d.id}`, value: 'ring_group', reason: 'ElevenLabs transfers to one number or SIP URI. Point this number at a ring group or hunt group on the phone provider; it is sent as a single number.' });
    if (d.type === 'rep_assigned') continue;
    if (d.ring_timeout_s !== DEFAULT_RING) unapplied.push({ setting: `live_transfer.destinations.${d.id}.ring_timeout_s`, value: String(d.ring_timeout_s), reason: 'ElevenLabs has no per-destination ring timeout field; the ring time is set by the phone provider.' });
    if (d.hours) unapplied.push({ setting: `live_transfer.destinations.${d.id}.hours`, value: `${d.hours.start}-${d.hours.end} ${d.hours.tz}`, reason: 'Destination hours are written into the transfer condition and judged by the agent (it knows the time from the prompt timezone); ElevenLabs does not enforce them.' });
  }
  return {
    tool: {
      type: 'system', name: 'transfer_to_number',
      description: 'Transfer the caller to a person when the conditions on the rules are met.',
      params: { system_tool_type: 'transfer_to_number', transfers, enable_client_message: true },
    },
    unapplied, timezone,
  };
}

function voicemailTool(s: AgentSettings): Record<string, unknown> | null {
  const v = s.call_handling.voicemail;
  if (!v.detect) return null;
  return {
    type: 'system', name: 'voicemail_detection',
    params: { system_tool_type: 'voicemail_detection', ...(v.action === 'leave_message' && v.message_template.trim() ? { voicemail_message: v.message_template } : {}) },
  };
}

/** Settings ElevenLabs has no field for, listed only when they are not at their neutral value. */
export function unappliedSettings(s: AgentSettings): Unapplied[] {
  const out: Unapplied[] = [];
  const ch = s.call_handling;
  if (ch.first_response_delay_ms > 0) out.push({ setting: 'call_handling.first_response_delay_ms', value: String(ch.first_response_delay_ms), reason: 'ElevenLabs has no field for a delay before the first response; stored only.' });
  if (ch.retry.max_attempts > 0) out.push({ setting: 'call_handling.retry', value: `${ch.retry.max_attempts} tries, ${ch.retry.gap_hours}h apart`, reason: 'Retries are a dialer feature outside ElevenLabs; stored only until an outbound dialer reads it.' });
  if (s.identity.languages.length > 1) out.push({ setting: 'identity.languages', value: s.identity.languages.join(', '), reason: 'The first language is applied. Additional languages need language presets on the ElevenLabs agent, which this API call does not create.' });
  if (s.channels.phone_number_id) out.push({ setting: 'channels.phone_number_id', value: s.channels.phone_number_id, reason: 'Assigning a phone number to the agent is done in ElevenLabs (Phone numbers); the id is stored for the console.' });
  return out;
}

/** Words a caller says on these calls that speech recognition would otherwise mishear. */
export const ASR_KEYWORDS = ['title company', 'earnest money', 'closing costs', 'as-is', 'walkthrough', 'probate', 'foreclosure', 'HOA', 'lien', 'back taxes', 'Zillow', 'Opendoor', 'Offerpad', 'wholesaler', 'realtor'];

/** The asr.keywords sent to ElevenLabs: the company, the agent, the team's first names and the call vocabulary, deduped and capped. */
export function asrKeywords(s: AgentSettings, teamNames: string[] = []): string[] {
  const out: string[] = []; const seen = new Set<string>();
  // The call words come before the team, so a big team never crowds them out.
  for (const k of [s.identity.company, s.identity.name, ...ASR_KEYWORDS, ...teamNames.slice(0, 30)]) {
    const t = String(k ?? '').trim();
    if (t.length < 2 || t.length > 40 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  return out.slice(0, 50);
}

/**
 * The full create/update body for one agent: the assembled prompt, voice and
 * model, turn and call limits, voicemail and transfer tools, dynamic variables,
 * the lead_context tool, the initiation webhook with its header secret (the
 * first message may be overridden) and the post-call webhook. Only tools that
 * are on AND built are sent; one that is off is sent as null so a later PATCH
 * removes it.
 */
export function agentBody(s: AgentSettings, templates: TemplateRegistry, w: Wiring) {
  const xfer = transferTool(s);
  const builtIn: Record<string, unknown> = {
    end_call: toolOn(s, 'end_call') ? { type: 'system', name: 'end_call', params: { system_tool_type: 'end_call' } } : null,
    transfer_to_number: xfer.tool,
    voicemail_detection: voicemailTool(s),
  };
  const roleName = s.identity.name || ROLE_LABEL[s.identity.role] || s.identity.role;
  const body = {
    name: `${s.identity.company || 'CLOZR'} ${roleName}`.slice(0, 100),
    conversation_config: {
      agent: {
        first_message: DEFAULT_FIRST_MESSAGE,
        language: s.identity.languages[0],
        dynamic_variables: { dynamic_variable_placeholders: DYNAMIC_VARIABLE_PLACEHOLDERS },
        prompt: {
          prompt: assemblePrompt(s, templates),
          llm: s.voice.llm,
          ...(REASONING_EFFORT[s.voice.thinking] ? { reasoning_effort: REASONING_EFFORT[s.voice.thinking] } : {}),
          // ElevenLabs' own cascade when the brain is slow or down, after 4 s.
          backup_llm_config: { preference: 'default' },
          built_in_tools: builtIn,
          tool_ids: agentToolIds(s, w),
          // The agent knows the date and time, so "today" and "later today" mean the team's today.
          timezone: xfer.timezone ?? s.call_handling.call_hours.tz,
        },
      },
      // Always sent, with the reference defaults when unset, so clearing a tuning value takes effect on a PATCH.
      tts: {
        voice_id: s.voice.voice_id, model_id: s.voice.tts_model,
        stability: s.voice.stability ?? (s.personality.expressiveness === 'expressive' ? EXPRESSIVE_STABILITY : VOICE_DEFAULTS.stability),
        similarity_boost: s.voice.similarity ?? VOICE_DEFAULTS.similarity,
        speed: s.voice.speed ?? VOICE_DEFAULTS.speed,
      },
      // High-quality transcription, primed with names and words these calls use.
      asr: { quality: 'high', keywords: asrKeywords(s, w.teamNames) },
      conversation: { max_duration_seconds: s.call_handling.max_call_seconds },
      turn: {
        turn_eagerness: s.call_handling.turn_eagerness,
        silence_end_call_timeout: s.call_handling.silence_timeout_s > 0 ? s.call_handling.silence_timeout_s : -1,
        turn_model: 'turn_v3',
        // Start the reply during the caller's pause instead of after it: quicker answers, a little more LLM spend.
        speculative_turn: true,
        // Speech the voice detector missed (a quiet or choppy line) is transcribed again before the agent re-engages.
        retranscribe_on_turn_timeout: true,
        interruption_ignore_terms: ignoreTerms(s.call_handling.interruption_sensitivity),
        // A thinking pause longer than 3 s gets a short filler that fits the moment instead of dead air.
        soft_timeout_config: { timeout_seconds: 3, message: 'Mm, okay…', use_llm_generated_message: s.personality.use_fillers },
      },
    },
    platform_settings: {
      overrides: {
        enable_conversation_initiation_client_data_from_webhook: true,
        conversation_config_override: { agent: { first_message: true } },
      },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: { url: w.personalizeUrl, request_headers: { [SECRET_HEADER]: w.personalizeSecret } },
        ...(w.webhookId ? { webhooks: { post_call_webhook_id: w.webhookId, events: ['transcript'], transcript_format: 'json' } } : {}),
      },
      // Signed URLs (test_session) are for agents that require authorization; this is
      // what keeps the bare agent id from being a public way to spend minutes.
      auth: { enable_auth: true },
    },
  };
  return { body, unapplied: [...xfer.unapplied, ...unappliedSettings(s)] };
}

/**
 * The lead_context webhook tool. caller_id, called_number and agent_id are ElevenLabs system dynamic variables.
 * record_kind, record_id and record_token are ours: /personalize fills the first two for a known caller and
 * leaves the token empty; test_session fills all three, so a browser test (no caller ID) finds its record.
 */
export function toolBody(toolUrl: string, toolSecret: string) {
  return {
    tool_config: {
      type: 'webhook',
      name: 'lead_context',
      description: 'Look up what we know about the person on this call: the brief, facts, latest offer, next appointment and deal stage.',
      api_schema: {
        url: toolUrl,
        method: 'POST',
        content_type: 'application/json',
        request_headers: { [SECRET_HEADER]: toolSecret },
        request_body_schema: {
          type: 'object',
          required: ['caller_id', 'called_number'],
          properties: {
            caller_id: { type: 'string', dynamic_variable: 'system__caller_id' },
            called_number: { type: 'string', dynamic_variable: 'system__called_number' },
            agent_id: { type: 'string', dynamic_variable: 'system__agent_id' },
            contact_name: { type: 'string', description: "The caller's name, only when several people share the number" },
            record_kind: { type: 'string', dynamic_variable: 'record_kind' },
            record_id: { type: 'string', dynamic_variable: 'record_id' },
            record_token: { type: 'string', dynamic_variable: 'record_token' },
          },
        },
      },
    },
  };
}

export const POST_CALL_WEBHOOK_NAME = 'CLOZR post-call';

/** The post-call webhook. ElevenLabs answers with webhook_id and the signing secret. */
export function webhookCreateBody(postCallUrl: string) {
  return { settings: { auth_type: 'hmac', name: POST_CALL_WEBHOOK_NAME, webhook_url: postCallUrl } };
}

// ---- ElevenLabs client ----------------------------------------------------------

export type ElConfig = { apiKey: string; baseUrl?: string; fetchFn?: typeof fetch };

export class ElevenError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const EL_BASE = 'https://api.elevenlabs.io';

/** Never let a secret or the API key ride back in an error message. */
export function redact(msg: string, secrets: (string | null | undefined)[]): string {
  let out = msg;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('***');
  return out.slice(0, 300);
}

function detailOf(body: unknown, status: number): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((x) => {
      const e = x as { msg?: string; loc?: unknown[] };
      return e?.msg ? `${Array.isArray(e.loc) ? e.loc.join('.') + ': ' : ''}${e.msg}` : '';
    }).filter(Boolean).join('; ') || `HTTP ${status}`;
  }
  const m = (d as { message?: string } | undefined)?.message ?? (body as { message?: string } | null)?.message;
  return typeof m === 'string' ? m : `HTTP ${status}`;
}

async function elRequest(cfg: ElConfig, method: string, path: string, body?: unknown): Promise<Response> {
  const f = cfg.fetchFn ?? fetch;
  const res = await f((cfg.baseUrl ?? EL_BASE) + path, {
    method,
    headers: { 'xi-api-key': cfg.apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => null);
    throw new ElevenError(res.status, redact(detailOf(parsed, res.status), [cfg.apiKey]));
  }
  return res;
}

export async function elJson<T = Record<string, unknown>>(cfg: ElConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await elRequest(cfg, method, path, body);
  return (await res.json().catch(() => ({}))) as T;
}

/**
 * Run an agent write with the chosen TTS model; if ElevenLabs rejects the model
 * itself (a 400/422 naming model_id, which is what an id missing from the
 * agents enum would look like), run it once more on FALLBACK_TTS_MODEL. A
 * brain that does not take a reasoning effort is retried on Thinking auto the
 * same way. The saved settings are untouched, so the next publish tries again.
 */
export async function withModelFallback<T>(s: AgentSettings, run: (s: AgentSettings) => Promise<T>): Promise<{ value: T; model: TtsModel; fellBack: boolean }> {
  const rejected = (e: unknown, field: RegExp) => e instanceof ElevenError && (e.status === 422 || e.status === 400) && field.test(e.message);
  const attempt = async (cur: AgentSettings): Promise<T> => {
    try {
      return await run(cur);
    } catch (e) {
      if (cur.voice.thinking === 'auto' || !rejected(e, /reasoning/i)) throw e;
      return await run({ ...cur, voice: { ...cur.voice, thinking: 'auto' } });
    }
  };
  try {
    return { value: await attempt(s), model: s.voice.tts_model, fellBack: false };
  } catch (e) {
    if (!rejected(e, /model_id/) || s.voice.tts_model === FALLBACK_TTS_MODEL) throw e;
    return { value: await attempt({ ...s, voice: { ...s.voice, tts_model: FALLBACK_TTS_MODEL } }), model: FALLBACK_TTS_MODEL, fellBack: true };
  }
}

// ---- Connect / publish ------------------------------------------------------------

export type ConnectState = {
  agent_id: string | null;
  tool_id: string | null;
  webhook_id: string | null;
  personalize_secret: string;
  tool_secret: string;
  /** Returned once by ElevenLabs when the webhook is created; null until then. */
  webhook_secret: string | null;
  /** The write tools' ids (voice_agent_secrets.tool_ids). */
  write_tool_ids?: Partial<Record<WriteTool, string>>;
};

export type Checks = { api_key: boolean; agent: boolean; personalize_webhook: boolean; tool: boolean; post_call_webhook: boolean; write_tools?: boolean };
export type ConnectResult = {
  state: ConnectState; checks: Checks; errors: { step: string; message: string }[]; connected: boolean; tts_model_used: TtsModel; unapplied: Unapplied[];
};

/**
 * Everything one agent needs on ElevenLabs, in dependency order: the shared
 * lead_context tool and post-call webhook first (the agent references both),
 * then the agent. Re-running updates in place using the ids in `state`; an id
 * ElevenLabs no longer knows (404) is created again. A failed step is recorded
 * and the rest still run, so one bad call leaves as much working as possible.
 * The tool and the webhook are one per workspace and shared by its agents.
 */
export async function runConnect(cfg: ElConfig, input: ConnectState, s: AgentSettings, templates: TemplateRegistry, urls: WebhookUrls, teamNames: string[] = []): Promise<ConnectResult> {
  const state: ConnectState = { ...input };
  const errors: ConnectResult['errors'] = [];
  const scrub = [cfg.apiKey, state.personalize_secret, state.tool_secret, state.webhook_secret];
  const fail = (step: string, e: unknown) => errors.push({ step, message: redact(e instanceof Error ? e.message : String(e), scrub) });

  // The lead_context tool.
  let toolOk = false;
  try {
    const body = toolBody(urls.tool, state.tool_secret);
    let updated = false;
    if (state.tool_id) {
      try { await elJson(cfg, 'PATCH', `/v1/convai/tools/${encodeURIComponent(state.tool_id)}`, body); updated = true; } catch (e) { if (!(e instanceof ElevenError && e.status === 404)) throw e; }
    }
    if (!updated) {
      const r = await elJson<{ id?: string }>(cfg, 'POST', '/v1/convai/tools', body);
      if (!r.id) throw new Error('ElevenLabs did not return a tool id');
      state.tool_id = r.id;
    }
    toolOk = true;
  } catch (e) { fail('tool', e); }

  // The write tools: one webhook tool each, shared by the workspace's agents like lead_context.
  // They live next to /tool/lead-context, so their base is the lead_context URL less its last two segments.
  const toolBase = urls.tool.replace(/\/tool\/lead-context$/, '');
  const writeIds: Partial<Record<WriteTool, string>> = { ...(state.write_tool_ids ?? {}) };
  let writeOk = true;
  for (const k of builtWriteTools()) {
    try {
      const body = writeToolBody(k, toolBase, SECRET_HEADER, state.tool_secret);
      let updated = false;
      const known = writeIds[k];
      if (known) {
        try { await elJson(cfg, 'PATCH', `/v1/convai/tools/${encodeURIComponent(known)}`, body); updated = true; } catch (e) { if (!(e instanceof ElevenError && e.status === 404)) throw e; }
      }
      if (!updated) {
        const r = await elJson<{ id?: string }>(cfg, 'POST', '/v1/convai/tools', body);
        if (!r.id) throw new Error('ElevenLabs did not return a tool id');
        writeIds[k] = r.id;
      }
    } catch (e) { writeOk = false; delete writeIds[k]; fail(`tool:${k}`, e); }
  }
  state.write_tool_ids = writeIds;

  // The post-call webhook. Its signing secret is only returned at creation.
  let webhookOk = false;
  try {
    let updated = false;
    if (state.webhook_id && state.webhook_secret) {
      try {
        await elJson(cfg, 'PATCH', `/v1/workspace/webhooks/${encodeURIComponent(state.webhook_id)}`, { is_disabled: false, name: POST_CALL_WEBHOOK_NAME, retry_enabled: true });
        updated = true;
      } catch (e) { if (!(e instanceof ElevenError && e.status === 404)) throw e; }
    } else if (state.webhook_id) {
      // Known id but the secret was never stored: it cannot be read back, so replace the webhook.
      await elJson(cfg, 'DELETE', `/v1/workspace/webhooks/${encodeURIComponent(state.webhook_id)}`).catch(() => undefined);
    }
    if (!updated) {
      const r = await elJson<{ webhook_id?: string; webhook_secret?: string | null }>(cfg, 'POST', '/v1/workspace/webhooks', webhookCreateBody(urls.post_call));
      if (!r.webhook_id) throw new Error('ElevenLabs did not return a webhook id');
      state.webhook_id = r.webhook_id;
      state.webhook_secret = r.webhook_secret || null;
      // Retries are a PATCH-only field; a failure here loses retries, not the webhook.
      await elJson(cfg, 'PATCH', `/v1/workspace/webhooks/${encodeURIComponent(r.webhook_id)}`, { is_disabled: false, name: POST_CALL_WEBHOOK_NAME, retry_enabled: true })
        .catch((e) => fail('post_call_retries', e));
    }
    if (!state.webhook_secret) throw new Error('ElevenLabs did not return the webhook signing secret');
    webhookOk = true;
  } catch (e) { fail('post_call_webhook', e); }

  // The agent.
  let agentOk = false;
  let ttsUsed: TtsModel = s.voice.tts_model;
  let unapplied: Unapplied[] = [];
  try {
    const wiring: Wiring = {
      toolId: toolOk ? state.tool_id : null, webhookId: webhookOk ? state.webhook_id : null, personalizeUrl: urls.personalize, personalizeSecret: state.personalize_secret,
      writeToolIds: writeIds, teamNames,
    };
    const write = async (cur: AgentSettings) => {
      const built = agentBody(cur, templates, wiring);
      unapplied = built.unapplied;
      if (state.agent_id) {
        try { await elJson(cfg, 'PATCH', `/v1/convai/agents/${encodeURIComponent(state.agent_id)}`, built.body); return; } catch (e) { if (!(e instanceof ElevenError && e.status === 404)) throw e; }
      }
      const r = await elJson<{ agent_id?: string }>(cfg, 'POST', '/v1/convai/agents/create', { ...built.body, tags: ['clozr'] });
      if (!r.agent_id) throw new Error('ElevenLabs did not return an agent id');
      state.agent_id = r.agent_id;
    };
    const r = await withModelFallback(s, write);
    ttsUsed = r.model;
    if (r.fellBack) errors.push({ step: 'tts_model', message: `ElevenLabs did not accept ${s.voice.tts_model} for agents, so the agent uses ${r.model}. The saved choice is kept and retried on the next publish.` });
    agentOk = true;
  } catch (e) { fail('agent', e); }

  const checks: Checks = {
    api_key: true,
    agent: agentOk,
    personalize_webhook: agentOk,
    tool: agentOk && toolOk && toolOn(s, 'lead_context'),
    post_call_webhook: agentOk && webhookOk,
    write_tools: agentOk && writeOk,
  };
  return { state, checks, errors, connected: agentOk, tts_model_used: ttsUsed, unapplied };
}

/** Delete the agent on ElevenLabs. A 404 counts as already gone. */
export async function deleteRemoteAgent(cfg: ElConfig, agentId: string): Promise<void> {
  try { await elJson(cfg, 'DELETE', `/v1/convai/agents/${encodeURIComponent(agentId)}`); } catch (e) { if (!(e instanceof ElevenError && e.status === 404)) throw e; }
}

/**
 * Refine stored checks against what ElevenLabs actually holds. Reads only
 * fields the create/update reference documents; anything missing reads false.
 */
export function checksFromAgent(agent: unknown, expect: { personalizeUrl: string; toolId: string | null; webhookId: string | null }): Pick<Checks, 'personalize_webhook' | 'tool' | 'post_call_webhook'> {
  // deno-lint-ignore no-explicit-any
  const a = (agent && typeof agent === 'object' ? agent : {}) as Record<string, any>;
  const ps = a.platform_settings ?? {};
  const wo = ps.workspace_overrides ?? {};
  const toolIds: unknown = a.conversation_config?.agent?.prompt?.tool_ids;
  return {
    personalize_webhook: wo.conversation_initiation_client_data_webhook?.url === expect.personalizeUrl
      && ps.overrides?.enable_conversation_initiation_client_data_from_webhook === true,
    tool: !!expect.toolId && Array.isArray(toolIds) && toolIds.includes(expect.toolId),
    post_call_webhook: !!expect.webhookId && wo.webhooks?.post_call_webhook_id === expect.webhookId,
  };
}

// ---- Voices, preview, signed URL -----------------------------------------------

export type VoiceOut = { voice_id: string; name: string; category: string | null; labels: Record<string, string>; preview_url: string | null };

export function trimVoice(v: unknown): VoiceOut | null {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (typeof r.voice_id !== 'string' || !r.voice_id) return null;
  const labels: Record<string, string> = {};
  if (r.labels && typeof r.labels === 'object') for (const [k, val] of Object.entries(r.labels as Record<string, unknown>)) if (typeof val === 'string') labels[k] = val.slice(0, 60);
  return {
    voice_id: r.voice_id, name: String(r.name ?? '').slice(0, 80), category: typeof r.category === 'string' ? r.category : null,
    labels, preview_url: typeof r.preview_url === 'string' ? r.preview_url : null,
  };
}

export async function listVoices(cfg: ElConfig, search?: string): Promise<VoiceOut[]> {
  const q = new URLSearchParams({ page_size: '100', include_total_count: 'false' });
  if (search) q.set('search', search.slice(0, 80));
  const r = await elJson<{ voices?: unknown[] }>(cfg, 'GET', `/v2/voices?${q}`);
  return (r.voices ?? []).map(trimVoice).filter((v): v is VoiceOut => !!v);
}

export const PREVIEW_MAX_CHARS = 300;

export function base64Of(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Speak `text` in the voice and model the saved agent uses. The TTS endpoint takes a
 * free-form model_id, but v4 Turbo is documented for the Text to Dialogue websocket
 * (https://elevenlabs.io/docs/overview/models), so a rejected v4 Turbo request is
 * retried once on FALLBACK_TTS_MODEL and `model` says which one spoke.
 */
export async function previewSpeech(
  cfg: ElConfig, voiceId: string, text: string, v: Pick<AgentSettings['voice'], 'tts_model' | 'stability' | 'similarity' | 'speed'>,
): Promise<{ audio_base64: string; mime: string; model: TtsModel }> {
  const path = `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`;
  const voice_settings = {
    stability: v.stability ?? VOICE_DEFAULTS.stability,
    similarity_boost: v.similarity ?? VOICE_DEFAULTS.similarity,
    speed: v.speed ?? VOICE_DEFAULTS.speed,
  };
  // v3 Conversational is an agents-only model; Text to Speech speaks the same tags with eleven_v3.
  const speak = async (model: TtsModel) => elRequest(cfg, 'POST', path, { text, model_id: model === EXPRESSIVE_TTS_MODEL ? 'eleven_v3' : model, voice_settings });
  let model = v.tts_model;
  let res: Response;
  try { res = await speak(model); } catch (e) {
    if (!(e instanceof ElevenError) || e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 429 || model === FALLBACK_TTS_MODEL) throw e;
    model = FALLBACK_TTS_MODEL;
    res = await speak(model);
  }
  return { audio_base64: base64Of(new Uint8Array(await res.arrayBuffer())), mime: 'audio/mpeg', model };
}

export async function getSignedUrl(cfg: ElConfig, agentId: string): Promise<string> {
  const r = await elJson<{ signed_url?: string }>(cfg, 'GET', `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
  if (!r.signed_url) throw new Error('ElevenLabs did not return a signed url');
  return r.signed_url;
}

// ---- Test session sample --------------------------------------------------------

/** The fixed fictional seller for a sample test. Goes through resolveCaller and buildInitiation like a real caller. */
export const SAMPLE_CANDIDATE: Candidate = { kind: 'seller', id: 0, name: 'Jamie Rivera', tags: [], property_address: '418 Sample Ave' };
export const SAMPLE_REP = 'Alex';
export const SAMPLE_MEMORY: NonNullable<MemoryForCall> = {
  brief: 'Jamie inherited 418 Sample Ave and lives out of state. Wants it sold within two months, asking 210,000. We said we would send a written offer by Friday. Roof and HVAC are old.',
  facts: {
    first_name: 'Jamie', preferred_name: null, property_address: '418 Sample Ave',
    last_contact_summary: 'Jamie asked for the offer in writing and said Friday works.', next_step: 'Send the written offer by Friday.',
  },
};

/** The fixed fictional cash buyer for a sample buyer test: a buy box, proof of funds and a deal we are offering. */
export const SAMPLE_BUYER: Candidate = { kind: 'buyer', id: 0, name: 'Marcus Lee', tags: [] };
export const SAMPLE_BUYER_MEMORY: NonNullable<MemoryForCall> = {
  brief: 'Marcus is a cash buyer who flips and rents. Buy box: 3 bed 2 bath single family in east Austin and Pflugerville, up to 250,000, light to medium rehab, no foundation work. Closes in about 10 days with cash or hard money; proof of funds on file is from March, so it is stale. Bought two deals from us last year. We sent him 418 Sample Ave (3 bed 2 bath, roof and HVAC are old, asking 185,000) on Tuesday.',
  facts: {
    first_name: 'Marcus', preferred_name: null, property_address: '',
    last_contact_summary: 'Marcus said 418 Sample Ave looked interesting and asked about the roof.', next_step: 'Get his offer on 418 Sample Ave and book a walkthrough.',
  },
};

// ---- Calls list -----------------------------------------------------------------

export type CallOut = {
  id: number; occurred_at: string; direction: string | null; duration_s: number | null; status: string | null;
  from_phone: string | null; to_phone: string | null; record_kind: 'seller' | 'buyer' | null; record_id: number | null;
  summary: string | null; transcript_preview: string | null; conversation_id: string | null;
};

export const TRANSCRIPT_PREVIEW_CHARS = 600;

export function callOut(r: Record<string, unknown>): CallOut {
  const t = typeof r.transcript === 'string' ? r.transcript : '';
  const sid = typeof r.source_id === 'string' && r.source_id.startsWith('el:') ? r.source_id.slice(3) : null;
  return {
    id: Number(r.id), occurred_at: String(r.occurred_at ?? ''), direction: (r.direction as string) ?? null,
    duration_s: r.duration_s == null ? null : Number(r.duration_s), status: (r.status as string) ?? null,
    from_phone: (r.from_phone as string) ?? null, to_phone: (r.to_phone as string) ?? null,
    record_kind: r.seller_id != null ? 'seller' : r.buyer_id != null ? 'buyer' : null,
    record_id: r.seller_id != null ? Number(r.seller_id) : r.buyer_id != null ? Number(r.buyer_id) : null,
    summary: (r.summary as string) ?? null,
    transcript_preview: t ? (t.length > TRANSCRIPT_PREVIEW_CHARS ? t.slice(0, TRANSCRIPT_PREVIEW_CHARS).trimEnd() + '...' : t) : null,
    conversation_id: sid,
  };
}
