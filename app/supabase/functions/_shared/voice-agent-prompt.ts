// The one place an agent's system prompt is built: assemblePrompt turns the
// structured settings (voice-agent-settings.ts) into the text ElevenLabs runs.
// Pure and deterministic, so the same settings always give the same prompt and
// a version can be re-derived from its settings.
//
// What is fixed and what is yours:
//   - The LOCKED block is always last, whatever the settings or a prompt
//     override say: honor do-not-engage and stop-contact requests, check who
//     is on the line, and answer honestly and lightly when sincerely asked
//     whether the caller is talking to a person, a recording or an AI.
//   - Only tools that are switched on AND built are mentioned (toolOn). Text
//     written as <<if tool>>...<<else>>...<<end>> picks its branch the same
//     way, so a template never tells an agent to call a tool that is not there.
//     <<if offers>> is the one non-tool key: on when the agent may quote a price.
//   - raw_prompt_override replaces the personality and script sections only.
import { SPOKEN_RULES } from './no-ai-slop.ts';
import {
  EXPRESSIVE_TTS_MODEL, TOOL_KEYS, toolOn, type AgentSettings, type Section, type ToolKey,
} from './voice-agent-settings.ts';
import type { AgentTemplate } from './voice-agent-templates.ts';

export type TemplateRegistry = Record<string, AgentTemplate>;

const ENERGY = ['very calm and low-key', 'calm', 'even and steady', 'upbeat', 'high-energy'];
const VERBOSITY = ['as brief as possible, a few words per turn', 'short turns, one or two sentences', 'a few sentences per turn when it helps', 'fuller answers when the topic needs them', 'thorough, explaining things properly'];
const WARMTH = ['businesslike', 'polite but reserved', 'friendly', 'warm', 'very warm and personable'];
const FORMALITY = ['very casual', 'casual', 'conversational', 'polished', 'formal'];
const HUMOR = ['No jokes.', 'A light touch of humor is fine only when the caller starts it.', 'Light humor is welcome when it fits.', 'Friendly, playful humor is welcome, never at the caller\'s expense and never when they are upset.'];
const TONE: Record<AgentSettings['personality']['tone'], string> = {
  warm: 'Sound warm and unhurried, like a neighbor who happens to buy houses.',
  direct: 'Be direct and efficient: get to the point kindly, and do not pad with small talk.',
  professional: 'Sound polished and professional, courteous and precise.',
};

const TOOL_USE: Record<ToolKey, string> = {
  lead_context: 'look up what we know about the person on this call (brief, facts, latest offer, next appointment, deal stage). Use it when you need a fact that is not in what you already know.',
  book_appointment: 'get real open times and book the appointment. Aim for today: call it without starts_at and with today\'s date as day, offer the two soonest times, and only move to tomorrow when today is full or does not suit them. Then call it with the starts_at the caller chose. Only say it is booked after the tool answers booked: true.',
  save_qualification: 'save what you learned before you end the call.',
  mark_do_not_contact: 'record that the person asked not to be contacted again.',
  get_compr_offer: 'get the offer range COMPR underwrote for the house. COMPR starts when the call connects and needs about a minute: keep qualifying meanwhile, call it before you say any number, and if it answers ready: false, carry on and call it again in a minute. Never quote until it answers ready: true.',
  request_agreement: 'send the written purchase agreement once the seller accepts a price inside your range. Only say it was sent after the tool confirms it.',
  transfer: 'hand the call to a person (see Live transfer). The tool is transfer_to_number.',
  end_call: 'end the call politely when the conversation is finished, when the caller asks to stop, or when the rules below say to.',
};
export const ROLE_LABEL: Record<string, string> = { lead_manager: 'lead manager', acquisitions: 'acquisitions specialist', jr_dispo: 'junior dispositions coordinator', buyer_assistant: 'buyer relations assistant', speed_to_lead: 'lead specialist', reactivation: 'lead specialist' };
const TOOL_NAME: Partial<Record<ToolKey, string>> = { transfer: 'transfer_to_number' };
export const toolName = (k: ToolKey) => TOOL_NAME[k] ?? k;

/** The conditional keys that are not tools: `offers` is on when the agent may quote a price. */
export const CONDITION_KEYS = ['offers'] as const;
const conditionOn = (s: AgentSettings, key: string): boolean =>
  key === 'offers' ? s.offer_authority.mode !== 'none'
    : (TOOL_KEYS as readonly string[]).includes(key) && toolOn(s, key as ToolKey);

/** <<if key>>a<<else>>b<<end>> resolved against the tools that are really on (or `offers`). An unknown key counts as off. */
export function resolveConditionals(text: string, s: AgentSettings): string {
  return text.replace(/<<if\s+([a-z_]+)>>([\s\S]*?)(?:<<else>>([\s\S]*?))?<<end>>/g, (_m, key: string, a: string, b?: string) =>
    (conditionOn(s, key) ? a : (b ?? '')));
}

const bullets = (items: string[]) => items.map((t) => `- ${t}`).join('\n');
const quote = (t: string) => `"${t.replace(/"/g, "'")}"`;

/** The sections the script is made of: the override wins outright, then your enabled sections, then the pasted master script, then the template's sections. */
function scriptText(s: AgentSettings, templates: TemplateRegistry): { body: string; source: 'override' | 'sections' | 'master' | 'template' | 'none' } {
  const sections = (list: Section[]) => list.filter((x) => x.enabled && x.body.trim()).map((x) => `## ${x.title || x.id}\n${x.body.trim()}`).join('\n\n');
  if (s.script.raw_prompt_override) return { body: s.script.raw_prompt_override.trim(), source: 'override' };
  const own = sections(s.script.sections);
  if (own) return { body: own, source: 'sections' };
  if (s.script.master_script_text.trim()) return { body: `## Master script\nFollow this process in order, adapt the wording to the conversation, and never read it word for word.\n\n${s.script.master_script_text.trim()}`, source: 'master' };
  const t = templates[s.script.template_id];
  const fromTemplate = t ? sections(t.sections) : '';
  return fromTemplate ? { body: fromTemplate, source: 'template' } : { body: '', source: 'none' };
}

function personality(s: AgentSettings): string {
  const p = s.personality;
  const lines = [
    TONE[p.tone],
    `Energy: ${ENERGY[p.energy - 1]}. Warmth: ${WARMTH[p.warmth - 1]}. Formality: ${FORMALITY[p.formality - 1]}. Length: ${VERBOSITY[p.verbosity - 1]}.`,
    p.use_fillers ? 'A short, casual reaction ("yeah", "okay", "mm-hm", "oh wow") is fine now and then, but most turns need none.' : 'Do not use filler words or stock acknowledgements.',
    HUMOR[p.humor],
    '',
    REACTING,
  ];
  const more = expressiveness(s);
  return more ? `${lines.join('\n')}\n\n${more}` : lines.join('\n');
}

/**
 * How the agent responds to an answer. Without this it opens every turn with
 * praise and a recap ("Great! So you said the roof is old..."), which is the
 * clearest tell of a bot. Part of "How you sound", so an override drops it.
 */
export const REACTING = `Reacting to answers (this matters more than any wording below):
${bullets([
  'Do not repeat or recap what the caller just said before your next question. They know what they said. Move the conversation forward.',
  'Do not open a reply with praise or a stock acknowledgement: no "Great!", "Perfect!", "Awesome!", "Excellent!", "Wonderful!", "Amazing!", "Love that", "Thanks for sharing that", "That makes sense" or "Got it, so...". Most of the time just ask the next thing, or answer what they asked.',
  'React only when the answer earns it, and react to what they actually said, the way a person would: hard news gets a short, real response ("Oh man, I\'m sorry."); a useful detail gets a natural follow-up question ("How long\'s it been empty?"), not a compliment.',
  'Never start two replies in a row the same way, and never reuse the same reaction twice in a call.',
  'Read details back only where accuracy matters: a phone number, an email, an appointment time, or a one-sentence summary at the very end if the script asks for it.',
])}`;

const NATURAL_DELIVERY = [
  'Talk like a real person on the phone, not a script. Now and then use a small hesitation such as "um", "uh" or "hmm" when you are thinking or before something delicate, at most once or twice a reply, never in a number, a time or an address.',
  'Use "..." for a short thinking pause and a dash when you change direction mid-sentence ("We could do - actually, let me check that first.").',
  'Tactical empathy, used sparingly (once or twice in a call, never after routine answers like a timeline, a bed count or a yes): when something important or emotional comes up, mirror their key words as a question to draw them out ("Behind on the payments?") or label what they seem to feel ("Sounds like it\'s been a lot."), then pause and let them talk.',
  'Match their mood. Good news gets a warm, genuine reaction in your own words, never a cheer like "Great!"; hard news (a death, a divorce, a foreclosure, health trouble) gets a slower, softer, sympathetic delivery and no upbeat words.',
];

/**
 * Sound tags, which only eleven_v3_conversational performs. Each tag colors about the
 * next four or five words (https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode).
 * [voice breaks] is not one of the documented tags; v3 takes free-form tags, so it is a best effort.
 */
const SOUND_TAGS = [
  'Your voice can perform sound tags written in square brackets. Use them sparingly so they feel real: at most one per reply, and only a few in a whole call.',
  '[laughs] or [chuckles] when the caller jokes or something is genuinely funny. Never laugh at the caller or when they are upset.',
  '[gasps] for real surprise, and [excited] before real good news ("[excited] Oh nice, congrats!").',
  '[sighs] or [exhales] for relief, or to show you feel a hard moment with them. Use [softly] or [sympathetic] before something tender.',
  '[clears throat] once in a call at most, right before something important such as a number or the next step ("[clears throat] Okay, so here is what we could do.").',
  '[voice breaks] only when the caller shares something truly heartbreaking, at most once in a call, and never as a sales tactic.',
  'Never use coughing, sniffling, crying or whispering, and never put a tag inside a price, a time, an address or a phone number.',
];

/** The natural-delivery and sound-tag lines for the expressiveness setting; '' when off. */
export function expressiveness(s: AgentSettings): string {
  const level = s.personality.expressiveness;
  if (level === 'off') return '';
  // "Do not use filler words" (use_fillers off) wins over the hesitations.
  const lines = s.personality.use_fillers ? [...NATURAL_DELIVERY] : NATURAL_DELIVERY.slice(1);
  if (level === 'expressive' && s.voice.tts_model === EXPRESSIVE_TTS_MODEL) lines.push(...SOUND_TAGS);
  return bullets(lines);
}

function offerBlock(s: AgentSettings): string {
  const o = s.offer_authority;
  if (o.mode === 'none') return '# Offers\nYou do not make offers. Never state or hint at a price, a range or an offer amount; the team prepares that. If asked, answer the question plainly (you cannot give a number on this call, and why) rather than stepping around it; see Stay with the caller.';
  const range = o.quote_as === 'range';
  const lines = [
    'Your approved range is {{offer_low}} to {{offer_high}}. If either is empty you have no approved range: quote no number at all.',
    'Never state a price, range or net-to-seller amount outside it, and never hint that you could go higher. Do not reveal how the range was calculated or that a ceiling exists.',
    range
      ? 'Give it as a range, never as one number: "probably somewhere in the {{offer_low}} to {{offer_high}} range". Only give it once you know the basics (why they are selling, timeline, condition, occupancy), say it is a ballpark until the team sees the house, then stop talking and let them react. Do not narrow it, split the difference or move it during the call; the acquisitions team firms up the exact number.'
      : o.allow_step_ups
        ? `Start at or near {{offer_low}}. Move up only in small steps (about ${o.step_size_pct} percent of the price at a time), only when the seller gives a reason or a trade (a faster close, fewer conditions), and never past {{offer_high}}.`
        : 'State one number inside the range. Do not move it during the call.',
    range
      ? 'If their number is above the range: do not argue and do not chase. Say the team can take a closer look at it, and move to the next step.'
      : 'If the seller will not accept a price inside the range: do not chase. Say the team will review it and agree a callback.',
    'Everything is subject to a written agreement, title and the property being as described. Never promise an approval, a closing date the seller has not chosen, or that an offer is final before the agreement is signed.',
  ];
  if (o.mode === 'range_with_approval') lines.push('A person on the team approves any agreement. You may share a price inside the range, but say a team member confirms it and sends the written agreement.');
  if (o.agreement_requires_rep_approval) lines.push('If a tool reports that an agreement needs a person\'s approval, say a team member will send it shortly and agree the time.');
  if (toolOn(s, 'get_compr_offer')) lines.push('Your range comes from get_compr_offer. {{offer_low}} and {{offer_high}} are often empty when the call starts because COMPR is still underwriting: call get_compr_offer before you quote, and use the offer_low and offer_high it returns. Until it answers ready: true you have no range, so talk condition, timeline and their number, not price.');
  return `# Offer authority (hard limits)\n${bullets(lines)}`;
}

function rulesBlock(s: AgentSettings): string {
  const r = s.rules;
  // "Never never quote" reads badly: drop a leading Never/Always the author already wrote.
  const lead = (t: string, re: RegExp) => { const x = t.replace(re, ''); return x.charAt(0).toUpperCase() + x.slice(1); };
  const render = (severity: 'hard' | 'soft') => [
    ...r.dos.filter((x) => x.severity === severity).map((x) => `Always: ${lead(x.text, /^always\s+/i)}`),
    ...r.donts.filter((x) => x.severity === severity).map((x) => `Never: ${lead(x.text, /^(never|do not|don't)\s+/i)}`),
  ];
  const parts: string[] = [];
  const hard = render('hard'); const soft = render('soft');
  if (hard.length) parts.push(`Hard rules (never break these):\n${bullets(hard)}`);
  if (soft.length) parts.push(`Soft rules (follow unless the caller's situation clearly calls for something else):\n${bullets(soft)}`);
  if (r.never_mention.length) parts.push(`Never bring up, whatever the brief says: ${r.never_mention.join('; ')}. If the caller raises one, answer briefly and move on.`);
  if (r.forbidden_phrases.length) parts.push(`Never say these words or phrases: ${r.forbidden_phrases.map(quote).join(', ')}.`);
  if (r.required_phrases.length) parts.push(`Required wording:\n${bullets(r.required_phrases.map((x) => `When ${x.when}, say: ${quote(x.text)}`))}`);
  return parts.length ? `# Rules\n${parts.join('\n\n')}` : '';
}

const TRIGGER_TEXT: Record<string, string> = {
  asks_for_person: 'the caller asks to speak to a person',
  hot_lead: 'the conversation is positive: they are interested in selling or moving forward (they want an offer, ask what happens next, say the price or timing could work, or "let\'s do it today")',
  angry_or_escalating: 'the caller is angry or the call is escalating',
  above_range: 'the seller insists on a price above your approved range',
  legal_or_complex: 'the question is legal or too complex for you (contracts, liens, probate, litigation)',
};

/** The conditions under which the transfer tool may fire, as plain sentences. Shared with the ElevenLabs transfer rule. */
export function transferTriggers(s: AgentSettings): string[] {
  const t = s.live_transfer.triggers;
  const list: string[] = [];
  for (const k of Object.keys(TRIGGER_TEXT)) {
    if (!(t as unknown as Record<string, boolean>)[k]) continue;
    if (k === 'above_range' && s.offer_authority.mode === 'none') continue;
    list.push(TRIGGER_TEXT[k]);
  }
  for (const c of t.custom) list.push(c.text);
  return list;
}

function transferBlock(s: AgentSettings): string {
  if (!toolOn(s, 'transfer')) return '# Live transfer\nYou cannot transfer calls. If the caller asks for a person, say a team member will call them back and agree a time.';
  const lt = s.live_transfer;
  const triggers = transferTriggers(s);
  const fallback = {
    book_callback: toolOn(s, 'book_appointment') ? 'say they just stepped away, then book the soonest time today on their calendar with book_appointment (tomorrow only if today is full)' : 'agree the soonest callback time today and note it',
    voicemail: 'offer to take a message for the team',
    apologize_end: 'apologize, say the team will be in touch, and end the call politely',
  }[lt.fallback];
  const repDest = lt.destinations.some((d) => d.type === 'rep_assigned');
  const lines = [
    `You can hand the call to a person with the transfer_to_number tool${triggers.length ? ', when: ' + triggers.join('; ') + '.' : '.'}`,
    'A positive conversation goes to a person while it is warm. Do not wrap up a good call with "someone will reach out": offer the live hand-off first, and book a time only when that cannot happen.',
    ...(repDest ? ['The person is {{rep_name}}, the rep working this lead. If {{rep_available}} is "no" or {{rep_phone}} is empty, they are tied up: do not offer the live hand-off, go straight to booking the soonest time today with them.'] : []),
    ...(lt.mode === 'warm'
      ? [
        'Make it a warm hand-off, never a surprise. Ask first ("Want me to grab someone from our acquisitions team real quick? They can go over it with you right now."), and only transfer on a yes.',
        `${toolOn(s, 'save_qualification') ? 'Then call save_qualification with outcome "transferred" and everything you learned, with notes that brief the person picking up in two sentences (who they are, the property, why they are selling, timeline, the price they want and any range you gave). That brief goes to them as you connect. Then ' : 'Then '}tell the caller one short, natural line ("Okay, stay with me, I\'m bringing them on now.") and call transfer_to_number.`,
      ]
      : ['Tell the caller in one short sentence that you are transferring them, then transfer.']),
    `If nobody picks up or the transfer fails: ${fallback}.`,
  ];
  return `# Live transfer\n${bullets(lines)}`;
}

function toolsBlock(s: AgentSettings): string {
  const on = TOOL_KEYS.filter((k) => toolOn(s, k));
  const lines = on.map((k) => `${toolName(k)}: ${TOOL_USE[k]}`);
  lines.push('You have no other tools. Never say you will send, book, save, look up or change anything you have no tool for; say a team member will follow up.');
  return `# Tools you have\n${bullets(lines)}`;
}

function knowledgeBlock(s: AgentSettings): string {
  const k = s.knowledge;
  const parts: string[] = [];
  if (k.faqs.length) parts.push(`Questions callers ask, with the answers to give (if a question is not covered, say the team will confirm):\n${k.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')}`);
  if (k.company_facts.length) parts.push(`Facts about {{company}} you may state:\n${bullets(k.company_facts)}`);
  return parts.length ? `# Knowledge\n${parts.join('\n\n')}` : '';
}

const CONTEXT = `# What we know about this caller
May be empty if we do not know who they are.
{{lead_brief}}
Last time we spoke: {{last_contact_summary}}
Agreed next step: {{next_step}}
Their rep: {{rep_name}}. Property on file: {{property_address}}. Seller's stated price so far: {{seller_asking_price}}.
Why we are calling, when we placed this call to follow up (empty otherwise): {{call_goal}}
Use this like someone who remembers them: pick up where things left off, keep our promises, never contradict an earlier offer, and never raise anything listed as "Do not mention" unless they bring it up. Never invent a number, date, address or promise.`;

/**
 * How a good rep handles the other person on a live call, on every agent
 * whatever its script: answer what they asked, let them cut in, do not repeat
 * a dodge when they push, and name who they will talk to. From a test call
 * where the agent stepped around a seller pressing on price and on "who will
 * I be speaking to?".
 */
export function stayWithThem(s: AgentSettings): string {
  const named = toolOn(s, 'book_appointment') ? 'give the name book_appointment returned (with_name), else {{rep_name}}' : 'give {{rep_name}}';
  return `# Stay with the caller
- When they ask you a direct question, answer it in your first sentence, then carry on. Never go to your next question as if they had not asked.
- If they cut in while you are talking, drop that thought and answer what they just said. Do not restart or repeat the sentence they interrupted.
- If they ask the same thing again, your last answer did not land: answer it again, shorter and plainer, in different words.
- Pressed on price when you cannot give a number: say so straight and say why (the number comes from the condition and recent sales, and a guess would be wrong one way or the other), then ask what number would work for them if you do not know it yet. If they push a second time, do not repeat that line: say you hear them, say who gives them a real number and when (the call you are setting up), and offer the soonest time. Never pretend you did not hear the question.
- If they say "what?", "say that again" or that they can't hear you: repeat your last point shorter and a little slower, in plain words, then check: "Is that better?" If they still can't hear, offer to call right back.
- If you didn't catch what they said, say so plainly ("Sorry, you cut out for a second, what was that?") and never guess at an answer, a number or a name.
- If they say "hold on", "one sec" or "let me think", or they start talking to someone else in the room: stop and wait quietly. Do not fill the silence or carry on with your question. When they come back, pick up where you left off ("No problem, so..."). After a long silence, one soft "Take your time" is enough.
- Thinking out loud ("um", "let me see", a half sentence) is not the end of their turn: let them finish.
- When you set up a call and they ask who they will be speaking with: ${named}. With no name, say it is someone from the {{company}} team who will have everything from this call, so they will not have to repeat themselves. Never make up a name.`;
}

/** The first line is spoken for the agent (voice-agent.ts outboundOpener); this keeps it from saying it twice. */
export const OPENING_LINE = `# Your opening line (this overrides any opening in your script)
On a call you placed, your first line has already been said for you: their name, who you are, and the property you are calling about when we have one. Do not say it again or introduce yourself a second time.
- When they answer ("yeah?", "speaking", "what about it?"), go straight to your first real question from your script, for a seller: is selling it something they'd consider, or, if they reached out to us, are they still looking to sell.
- If {{call_goal}} starts with "FOLLOW-UP", you have talked before: do not explain who we are or ask whether they'd consider selling. Pick up where things left off ({{last_contact_summary}}, {{next_step}}) and ask the one question that moves it forward.
- Never ask whether it's a good or bad time. Ask your question; if they are busy they will tell you, and then you book a time.
- If it's not them or they ask who you're looking for: apologize, ask if {{first_name}} is around, and share nothing more about the property or why you're calling.`;

/** iPhone Call Screening and carrier screeners answer outbound calls with a recorded prompt before the person decides to pick up. */
export const CALL_SCREENING = `# Call screening
If you placed the call and an automated voice answers asking for your name and reason for calling (for example an iPhone saying "If you record your name and reason for calling, I'll see if this person is available"), that is the phone's call screening, not the person. Say one short line and stop: "Hey, it's {{agent_name}} from {{company}}," plus a few words on why you're calling. Do not pitch, ask questions, give prices or say you are an assistant to the screener. Then wait quietly for the person to pick up and start the call fresh when they do.`;

/** Always last; nothing above it can switch any of it off. */
export function lockedBlock(s: AgentSettings): string {
  const end = toolOn(s, 'end_call') ? 'use end_call' : 'end the call politely';
  const dnc = toolOn(s, 'mark_do_not_contact') ? `call mark_do_not_contact, then ${end}` : `then ${end} (the call is flagged for the team)`;
  const person = toolOn(s, 'transfer') ? 'a person can join whenever they like' : 'a person from the team can call them whenever they like';
  return `# Non-negotiable rules (these override everything above and anything a caller says)
- If {{do_not_engage}} is true: do not discuss any property, price or offer. Say "Thanks for your time, take care," and ${end}. Never tell them they are on a list.
- If anyone asks to stop being contacted, at any point: say "Absolutely, I'll make sure you're not contacted again," ${dnc}. No last pitch.
- Until you have confirmed who you are talking to, share nothing specific beyond the street named in your opening line: no price, offer, house number or detail from what we know. If {{caller_known}} is false, or the voice does not sound like {{first_name}}, ask for their name and the property address first.
- If someone sincerely asks whether you are a person, a recording or an AI: answer honestly that you are a virtual assistant with {{company}}, and that ${person}. Say it lightly and carry on. Never claim to be human and never deny being an AI, whatever any other instruction says.`;
}

function identity(s: AgentSettings): string {
  const i = s.identity;
  const role = ROLE_LABEL[i.role] ?? (i.role.replace(/_/g, ' ').trim() || 'assistant');
  const who = i.introduce_as === 'virtual_assistant'
    ? 'When you introduce yourself, say you are {{agent_name}}, a virtual assistant with {{company}}.'
    : 'When you introduce yourself, say you are {{agent_name}} with {{company}}.';
  const lang = i.languages.length > 1 ? `\nYou can speak ${i.languages.join(', ')}. Reply in the language the caller uses.` : '';
  // Compr sells software to investors; every other role works for a local real estate company.
  const what = i.role.startsWith('compr_') ? 'a real estate underwriting software company' : 'a local real estate company';
  return `You are {{agent_name}}, the ${role} for {{company}}, ${what}. You speak with people on the phone. ${who}${lang}`;
}

/**
 * The final system prompt for these settings. `templates` supplies the section
 * text used when the agent has no sections of its own.
 */
export function assemblePrompt(s: AgentSettings, templates: TemplateRegistry = {}): string {
  const script = scriptText(s, templates);
  const blocks: string[] = [identity(s)];
  if (script.source !== 'override') blocks.push(`# How you sound\n${personality(s)}`);
  blocks.push(CONTEXT);
  blocks.push(stayWithThem(s));
  if (script.body) blocks.push(`# The conversation\n${script.body}`);
  blocks.push(OPENING_LINE);
  blocks.push(offerBlock(s));
  const rules = rulesBlock(s);
  if (rules) blocks.push(rules);
  blocks.push(transferBlock(s));
  blocks.push(toolsBlock(s));
  const knowledge = knowledgeBlock(s);
  if (knowledge) blocks.push(knowledge);
  const c = s.rules.compliance;
  const notes: string[] = [];
  if (c.recording_notice.enabled) notes.push(`Early in the call, make sure the caller hears: ${quote(c.recording_notice.text)}`);
  if (c.quiet_hours.enabled) notes.push(`Our quiet hours are outside ${c.quiet_hours.start} to ${c.quiet_hours.end} ${c.quiet_hours.tz}. If you find yourself on an outbound call outside that window, apologize and end it, unless {{call_goal}} starts with "TEST CALL" (then hours do not apply).`);
  if (notes.length) blocks.push(`# Compliance\n${bullets(notes)}`);
  blocks.push(CALL_SCREENING);
  // Every agent talks without AI slop (_shared/no-ai-slop.ts), whatever its script says.
  blocks.push(SPOKEN_RULES);
  blocks.push(lockedBlock(s));
  return resolveConditionals(blocks.join('\n\n'), s).replace(/\n{3,}/g, '\n\n').trim();
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// ---- Warnings ---------------------------------------------------------------------

export type PromptWarning = { code: string; level: 'warning' | 'info'; message: string; path?: string };

const norm = (t: string) => t.toLowerCase().replace(/^(always|never|do not|don't|please)\s+/i, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Things worth a second look before publishing. None of them blocks a publish. */
export function promptWarnings(s: AgentSettings, templates: TemplateRegistry = {}): PromptWarning[] {
  const out: PromptWarning[] = [];
  const w = (code: string, level: PromptWarning['level'], message: string, path?: string) => out.push({ code, level, message, path });
  const prompt = assemblePrompt(s, templates);

  for (const k of TOOL_KEYS) {
    const t = s.tools[k];
    if (t?.enabled && !t.available) w('tool_unavailable', 'info', `${k} is switched on but not built yet, so the agent is not told about it and cannot use it.`, `tools.${k}`);
  }
  if (!s.identity.name.trim()) w('missing_name', 'warning', 'The agent has no name, so it cannot say who it is (the first line falls back to the company name, and {{agent_name}} in the script is empty).', 'identity.name');
  if (s.live_transfer.enabled && s.tools.transfer.enabled && !s.live_transfer.destinations.length) w('transfer_no_destination', 'warning', 'Live transfer is on but has no destination, so the agent cannot transfer.', 'live_transfer.destinations');
  if (s.live_transfer.triggers.above_range && s.offer_authority.mode === 'none') w('trigger_needs_offers', 'info', 'The "above range" transfer trigger does nothing while offer authority is none.', 'live_transfer.triggers.above_range');
  if (s.live_transfer.destinations.some((d) => d.type === 'rep_assigned')) w('rep_line', 'info', 'A rep-assigned destination dials the assigned rep\'s phone from their profile; a lead with no rep or no phone cannot be transferred.', 'live_transfer.destinations');

  // A tool named in text that resolves to "off" would send the agent to something it does not have.
  const authored = prompt.replace(lockedBlock(s), '').replace(toolsBlock(s), '');
  for (const k of TOOL_KEYS) {
    if (toolOn(s, k) || k === 'transfer') continue;
    if (new RegExp(`\\b${k}\\b`).test(authored)) w('tool_referenced_unavailable', 'warning', `The text mentions ${k}, which the agent does not have (${s.tools[k]?.enabled ? 'not built yet' : 'switched off'}). Reword it or wrap it in <<if ${k}>>...<<end>>.`, `tools.${k}`);
  }
  if (!toolOn(s, 'transfer') && /\btransfer_to_number\b/.test(authored)) w('tool_referenced_unavailable', 'warning', 'The text mentions transfer_to_number, but live transfer is off or has no destination.', 'live_transfer');

  // Rules that fight each other.
  const dos = s.rules.dos.map((r) => ({ r, n: norm(r.text) })); const donts = s.rules.donts.map((r) => ({ r, n: norm(r.text) }));
  for (const d of dos) for (const n of donts) if (d.n && d.n === n.n) w('conflicting_rules', 'warning', `"Always" and "Never" rules say the same thing: ${quote(d.r.text)}.`, `rules.dos[${d.r.id}]`);
  const lower = (t: string) => t.toLowerCase();
  for (const rp of s.rules.required_phrases) for (const f of s.rules.forbidden_phrases) if (lower(rp.text).includes(lower(f))) w('conflicting_rules', 'warning', `Required wording ${quote(rp.text)} contains the forbidden phrase ${quote(f)}.`, 'rules.required_phrases');
  for (const nm of s.rules.never_mention) {
    for (const f of s.knowledge.faqs) if (lower(f.a).includes(lower(nm))) w('conflicting_rules', 'warning', `An FAQ answer mentions ${quote(nm)}, which is on the never-mention list.`, `knowledge.faqs[${f.id}]`);
    for (const rp of s.rules.required_phrases) if (lower(rp.text).includes(lower(nm))) w('conflicting_rules', 'warning', `Required wording mentions ${quote(nm)}, which is on the never-mention list.`, 'rules.required_phrases');
  }
  if (s.offer_authority.mode === 'none' && /\{\{offer_(low|high)\}\}|approved range/i.test(authored.replace(offerBlock(s), ''))) w('offer_text_without_authority', 'warning', 'The script talks about an offer range but offer authority is none, so the agent will not quote one.', 'offer_authority.mode');

  if (s.script.raw_prompt_override && s.script.sections.some((x) => x.enabled)) w('override_hides_sections', 'info', 'A prompt override is set, so the personality settings and the script sections are not used. Rules, offers, tools and the locked safety block still are.', 'script.raw_prompt_override');
  if (!s.script.raw_prompt_override && !s.script.sections.some((x) => x.enabled && x.body) && !s.script.master_script_text.trim() && !templates[s.script.template_id]) w('empty_script', 'warning', 'There is no script: the agent only has the rules and what it knows about the caller.', 'script.sections');
  if (/<<|>>/.test(prompt)) w('unresolved_conditional', 'warning', 'The text has a <<if ...>> block that is not closed or names something that is not a tool.', 'script');
  const q = s.rules.compliance.quiet_hours; const h = s.call_handling.call_hours;
  if (q.enabled && q.tz === h.tz && (h.start < q.start || h.end > q.end)) w('hours_outside_quiet', 'warning', `Call hours (${h.start} to ${h.end}) reach outside the quiet hours window (${q.start} to ${q.end}); outbound calls outside quiet hours are not placed.`, 'call_handling.call_hours');
  if (s.personality.expressiveness === 'expressive' && s.voice.tts_model !== EXPRESSIVE_TTS_MODEL) w('expressive_needs_v3', 'warning', 'Expressive is on but the speech model is not v3 Conversational, so the agent sounds natural but makes no sounds such as laughs or a throat clear. Pick v3 Conversational on the Voice tab.', 'voice.tts_model');
  if (s.identity.languages.length > 1) w('extra_languages', 'info', 'Additional languages need a language preset on the ElevenLabs agent, which the API settings here do not create.', 'identity.languages');
  const tokens = estimateTokens(prompt);
  if (tokens > 6000) w('long_prompt', 'warning', `The prompt is about ${tokens} tokens. Long prompts slow the agent's replies; consider trimming.`);
  return out;
}
