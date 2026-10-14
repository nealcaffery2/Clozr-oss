// AI Agent settings, schema v2 (migration 111): the structured settings one
// voice agent is built from, their validation, and the diff between two
// versions. Pure: no I/O, so voice-agent-settings.test.ts runs under tsx or
// deno. The system prompt is built from these by voice-agent-prompt.ts.
//
// Everything a client sends is validated here: text is stripped of control
// characters and capped, numbers are clamped, enums are checked, ids are made
// unique. Three things a client can never change: compliance.honor_dnc and
// compliance.ai_disclosure_when_asked are forced true (a false is reported in
// `warnings`), each tool's `available` is set from TOOL_AVAILABLE (a tool that
// is not built cannot be switched on), and text that tells the agent to deny
// being an AI is refused (see deniesAi).
import { toE164 } from './voice-agent.ts';
import { DYNAMIC_VARIABLES, TOOL_ONLY_VARIABLES } from './voice-agent.ts';

// ---- Keys, tools, variables ---------------------------------------------------

export const DEFAULT_AGENT_KEY = 'lead_manager';
export const AGENT_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** A display name or free text into an agent_key slug. */
export function slugify(s: string): string {
  const k = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(k) ? k : k ? 'a_' + k.slice(0, 37) : '';
}

export const TOOL_KEYS = [
  'lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'request_agreement', 'transfer', 'end_call',
] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

/**
 * Which tools exist today. Only these are ever advertised to an ElevenLabs
 * agent; the rest are shown as "coming soon" and switching them on stores the
 * choice but changes nothing on the agent. Flip a value here when the tool is
 * built (the webhook, its route and its ElevenLabs tool config).
 */
export const TOOL_AVAILABLE: Record<ToolKey, boolean> = {
  lead_context: true, end_call: true, transfer: true, book_appointment: true, save_qualification: true, mark_do_not_contact: true,
  get_compr_offer: true, request_agreement: false,
};

export const TOOL_LABELS: Record<ToolKey, string> = {
  lead_context: 'Look up the caller', book_appointment: 'Book an appointment', save_qualification: 'Save what was learned',
  mark_do_not_contact: 'Mark do not contact', get_compr_offer: 'Get the Compr offer range', request_agreement: 'Send the agreement',
  transfer: 'Transfer to a person', end_call: 'End the call',
};

/** Variables the personalize webhook returns on every call; the only {{names}} a prompt may use besides system__*. */
export const PROMPT_VARIABLES: readonly string[] = DYNAMIC_VARIABLES.filter((v) => !TOOL_ONLY_VARIABLES.includes(v));

/** {{name}} stays when it is a variable the agent has; any other {{...}} loses its braces (ElevenLabs fails a call on a variable it does not know). */
export function sanitizeVars(text: string): string {
  // Keep the real ones behind private markers while every other brace goes, then put them back.
  const kept = text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, name: string) => (PROMPT_VARIABLES.includes(name) || /^system__[a-z_]+$/.test(name) ? `\u0001${name}\u0002` : name));
  return kept.replace(/\{\{|\}\}/g, '').replace(/\u0001([^\u0002]*)\u0002/g, '{{$1}}');
}

// ---- Types ---------------------------------------------------------------------

export const TONES = ['warm', 'direct', 'professional'] as const;
export type Tone = (typeof TONES)[number];
export const TTS_MODELS = ['eleven_v4_turbo', 'eleven_v4', 'eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3_conversational'] as const;
/**
 * The agent's brain: the LLM ElevenLabs runs the conversation on
 * (conversation_config.agent.prompt.llm). Unset, ElevenLabs picked its own
 * default. Gemini Flash answers fastest; Claude Sonnet follows a script and
 * holds a line under pressure best, a beat slower.
 */
export const LLMS = ['gemini-3.8-flash', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'] as const;
export type Llm = (typeof LLMS)[number];
export const DEFAULT_LLM: Llm = 'gemini-3.8-flash';
/** How much the brain thinks before it talks: the model's own default, or reasoning_effort low / medium. More is smarter and slower. */
export const THINKING = ['auto', 'light', 'deep'] as const;
export type Thinking = (typeof THINKING)[number];
/** The model that performs sound tags ([laughs], [clears throat]); on the others a tag is read out, so the prompt only teaches tags here. */
export const EXPRESSIVE_TTS_MODEL: TtsModel = 'eleven_v3_conversational';
export const EXPRESSIVENESS = ['off', 'natural', 'expressive'] as const;
export type Expressiveness = (typeof EXPRESSIVENESS)[number];
export type TtsModel = (typeof TTS_MODELS)[number];
export const DEFAULT_VOICE_ID = 'cjVigY5qzO86Huf0OWal';
export const SPEED_MIN = 0.7;
export const SPEED_MAX = 1.2;
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type Hours = { days: string[]; start: string; end: string; tz: string };
export type Rule = { id: string; text: string; severity: 'hard' | 'soft' };
export type Section = { id: string; title: string; body: string; enabled: boolean };
export type Destination = {
  id: string; label: string; number: string; type: 'rep_assigned' | 'fixed' | 'ring_group'; hours?: Hours; ring_timeout_s: number;
};
export type ToolSetting = { enabled: boolean; available: boolean };

export type AgentSettings = {
  identity: { name: string; company: string; role: string; introduce_as: 'none' | 'virtual_assistant'; languages: string[] };
  voice: { voice_id: string; tts_model: TtsModel; stability: number | null; similarity: number | null; speed: number | null; llm: Llm; thinking: Thinking };
  personality: { tone: Tone; energy: number; verbosity: number; warmth: number; formality: number; use_fillers: boolean; humor: number; expressiveness: Expressiveness };
  script: { template_id: string; sections: Section[]; raw_prompt_override: string | null; master_script_text: string };
  rules: {
    dos: Rule[]; donts: Rule[]; never_mention: string[]; forbidden_phrases: string[]; required_phrases: { when: string; text: string }[];
    compliance: {
      honor_dnc: true;
      quiet_hours: { enabled: boolean; start: string; end: string; tz: string };
      recording_notice: { enabled: boolean; text: string };
      ai_disclosure_when_asked: true;
    };
  };
  offer_authority: {
    mode: 'none' | 'range_only' | 'range_with_approval'; allow_step_ups: boolean; step_size_pct: number;
    /** Offer floor as a percent of the deal's MAO (the ceiling). */
    floor_pct_of_mao: number; agreement_requires_rep_approval: boolean;
    /** How a quote is said: one number inside the range, or the range itself as a ballpark. */
    quote_as: 'number' | 'range';
  };
  call_handling: {
    max_call_seconds: number; silence_timeout_s: number; first_response_delay_ms: number; interruption_sensitivity: number;
    turn_eagerness: 'patient' | 'normal' | 'eager';
    voicemail: { detect: boolean; action: 'leave_message' | 'hang_up'; message_template: string };
    call_hours: Hours; retry: { max_attempts: number; gap_hours: number };
  };
  live_transfer: {
    enabled: boolean; mode: 'warm' | 'cold'; destinations: Destination[];
    triggers: { asks_for_person: boolean; hot_lead: boolean; angry_or_escalating: boolean; above_range: boolean; legal_or_complex: boolean; custom: { id: string; text: string }[] };
    whisper_message_template: string; fallback: 'book_callback' | 'voicemail' | 'apologize_end';
  };
  tools: Record<ToolKey, ToolSetting>;
  knowledge: { faqs: { id: string; q: string; a: string }[]; company_facts: string[] };
  channels: { phone_number_id: string | null; inbound: boolean; outbound: boolean };
};

const ALL_DAYS = [...DAYS];
const tool = (enabled: boolean, key: ToolKey): ToolSetting => ({ enabled, available: TOOL_AVAILABLE[key] });

export function defaultSettings(): AgentSettings {
  return {
    identity: { name: '', company: '', role: 'lead_manager', introduce_as: 'virtual_assistant', languages: ['en'] },
    voice: { voice_id: DEFAULT_VOICE_ID, tts_model: 'eleven_v4_turbo', stability: null, similarity: null, speed: null, llm: DEFAULT_LLM, thinking: 'light' },
    personality: { tone: 'warm', energy: 3, verbosity: 2, warmth: 3, formality: 3, use_fillers: true, humor: 0, expressiveness: 'natural' },
    script: { template_id: '', sections: [], raw_prompt_override: null, master_script_text: '' },
    rules: {
      dos: [], donts: [], never_mention: [], forbidden_phrases: [], required_phrases: [],
      compliance: {
        honor_dnc: true, quiet_hours: { enabled: true, start: '08:00', end: '21:00', tz: 'America/Chicago' },
        recording_notice: { enabled: false, text: 'This call may be recorded.' }, ai_disclosure_when_asked: true,
      },
    },
    offer_authority: { mode: 'none', allow_step_ups: false, step_size_pct: 2, floor_pct_of_mao: 85, agreement_requires_rep_approval: true, quote_as: 'number' },
    call_handling: {
      max_call_seconds: 600, silence_timeout_s: 30, first_response_delay_ms: 0, interruption_sensitivity: 3, turn_eagerness: 'normal',
      voicemail: { detect: true, action: 'leave_message', message_template: 'Hi, this is {{agent_name}} with {{company}}. Please call us back when you can. Thank you.' },
      call_hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '08:00', end: '21:00', tz: 'America/Chicago' },
      retry: { max_attempts: 0, gap_hours: 24 },
    },
    live_transfer: {
      // A positive call is warm-transferred to the rep working the lead; booking is the fallback.
      enabled: true, mode: 'warm', destinations: [{ id: 'rep', label: 'The rep working the lead', number: '', type: 'rep_assigned', ring_timeout_s: 25 }],
      triggers: { asks_for_person: true, hot_lead: true, angry_or_escalating: false, above_range: false, legal_or_complex: false, custom: [] },
      whisper_message_template: '', fallback: 'book_callback',
    },
    tools: {
      lead_context: tool(true, 'lead_context'), book_appointment: tool(true, 'book_appointment'), save_qualification: tool(true, 'save_qualification'),
      mark_do_not_contact: tool(true, 'mark_do_not_contact'), get_compr_offer: tool(false, 'get_compr_offer'), request_agreement: tool(false, 'request_agreement'),
      transfer: tool(true, 'transfer'), end_call: tool(true, 'end_call'),
    },
    knowledge: { faqs: [], company_facts: [] },
    channels: { phone_number_id: null, inbound: true, outbound: false },
  };
}

/** Is the tool really on: switched on, built, and (transfer) with a place to send the call. */
export function toolOn(s: AgentSettings, k: ToolKey): boolean {
  const t = s.tools[k];
  if (!t || !t.enabled || !TOOL_AVAILABLE[k]) return false;
  if (k === 'transfer') return s.live_transfer.enabled && s.live_transfer.destinations.length > 0;
  return true;
}

// ---- Text that must never reach a prompt ------------------------------------------

const AI_WORDS = 'ai|a\\.i\\.|robot|bot|artificial(?: intelligence)?|virtual assistant|automated(?: assistant| system)?|recording|recorded message|computer';
const DENY_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:deny|denies|denying|lie about|lying about|hide|hiding|conceal|concealing)\\b[^.\\n]{0,40}\\b(?:${AI_WORDS})\\b`, 'i'),
  new RegExp(`\\b(?:never|don'?t|do not|must not|mustn'?t|avoid|refuse to|cannot|can'?t)\\s+(?:ever\\s+)?(?:admit|reveal|disclose|confirm|acknowledge|say|mention|tell (?:them|anyone|callers?|the caller))\\b[^.\\n]{0,30}\\b(?:you(?:'re| are)|that you(?:'re| are)|being)\\s+(?:an?\\s+)?(?:${AI_WORDS})\\b`, 'i'),
  /\b(?:if (?:asked|they ask|anyone asks|the caller asks)|when asked)\b[^.\n]{0,60}\b(?:you are|you're|say you are|tell them you are)\s+(?:an?\s+)?(?:human|real person|person|live agent)\b/i,
];
const CLAIM_HUMAN = /\b(?:claim|say|tell (?:them|the caller|callers)|pretend|insist|act like|state)\b[^.\n]{0,25}\b(?:you(?:'re| are)|to be|as if you(?:'re| are)?)\s+(?:an?\s+)?(?:human|real person|person|live agent|not (?:an?\s+)?(?:ai|robot|bot|recording))/gi;
const NEGATED = /(?:never|not|n't|no|don'?t|do not|must not|mustn'?t|cannot|can'?t)\s+(?:\w+\s+){0,2}$/i;

/** The first phrase in `text` that tells the agent to deny being an AI (or to claim to be human), or null. A negated "never claim to be human" is fine. */
export function deniesAi(text: string): string | null {
  for (const p of DENY_PATTERNS) { const m = text.match(p); if (m) return m[0].slice(0, 80); }
  CLAIM_HUMAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAIM_HUMAN.exec(text))) {
    if (!NEGATED.test(text.slice(Math.max(0, m.index - 30), m.index))) return m[0].slice(0, 80);
  }
  return null;
}

/** A never_mention or forbidden_phrases entry that is really "never say you are an AI". */
const FORBIDS_AI_WORD = /\b(?:ai|a\.i\.|robot|bot|virtual assistant|artificial intelligence|automated assistant)\b/i;

// ---- Readers ------------------------------------------------------------------

type Rec = Record<string, unknown>;
export type NormalizeResult = { settings: AgentSettings; errors: string[]; warnings: string[] };
type Ctx = { errs: string[]; warns: string[] };

const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** Control characters out; line breaks and tabs become a space unless kept; `{{ }}` handled by the caller. */
function strip(v: unknown, max: number, multiline = false): string {
  let s = String(v ?? '');
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    : s.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ');
  return s.trim().slice(0, max).trim();
}
/** Plain text: any {{ }} is removed. */
export const cleanText = (v: unknown, max: number, multiline = false) => strip(v, Infinity, multiline).replace(/\{\{|\}\}/g, '').slice(0, max).trim();
/** Prompt text: real variables kept, unknown ones defused. */
export const cleanVarText = (v: unknown, max: number, multiline = false) => sanitizeVars(strip(v, Infinity, multiline)).slice(0, max).trim();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

function sub(c: Ctx, parent: Rec, key: string, path: string): Rec | undefined {
  const v = parent[key];
  if (v === undefined) return undefined;
  if (!isObj(v)) { c.errs.push(`${path}${key} must be an object`); return undefined; }
  return v;
}
function rStr<T extends string>(c: Ctx, o: Rec | undefined, k: string, base: T, path: string, max: number, opts: { multiline?: boolean; vars?: boolean } = {}): string {
  const v = o?.[k];
  if (v === undefined) return base;
  if (typeof v !== 'string') { c.errs.push(`${path}${k} must be a string`); return base; }
  return opts.vars ? cleanVarText(v, max, opts.multiline) : cleanText(v, max, opts.multiline);
}
function rBool(c: Ctx, o: Rec | undefined, k: string, base: boolean, path: string): boolean {
  const v = o?.[k];
  if (v === undefined) return base;
  if (typeof v !== 'boolean') { c.errs.push(`${path}${k} must be true or false`); return base; }
  return v;
}
function rNum(c: Ctx, o: Rec | undefined, k: string, base: number, path: string, lo: number, hi: number, decimals = 0): number {
  const v = o?.[k];
  if (v === undefined) return base;
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) { c.errs.push(`${path}${k} must be a number`); return base; }
  const f = 10 ** decimals;
  return Math.round(Math.min(hi, Math.max(lo, n)) * f) / f;
}
function rNumOrNull(c: Ctx, o: Rec | undefined, k: string, base: number | null, path: string, lo: number, hi: number): number | null {
  const v = o?.[k];
  if (v === undefined) return base;
  if (v === null) return null;
  return rNum(c, o, k, base ?? lo, path, lo, hi, 2);
}
function rEnum<T extends string>(c: Ctx, o: Rec | undefined, k: string, base: T, path: string, allowed: readonly T[]): T {
  const v = o?.[k];
  if (v === undefined) return base;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  c.errs.push(`${path}${k} must be one of ${allowed.join(', ')}`);
  return base;
}
function rList<T>(c: Ctx, o: Rec | undefined, k: string, base: T[], path: string, max: number, item: (x: unknown, i: number) => T | null): T[] {
  const v = o?.[k];
  if (v === undefined) return base;
  if (!Array.isArray(v)) { c.errs.push(`${path}${k} must be a list`); return base; }
  if (v.length > max) c.warns.push(`${path}${k} keeps the first ${max} of ${v.length} items`);
  const out: T[] = [];
  v.slice(0, max).forEach((x, i) => { const r = item(x, i); if (r !== null) out.push(r); });
  return out;
}
function rHours(c: Ctx, o: Rec | undefined, base: Hours, path: string): Hours {
  if (!o) return base;
  const h: Hours = { ...base, days: [...base.days] };
  if (o.days !== undefined) {
    if (!Array.isArray(o.days) || o.days.some((d) => typeof d !== 'string' || !(DAYS as readonly string[]).includes(d))) c.errs.push(`${path}days must be a list of ${DAYS.join(', ')}`);
    else h.days = DAYS.filter((d) => (o.days as string[]).includes(d));
  }
  for (const k of ['start', 'end'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] === 'string' && HHMM.test(o[k] as string)) h[k] = o[k] as string; else c.errs.push(`${path}${k} must be HH:MM (24 hour)`);
  }
  if (o.tz !== undefined) {
    if (typeof o.tz === 'string' && o.tz.length <= 64 && validTz(o.tz)) h.tz = o.tz; else c.errs.push(`${path}tz must be an IANA time zone such as America/Chicago`);
  }
  return h;
}
const uniq = (id: string, seen: Set<string>) => { let x = id, n = 2; while (seen.has(x)) x = `${id.slice(0, 36)}_${n++}`; seen.add(x); return x; };
const idOf = (raw: unknown, fallback: string) => slugify(String(raw ?? '')).slice(0, 40) || fallback;

function ruleList(c: Ctx, o: Rec | undefined, k: 'dos' | 'donts', base: Rule[], path: string): Rule[] {
  const seen = new Set<string>();
  return rList(c, o, k, base, path, 40, (x, i) => {
    if (!isObj(x)) { c.errs.push(`${path}${k}[${i}] must be an object`); return null; }
    const text = cleanVarText(x.text, 300);
    if (!text) return null;
    if (x.severity !== undefined && x.severity !== 'hard' && x.severity !== 'soft') c.errs.push(`${path}${k}[${i}].severity must be hard or soft`);
    return { id: uniq(idOf(x.id, `${k === 'dos' ? 'do' : 'dont'}${i + 1}`), seen), text, severity: x.severity === 'soft' ? 'soft' : 'hard' };
  });
}

// ---- Normalize ----------------------------------------------------------------

const LEGACY_KEYS = ['agent_name', 'company', 'voice_id', 'tts_model', 'voice_stability', 'voice_similarity', 'voice_speed', 'tone', 'opening_style', 'extra_instructions', 'max_call_seconds', 'transfer_number', 'never_mention', 'call_hours'];
const V2_KEYS = ['identity', 'voice', 'personality', 'script', 'rules', 'offer_authority', 'call_handling', 'live_transfer', 'tools', 'knowledge', 'channels'];

/** The flat v1 settings shape, mapped onto v2, so a client that has not moved yet still saves. */
export function legacyToV2(o: Rec): Rec {
  const out: Rec = {};
  const put = (path: string[], v: unknown) => {
    if (v === undefined) return;
    let cur = out;
    for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as Rec;
    cur[path[path.length - 1]] = v;
  };
  put(['identity', 'name'], o.agent_name); put(['identity', 'company'], o.company);
  put(['voice', 'voice_id'], o.voice_id); put(['voice', 'tts_model'], o.tts_model);
  put(['voice', 'stability'], o.voice_stability); put(['voice', 'similarity'], o.voice_similarity); put(['voice', 'speed'], o.voice_speed);
  put(['personality', 'tone'], o.tone);
  const extra = [o.opening_style ? `Opening style: ${o.opening_style}` : '', o.extra_instructions ?? ''].filter(Boolean).join('\n\n');
  if (extra) put(['script', 'sections'], [{ id: 'extra', title: 'Additional guidance', body: extra, enabled: true }]);
  put(['call_handling', 'max_call_seconds'], o.max_call_seconds);
  if (o.call_hours !== undefined) put(['call_handling', 'call_hours'], o.call_hours === null ? undefined : { days: ALL_DAYS, ...(o.call_hours as Rec) });
  if (o.transfer_number !== undefined) {
    put(['live_transfer', 'enabled'], !!o.transfer_number);
    put(['live_transfer', 'destinations'], o.transfer_number ? [{ id: 'office', label: 'Office', number: o.transfer_number, type: 'fixed', ring_timeout_s: 25 }] : []);
  }
  put(['rules', 'never_mention'], o.never_mention);
  return out;
}

/**
 * Validate and clamp settings. `input` may be partial: a key it does not name
 * keeps its value from `base`, arrays it names replace the base's. Errors
 * (wrong shape, a value that is not allowed) mean nothing should be stored;
 * warnings are things that were changed on the way in (a locked field, a list
 * cut to its cap).
 */
export function normalizeSettings(input: unknown, base: AgentSettings = defaultSettings()): NormalizeResult {
  const c: Ctx = { errs: [], warns: [] };
  const s: AgentSettings = structuredClone(base);
  if (!isObj(input)) return { settings: s, errors: ['settings must be an object'], warnings: [] };
  const raw: Rec = LEGACY_KEYS.some((k) => k in input) && !V2_KEYS.some((k) => k in input) ? legacyToV2(input) : input;

  // identity
  const id = sub(c, raw, 'identity', '');
  s.identity.name = rStr(c, id, 'name', s.identity.name, 'identity.', 40);
  s.identity.company = rStr(c, id, 'company', s.identity.company, 'identity.', 80);
  s.identity.role = rStr(c, id, 'role', s.identity.role, 'identity.', 60);
  s.identity.introduce_as = rEnum(c, id, 'introduce_as', s.identity.introduce_as, 'identity.', ['none', 'virtual_assistant'] as const);
  s.identity.languages = rList(c, id, 'languages', s.identity.languages, 'identity.', 5, (x, i) => {
    if (typeof x === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(x.trim())) return x.trim();
    c.errs.push(`identity.languages[${i}] must be a language code such as en or es`); return null;
  });
  if (!s.identity.languages.length) s.identity.languages = ['en'];
  s.identity.languages = [...new Set(s.identity.languages)];

  // voice
  const vo = sub(c, raw, 'voice', '');
  const vid = vo?.voice_id;
  if (vid !== undefined) {
    if (typeof vid !== 'string') c.errs.push('voice.voice_id must be a string');
    else if (!vid.trim()) s.voice.voice_id = DEFAULT_VOICE_ID;
    else if (!/^[A-Za-z0-9_-]{6,64}$/.test(vid.trim())) c.errs.push('voice.voice_id is not a valid voice id');
    else s.voice.voice_id = vid.trim();
  }
  s.voice.tts_model = rEnum(c, vo, 'tts_model', s.voice.tts_model, 'voice.', TTS_MODELS);
  s.voice.llm = rEnum(c, vo, 'llm', s.voice.llm, 'voice.', LLMS);
  s.voice.thinking = rEnum(c, vo, 'thinking', s.voice.thinking, 'voice.', THINKING);
  s.voice.stability = rNumOrNull(c, vo, 'stability', s.voice.stability, 'voice.', 0, 1);
  s.voice.similarity = rNumOrNull(c, vo, 'similarity', s.voice.similarity, 'voice.', 0, 1);
  s.voice.speed = rNumOrNull(c, vo, 'speed', s.voice.speed, 'voice.', SPEED_MIN, SPEED_MAX);

  // personality
  const pe = sub(c, raw, 'personality', '');
  s.personality.tone = rEnum(c, pe, 'tone', s.personality.tone, 'personality.', TONES);
  for (const k of ['energy', 'verbosity', 'warmth', 'formality'] as const) s.personality[k] = rNum(c, pe, k, s.personality[k], 'personality.', 1, 5);
  s.personality.use_fillers = rBool(c, pe, 'use_fillers', s.personality.use_fillers, 'personality.');
  s.personality.humor = rNum(c, pe, 'humor', s.personality.humor, 'personality.', 0, 3);
  s.personality.expressiveness = rEnum(c, pe, 'expressiveness', s.personality.expressiveness, 'personality.', EXPRESSIVENESS);

  // script
  const sc = sub(c, raw, 'script', '');
  s.script.template_id = rStr(c, sc, 'template_id', s.script.template_id, 'script.', 40);
  const secSeen = new Set<string>();
  s.script.sections = rList(c, sc, 'sections', s.script.sections, 'script.', 30, (x, i) => {
    if (!isObj(x)) { c.errs.push(`script.sections[${i}] must be an object`); return null; }
    const title = cleanText(x.title, 80);
    const body = cleanVarText(x.body, 8000, true);
    if (!title && !body) return null;
    if (x.enabled !== undefined && typeof x.enabled !== 'boolean') c.errs.push(`script.sections[${i}].enabled must be true or false`);
    return { id: uniq(idOf(x.id ?? title, `s${i + 1}`), secSeen), title, body, enabled: x.enabled !== false };
  });
  if (sc && sc.raw_prompt_override !== undefined) {
    if (sc.raw_prompt_override === null) s.script.raw_prompt_override = null;
    else if (typeof sc.raw_prompt_override !== 'string') c.errs.push('script.raw_prompt_override must be a string or null');
    else s.script.raw_prompt_override = cleanVarText(sc.raw_prompt_override, 20000, true) || null;
  }
  s.script.master_script_text = rStr(c, sc, 'master_script_text', s.script.master_script_text, 'script.', 20000, { multiline: true, vars: true });

  // rules
  const ru = sub(c, raw, 'rules', '');
  s.rules.dos = ruleList(c, ru, 'dos', s.rules.dos, 'rules.');
  s.rules.donts = ruleList(c, ru, 'donts', s.rules.donts, 'rules.');
  const short = (k: 'never_mention' | 'forbidden_phrases', max: number, n: number) => {
    s.rules[k] = rList(c, ru, k, s.rules[k], 'rules.', n, (x, i) => {
      if (typeof x !== 'string') { c.errs.push(`rules.${k}[${i}] must be a string`); return null; }
      const t = cleanText(x, max);
      if (t && FORBIDS_AI_WORD.test(t)) { c.errs.push(`rules.${k}[${i}] cannot forbid saying the agent is an AI: the agent always answers honestly when sincerely asked`); return null; }
      return t || null;
    });
    const seen = new Set<string>();
    s.rules[k] = s.rules[k].filter((t) => { const l = t.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; });
  };
  short('never_mention', 80, 20);
  short('forbidden_phrases', 60, 30);
  s.rules.required_phrases = rList(c, ru, 'required_phrases', s.rules.required_phrases, 'rules.', 20, (x, i) => {
    if (!isObj(x)) { c.errs.push(`rules.required_phrases[${i}] must be an object`); return null; }
    const when = cleanText(x.when, 120); const text = cleanVarText(x.text, 300);
    return when && text ? { when, text } : null;
  });
  const co = ru ? sub(c, ru, 'compliance', 'rules.') : undefined;
  if (co) {
    if (co.honor_dnc === false) c.warns.push('rules.compliance.honor_dnc is locked on and cannot be turned off');
    if (co.ai_disclosure_when_asked === false) c.warns.push('rules.compliance.ai_disclosure_when_asked is locked on and cannot be turned off');
    const qh = sub(c, co, 'quiet_hours', 'rules.compliance.');
    const q = s.rules.compliance.quiet_hours;
    q.enabled = rBool(c, qh, 'enabled', q.enabled, 'rules.compliance.quiet_hours.');
    const h = rHours(c, qh, { days: ALL_DAYS, start: q.start, end: q.end, tz: q.tz }, 'rules.compliance.quiet_hours.');
    q.start = h.start; q.end = h.end; q.tz = h.tz;
    const rn = sub(c, co, 'recording_notice', 'rules.compliance.');
    s.rules.compliance.recording_notice.enabled = rBool(c, rn, 'enabled', s.rules.compliance.recording_notice.enabled, 'rules.compliance.recording_notice.');
    s.rules.compliance.recording_notice.text = rStr(c, rn, 'text', s.rules.compliance.recording_notice.text, 'rules.compliance.recording_notice.', 200, { vars: true }) || 'This call may be recorded.';
  }
  s.rules.compliance.honor_dnc = true;
  s.rules.compliance.ai_disclosure_when_asked = true;

  // offer authority
  const oa = sub(c, raw, 'offer_authority', '');
  s.offer_authority.mode = rEnum(c, oa, 'mode', s.offer_authority.mode, 'offer_authority.', ['none', 'range_only', 'range_with_approval'] as const);
  s.offer_authority.allow_step_ups = rBool(c, oa, 'allow_step_ups', s.offer_authority.allow_step_ups, 'offer_authority.');
  s.offer_authority.step_size_pct = rNum(c, oa, 'step_size_pct', s.offer_authority.step_size_pct, 'offer_authority.', 0.5, 10, 1);
  s.offer_authority.floor_pct_of_mao = rNum(c, oa, 'floor_pct_of_mao', s.offer_authority.floor_pct_of_mao, 'offer_authority.', 50, 100, 1);
  s.offer_authority.agreement_requires_rep_approval = rBool(c, oa, 'agreement_requires_rep_approval', s.offer_authority.agreement_requires_rep_approval, 'offer_authority.');
  s.offer_authority.quote_as = rEnum(c, oa, 'quote_as', s.offer_authority.quote_as, 'offer_authority.', ['number', 'range'] as const);

  // call handling
  const ch = sub(c, raw, 'call_handling', '');
  const chs = s.call_handling;
  chs.max_call_seconds = rNum(c, ch, 'max_call_seconds', chs.max_call_seconds, 'call_handling.', 60, 1800);
  chs.silence_timeout_s = rNum(c, ch, 'silence_timeout_s', chs.silence_timeout_s, 'call_handling.', 0, 300);
  chs.first_response_delay_ms = rNum(c, ch, 'first_response_delay_ms', chs.first_response_delay_ms, 'call_handling.', 0, 3000);
  chs.interruption_sensitivity = rNum(c, ch, 'interruption_sensitivity', chs.interruption_sensitivity, 'call_handling.', 1, 5);
  chs.turn_eagerness = rEnum(c, ch, 'turn_eagerness', chs.turn_eagerness, 'call_handling.', ['patient', 'normal', 'eager'] as const);
  const vm = ch ? sub(c, ch, 'voicemail', 'call_handling.') : undefined;
  chs.voicemail.detect = rBool(c, vm, 'detect', chs.voicemail.detect, 'call_handling.voicemail.');
  chs.voicemail.action = rEnum(c, vm, 'action', chs.voicemail.action, 'call_handling.voicemail.', ['leave_message', 'hang_up'] as const);
  chs.voicemail.message_template = rStr(c, vm, 'message_template', chs.voicemail.message_template, 'call_handling.voicemail.', 500, { vars: true });
  chs.call_hours = rHours(c, ch ? sub(c, ch, 'call_hours', 'call_handling.') : undefined, chs.call_hours, 'call_handling.call_hours.');
  const rt = ch ? sub(c, ch, 'retry', 'call_handling.') : undefined;
  chs.retry.max_attempts = rNum(c, rt, 'max_attempts', chs.retry.max_attempts, 'call_handling.retry.', 0, 10);
  chs.retry.gap_hours = rNum(c, rt, 'gap_hours', chs.retry.gap_hours, 'call_handling.retry.', 1, 168);

  // live transfer
  const lt = sub(c, raw, 'live_transfer', '');
  const lts = s.live_transfer;
  lts.enabled = rBool(c, lt, 'enabled', lts.enabled, 'live_transfer.');
  lts.mode = rEnum(c, lt, 'mode', lts.mode, 'live_transfer.', ['warm', 'cold'] as const);
  const destSeen = new Set<string>();
  lts.destinations = rList(c, lt, 'destinations', lts.destinations, 'live_transfer.', 6, (x, i) => {
    if (!isObj(x)) { c.errs.push(`live_transfer.destinations[${i}] must be an object`); return null; }
    const type = rEnum(c, x, 'type', 'fixed' as Destination['type'], `live_transfer.destinations[${i}].`, ['rep_assigned', 'fixed', 'ring_group'] as const);
    let number = '';
    if (type === 'rep_assigned' && (x.number === undefined || x.number === null || x.number === '')) number = '';
    else {
      const e164 = typeof x.number === 'string' ? toE164(x.number.slice(0, 40)) : null;
      if (!e164 || e164.length > 16) { c.errs.push(`live_transfer.destinations[${i}].number is not a valid phone number`); return null; }
      number = e164;
    }
    const d: Destination = {
      id: uniq(idOf(x.id ?? x.label, `d${i + 1}`), destSeen), label: cleanText(x.label, 60) || `Destination ${i + 1}`, number, type,
      ring_timeout_s: rNum(c, x, 'ring_timeout_s', 25, `live_transfer.destinations[${i}].`, 5, 60),
    };
    if (isObj(x.hours)) d.hours = rHours(c, x.hours, { days: ALL_DAYS, start: '08:00', end: '18:00', tz: 'America/Chicago' }, `live_transfer.destinations[${i}].hours.`);
    else if (x.hours !== undefined && x.hours !== null) c.errs.push(`live_transfer.destinations[${i}].hours must be an object or null`);
    return d;
  });
  const tr = lt ? sub(c, lt, 'triggers', 'live_transfer.') : undefined;
  for (const k of ['asks_for_person', 'hot_lead', 'angry_or_escalating', 'above_range', 'legal_or_complex'] as const) lts.triggers[k] = rBool(c, tr, k, lts.triggers[k], 'live_transfer.triggers.');
  const trSeen = new Set<string>();
  lts.triggers.custom = rList(c, tr, 'custom', lts.triggers.custom, 'live_transfer.triggers.', 10, (x, i) => {
    if (!isObj(x)) { c.errs.push(`live_transfer.triggers.custom[${i}] must be an object`); return null; }
    const text = cleanText(x.text, 200);
    return text ? { id: uniq(idOf(x.id, `c${i + 1}`), trSeen), text } : null;
  });
  lts.whisper_message_template = rStr(c, lt, 'whisper_message_template', lts.whisper_message_template, 'live_transfer.', 500, { vars: true });
  lts.fallback = rEnum(c, lt, 'fallback', lts.fallback, 'live_transfer.', ['book_callback', 'voicemail', 'apologize_end'] as const);

  // tools
  const tl = sub(c, raw, 'tools', '');
  for (const k of TOOL_KEYS) {
    const t = tl ? sub(c, tl, k, 'tools.') : undefined;
    s.tools[k] = { enabled: rBool(c, t, 'enabled', s.tools[k]?.enabled ?? false, `tools.${k}.`), available: TOOL_AVAILABLE[k] };
  }
  if (tl) for (const k of Object.keys(tl)) if (!(TOOL_KEYS as readonly string[]).includes(k)) c.warns.push(`tools.${k} is not a known tool and was ignored`);

  // knowledge
  const kn = sub(c, raw, 'knowledge', '');
  const faqSeen = new Set<string>();
  s.knowledge.faqs = rList(c, kn, 'faqs', s.knowledge.faqs, 'knowledge.', 40, (x, i) => {
    if (!isObj(x)) { c.errs.push(`knowledge.faqs[${i}] must be an object`); return null; }
    const q = cleanText(x.q, 200); const a = cleanVarText(x.a, 800, true);
    return q && a ? { id: uniq(idOf(x.id, `f${i + 1}`), faqSeen), q, a } : null;
  });
  s.knowledge.company_facts = rList(c, kn, 'company_facts', s.knowledge.company_facts, 'knowledge.', 40, (x, i) => {
    if (typeof x !== 'string') { c.errs.push(`knowledge.company_facts[${i}] must be a string`); return null; }
    return cleanVarText(x, 300) || null;
  });

  // channels
  const cn = sub(c, raw, 'channels', '');
  if (cn && cn.phone_number_id !== undefined) {
    if (cn.phone_number_id === null || cn.phone_number_id === '') s.channels.phone_number_id = null;
    else if (typeof cn.phone_number_id === 'string' && /^[A-Za-z0-9_-]{4,80}$/.test(cn.phone_number_id.trim())) s.channels.phone_number_id = cn.phone_number_id.trim();
    else c.errs.push('channels.phone_number_id is not a valid phone number id');
  }
  s.channels.inbound = rBool(c, cn, 'inbound', s.channels.inbound, 'channels.');
  s.channels.outbound = rBool(c, cn, 'outbound', s.channels.outbound, 'channels.');

  // Text that tells the agent to deny being an AI is refused wherever it is written.
  for (const [label, text] of freeTexts(s)) {
    const hit = deniesAi(text);
    if (hit) c.errs.push(`${label} tells the agent to deny being an AI ("${hit}"), which is not allowed`);
  }
  return { settings: s, errors: c.errs, warnings: c.warns };
}

/** Every free-text field that ends up in a prompt, with a label for error messages. */
export function freeTexts(s: AgentSettings): [string, string][] {
  const out: [string, string][] = [];
  s.script.sections.forEach((x) => out.push([`script.sections[${x.id}]`, x.title + '\n' + x.body]));
  if (s.script.raw_prompt_override) out.push(['script.raw_prompt_override', s.script.raw_prompt_override]);
  if (s.script.master_script_text) out.push(['script.master_script_text', s.script.master_script_text]);
  s.rules.dos.forEach((r) => out.push([`rules.dos[${r.id}]`, r.text]));
  s.rules.donts.forEach((r) => out.push([`rules.donts[${r.id}]`, r.text]));
  s.rules.required_phrases.forEach((r, i) => out.push([`rules.required_phrases[${i}]`, r.text]));
  s.rules.forbidden_phrases.forEach((t, i) => out.push([`rules.forbidden_phrases[${i}]`, t]));
  out.push(['voicemail.message_template', s.call_handling.voicemail.message_template]);
  out.push(['live_transfer.whisper_message_template', s.live_transfer.whisper_message_template]);
  s.live_transfer.triggers.custom.forEach((t) => out.push([`live_transfer.triggers.custom[${t.id}]`, t.text]));
  s.knowledge.faqs.forEach((f) => out.push([`knowledge.faqs[${f.id}]`, f.a]));
  s.knowledge.company_facts.forEach((t, i) => out.push([`knowledge.company_facts[${i}]`, t]));
  return out.filter(([, t]) => t);
}

/** A stored jsonb (any version) back into settings; whatever no longer validates falls back to the default. */
export function settingsFromRow(stored: unknown): AgentSettings {
  return normalizeSettings(stored, defaultSettings()).settings;
}

// ---- Diff -----------------------------------------------------------------------

export type Change = { path: string; from: unknown; to: unknown };

function flatten(v: unknown, path: string, out: Map<string, unknown>) {
  if (Array.isArray(v) && v.length && v.every((x) => isObj(x) && typeof x.id === 'string')) {
    for (const x of v as Rec[]) flatten(x, `${path}[${x.id}]`, out);
    out.set(`${path}#order`, (v as Rec[]).map((x) => x.id));
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, v);
}

/** Leaf-level changes between two settings objects. Lists of items with ids are compared item by item, so a reworded section is one change, not a whole-list change. */
export function diffSettings(a: unknown, b: unknown): Change[] {
  const fa = new Map<string, unknown>(); const fb = new Map<string, unknown>();
  flatten(a, '', fa); flatten(b, '', fb);
  const paths = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const out: Change[] = [];
  for (const p of paths) {
    const x = fa.get(p); const y = fb.get(p);
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: p, from: x === undefined ? null : x, to: y === undefined ? null : y });
  }
  return out;
}

/** Lines only in b (added) and only in a (removed), in order. A cheap prompt diff for the versions screen. */
export function diffLines(a: string, b: string): { added: string[]; removed: string[] } {
  const la = a.split('\n'); const lb = b.split('\n');
  const sa = new Set(la); const sb = new Set(lb);
  return { added: lb.filter((l) => l.trim() && !sa.has(l)), removed: la.filter((l) => l.trim() && !sb.has(l)) };
}
