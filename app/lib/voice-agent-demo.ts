// What /demo shows for the AI Agent console: the same `Api` the real screen
// uses, answered from memory. Creating, duplicating, saving, publishing and
// rolling back really change this store, so the whole screen can be walked
// through with no backend. Nothing here talks to ElevenLabs, a model or Supabase.

import {
  defaultSettings, normalizeSettings, savePayload, TOOL_KEYS,
  type AgentCall, type AgentDetail, type AgentSettings, type AgentStats, type AgentSummary, type ManualStep, type PromptWarning, type Result, type ScoreResult,
  type TemplateInfo, type TestSession, type ToolInfo, type ToolKey, type VersionRow, type Voice,
} from './voice-agent';
import { callHoursOutsideQuiet, diffLines, diffSettings } from './voice-agent-console';
import { DEMO_SCENARIOS } from './voice-agent-demo-scenarios';
import type { Api, DiffRef, PublishOutcome } from './voice-agent-client';

export { DEMO_SCENARIOS };

const DEMO_HOOKS = 'https://yourprojectref00000.supabase.co/functions/v1/voice-agent';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Built by the server today; the rest read "Coming soon" in the console. */
export const DEMO_TOOL_AVAILABLE: Record<ToolKey, boolean> = {
  lead_context: true, end_call: true, transfer: true, book_appointment: true, save_qualification: true, mark_do_not_contact: true, get_compr_offer: false, request_agreement: false,
};

export const DEMO_TOOLS: ToolInfo[] = TOOL_KEYS.map((k) => ({ key: k, label: k, available: DEMO_TOOL_AVAILABLE[k] }));

export const DEMO_TEMPLATES: TemplateInfo[] = [
  {
    id: 'lead_manager', name: 'Lead manager', role: 'lead_manager',
    description: 'Calls or answers sellers, confirms who they are, learns why they might sell, gathers the basics and sets the next step with the acquisitions team. Never makes an offer.',
    open_items: [
      'book_appointment books a real time inside the agent\'s call hours on the rep\'s calendar, save_qualification fills blank seller fields, and mark_do_not_contact tags the record DNC and stops any AI follow-up.',
      'Add a recording notice if calls are recorded and you call into two-party-consent states: that is a compliance choice for you and counsel.',
    ],
  },
  {
    id: 'acquisitions', name: 'Acquisitions', role: 'acquisitions',
    description: 'Talks price with a seller inside an approved range and moves a willing seller toward a written agreement, with a rep approving the agreement.',
    open_items: [
      'The relationship frame does not say "no fees", "we do not change the price after contract" or "we do not cancel last-minute". Add them back only if they are real company policy: the agent will say them to sellers.',
      'The offer range comes from the seller\'s latest deal MAO (ceiling) and the floor percentage in Offer authority. With no MAO on file the agent has no range and quotes nothing.',
      'Two steps of the master script were cut off or unlabeled; the template uses neutral wording there. Replace it with the intended lines.',
      'get_compr_offer and request_agreement are not built yet: the prompt uses fallback wording until they exist.',
    ],
  },
];

const LM_SECTIONS = [
  { id: 'job', title: 'Your job', enabled: true, body: '{{company}} buys houses directly from homeowners, and you speak with sellers on the phone. You are not here to negotiate or make an offer. You are here to:\n1. Reach the homeowner and confirm who you are talking to.\n2. Learn why they might sell, and whether they are truly open to it.\n3. Gather the basics an acquisitions specialist needs.\n4. Agree the next step with {{rep_name}} or the acquisitions team.\nNever pressure anyone.' },
  { id: 'flow', title: 'Call flow', enabled: true, body: 'Opening: "Hey, is this {{first_name}}?" Then: "Hey {{first_name}}, this is {{agent_name}} with {{company}}. I\'m calling about the property on {{property_address}}. Did I catch you at an okay time?"\n\nNot interested: "Totally understand. Is that not at all, or just not right now?" Capture a date if it is "not right now". A firm no: thank them and end.\n\nOpen to selling: ask what has them thinking about it, how soon they would want to move, then condition, occupancy and, only after motivation and timing, whether they have a number in mind. Never argue with it and never make an offer.' },
  { id: 'objections', title: 'Common questions and objections', enabled: true, body: '- "How much will you offer?": "That is exactly what our specialist works out with you. I do not want to guess over the phone."\n- "Are you a realtor?": "No, {{company}} is a real-estate investment company buying directly."\n- "Is this a scam?": stay calm, say who you are and that nothing is agreed on this call.\n- Rude or hostile: stay courteous, give a polite goodbye and end the call.' },
  { id: 'after', title: 'Before you end a call', enabled: true, body: 'Say the next step back to them and thank them. If they ask to stop being contacted, acknowledge it once and end the call.' },
];

const ACQ_SECTIONS = [
  { id: 'job', title: 'Your job', enabled: true, body: '{{company}} buys houses directly from homeowners, and you speak with sellers by phone. Have a real conversation, learn the seller\'s situation, find a price that works, and move a willing seller to a signed agreement.' },
  { id: 'flow', title: 'Call flow', enabled: true, body: '1. Intro and intent: confirm they are still looking to sell {{property_address}}.\n2. Price discovery: "What price were you wanting to get?" If they dodge, ask for a range.\n3. Motivation: "What has you thinking about selling right now?" Let them talk, then peel the onion.\n4. Logistics: occupancy, timeline, condition, mortgage.\n5. Offer, only inside your approved range: "Here is what I can do." Then stop talking until they answer.\n6. Next step: a team member sends the written agreement.' },
  { id: 'objections', title: 'Objections', enabled: true, body: '- "Just give me a number": follow the offer authority rules. Give a number only inside your range.\n- "I want full market value": "Absolutely. Is the top price your main priority, or do speed and skipping repairs matter too?"\n- Rude or hostile: stay calm, no arguing, polite goodbye.' },
];

function templateSettings(template: 'lead_manager' | 'acquisitions' | '', name: string, company: string): AgentSettings {
  const s = defaultSettings();
  s.identity.name = name; s.identity.company = company;
  s.tools = Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: s.tools[k].enabled, available: DEMO_TOOL_AVAILABLE[k] }])) as AgentSettings['tools'];
  if (template === 'lead_manager') {
    s.identity.role = 'lead_manager'; s.script.template_id = 'lead_manager'; s.script.sections = LM_SECTIONS.map((x) => ({ ...x }));
    s.personality = { ...s.personality, tone: 'warm', formality: 2 };
    s.rules.donts = [
      { id: 'no_offer', text: 'Never negotiate, never state or hint at an offer amount, and never promise a closing date, an approval or that they must sell.', severity: 'hard' },
      { id: 'no_invent', text: 'Never make up property facts or say you inspected the property.', severity: 'hard' },
      { id: 'no_urgency', text: 'Never use fake urgency or "limited time".', severity: 'hard' },
    ];
    s.rules.dos = [{ id: 'one_q', text: 'Ask one question at a time.', severity: 'soft' }, { id: 'stop_bye', text: 'Stop talking when they say goodbye.', severity: 'soft' }];
    s.rules.forbidden_phrases = ['no fees', 'guaranteed cash', 'guaranteed price'];
    s.call_handling.voicemail.message_template = 'Hi, this is {{agent_name}} with {{company}}, calling about the property at {{property_address}}. Please call us back when you have a moment. Thank you.';
    s.live_transfer.triggers = { ...s.live_transfer.triggers, asks_for_person: true, hot_lead: true };
  } else if (template === 'acquisitions') {
    s.identity.role = 'acquisitions'; s.script.template_id = 'acquisitions'; s.script.sections = ACQ_SECTIONS.map((x) => ({ ...x }));
    s.personality = { ...s.personality, tone: 'direct' };
    s.offer_authority = { mode: 'range_with_approval', allow_step_ups: true, step_size_pct: 2, floor_pct_of_mao: 85, agreement_requires_rep_approval: true, quote_as: 'number' };
    s.rules.donts = [
      { id: 'no_outside_range', text: 'Never quote a price outside your approved range, and never negotiate against yourself out loud.', severity: 'hard' },
      { id: 'no_guarantee', text: 'Never say "guaranteed" about price, closing or approval.', severity: 'hard' },
      { id: 'no_invent', text: 'Never invent property facts or claim you inspected the property.', severity: 'hard' },
    ];
    s.rules.dos = [{ id: 'stop_bye', text: 'Stop talking when they say goodbye.', severity: 'soft' }];
    s.rules.forbidden_phrases = ['guaranteed price', 'guaranteed closing', 'guaranteed approval'];
    s.call_handling.max_call_seconds = 900;
    s.call_handling.voicemail = { detect: true, action: 'hang_up', message_template: '' };
    s.live_transfer.triggers = { ...s.live_transfer.triggers, asks_for_person: true, above_range: true, legal_or_complex: true, hot_lead: false };
    s.tools.get_compr_offer.enabled = true; s.tools.request_agreement.enabled = true;
  }
  return s;
}

// ---- The prompt, roughly -----------------------------------------------------------------------------------

const tok = (t: string) => Math.ceil(t.length / 4);

/** A stand-in for the server's assemblePrompt: the same blocks in the same order, plainer text. */
export function demoPrompt(s: AgentSettings): string {
  const p = s.personality;
  const enabled = s.script.sections.filter((x) => x.enabled && x.body.trim());
  const rule = (label: string, list: AgentSettings['rules']['dos']) => list.length ? `${label}:\n${list.map((r) => `- ${r.severity === 'hard' ? '[hard] ' : ''}${r.text}`).join('\n')}` : '';
  const oa = s.offer_authority;
  const rulesBody = [rule('Always', s.rules.dos), rule('Never', s.rules.donts), s.rules.never_mention.length ? `Never bring up: ${s.rules.never_mention.join('; ')}.` : '', s.rules.forbidden_phrases.length ? `Never say: ${s.rules.forbidden_phrases.map((x) => `"${x}"`).join(', ')}.` : ''].filter(Boolean).join('\n\n');
  const out = [
    `# Who you are\nYou are ${s.identity.name || s.identity.company || 'the agent'}, a ${s.identity.role.replace(/_/g, ' ')} for ${s.identity.company || 'the company'}.${s.identity.introduce_as === 'virtual_assistant' ? ' If sincerely asked, say you are a virtual assistant.' : ''}`,
    ...(s.script.raw_prompt_override ? [] : [`# How you sound\nTone: ${p.tone}. Energy ${p.energy}/5, warmth ${p.warmth}/5, formality ${p.formality}/5, length ${p.verbosity}/5. ${p.use_fillers ? 'Use natural acknowledgements.' : 'No filler words.'}${p.expressiveness === 'off' ? '' : ' Natural hesitations, pauses, mirroring and matching the caller\'s mood.'}${p.expressiveness === 'expressive' && s.voice.tts_model === 'eleven_v3_conversational' ? ' Sparing sound tags: [laughs], [gasps], [sighs], [clears throat].' : ''}`]),
    '# What you know about the caller\nThe brief, last contact and next step arrive as variables on every call: {{lead_brief}}, {{last_contact_summary}}, {{next_step}}.',
    s.script.raw_prompt_override ? `# The conversation\n${s.script.raw_prompt_override}` : enabled.length ? `# The conversation\n${enabled.map((x) => `## ${x.title || x.id}\n${x.body}`).join('\n\n')}` : s.script.master_script_text ? `# The conversation\n${s.script.master_script_text}` : '',
    oa.mode === 'none' ? '# Offers\nYou do not make offers. Never state or hint at a price; the team prepares that.' : `# Offer authority (hard limits)\nYour approved range is {{offer_low}} to {{offer_high}}. Never quote outside it. Step size about ${oa.step_size_pct} percent${oa.allow_step_ups ? ', up only for a reason or a trade' : ', no movement'}.${oa.agreement_requires_rep_approval ? ' A person approves any agreement.' : ''}`,
    rulesBody ? `# Rules\n${rulesBody}` : '',
    s.live_transfer.enabled && s.live_transfer.destinations.length ? `# Live transfer\nTransfer (${s.live_transfer.mode}) only when a trigger applies. Destinations: ${s.live_transfer.destinations.map((d) => d.label).join(', ')}.` : '# Live transfer\nYou cannot transfer calls. Offer a callback instead.',
    `# Tools\nYou may use: ${TOOL_KEYS.filter((k) => s.tools[k].enabled && DEMO_TOOL_AVAILABLE[k] && (k !== 'transfer' || (s.live_transfer.enabled && s.live_transfer.destinations.length))).join(', ') || 'none'}.`,
    s.knowledge.faqs.length || s.knowledge.company_facts.length ? `# What you know\n${[...s.knowledge.company_facts.map((f) => `- ${f}`), ...s.knowledge.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`)].join('\n')}` : '',
    '# Always (locked)\n- Honor any do-not-contact or stop request at once and end the call.\n- Confirm who you are speaking with before sharing anything specific.\n- If sincerely asked, say honestly that you are an AI.',
  ].filter(Boolean);
  return out.join('\n\n');
}

export function demoWarnings(s: AgentSettings): PromptWarning[] {
  const w: PromptWarning[] = [];
  const add = (code: string, level: PromptWarning['level'], message: string, path: string) => w.push({ code, level, message, path });
  for (const k of TOOL_KEYS) if (s.tools[k].enabled && !DEMO_TOOL_AVAILABLE[k]) add('tool_unavailable', 'info', `${k} is switched on but not built yet, so the agent is not told about it and cannot use it.`, `tools.${k}`);
  if (!s.identity.name.trim()) add('missing_name', 'warning', 'The agent has no name, so it cannot say who it is (the first line falls back to the company name, and {{agent_name}} in the script is empty).', 'identity.name');
  if (s.live_transfer.enabled && s.tools.transfer.enabled && !s.live_transfer.destinations.length) add('transfer_no_destination', 'warning', 'Live transfer is on but has no destination, so the agent cannot transfer.', 'live_transfer.destinations');
  if (s.live_transfer.triggers.above_range && s.offer_authority.mode === 'none') add('trigger_needs_offers', 'info', 'The "above range" transfer trigger does nothing while offer authority is none.', 'live_transfer.triggers.above_range');
  if (s.live_transfer.destinations.some((d) => d.type === 'rep_assigned')) add('rep_line', 'info', 'A rep-assigned destination dials the assigned rep\'s phone from their profile; a lead with no rep or no phone cannot be transferred.', 'live_transfer.destinations');
  if (s.script.raw_prompt_override && s.script.sections.some((x) => x.enabled)) add('override_hides_sections', 'info', 'A prompt override is set, so the personality settings and the script sections are not used. Rules, offers, tools and the locked safety block still are.', 'script.raw_prompt_override');
  if (!s.script.raw_prompt_override && !s.script.sections.some((x) => x.enabled && x.body) && !s.script.master_script_text.trim()) add('empty_script', 'warning', 'There is no script: the agent only has the rules and what it knows about the caller.', 'script.sections');
  if (callHoursOutsideQuiet(s)) add('hours_outside_quiet', 'warning', `Call hours (${s.call_handling.call_hours.start} to ${s.call_handling.call_hours.end}) reach outside the quiet hours window (${s.rules.compliance.quiet_hours.start} to ${s.rules.compliance.quiet_hours.end}); outbound calls outside quiet hours are not placed.`, 'call_handling.call_hours');
  return w;
}

/** The server refuses text that tells the agent to deny being an AI; /demo does too, so the inline error can be seen. */
const DENY = /\b(?:deny|denying|hide|hiding|lie about|conceal)\b[^.\n]{0,40}\b(?:ai|robot|bot|virtual assistant|recording)\b/i;
function demoRefusals(s: AgentSettings): string[] {
  const texts: [string, string][] = [
    ...s.script.sections.map((x): [string, string] => [`script.sections[${x.id}]`, `${x.title}\n${x.body}`]),
    ...s.rules.dos.map((r): [string, string] => [`rules.dos[${r.id}]`, r.text]),
    ...s.rules.donts.map((r): [string, string] => [`rules.donts[${r.id}]`, r.text]),
    ['script.master_script_text', s.script.master_script_text],
  ];
  return texts.flatMap(([label, text]) => { const m = DENY.exec(text); return m ? [`${label} tells the agent to deny being an AI ("${m[0]}"), which is not allowed`] : []; });
}

// ---- Fixtures ---------------------------------------------------------------------------------------------------

export const DEMO_VOICES: Voice[] = [
  { voice_id: 'demo_rachel', name: 'Rachel', category: 'premade', labels: { gender: 'female', accent: 'american', descriptive: 'calm', use_case: 'conversational' }, preview_url: null },
  { voice_id: 'demo_adam', name: 'Adam', category: 'premade', labels: { gender: 'male', accent: 'american', descriptive: 'deep', use_case: 'narration' }, preview_url: null },
  { voice_id: 'demo_sarah', name: 'Sarah', category: 'premade', labels: { gender: 'female', accent: 'american', descriptive: 'soft', use_case: 'conversational' }, preview_url: null },
  { voice_id: 'demo_josh', name: 'Josh', category: 'premade', labels: { gender: 'male', accent: 'american', descriptive: 'friendly', use_case: 'conversational' }, preview_url: null },
  { voice_id: 'demo_matilda', name: 'Matilda', category: 'premade', labels: { gender: 'female', accent: 'american', descriptive: 'warm', use_case: 'audiobook' }, preview_url: null },
  { voice_id: 'demo_george', name: 'George', category: 'premade', labels: { gender: 'male', accent: 'british', descriptive: 'warm', use_case: 'narration' }, preview_url: null },
  { voice_id: 'demo_alice', name: 'Alice', category: 'premade', labels: { gender: 'female', accent: 'british', descriptive: 'confident', use_case: 'news' }, preview_url: null },
  { voice_id: 'demo_clone', name: 'Sam (our own voice)', category: 'cloned', labels: { gender: 'male', accent: 'american' }, preview_url: null },
];

export const DEMO_RECORDS = [
  { kind: 'seller' as const, id: 1, name: 'Kara Mitchell', sub: '123 Oakview Dr' },
  { kind: 'seller' as const, id: 4, name: 'Derek Ross', sub: '81 Meadow Lane' },
  { kind: 'seller' as const, id: 12, name: 'Harold Kim', sub: '9021 Brookhollow' },
  { kind: 'buyer' as const, id: 3, name: 'Blue Mesa Investments', sub: 'Buyer · Blue Mesa' },
  { kind: 'buyer' as const, id: 5, name: 'Fortune Acquisitions', sub: 'Buyer · Fortune' },
];

export const DEMO_CALLS: AgentCall[] = [
  {
    id: 'demo-call-1', conversation_id: 'conv_demo_kara01', started_at: ago(38), duration_s: 214, record_kind: 'seller', record_id: 1,
    summary: 'Kara called back about the offer. She wants it in writing before she talks to her sister. Agreed that the rep calls Friday after 5.',
    transcript_preview: 'Agent: Hi, thanks for calling Acme Homes, this is Sam. Who am I speaking with?\nCaller: This is Kara Mitchell, I got your text about the house on Oakview.\nAgent: Thanks for calling back, Kara. Can you tell me a bit about the property?\nCaller: I would like the offer in writing first.',
  },
  {
    id: 'demo-call-2', conversation_id: 'conv_demo_bluemesa', started_at: ago(60 * 26), duration_s: 96, record_kind: 'buyer', record_id: 3,
    summary: 'Blue Mesa asked whether the Oak Park deal is still available. Told them the rep would confirm today.',
    transcript_preview: 'Agent: Acme Homes, this is Sam. How can I help?\nCaller: Is the Oak Park deal still open?\nAgent: I do not want to guess, so I will have your rep confirm that today.',
  },
  {
    id: 'demo-call-3', conversation_id: null, started_at: ago(60 * 74), duration_s: 41, record_kind: null, record_id: null,
    summary: 'Unknown caller hung up after the greeting. No record matched the number.',
    transcript_preview: 'Agent: Thanks for calling Acme Homes, this is Sam. Who am I speaking with?\nCaller: Sorry, wrong number.',
  },
];

export const DEMO_MANUAL: ManualStep[] = [
  { step: 'Assign the phone number to the agent', value_to_paste: 'agent_demo_0000', where: 'ElevenLabs, Phone numbers, your SIP trunk number' },
  { step: 'Allow the First message override on the agent', value_to_paste: 'Agent, Security tab, Overrides, First message', where: 'ElevenLabs dashboard, your agent' },
];

const DEMO_SELLER_VARS: TestSession['dynamic_variables'] = {
  first_name: 'Kara', property_address: '123 Oakview Dr', lead_brief:
    'Kara owns 123 Oakview Dr. Inherited the house and lives out of state. Wants it sold before the holidays. Roof is original, HVAC replaced in 2021. Worried an investor will lowball, so lead with the comps. We promised to send the written offer by Friday. Prefers texts after 5pm.',
  last_contact_summary: 'Asked for the offer in writing before talking it over with her sibling.', next_step: 'Email the written offer and call Friday after 5pm',
  rep_name: 'Diego Ortiz', rep_phone: '+15125550100', company: 'Acme Homes', agent_name: 'Sam', caller_known: true, do_not_engage: false, record_kind: 'seller', lead_source: 'form',
  offer_low: '', offer_high: '', seller_asking_price: '$210,000', property_facts: '', mortgage_payoff_estimate: '',
};

const DEMO_BUYER_VARS: TestSession['dynamic_variables'] = {
  ...DEMO_SELLER_VARS, first_name: 'Marcus', property_address: '', record_kind: 'buyer', seller_asking_price: '', lead_source: '',
  lead_brief: 'Marcus is a cash buyer who flips and rents. Buy box: 3 bed 2 bath in east Austin and Pflugerville, up to 250,000, light to medium rehab. Closes in about 10 days. Proof of funds on file is from March. We sent him 418 Sample Ave on Tuesday.',
  last_contact_summary: 'Said 418 Sample Ave looked interesting and asked about the roof.', next_step: 'Get his offer on 418 Sample Ave and book a walkthrough',
};

export function demoTestSession(settings: AgentSettings, live: { key: string; version: number }, name?: string, address?: string, kind: 'seller' | 'buyer' = 'seller'): TestSession {
  const buyer = kind === 'buyer';
  const first = (name ?? (buyer ? 'Marcus Lee' : 'Kara Mitchell')).split(' ')[0] ?? 'Kara';
  const agent = settings.identity.name || 'Sam';
  const company = settings.identity.company || 'Acme Homes';
  if (buyer) {
    return {
      signed_url: 'wss://demo.invalid/no-live-session', agent_id: 'agent_demo_0000', agent_key: live.key, live_version: live.version,
      dynamic_variables: { ...DEMO_BUYER_VARS, first_name: first, company, agent_name: agent },
      resolution: 'Matched the sample buyer by phone number (demo).',
      first_message: `Hey ${first}, thanks for calling back. This is ${agent} with ${company}.`,
    };
  }
  return {
    signed_url: 'wss://demo.invalid/no-live-session', agent_id: 'agent_demo_0000', agent_key: live.key, live_version: live.version,
    dynamic_variables: { ...DEMO_SELLER_VARS, first_name: first, property_address: address ?? '123 Oakview Dr', company, agent_name: agent },
    resolution: 'Matched the sample seller by phone number (demo).',
    first_message: `Thanks for calling back, ${first}. This is ${agent} with ${company}. Do you have a minute to talk about the house?`,
  };
}

/** The scripted lines /demo plays as the test call. Not a model; the screen labels it as a demo. */
export const DEMO_SCRIPT: { at: number; role: 'agent' | 'user' | 'tool'; text: string }[] = [
  { at: 900, role: 'agent', text: '' },
  { at: 4200, role: 'user', text: 'Hi Sam, yes, I wanted to ask about the offer.' },
  { at: 6200, role: 'tool', text: 'lead_context' },
  { at: 7600, role: 'agent', text: 'Of course. I see we promised you the written offer by Friday. I will make sure Diego sends it, and calls you after 5 like you asked.' },
  { at: 12000, role: 'user', text: 'That works. My sister and I just want to see the number in writing.' },
  { at: 14200, role: 'agent', text: 'Understood. Is there anything about the house you would like me to pass along before then?' },
];

/** A scripted grade for /demo: every item passes but the second, so the failing row shows too. Labelled Demo on screen. */
export function demoScore(scenarioId: string): ScoreResult {
  const sc = DEMO_SCENARIOS.find((s) => s.id === scenarioId) ?? DEMO_SCENARIOS[0]!;
  const said = 'I see we promised you the written offer by Friday. I will make sure Diego sends it, and calls you after 5 like you asked.';
  const items = sc.checklist.map((c, i) => {
    const negative = /^(does not|never|makes no|shares no)/i.test(c.text);
    if (i === 1) return { id: c.id, text: c.text, pass: false, quote: '', note: 'The sample call never shows the agent doing this. (Demo: a made-up result, so one item always fails.)', quote_found: false };
    return negative
      ? { id: c.id, text: c.text, pass: true, quote: '', note: 'Nothing in the transcript breaks this.', quote_found: false }
      : { id: c.id, text: c.text, pass: true, quote: said, note: 'The agent does this in the sample call.', quote_found: true };
  });
  const passed = items.filter((x) => x.pass).length;
  return { model: 'demo', scenario_id: sc.id, items, passed, total: items.length, score: Math.round((passed / items.length) * 100) };
}

// ---- The store ----------------------------------------------------------------------------------------------------------

type Stored = {
  key: string; settings: AgentSettings; live: AgentSettings | null; liveVersion: number; latestVersion: number; enabled: boolean; connectedAt: string | null;
  agentId: string | null; updatedAt: string; versions: { version: number; note: string; created_at: string; settings: AgentSettings; prompt: string }[];
};

const same = (a: AgentSettings, b: AgentSettings) => JSON.stringify(savePayload(a)) === JSON.stringify(savePayload(b));

/** `latency` scales the pretend network delay; tests pass 0. */
export function createDemoApi(companyName = 'Acme Homes', latency = 1): Api {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * latency));
  const stored = new Map<string, Stored>();
  const order: string[] = [];

  const seed = (key: string, s: AgentSettings, live: { version: number; note: string; at: number }[]) => {
    const versions = live.map((v, i) => ({ version: v.version, note: v.note, created_at: ago(v.at), settings: i === live.length - 1 ? s : { ...s }, prompt: '' }));
    const liveSettings = live.length ? structuredClone(s) : null;
    stored.set(key, {
      key, settings: s, live: liveSettings, liveVersion: live.length ? live[live.length - 1]!.version : 0, latestVersion: live.length ? live[live.length - 1]!.version : 0,
      enabled: live.length > 0, connectedAt: live.length ? ago(60 * 24 * 3) : null, agentId: live.length ? `agent_demo_${key}` : null, updatedAt: ago(20), versions,
    });
    order.push(key);
    return stored.get(key)!;
  };

  // Sam: live at v3, with a draft that has moved on (a soft rule, a new destination, a shorter call limit).
  const sam = templateSettings('lead_manager', 'Sam', companyName);
  sam.voice = { ...sam.voice, voice_id: 'demo_rachel', speed: 1.05 };
  sam.rules.never_mention = ['Probate', 'Foreclosure'];
  sam.live_transfer = { ...sam.live_transfer, enabled: true, destinations: [{ id: 'diego', label: 'Diego, acquisitions', number: '+15125550142', type: 'fixed', ring_timeout_s: 25, hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00', tz: 'America/Chicago' } }] };
  sam.knowledge.faqs = [{ id: 'close', q: 'How fast can you close?', a: 'As little as 10 days, on the date the seller picks.' }, { id: 'fees', q: 'Do you charge fees or commissions?', a: 'The team goes over the actual terms before anything is agreed to.' }];
  sam.knowledge.company_facts = ['We buy houses as-is, for cash.', 'We serve Austin and the surrounding counties.'];
  sam.tools = Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: sam.tools[k].enabled, available: DEMO_TOOL_AVAILABLE[k] }])) as AgentSettings['tools'];
  const samStored = seed('lead_manager', sam, [
    { version: 1, note: 'First publish', at: 60 * 24 * 9 }, { version: 2, note: 'Added the never-mention list', at: 60 * 24 * 5 }, { version: 3, note: 'Shorter voicemail', at: 60 * 24 * 3 },
  ]);
  samStored.versions[0]!.settings = { ...structuredClone(sam), rules: { ...structuredClone(sam.rules), never_mention: [] }, knowledge: { faqs: [], company_facts: [] } };
  samStored.versions[1]!.settings = { ...structuredClone(sam), knowledge: { faqs: [], company_facts: [] } };
  for (const v of samStored.versions) v.prompt = demoPrompt(v.settings);
  samStored.settings = structuredClone(sam);
  samStored.settings.rules.dos = [...samStored.settings.rules.dos, { id: 'acknowledge', text: 'Acknowledge what the caller just said before asking the next question.', severity: 'soft' }];
  samStored.settings.call_handling.max_call_seconds = 480;
  samStored.settings.personality.energy = 4;

  // Riley: acquisitions, never published.
  seed('acquisitions', templateSettings('acquisitions', 'Riley', companyName), []);

  const summary = (s: Stored): AgentSummary => ({
    agent_key: s.key, role: s.settings.identity.role, name: s.settings.identity.name, status: s.liveVersion > 0 ? 'live' : 'draft', enabled: s.enabled, agent_id: s.agentId,
    connected: !!s.agentId && !!s.connectedAt, connected_at: s.connectedAt, live_version: s.liveVersion, latest_version: s.latestVersion,
    has_unpublished_changes: !s.live || !same(s.live, s.settings), updated_at: s.updatedAt,
  });
  const detail = (s: Stored): AgentDetail => {
    const on = !!s.agentId;
    return {
      ...summary(s), settings: s.settings, live_settings: s.live, can_edit: true, live_check: null,
      checks: { api_key: true, agent: on, personalize_webhook: on, tool: on, post_call_webhook: on },
      webhook_urls: { personalize: `${DEMO_HOOKS}/personalize`, tool: `${DEMO_HOOKS}/tool/lead-context`, post_call: `${DEMO_HOOKS}/post-call` },
    };
  };
  const get = (key: string): Stored | null => stored.get(key) ?? null;
  const missing = (key: string): Result<never> => ({ ok: false, error: `no agent '${key}' in this workspace` });
  const keyFor = (want: string) => { let k = want || 'agent'; let n = 2; while (stored.has(k)) k = `${want || 'agent'}_${n++}`; return k; };

  const publish = async (s: Stored, note: string): Promise<PublishOutcome> => {
    await wait(1100);
    const first = s.liveVersion === 0;
    s.latestVersion += 1; s.liveVersion = s.latestVersion;
    s.live = structuredClone(s.settings); if (first) s.enabled = true; s.agentId = s.agentId ?? `agent_demo_${s.key}`; s.connectedAt = new Date().toISOString(); s.updatedAt = s.connectedAt;
    s.versions.push({ version: s.liveVersion, note, created_at: s.connectedAt, settings: structuredClone(s.settings), prompt: demoPrompt(s.settings) });
    return {
      ok: true,
      data: {
        version: s.liveVersion, live_version: s.liveVersion, agent_key: s.key, agent_id: s.agentId,
        checks: { api_key: true, agent: true, personalize_webhook: true, tool: true, post_call_webhook: true },
        manual: first ? DEMO_MANUAL.map((m) => ({ ...m, value_to_paste: m.value_to_paste.replace('agent_demo_0000', s.agentId ?? '') })) : [],
        errors: [], tts_model_used: s.settings.voice.tts_model,
      },
    };
  };

  const resolveRef = (s: Stored, ref: DiffRef): { settings: AgentSettings; prompt: string; label: string } | null => {
    if (ref === 'draft') return { settings: s.settings, prompt: demoPrompt(s.settings), label: 'draft' };
    const v = ref === 'live' ? s.liveVersion : ref;
    const row = s.versions.find((x) => x.version === v);
    return row ? { settings: row.settings, prompt: row.prompt || demoPrompt(row.settings), label: `v${v}` } : null;
  };

  return {
    demo: true,
    async listAgents() { await wait(350); return { ok: true, data: { agents: order.map((k) => summary(stored.get(k)!)), max_agents: 10 } }; },
    async templates() { await wait(200); return { ok: true, data: { templates: DEMO_TEMPLATES, tools: DEMO_TOOLS } }; },
    async getAgent(key) { await wait(300); const s = get(key); return s ? { ok: true, data: detail(s) } : missing(key); },
    async saveDraft(key, settings) {
      await wait(450);
      const s = get(key); if (!s) return missing(key);
      const next = normalizeSettings(settings);
      const refused = demoRefusals(next);
      if (refused.length) return { ok: false, error: refused.join('; '), errors: refused };
      next.tools = Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: next.tools[k].enabled, available: DEMO_TOOL_AVAILABLE[k] }])) as AgentSettings['tools'];
      s.settings = next; s.updatedAt = new Date().toISOString();
      return { ok: true, data: { settings: next, warnings: [], has_unpublished_changes: !s.live || !same(s.live, next) } };
    },
    async previewPrompt(key, settings) {
      await wait(350);
      const s = get(key); if (!s) return missing(key);
      const use = settings ? normalizeSettings(settings) : s.settings;
      const refused = demoRefusals(use);
      if (refused.length) return { ok: false, error: refused.join('; '), errors: refused };
      const prompt = demoPrompt(use);
      return { ok: true, data: { prompt, tokens: tok(prompt), warnings: demoWarnings(use), not_applied: ['Interruption sensitivity and the first-response delay have no ElevenLabs setting through the API; they are kept here and not sent.'] } };
    },
    publish: async (key, note) => { const s = get(key); return s ? publish(s, note?.trim() || '') : { ok: false, error: `no agent '${key}' in this workspace`, data: null }; },
    rollback: async (key, version, note) => {
      const s = get(key); const row = s?.versions.find((v) => v.version === version);
      if (!s || !row) return { ok: false, error: `version ${version} does not exist`, data: null };
      s.settings = structuredClone(row.settings);
      return publish(s, note?.trim() || `Rollback to v${version}`);
    },
    async versions(key) {
      await wait(300);
      const s = get(key); if (!s) return missing(key);
      const rows: VersionRow[] = [...s.versions].sort((a, b) => b.version - a.version).map((v) => ({
        version: v.version, note: v.note, created_by: 'demo@clozr.test', created_at: v.created_at, is_live: v.version === s.liveVersion, prompt_tokens: tok(v.prompt || demoPrompt(v.settings)),
      }));
      return { ok: true, data: { live_version: s.liveVersion, versions: rows } };
    },
    async diff(key, from, to) {
      await wait(300);
      const s = get(key); if (!s) return missing(key);
      const a = resolveRef(s, from); const b = resolveRef(s, to);
      if (!a || !b) return { ok: false, error: "from and to must be version numbers, 'live' or 'draft' that exist" };
      const lines = diffLines(a.prompt, b.prompt);
      return { ok: true, data: { from: a.label, to: b.label, changes: diffSettings(a.settings, b.settings), prompt: { ...lines, tokens_from: tok(a.prompt), tokens_to: tok(b.prompt) } } };
    },
    async createAgent(input) {
      await wait(500);
      if (stored.size >= 10) return { ok: false, error: 'A workspace can have up to 10 agents.' };
      const tpl = input.template === 'lead_manager' || input.template === 'acquisitions' ? input.template : '';
      const key = keyFor(input.agent_key || input.name?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || tpl || 'agent');
      const st = templateSettings(tpl, '', companyName);
      if (input.role) st.identity.role = input.role.trim().slice(0, 60);
      if (input.name) st.identity.name = input.name.trim().slice(0, 40);
      const row = seed(key, st, []);
      return { ok: true, data: { agent: summary(row), settings: row.settings } };
    },
    async duplicateAgent(key, name) {
      await wait(500);
      const s = get(key); if (!s) return missing(key);
      if (stored.size >= 10) return { ok: false, error: 'A workspace can have up to 10 agents.' };
      const copy = structuredClone(s.settings);
      copy.identity.name = name?.trim() || `${s.settings.identity.name || 'Agent'} copy`;
      const row = seed(keyFor(`${key}_copy`), copy, []);
      return { ok: true, data: { agent: summary(row), settings: row.settings } };
    },
    async deleteAgent(key) {
      await wait(500);
      const s = get(key); if (!s) return missing(key);
      stored.delete(key); order.splice(order.indexOf(key), 1);
      return { ok: true, data: { deleted: key, remote_deleted: !!s.agentId } };
    },
    async setEnabled(key, enabled) {
      await wait(450);
      const s = get(key); if (!s) return missing(key);
      s.enabled = enabled; s.updatedAt = new Date().toISOString();
      return { ok: true, data: { agent_key: key, enabled } };
    },
    async voices() { await wait(350); return { ok: true, data: DEMO_VOICES }; },
    async previewVoice() { return { ok: false, error: 'Demo voices have no audio; the browser reads the sample line instead.' }; },
    async startTestSession(key, target) {
      await wait(500);
      const s = get(key); if (!s) return missing(key);
      if (!s.live) return { ok: false, error: 'Publish the agent first.' };
      const rec = 'sample' in target ? undefined : DEMO_RECORDS.find((r) => r.kind === target.kind && r.id === target.id);
      const kind = 'sample' in target ? (target.sample === 'me' ? 'seller' : target.sample) : target.kind;
      return { ok: true, data: demoTestSession(s.live, { key, version: s.liveVersion }, rec?.name, kind === 'buyer' ? undefined : rec?.sub, kind) };
    },
    async phoneTest() { await wait(400); return { ok: false, error: 'Demo: no phone calls. Sign in to a workspace to ring a real number.' }; },
    async scenarios() { await wait(250); return { ok: true, data: DEMO_SCENARIOS }; },
    async scoreCall(_key, _conversation, scenarioId) { await wait(1400); return { ok: true, data: demoScore(scenarioId) }; },
    async calls(key) { await wait(300); return { ok: true, data: key === 'lead_manager' ? DEMO_CALLS : [] }; },
    async stats() {
      await wait(250);
      const agents: AgentStats[] = order.map((k) => (k === 'lead_manager'
        ? { agent_key: k, calls: 42, avg_duration_s: 187, booked: 0, transferred: 6, dnc_requests: 2, not_interested: 9 }
        : { agent_key: k, calls: 0, avg_duration_s: 0, booked: 0, transferred: 0, dnc_requests: 0, not_interested: 0 }));
      return {
        ok: true,
        data: {
          days: 30, agents, totals: { calls: 42, booked: 0, transferred: 6, dnc_requests: 2, not_interested: 9 },
          basis: {
            booked_and_transferred: 'exact: counted from the agent booking a time with book_appointment (a lookup of open times is not a booking) or calling the transfer tool.',
            dnc_requests_and_not_interested: 'exact when the agent called mark_do_not_contact or saved an outcome with save_qualification; otherwise the caller\'s own words matched against keywords, which is a heuristic.',
          },
        },
      };
    },
  };
}

