// The AI Agent console's pure half (Settings, AI Agent): the v2 shapes the
// `voice-agent-admin` edge function speaks (mirrors _shared/voice-agent-settings.ts
// on feat/voice-agent-admin), the reading, cleaning and validating the screen
// does before it saves or draws anything. No network, no React, so the rules
// can be tested without either. Console-only helpers (diff text, hours, lists,
// stats) live in voice-agent-console.ts.

// ---- Vocabulary ---------------------------------------------------------------------

export type Tone = 'warm' | 'direct' | 'professional';
export const TONES: { id: Tone; label: string; hint: string }[] = [
  { id: 'warm', label: 'Warm', hint: 'Friendly and unhurried, like a neighbor who buys houses.' },
  { id: 'direct', label: 'Direct', hint: 'Short answers, gets to the point, respects their time.' },
  { id: 'professional', label: 'Professional', hint: 'Polished and measured, like a front desk.' },
];

export type TtsModel = 'eleven_v4_turbo' | 'eleven_v4' | 'eleven_flash_v2_5' | 'eleven_multilingual_v2' | 'eleven_v3_conversational';
export const TTS_DEFAULT: TtsModel = 'eleven_v4_turbo';
export const TTS_MODELS: { id: TtsModel; label: string; hint: string }[] = [
  { id: 'eleven_v4_turbo', label: 'v4 Turbo', hint: 'Natural, quick, and stops mid-word when the caller cuts in. ElevenLabs\' pick for phone agents and the default.' },
  { id: 'eleven_v4', label: 'v4', hint: 'The most natural v4 voice, but slower to start each reply. Better for recordings than live calls.' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5', hint: 'Fastest replies, a little flatter.' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2', hint: 'Richer and slower, many languages.' },
  { id: 'eleven_v3_conversational', label: 'v3 Conversational', hint: 'The most emotional, and the only one that can laugh, sigh or clear its throat (Personality, Delivery: Expressive). Does not keep the character of a Professional Voice Clone.' },
];
export const EXPRESSIVE_TTS: TtsModel = 'eleven_v3_conversational';
export type Expressiveness = 'off' | 'natural' | 'expressive';
export const EXPRESSIVENESS: { id: Expressiveness; label: string; hint: string }[] = [
  { id: 'off', label: 'Plain', hint: 'Clean, scripted delivery.' },
  { id: 'natural', label: 'Natural', hint: '"Um" and "hmm", thinking pauses, mirroring and matching the caller\'s mood.' },
  { id: 'expressive', label: 'Expressive', hint: 'Natural, plus real sounds: laughs, gasps, sighs, a throat clear. Needs the v3 Conversational voice model.' },
];
const isExpressiveness = (v: unknown): v is Expressiveness => EXPRESSIVENESS.some((x) => x.id === v);
export const ttsLabel = (m: string) => TTS_MODELS.find((x) => x.id === m)?.label ?? m;
export const isTts = (v: unknown): v is TtsModel => TTS_MODELS.some((m) => m.id === v);

/** The brain: the LLM ElevenLabs runs the conversation on. Mirrors LLMS in _shared/voice-agent-settings.ts. */
export type Llm = 'gemini-3.8-flash' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-haiku-4-5';
export const LLM_DEFAULT: Llm = 'gemini-3.8-flash';
export const LLMS: { id: Llm; label: string; hint: string }[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', hint: 'Fastest replies with solid judgment. The default.' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'Sharpest: sticks to the script and answers a pushy caller best. About half a second slower to reply.' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'The most capable, and noticeably slower to answer on a live call. Worth a test on an acquisitions agent; Sonnet 5.5 is the usual pick.' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'Quick and cheap. Fine for short, simple calls.' },
];
export const isLlm = (v: unknown): v is Llm => LLMS.some((m) => m.id === v);
export type Thinking = 'auto' | 'light' | 'deep';
export const THINKING: { id: Thinking; label: string }[] = [{ id: 'auto', label: 'Model default' }, { id: 'light', label: 'Light' }, { id: 'deep', label: 'Deep' }];
export function isTone(v: unknown): v is Tone {
  return v === 'warm' || v === 'direct' || v === 'professional';
}

/** The three voice-tuning knobs: range, step, and what ElevenLabs uses when the value is unset. */
export const TUNING = {
  stability: { min: 0, max: 1, step: 0.05, def: 0.5 },
  similarity: { min: 0, max: 1, step: 0.05, def: 0.8 },
  speed: { min: 0.7, max: 1.2, step: 0.05, def: 1 },
} as const;
export type TuningKey = keyof typeof TUNING;
export const TUNING_KEYS = Object.keys(TUNING) as TuningKey[];
export type Tuning = Record<TuningKey, number | null>;

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

export const TOOL_KEYS = [
  'lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'request_agreement', 'transfer', 'end_call',
] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

/** What each tool does, in words a rep would use. `available` comes from the server, never from here. */
export const TOOL_META: Record<ToolKey, { label: string; hint: string }> = {
  lead_context: { label: 'Look up the caller', hint: 'Reads the brief, latest offer and next appointment on the record, mid-call.' },
  book_appointment: { label: 'Book an appointment', hint: 'Finds real open times and books the seller with a rep.' },
  save_qualification: { label: 'Save what was learned', hint: 'Files motivation, timeline, condition and price expectations on the record.' },
  mark_do_not_contact: { label: 'Mark do not contact', hint: 'Puts the number on the do not contact list the moment someone asks.' },
  get_compr_offer: { label: 'Get the Compr offer range', hint: 'Pulls the current offer range from the underwrite before quoting a number.' },
  request_agreement: { label: 'Send the agreement', hint: 'Sends the purchase agreement, after a rep approves it.' },
  transfer: { label: 'Transfer to a person', hint: 'Hands the live call to a rep. Set the destinations under Live transfer.' },
  end_call: { label: 'End the call', hint: 'Hangs up politely when the conversation is done or the caller asks to stop.' },
};

// ---- Settings (v2) ------------------------------------------------------------------------

export type Hours = { days: string[]; start: string; end: string; tz: string };
export type Rule = { id: string; text: string; severity: 'hard' | 'soft' };
export type ScriptSection = { id: string; title: string; body: string; enabled: boolean };
export type DestinationType = 'rep_assigned' | 'fixed' | 'ring_group';
export type Destination = { id: string; label: string; number: string; type: DestinationType; hours?: Hours; ring_timeout_s: number };
export type ToolSetting = { enabled: boolean; available: boolean };
export type TurnEagerness = 'patient' | 'normal' | 'eager';
export type OfferMode = 'none' | 'range_only' | 'range_with_approval';
export type TransferFallback = 'book_callback' | 'voicemail' | 'apologize_end';

export type AgentSettings = {
  identity: { name: string; company: string; role: string; introduce_as: 'none' | 'virtual_assistant'; languages: string[] };
  voice: { voice_id: string; tts_model: TtsModel; llm: Llm; thinking: Thinking } & Tuning;
  personality: { tone: Tone; energy: number; verbosity: number; warmth: number; formality: number; use_fillers: boolean; humor: number; expressiveness: Expressiveness };
  script: { template_id: string; sections: ScriptSection[]; raw_prompt_override: string | null; master_script_text: string };
  rules: {
    dos: Rule[]; donts: Rule[]; never_mention: string[]; forbidden_phrases: string[]; required_phrases: { when: string; text: string }[];
    compliance: {
      honor_dnc: true;
      quiet_hours: { enabled: boolean; start: string; end: string; tz: string };
      recording_notice: { enabled: boolean; text: string };
      ai_disclosure_when_asked: true;
    };
  };
  offer_authority: { mode: OfferMode; allow_step_ups: boolean; step_size_pct: number; floor_pct_of_mao: number; agreement_requires_rep_approval: boolean; quote_as: 'number' | 'range' };
  call_handling: {
    max_call_seconds: number; silence_timeout_s: number; first_response_delay_ms: number; interruption_sensitivity: number; turn_eagerness: TurnEagerness;
    voicemail: { detect: boolean; action: 'leave_message' | 'hang_up'; message_template: string };
    call_hours: Hours; retry: { max_attempts: number; gap_hours: number };
  };
  live_transfer: {
    enabled: boolean; mode: 'warm' | 'cold'; destinations: Destination[];
    triggers: { asks_for_person: boolean; hot_lead: boolean; angry_or_escalating: boolean; above_range: boolean; legal_or_complex: boolean; custom: { id: string; text: string }[] };
    whisper_message_template: string; fallback: TransferFallback;
  };
  tools: Record<ToolKey, ToolSetting>;
  knowledge: { faqs: { id: string; q: string; a: string }[]; company_facts: string[] };
  channels: { phone_number_id: string | null; inbound: boolean; outbound: boolean };
};

/** Field limits the server enforces (it clamps or refuses past them); the form shows them as counters and errors. */
export const LIMITS = {
  name: 40, company: 80, role: 60, languages: 5, sectionTitle: 80, sectionBody: 8000, sections: 30, override: 20000, master: 20000,
  ruleText: 300, rules: 40, neverMention: 80, neverMentionCount: 20, forbidden: 60, forbiddenCount: 30, requiredWhen: 120, requiredText: 300, requiredCount: 20,
  recordingText: 200, voicemail: 500, whisper: 500, destinations: 6, destLabel: 60, customTrigger: 200, customTriggers: 10,
  faqQ: 200, faqA: 800, faqs: 40, fact: 300, facts: 40,
} as const;
export const CALL_MIN_SECONDS = 60;
export const CALL_MAX_SECONDS = 1800;

export const DEFAULT_VOICE_ID = 'cjVigY5qzO86Huf0OWal';
const ALL_DAYS: string[] = [...DAYS];

const tool = (enabled: boolean): ToolSetting => ({ enabled, available: false });

export function defaultSettings(): AgentSettings {
  return {
    identity: { name: '', company: '', role: 'lead_manager', introduce_as: 'virtual_assistant', languages: ['en'] },
    voice: { voice_id: DEFAULT_VOICE_ID, tts_model: TTS_DEFAULT, stability: null, similarity: null, speed: null, llm: LLM_DEFAULT, thinking: 'light' },
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
      enabled: true, mode: 'warm', destinations: [{ id: 'rep', label: 'The rep working the lead', number: '', type: 'rep_assigned', ring_timeout_s: 25 }],
      triggers: { asks_for_person: true, hot_lead: true, angry_or_escalating: false, above_range: false, legal_or_complex: false, custom: [] },
      whisper_message_template: '', fallback: 'book_callback',
    },
    tools: {
      lead_context: tool(true), book_appointment: tool(true), save_qualification: tool(true), mark_do_not_contact: tool(true),
      get_compr_offer: tool(false), request_agreement: tool(false), transfer: tool(true), end_call: tool(true),
    },
    knowledge: { faqs: [], company_facts: [] },
    channels: { phone_number_id: null, inbound: true, outbound: false },
  };
}

// ---- Replies ---------------------------------------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; errors?: string[] };

/**
 * What a reply means: `{ok:true,...}` is the payload, `{error}` is the reason
 * (whatever the HTTP status), and a transport failure that never reached the
 * function says the function is not deployed rather than "failed to send".
 * A 422's `errors[]` rides along so a field can show its own message.
 */
export function interpretReply(data: unknown, transportError: string | null): Result<Record<string, unknown>> {
  const res = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (typeof res.error === 'string' && res.error) {
    const errors = Array.isArray(res.errors) ? res.errors.filter((e): e is string => typeof e === 'string') : undefined;
    return { ok: false, error: res.error, ...(errors?.length ? { errors } : {}) };
  }
  if (transportError) {
    return { ok: false, error: /failed to send|not found|404/i.test(transportError) ? 'The voice-agent-admin function is not deployed on the Supabase project yet.' : transportError };
  }
  if (res.ok === false) return { ok: false, error: 'The request was refused.' };
  return { ok: true, data: res };
}

// ---- Reading and cleaning settings ------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Rec => (isObj(v) ? v : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const txt = (v: unknown, d = ''): string => (typeof v === 'string' ? v.trim() : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const round = (n: number, dec: number) => { const f = 10 ** dec; return Math.round(n * f) / f; };
const num = (v: unknown, d: number, lo: number, hi: number, dec = 0): number => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? round(Math.min(hi, Math.max(lo, n)), dec) : d;
};
const numOrNull = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? round(Math.min(hi, Math.max(lo, v)), 2) : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => ((allowed as readonly string[]).includes(v as string) ? (v as T) : d);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (v: string) => HHMM.test(v);

function hours(v: unknown, d: Hours): Hours {
  const o = obj(v);
  const days = Array.isArray(o.days) ? DAYS.filter((x) => (o.days as unknown[]).includes(x)) : [...d.days];
  return { days, start: HHMM.test(str(o.start)) ? str(o.start) : d.start, end: HHMM.test(str(o.end)) ? str(o.end) : d.end, tz: txt(o.tz) || d.tz };
}

/** Same ids twice would collide as React keys and as the server's id-keyed diff, so the second one is renumbered. */
function uniq(id: string, seen: Set<string>): string {
  let x = id; let n = 2;
  while (seen.has(x)) x = `${id.slice(0, 36)}_${n++}`;
  seen.add(x);
  return x;
}

const dedupeText = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter((t) => { const l = t.toLowerCase(); if (!t || seen.has(l)) return false; seen.add(l); return true; });
};

/** "(512) 555-0142" and "512-555-0142" become +15125550142; "+44 20 7946 0958" keeps its country code. */
export function normalizePhone(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

/**
 * Anything the function (or the form) holds, read as v2 settings: wrong types
 * fall back to the default, numbers are clamped, text is trimmed, empty list
 * items are dropped and keys come out in one fixed order. The same function is
 * "clean before save" and "clean before comparing", so dirty means what saving
 * would change and nothing else.
 */
export function normalizeSettings(raw: unknown): AgentSettings {
  const d = defaultSettings();
  const r = obj(raw);
  const id = obj(r.identity); const vo = obj(r.voice); const pe = obj(r.personality); const sc = obj(r.script); const ru = obj(r.rules);
  const oa = obj(r.offer_authority); const ch = obj(r.call_handling); const lt = obj(r.live_transfer); const tl = obj(r.tools);
  const kn = obj(r.knowledge); const cn = obj(r.channels); const co = obj(ru.compliance);

  const languages = dedupeText(list(id.languages).map((x) => txt(x)).filter((x) => /^[a-z]{2}(-[A-Za-z]{2})?$/.test(x))).slice(0, LIMITS.languages);
  const secSeen = new Set<string>();
  const sections = list(sc.sections).filter(isObj).map((x) => ({ id: txt(x.id), title: txt(x.title), body: txt(x.body), enabled: x.enabled !== false }))
    .filter((x) => x.title || x.body).map((x, i) => ({ ...x, id: uniq(x.id || `s${i + 1}`, secSeen) }));
  const rules = (key: 'dos' | 'donts'): Rule[] => {
    const seen = new Set<string>();
    return list(ru[key]).filter(isObj).map((x) => ({ id: txt(x.id), text: txt(x.text), severity: x.severity === 'soft' ? 'soft' as const : 'hard' as const }))
      .filter((x) => x.text).map((x, i) => ({ ...x, id: uniq(x.id || `${key === 'dos' ? 'do' : 'dont'}${i + 1}`, seen) }));
  };
  const destSeen = new Set<string>();
  const destinations = (lt.destinations === undefined ? d.live_transfer.destinations : list(lt.destinations)).filter(isObj).map((x, i): Destination => {
    const type = oneOf(x.type, ['rep_assigned', 'fixed', 'ring_group'] as const, 'fixed');
    const number = txt(x.number);
    const out: Destination = {
      id: uniq(txt(x.id) || `d${i + 1}`, destSeen), label: txt(x.label) || `Destination ${i + 1}`,
      number: number ? normalizePhone(number) ?? number : '', type, ring_timeout_s: num(x.ring_timeout_s, 25, 5, 60),
    };
    if (isObj(x.hours)) out.hours = hours(x.hours, { days: ALL_DAYS, start: '08:00', end: '18:00', tz: 'America/Chicago' });
    return out;
  }).slice(0, LIMITS.destinations);
  const trSeen = new Set<string>();
  const tr = obj(lt.triggers);
  const faqSeen = new Set<string>();
  const qh = obj(co.quiet_hours); const rn = obj(co.recording_notice); const vm = obj(ch.voicemail); const rt = obj(ch.retry);
  const tools = {} as Record<ToolKey, ToolSetting>;
  for (const k of TOOL_KEYS) { const t = obj(tl[k]); tools[k] = { enabled: bool(t.enabled, d.tools[k].enabled), available: t.available === true }; }
  const qHours = hours({ ...qh, days: ALL_DAYS }, { days: ALL_DAYS, ...d.rules.compliance.quiet_hours });

  return {
    identity: {
      name: txt(id.name), company: txt(id.company), role: txt(id.role) || d.identity.role,
      introduce_as: oneOf(id.introduce_as, ['none', 'virtual_assistant'] as const, d.identity.introduce_as), languages: languages.length ? languages : ['en'],
    },
    voice: {
      voice_id: txt(vo.voice_id) || d.voice.voice_id, tts_model: isTts(vo.tts_model) ? vo.tts_model : TTS_DEFAULT,
      llm: isLlm(vo.llm) ? vo.llm : LLM_DEFAULT, thinking: oneOf(vo.thinking, ['auto', 'light', 'deep'] as const, 'light'),
      stability: numOrNull(vo.stability, TUNING.stability.min, TUNING.stability.max),
      similarity: numOrNull(vo.similarity, TUNING.similarity.min, TUNING.similarity.max),
      speed: numOrNull(vo.speed, TUNING.speed.min, TUNING.speed.max),
    },
    personality: {
      tone: isTone(pe.tone) ? pe.tone : d.personality.tone, energy: num(pe.energy, 3, 1, 5), verbosity: num(pe.verbosity, 2, 1, 5),
      warmth: num(pe.warmth, 3, 1, 5), formality: num(pe.formality, 3, 1, 5), use_fillers: bool(pe.use_fillers, true), humor: num(pe.humor, 0, 0, 3),
      expressiveness: isExpressiveness(pe.expressiveness) ? pe.expressiveness : 'natural',
    },
    script: {
      template_id: txt(sc.template_id), sections,
      raw_prompt_override: typeof sc.raw_prompt_override === 'string' && sc.raw_prompt_override.trim() ? sc.raw_prompt_override.trim() : null,
      master_script_text: txt(sc.master_script_text),
    },
    rules: {
      dos: rules('dos'), donts: rules('donts'),
      never_mention: dedupeText(list(ru.never_mention).map((x) => txt(x).replace(/\s+/g, ' ')).map((x) => x.slice(0, LIMITS.neverMention))).slice(0, LIMITS.neverMentionCount),
      forbidden_phrases: dedupeText(list(ru.forbidden_phrases).map((x) => txt(x).replace(/\s+/g, ' ')).map((x) => x.slice(0, LIMITS.forbidden))).slice(0, LIMITS.forbiddenCount),
      required_phrases: list(ru.required_phrases).filter(isObj).map((x) => ({ when: txt(x.when), text: txt(x.text) })).filter((x) => x.when && x.text).slice(0, LIMITS.requiredCount),
      compliance: {
        honor_dnc: true,
        quiet_hours: { enabled: bool(qh.enabled, d.rules.compliance.quiet_hours.enabled), start: qHours.start, end: qHours.end, tz: qHours.tz },
        recording_notice: { enabled: bool(rn.enabled, false), text: txt(rn.text) || d.rules.compliance.recording_notice.text },
        ai_disclosure_when_asked: true,
      },
    },
    offer_authority: {
      mode: oneOf(oa.mode, ['none', 'range_only', 'range_with_approval'] as const, 'none'), allow_step_ups: bool(oa.allow_step_ups, false),
      step_size_pct: num(oa.step_size_pct, 2, 0.5, 10, 1), floor_pct_of_mao: num(oa.floor_pct_of_mao, 85, 50, 100, 1),
      agreement_requires_rep_approval: bool(oa.agreement_requires_rep_approval, true),
      quote_as: oneOf(oa.quote_as, ['number', 'range'] as const, 'number'),
    },
    call_handling: {
      max_call_seconds: num(ch.max_call_seconds, 600, CALL_MIN_SECONDS, CALL_MAX_SECONDS), silence_timeout_s: num(ch.silence_timeout_s, 30, 0, 300),
      first_response_delay_ms: num(ch.first_response_delay_ms, 0, 0, 3000), interruption_sensitivity: num(ch.interruption_sensitivity, 3, 1, 5),
      turn_eagerness: oneOf(ch.turn_eagerness, ['patient', 'normal', 'eager'] as const, 'normal'),
      voicemail: {
        detect: bool(vm.detect, true), action: oneOf(vm.action, ['leave_message', 'hang_up'] as const, 'leave_message'), message_template: txt(vm.message_template, d.call_handling.voicemail.message_template),
      },
      call_hours: hours(ch.call_hours, d.call_handling.call_hours),
      retry: { max_attempts: num(rt.max_attempts, 0, 0, 10), gap_hours: num(rt.gap_hours, 24, 1, 168) },
    },
    live_transfer: {
      enabled: bool(lt.enabled, d.live_transfer.enabled), mode: oneOf(lt.mode, ['warm', 'cold'] as const, 'warm'), destinations,
      triggers: {
        asks_for_person: bool(tr.asks_for_person, true), hot_lead: bool(tr.hot_lead, true), angry_or_escalating: bool(tr.angry_or_escalating, false),
        above_range: bool(tr.above_range, false), legal_or_complex: bool(tr.legal_or_complex, false),
        custom: list(tr.custom).filter(isObj).map((x) => ({ id: txt(x.id), text: txt(x.text) })).filter((x) => x.text).slice(0, LIMITS.customTriggers)
          .map((x, i) => ({ id: uniq(x.id || `c${i + 1}`, trSeen), text: x.text })),
      },
      whisper_message_template: txt(lt.whisper_message_template), fallback: oneOf(lt.fallback, ['book_callback', 'voicemail', 'apologize_end'] as const, 'book_callback'),
    },
    tools,
    knowledge: {
      faqs: list(kn.faqs).filter(isObj).map((x) => ({ id: txt(x.id), q: txt(x.q), a: txt(x.a) })).filter((x) => x.q && x.a).slice(0, LIMITS.faqs)
        .map((x, i) => ({ ...x, id: uniq(x.id || `f${i + 1}`, faqSeen) })),
      company_facts: list(kn.company_facts).map((x) => txt(x)).filter(Boolean).slice(0, LIMITS.facts),
    },
    channels: { phone_number_id: txt(cn.phone_number_id) || null, inbound: bool(cn.inbound, true), outbound: bool(cn.outbound, false) },
  };
}

/** The draft as save_draft receives it: cleaned, with the server-owned `available` flags left off each tool. */
export function savePayload(s: AgentSettings): Record<string, unknown> {
  const c = normalizeSettings(s);
  const tools = Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: c.tools[k].enabled }]));
  return { ...c, tools };
}

/** Whether the draft differs from what is saved, ignoring whitespace noise and what the server owns. */
export function isDirty(saved: AgentSettings, draft: AgentSettings): boolean {
  return JSON.stringify(savePayload(saved)) !== JSON.stringify(savePayload(draft));
}

// ---- Agents ---------------------------------------------------------------------------------------------

export type Checks = { api_key: boolean; agent: boolean; personalize_webhook: boolean; tool: boolean; post_call_webhook: boolean };
export type CheckKey = keyof Checks;

/** Label and the one-line reason it matters, in the order the checklist draws them. */
export const CHECK_ROWS: { key: CheckKey; label: string; hint: string }[] = [
  { key: 'api_key', label: 'ElevenLabs API key', hint: 'The project secret CLOZR uses to configure and test the agent.' },
  { key: 'agent', label: 'Agent created', hint: 'The voice agent that answers, with your voice, prompt and settings.' },
  { key: 'personalize_webhook', label: 'Caller lookup', hint: 'Tells the agent who is calling and what the record says, as the phone rings.' },
  { key: 'tool', label: 'Lead context tool', hint: 'Lets the agent look up the brief, latest offer and next appointment mid-call.' },
  { key: 'post_call_webhook', label: 'Call log', hint: 'Files the transcript and summary on the seller or buyer after every call.' },
];

export type ManualStep = { step: string; value_to_paste: string; where: string };
export type ConnectError = { step: string; message: string };
export type WebhookUrls = { personalize: string; tool: string; post_call: string };

export type AgentStatus = 'draft' | 'live' | 'unpublished';

export type AgentSummary = {
  agent_key: string; role: string; name: string; status: 'draft' | 'live'; enabled: boolean; agent_id: string | null; connected: boolean;
  connected_at: string | null; live_version: number; latest_version: number; has_unpublished_changes: boolean; updated_at: string | null;
  /** The agent's picture (migration 123): a public URL or a data: SVG. */
  avatar_url?: string | null;
  /** Which records it may be switched on for (migration 123). */
  audience?: 'sellers' | 'buyers' | 'both';
};
export type AgentDetail = AgentSummary & {
  settings: AgentSettings; live_settings: AgentSettings | null; checks: Checks; webhook_urls: WebhookUrls; can_edit: boolean; live_check: string | null;
};

/** The answer to `set_enabled`: `{ ok, agent_key, enabled }`. A reply without a real boolean is not read as either state. */
export function normalizeEnabled(r: Record<string, unknown>, key: string): { agent_key: string; enabled: boolean } {
  if (typeof r.enabled !== 'boolean') throw new Error('The reply did not say whether the agent is on.');
  return { agent_key: typeof r.agent_key === 'string' && r.agent_key ? r.agent_key : key, enabled: r.enabled };
}

/**
 * What the on/off switch means, in the console's words. The switch is a real gate
 * only for a published agent: a never-published one is not treated as off, and its
 * first publish switches it on.
 */
export function enabledNote(a: Pick<AgentSummary, 'enabled' | 'live_version'>): string {
  if (a.live_version <= 0) return 'Not live yet. It starts answering calls when you first publish it.';
  return a.enabled
    ? 'Answering calls. Switching it off makes it answer like a do-not-engage number: a neutral greeting, no lead, property or price details, and the call ends.'
    : 'Switched off. It answers calls like a do-not-engage number: a neutral greeting, no lead, property or price details, and the call ends. Publishing does not turn it back on.';
}

/** Draft until the first publish; Live when the draft matches what runs; Unpublished changes when they differ. */
export function agentStatus(a: Pick<AgentSummary, 'status' | 'live_version' | 'has_unpublished_changes'>): AgentStatus {
  if (a.status !== 'live' || a.live_version <= 0) return 'draft';
  return a.has_unpublished_changes ? 'unpublished' : 'live';
}
export const STATUS_LABEL: Record<AgentStatus, string> = { draft: 'Draft', live: 'Live', unpublished: 'Unpublished changes' };

const ROLE_NAMES: Record<string, string> = { lead_manager: 'Lead manager', acquisitions: 'Acquisitions', jr_dispo: 'Dispositions', buyer_assistant: 'Buyer assistant', speed_to_lead: 'Speed to lead', reactivation: 'Reactivation' };
export function roleLabel(role: string): string {
  if (ROLE_NAMES[role]) return ROLE_NAMES[role]!;
  const t = role.replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Agent';
}

export function normalizeSummary(raw: unknown): AgentSummary {
  const r = obj(raw);
  return {
    agent_key: str(r.agent_key), role: str(r.role, 'lead_manager'), name: str(r.name), status: r.status === 'live' ? 'live' : 'draft', enabled: r.enabled === true,
    agent_id: str(r.agent_id) || null, connected: r.connected === true, connected_at: str(r.connected_at) || null,
    live_version: Math.max(0, Math.round(Number(r.live_version) || 0)), latest_version: Math.max(0, Math.round(Number(r.latest_version) || 0)),
    has_unpublished_changes: r.has_unpublished_changes === true, updated_at: str(r.updated_at) || null,
    avatar_url: /^(https:\/\/|data:image\/)/.test(str(r.avatar_url)) ? str(r.avatar_url) : null,
    audience: r.audience === 'buyers' || r.audience === 'both' || r.audience === 'sellers' ? r.audience : /^(buyer_assistant|jr_dispo)$/.test(str(r.role)) ? 'buyers' : 'sellers',
  };
}

export function normalizeChecks(raw: unknown): Checks {
  const r = obj(raw);
  return { api_key: r.api_key === true, agent: r.agent === true, personalize_webhook: r.personalize_webhook === true, tool: r.tool === true, post_call_webhook: r.post_call_webhook === true };
}

export function normalizeDetail(raw: unknown): AgentDetail {
  const r = obj(raw);
  const urls = obj(r.webhook_urls);
  return {
    ...normalizeSummary(r),
    settings: normalizeSettings(r.settings),
    live_settings: isObj(r.live_settings) ? normalizeSettings(r.live_settings) : null,
    checks: normalizeChecks(r.checks),
    webhook_urls: { personalize: str(urls.personalize), tool: str(urls.tool), post_call: str(urls.post_call) },
    can_edit: r.can_edit === true, live_check: str(r.live_check) || null,
  };
}

export function normalizeAgents(raw: unknown): AgentSummary[] {
  return list(raw).filter(isObj).map(normalizeSummary).filter((a) => a.agent_key);
}

export type TemplateInfo = { id: string; name: string; role: string; description: string; open_items: string[] };
export type ToolInfo = { key: ToolKey; label: string; available: boolean };

export function normalizeTemplates(raw: unknown): TemplateInfo[] {
  return list(raw).filter(isObj).map((t) => ({
    id: str(t.id), name: str(t.name), role: str(t.role), description: str(t.description), open_items: list(t.open_items).filter((x): x is string => typeof x === 'string' && !!x),
  })).filter((t) => t.id);
}

/** Which tools the server has built, from `templates`; the settings' own `available` flags say the same per agent. */
export function normalizeToolInfo(raw: unknown): ToolInfo[] {
  return list(raw).filter(isObj).filter((t) => (TOOL_KEYS as readonly string[]).includes(str(t.key)))
    .map((t) => ({ key: str(t.key) as ToolKey, label: str(t.label), available: t.available === true }));
}

export function normalizeConnectErrors(raw: unknown): ConnectError[] {
  return list(raw).filter(isObj).filter((e) => str(e.message)).map((e) => ({ step: str(e.step), message: str(e.message) }));
}

export type PublishResult = {
  version: number; live_version: number; agent_key: string; agent_id: string | null; checks: Checks; manual: ManualStep[]; errors: ConnectError[]; tts_model_used: string | null;
};
export function normalizePublish(raw: unknown): PublishResult {
  const r = obj(raw);
  return {
    version: Math.round(Number(r.version) || 0), live_version: Math.round(Number(r.live_version) || 0), agent_key: str(r.agent_key), agent_id: str(r.agent_id) || null,
    checks: normalizeChecks(r.checks),
    manual: list(r.manual).filter(isObj).map((m) => ({ step: str(m.step), value_to_paste: str(m.value_to_paste), where: str(m.where) })).filter((m) => m.step),
    errors: normalizeConnectErrors(r.errors), tts_model_used: str(r.tts_model_used) || null,
  };
}

export type PromptWarning = { code: string; level: 'warning' | 'info'; message: string; path: string | null };
export type PromptPreview = { prompt: string; tokens: number; warnings: PromptWarning[]; not_applied: string[] };
export function normalizePreview(raw: unknown): PromptPreview {
  const r = obj(raw);
  return {
    prompt: str(r.prompt), tokens: Math.max(0, Math.round(Number(r.tokens) || 0)),
    warnings: list(r.warnings).filter(isObj).filter((w) => str(w.message)).map((w) => ({
      code: str(w.code), level: w.level === 'info' ? 'info' as const : 'warning' as const, message: str(w.message), path: str(w.path) || null,
    })),
    not_applied: list(r.not_applied).filter((x): x is string => typeof x === 'string'),
  };
}

export type VersionRow = { version: number; note: string; created_by: string | null; created_at: string; is_live: boolean; prompt_tokens: number };
export function normalizeVersions(raw: unknown): { live_version: number; versions: VersionRow[] } {
  const r = obj(raw);
  return {
    live_version: Math.round(Number(r.live_version) || 0),
    versions: list(r.versions).filter(isObj).map((v) => ({
      version: Math.round(Number(v.version) || 0), note: str(v.note), created_by: str(v.created_by) || null, created_at: str(v.created_at),
      is_live: v.is_live === true, prompt_tokens: Math.round(Number(v.prompt_tokens) || 0),
    })).filter((v) => v.version > 0),
  };
}

export type SettingChange = { path: string; from: unknown; to: unknown };
export type DiffResult = {
  from: string; to: string; changes: SettingChange[];
  prompt: { added: string[]; removed: string[]; tokens_from: number; tokens_to: number };
};
export function normalizeDiff(raw: unknown): DiffResult {
  const r = obj(raw); const p = obj(r.prompt);
  const lines = (v: unknown) => list(v).filter((x): x is string => typeof x === 'string');
  return {
    from: str(r.from), to: str(r.to),
    changes: list(r.changes).filter(isObj).filter((c) => str(c.path)).map((c) => ({ path: str(c.path), from: c.from ?? null, to: c.to ?? null })),
    prompt: { added: lines(p.added), removed: lines(p.removed), tokens_from: Math.round(Number(p.tokens_from) || 0), tokens_to: Math.round(Number(p.tokens_to) || 0) },
  };
}

export type ScenarioItem = { id: string; text: string };
export type ScenarioAudience = 'seller' | 'buyer' | 'any';
export type Scenario = { id: string; title: string; summary: string; audience: ScenarioAudience; persona: string; checklist: ScenarioItem[] };
/** A scenario fits a test as this kind of caller. */
export const scenarioFits = (s: Scenario, as: 'seller' | 'buyer') => s.audience === 'any' || s.audience === as;
export function normalizeScenarios(raw: unknown): Scenario[] {
  return list(raw).filter(isObj).map((s) => ({
    id: str(s.id), title: str(s.title), summary: str(s.summary), persona: str(s.persona),
    // Scenarios from before buyers were added are all seller calls.
    audience: (s.audience === 'buyer' || s.audience === 'any' ? s.audience : 'seller') as ScenarioAudience,
    checklist: list(s.checklist).filter(isObj).map((c) => ({ id: str(c.id), text: str(c.text) })).filter((c) => c.id),
  })).filter((s) => s.id && s.checklist.length);
}

export type Grade = { id: string; text: string; pass: boolean; quote: string; note: string; quote_found: boolean };
export type ScoreResult = { model: string; scenario_id: string; items: Grade[]; passed: number; total: number; score: number };
export function normalizeScore(raw: unknown): ScoreResult {
  const r = obj(raw);
  const items = list(r.items).filter(isObj).map((g) => ({
    id: str(g.id), text: str(g.text), pass: g.pass === true, quote: str(g.quote), note: str(g.note), quote_found: g.quote_found === true,
  }));
  const passed = Number.isFinite(Number(r.passed)) ? Math.round(Number(r.passed)) : items.filter((i) => i.pass).length;
  const total = Number.isFinite(Number(r.total)) ? Math.round(Number(r.total)) : items.length;
  return { model: str(r.model), scenario_id: str(r.scenario_id), items, passed, total, score: Number.isFinite(Number(r.score)) ? Math.round(Number(r.score)) : total ? Math.round((passed / total) * 100) : 0 };
}

export type AgentStats = { agent_key: string; calls: number; avg_duration_s: number; booked: number; transferred: number; dnc_requests: number; not_interested: number };
export type StatsResult = { days: number; agents: AgentStats[]; totals: Omit<AgentStats, 'agent_key' | 'avg_duration_s'>; basis: Record<string, string> };
const count = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
export function normalizeStats(raw: unknown): StatsResult {
  const r = obj(raw); const t = obj(r.totals);
  const basis: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(r.basis))) if (typeof v === 'string' && v) basis[k] = v;
  return {
    days: count(r.days) || 30,
    agents: list(r.agents).filter(isObj).map((a) => ({
      agent_key: str(a.agent_key), calls: count(a.calls), avg_duration_s: count(a.avg_duration_s), booked: count(a.booked), transferred: count(a.transferred),
      dnc_requests: count(a.dnc_requests), not_interested: count(a.not_interested),
    })).filter((a) => a.agent_key),
    totals: { calls: count(t.calls), booked: count(t.booked), transferred: count(t.transferred), dnc_requests: count(t.dnc_requests), not_interested: count(t.not_interested) },
    basis,
  };
}

export type Voice = { voice_id: string; name: string; category: string; labels: Record<string, string>; preview_url: string | null };

export function normalizeVoices(raw: unknown): Voice[] {
  const out: Voice[] = [];
  for (const v of list(raw).filter(isObj)) {
    if (!str(v.voice_id)) continue;
    const labels: Record<string, string> = {};
    for (const [k, x] of Object.entries(obj(v.labels))) if (typeof x === 'string' && x) labels[k] = x;
    out.push({ voice_id: str(v.voice_id), name: str(v.name, 'Untitled voice'), category: str(v.category), labels, preview_url: str(v.preview_url) || null });
  }
  return out;
}

export type RecordKind = 'seller' | 'buyer';

export type TestSession = {
  signed_url: string; agent_id: string; agent_key: string; live_version: number;
  dynamic_variables: Record<string, string | number | boolean>; first_message: string;
  /** How the function matched the record, when it says. */
  resolution: string | null;
};

export type AgentCall = {
  id: string; conversation_id: string | null; started_at: string; duration_s: number; record_kind: RecordKind | null; record_id: number | null;
  summary: string; transcript_preview: string;
};

export function normalizeCalls(raw: unknown): AgentCall[] {
  const out: AgentCall[] = [];
  for (const c of list(raw).filter(isObj)) {
    const kind = c.record_kind === 'seller' || c.record_kind === 'buyer' ? c.record_kind : null;
    const rid = Number(c.record_id);
    out.push({
      id: String(c.id ?? ''), conversation_id: str(c.conversation_id) || null, started_at: str(c.started_at) || str(c.occurred_at),
      duration_s: Math.max(0, Math.round(Number(c.duration_s) || 0)), record_kind: kind, record_id: Number.isFinite(rid) && rid > 0 ? rid : null,
      summary: str(c.summary), transcript_preview: str(c.transcript_preview),
    });
  }
  return out.filter((c) => c.id);
}

// ---- Validating what the form holds -----------------------------------------------------------------------

/** Field errors by path, e.g. `identity.name` or `rules.dos[no_offer].text`. */
export type FieldErrors = Record<string, string>;

export const hasErrors = (e: FieldErrors) => Object.keys(e).length > 0;

const over = (s: string, max: number) => (s.length > max ? `${s.length - max} characters over the ${max.toLocaleString('en-US')} limit.` : null);

/** Why a window cannot be used, or null. Overnight windows (end before start) are fine; a zero-width one is not. */
export function hoursProblem(h: { start: string; end: string; tz: string; days?: string[] }): string | null {
  if (!HHMM.test(h.start) || !HHMM.test(h.end)) return 'Pick a start and an end time.';
  if (h.start === h.end) return 'The start and end cannot be the same time.';
  if (!h.tz.trim()) return 'Pick a time zone.';
  if (h.days && !h.days.length) return 'Pick at least one day.';
  return null;
}

/** The paths that are guidance shown beside a field, not a reason the server would refuse the save. */
const GUIDANCE_PATHS = new Set(['live_transfer.destinations']);

/** The checks the server would fail a save on, plus limits it silently cuts, so a person sees them before pressing Save. */
export function validateSettings(s: AgentSettings): FieldErrors {
  const e: FieldErrors = {};
  const set = (path: string, msg: string | null) => { if (msg && !e[path]) e[path] = msg; };
  set('identity.name', over(s.identity.name.trim(), LIMITS.name));
  set('identity.company', over(s.identity.company.trim(), LIMITS.company));
  set('identity.role', over(s.identity.role.trim(), LIMITS.role));
  s.script.sections.forEach((x) => {
    set(`script.sections[${x.id}].title`, over(x.title.trim(), LIMITS.sectionTitle));
    set(`script.sections[${x.id}].body`, over(x.body.trim(), LIMITS.sectionBody));
  });
  set('script.raw_prompt_override', over((s.script.raw_prompt_override ?? '').trim(), LIMITS.override));
  set('script.master_script_text', over(s.script.master_script_text.trim(), LIMITS.master));
  for (const k of ['dos', 'donts'] as const) s.rules[k].forEach((r) => set(`rules.${k}[${r.id}].text`, over(r.text.trim(), LIMITS.ruleText)));
  s.rules.required_phrases.forEach((r, i) => {
    set(`rules.required_phrases[${i}].when`, over(r.when.trim(), LIMITS.requiredWhen));
    set(`rules.required_phrases[${i}].text`, over(r.text.trim(), LIMITS.requiredText));
  });
  const q = s.rules.compliance.quiet_hours;
  if (q.enabled) set('rules.compliance.quiet_hours', hoursProblem({ start: q.start, end: q.end, tz: q.tz }));
  set('rules.compliance.recording_notice.text', over(s.rules.compliance.recording_notice.text.trim(), LIMITS.recordingText));
  set('call_handling.call_hours', hoursProblem(s.call_handling.call_hours));
  set('call_handling.voicemail.message_template', over(s.call_handling.voicemail.message_template.trim(), LIMITS.voicemail));
  set('live_transfer.whisper_message_template', over(s.live_transfer.whisper_message_template.trim(), LIMITS.whisper));
  s.live_transfer.destinations.forEach((d) => {
    const base = `live_transfer.destinations[${d.id}]`;
    set(`${base}.label`, over(d.label.trim(), LIMITS.destLabel));
    const n = d.number.trim();
    if (d.type === 'rep_assigned' && !n) {
      // The assigned rep's own phone is dialed, so no number is needed.
    } else if (!n) set(`${base}.number`, 'Add the number to dial.');
    else if (!normalizePhone(n)) set(`${base}.number`, 'Use a full number, like (512) 555-0142 or +44 20 7946 0958.');
    if (d.hours) set(`${base}.hours`, hoursProblem(d.hours));
  });
  s.live_transfer.triggers.custom.forEach((t) => set(`live_transfer.triggers.custom[${t.id}].text`, over(t.text.trim(), LIMITS.customTrigger)));
  s.knowledge.faqs.forEach((f) => {
    set(`knowledge.faqs[${f.id}].q`, over(f.q.trim(), LIMITS.faqQ));
    set(`knowledge.faqs[${f.id}].a`, over(f.a.trim(), LIMITS.faqA));
  });
  s.knowledge.company_facts.forEach((f, i) => set(`knowledge.company_facts[${i}]`, over(f.trim(), LIMITS.fact)));
  // A warning on the server, not a refusal; the form still says it where the fix is.
  if (s.live_transfer.enabled && s.tools.transfer.enabled && !s.live_transfer.destinations.length) set('live_transfer.destinations', 'Add a destination or the agent cannot transfer.');
  return e;
}

/** Errors that stop a save, as opposed to guidance shown in the same place. */
export function blockingErrors(e: FieldErrors): FieldErrors {
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(e)) if (!GUIDANCE_PATHS.has(k)) out[k] = v;
  return out;
}

// ---- What the server refused --------------------------------------------------------------------------------

const LIST_KEYS = ['script.sections', 'rules.dos', 'rules.donts', 'live_transfer.destinations', 'live_transfer.triggers.custom', 'knowledge.faqs'] as const;

/** `rules.dos[0].text` to `rules.dos[no_offer].text`: the server counts by position, the form's fields are keyed by id. */
export function indexPathToId(path: string, s: AgentSettings): string {
  return path.replace(/^((?:[a-z_]+\.)*[a-z_]+)\[(\d+)\]/, (m, base: string, idx: string) => {
    if (!(LIST_KEYS as readonly string[]).includes(base)) return m;
    const items = base.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), s as unknown);
    const item = Array.isArray(items) ? (items[Number(idx)] as { id?: string } | undefined) : undefined;
    return item?.id ? `${base}[${item.id}]` : m;
  });
}

const ERR_PATH = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\s]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*)(?=\s|$)/;
const LABEL_FIXES: Record<string, string> = { 'voicemail.message_template': 'call_handling.voicemail.message_template' };

/** The server's 422 `errors[]` (each starts with the path it is about) as field errors; anything else lands on `_general`. */
export function serverErrorsToFields(errors: string[], s: AgentSettings): FieldErrors {
  const out: FieldErrors = {};
  for (const line of errors) {
    const m = ERR_PATH.exec(line.trim());
    const head = m?.[1] ?? '';
    if (!head || !(head.includes('.') || head.includes('['))) {
      out._general = out._general ? `${out._general} ${line}` : line;
      continue;
    }
    const path = indexPathToId(LABEL_FIXES[head] ?? head, s);
    const message = line.trim().slice(head.length).trim().replace(/^[:,-]\s*/, '');
    const shown = message.charAt(0).toUpperCase() + message.slice(1);
    out[path] = out[path] ? `${out[path]} ${shown}` : shown;
  }
  return out;
}

// ---- Chips and misc text ----------------------------------------------------------------------------------------

/** Add a chip: trimmed, capped, no repeats regardless of case. */
export function addChip(items: string[], text: string, maxLen: number = LIMITS.neverMention, maxCount: number = LIMITS.neverMentionCount): string[] {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  if (!t) return items;
  if (items.some((x) => x.toLowerCase() === t.toLowerCase())) return items;
  if (items.length >= maxCount) return items;
  return [...items, t];
}

/** Letters, digits, spaces and a few name marks; anything PostgREST would read as filter syntax is dropped. */
export const cleanQuery = (q: string) => q.replace(/[^\p{L}\p{N} .'\-@]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Whether a model other than the chosen one spoke or was configured (ElevenLabs refused the choice). */
export const modelDiffers = (chosen: string, used: string | null | undefined) => !!used && used !== chosen;

export const tuningIsDefault = (v: Tuning) => TUNING_KEYS.every((k) => v[k] == null);

// ---- voices ---------------------------------------------------------------------------------------------------------

/** Case-insensitive match on the name, category and every label value ("american", "female", "calm"). */
export function filterVoices(voices: Voice[], q: string): Voice[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return voices;
  return voices.filter((v) => {
    const hay = [v.name, v.category, ...Object.values(v.labels)].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "Female · American · Calm": the few labels worth a line under the name. */
export function voiceTraits(v: Voice): string {
  const order = ['gender', 'accent', 'descriptive', 'age', 'use_case'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of order) {
    const x = v.labels[k];
    if (x && !seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); out.push(x.charAt(0).toUpperCase() + x.slice(1)); }
  }
  return out.slice(0, 3).join(' · ');
}

/** The fixed line a voice reads when it has no ready-made sample. The real agent does not announce itself unprompted, so neither does the sample. */
export function sampleLine(s: { name: string; company: string }): string {
  const name = s.name.trim() || 'Sam';
  const company = s.company.trim() || 'our team';
  return `Hi, this is ${name} with ${company}. Thanks for calling back about the house. Is now a good time to talk for a minute?`;
}

// ---- the test call ----------------------------------------------------------------------------------------------------

export type TestLine = { id: number; role: 'agent' | 'user'; text: string };

export function pushLine(lines: TestLine[], role: TestLine['role'], text: string): TestLine[] {
  const t = text.trim();
  if (!t) return lines;
  return [...lines, { id: lines.length ? lines[lines.length - 1]!.id + 1 : 1, role, text: t }];
}

/** The SDK reports volume 0..1; the meter wants a whole percent that does not sit at zero when a voice is present. */
export function levelPercent(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  return Math.min(100, Math.max(4, Math.round(Math.sqrt(volume) * 100)));
}

export type MicProblem = 'denied' | 'missing' | 'busy' | 'other';

/** What a getUserMedia failure means to the person holding the phone. */
export function micProblem(err: unknown): MicProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'other';
}

export const MIC_MESSAGES: Record<MicProblem, string> = {
  denied: 'The browser blocked the microphone. Allow it from the lock icon in the address bar, then start the call again.',
  missing: 'No microphone was found. Plug one in or pick a headset, then start the call again.',
  busy: 'The microphone is in use by another app or tab. Close it and try again.',
  other: 'The microphone could not be opened.',
};

/** Dynamic variables in the order a rep reads them; the brief is drawn on its own. */
const VAR_ORDER = ['first_name', 'property_address', 'caller_known', 'rep_name', 'company', 'agent_name', 'record_kind', 'do_not_engage', 'last_contact_summary', 'next_step'];

export function orderVariables(vars: Record<string, string | number | boolean>): { key: string; value: string }[] {
  const keys = Object.keys(vars).filter((k) => k !== 'lead_brief');
  keys.sort((a, b) => {
    const ia = VAR_ORDER.indexOf(a); const ib = VAR_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((k) => ({ key: k, value: String(vars[k]) }));
}

// ---- formatting ------------------------------------------------------------------------------------------------------

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 600 -> "10 min", 90 -> "1 min 30 s". */
export function formatLimit(seconds: number): string {
  const m = Math.floor(seconds / 60); const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function timeAgo(iso: string | null, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
