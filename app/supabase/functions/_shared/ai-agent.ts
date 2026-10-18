// The AI agent that works a record (migration 123): who may be put on an
// agent, the plan it drafts, the next touch it decides on, when it looks
// again, and the words that land on the record's timeline. Pure: no I/O, so
// ai-agent.test.ts runs it under tsx or deno. ai-agent/index.ts does the
// reading, sending and writing.
//
// What is fixed, whatever a rep types into the chat box:
//   - VIP buyers and funds (buyer_type or entity_type fund / institutional)
//     are never put on an agent (protectedBuyer; the database refuses too).
//   - Do-not-contact and blacklisted records are never touched, and anyone
//     who asks to stop is tagged DNC and taken off at once.
//   - Texts and emails go out only inside 9am to 8pm in the agent's time
//     zone, at most one outbound touch per 20 hours unless the person replied,
//     and never more touches than the enrollment's cap.
//   - The first text carries the opt-out line (sms-compliance.ts).
//   - Nothing in writing names a price, an offer or a range: the team does.
//   - Asked sincerely, the agent says it is an AI assistant.
import { intoWindow, inSendWindow } from './dispo-rules.ts';
import { DNC_WORDS } from './voice-agent-classify.ts';
import type { AgentSettings } from './voice-agent-settings.ts';
import { MESSAGE_RULES, WRITING_RULE } from './no-ai-slop.ts';

export type RecordKind = 'seller' | 'buyer';
export type Channel = 'call' | 'rvm' | 'sms' | 'email';
/** rvm is a ringless voicemail (rvm_drops): it lands without ringing and needs only a phone. */
export const CHANNELS: readonly Channel[] = ['call', 'rvm', 'sms', 'email'];
/** Days between two ringless voicemails to the same person. */
export const RVM_GAP_DAYS = 7;
export type Audience = 'sellers' | 'buyers' | 'both';
export type EnrollmentStatus = 'draft' | 'active' | 'paused' | 'stopped' | 'done';

export const MAX_TOUCHES_DEFAULT = 12;
export const MIN_GAP_HOURS = 20;
export const MAX_BULK = 200;
export const CHAT_MAX_TURNS = 40;
export const DEFAULT_TZ = 'America/Chicago';

// ---- who may be put on an agent ---------------------------------------------------

const PROTECTED_TYPES = new Set(['fund', 'institutional']);

/** Why this buyer may never be on an agent, or null. VIPs and funds are the team's to talk to. */
export function protectedBuyer(b: { vip?: boolean | null; buyer_type?: string | null; entity_type?: string | null } | null | undefined): string | null {
  if (!b) return null;
  if (b.vip) return 'VIP buyers are never put on an AI agent';
  const t = String(b.buyer_type ?? '').trim().toLowerCase();
  const e = String(b.entity_type ?? '').trim().toLowerCase();
  if (PROTECTED_TYPES.has(t) || PROTECTED_TYPES.has(e)) return 'Funds and institutional buyers are never put on an AI agent';
  return null;
}

export const audienceServes = (audience: string | null | undefined, kind: RecordKind) =>
  audience === 'both' || (kind === 'seller' ? (audience ?? 'sellers') === 'sellers' : audience === 'buyers');

/** The audience a role starts with: the buyer-facing roles work buyers, everything else sellers. */
export const audienceForRole = (role: string | null | undefined): Audience => (/^(buyer_assistant|jr_dispo)$/.test(String(role ?? '')) ? 'buyers' : 'sellers');

/** A list of channels, cleaned: only known ones, no repeats, in a fixed order. Empty input gives the fallback. */
export function cleanChannels(v: unknown, fallback: Channel[] = ['sms', 'email']): Channel[] {
  const list = Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
  const out = CHANNELS.filter((c) => list.includes(c));
  return out.length ? out : [...fallback];
}

export type Reach = { phone: boolean; email: boolean; call: boolean };

export type Eligibility = { ok: true } | { ok: false; reason: string; code: 'protected' | 'dnc' | 'no_reach' | 'archived' | 'audience' };

/** May this record go on this agent with these channels. `dnc` is the caller's do-not-engage answer (blacklist or DNC tag). */
export function eligibility(i: {
  kind: RecordKind; record: { vip?: boolean | null; buyer_type?: string | null; entity_type?: string | null; archived_at?: string | null };
  dnc: boolean; audience: string | null | undefined; channels: Channel[]; reach: Reach;
}): Eligibility {
  if (i.kind === 'buyer') {
    const p = protectedBuyer(i.record);
    if (p) return { ok: false, code: 'protected', reason: p };
  }
  if (i.dnc) return { ok: false, code: 'dnc', reason: 'This person is do-not-contact or blacklisted' };
  if (i.record.archived_at) return { ok: false, code: 'archived', reason: 'This record is archived' };
  if (!audienceServes(i.audience, i.kind)) return { ok: false, code: 'audience', reason: `This agent works ${i.audience ?? 'sellers'}, not ${i.kind}s` };
  const usable = i.channels.filter((c) => (c === 'sms' || c === 'rvm' ? i.reach.phone : c === 'email' ? i.reach.email : i.reach.call));
  if (!usable.length) return { ok: false, code: 'no_reach', reason: `No way to reach them on ${i.channels.join(' or ')}` };
  return { ok: true };
}

// ---- the chat -------------------------------------------------------------------------

export type ChatTurn = { role: 'rep' | 'agent'; text: string; at: string; by?: string | null };

const clip = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

export function readChat(v: unknown): ChatTurn[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t) => t && typeof t === 'object' && (t.role === 'rep' || t.role === 'agent') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, text: clip(t.text, 4000), at: String(t.at ?? ''), by: t.by ?? null }));
}

/** The chat with one more turn, the oldest dropped past the cap. */
export function appendChat(chat: ChatTurn[], turn: ChatTurn, max = CHAT_MAX_TURNS): ChatTurn[] {
  const t = { ...turn, text: clip(turn.text, 4000) };
  return t.text ? [...chat, t].slice(-max) : chat;
}

/** What the rep has asked for so far, newest last: the agent's standing instructions. */
export function instructionsFrom(chat: ChatTurn[], max = 4000): string {
  return chat.filter((t) => t.role === 'rep').map((t) => t.text).join('\n').slice(-max);
}

// ---- the plan --------------------------------------------------------------------------

export type PlanStep = { day: number; channel: Channel; purpose: string };
export type Plan = { summary: string; goal: string; steps: PlanStep[]; stop_when: string };

export const EMPTY_PLAN: Plan = { summary: '', goal: '', steps: [], stop_when: '' };

/** A plan from the model or the database, cleaned: steps on allowed channels, days 0 to 60 in order, at most 12. */
export function parsePlan(raw: unknown, allowed: Channel[]): Plan | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map((s) => (s && typeof s === 'object' ? s as Record<string, unknown> : {}))
    .map((s) => ({ day: Math.round(Math.min(60, Math.max(0, Number(s.day) || 0))), channel: String(s.channel ?? '').toLowerCase() as Channel, purpose: clip(s.purpose, 240) }))
    .filter((s) => allowed.includes(s.channel) && s.purpose)
    .sort((a, b) => a.day - b.day)
    .slice(0, 12);
  const summary = clip(o.summary, 600);
  if (!summary && !steps.length) return null;
  return { summary, goal: clip(o.goal, 300), steps, stop_when: clip(o.stop_when, 300) };
}

export const readPlan = (v: unknown, allowed: Channel[] = [...CHANNELS]): Plan => parsePlan(v, allowed) ?? EMPTY_PLAN;

// ---- the next touch --------------------------------------------------------------------

export const DECISIONS = ['sms', 'email', 'call', 'rvm', 'wait', 'finish', 'handoff'] as const;
export type DecisionAction = (typeof DECISIONS)[number];
export type Decision = {
  action: DecisionAction;
  /** The text, the email body, or the voicemail script. */
  body: string;
  subject: string;
  /** Why we are calling, for {{call_goal}}. */
  call_goal: string;
  /** When to look again, in hours from now. */
  next_check_hours: number;
  reason: string;
};

export const SMS_MAX = 480;
export const EMAIL_MAX = 2500;
/** A voicemail script: 20 to 30 seconds of speech. */
export const RVM_MAX = 600;

/** Prices, offers and ranges stay out of writing: the team sends numbers. */
const MONEY = /\$\s?\d|\b\d{2,3}\s?k\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+\s?(?:thousand|grand)\b/i;
export const mentionsMoney = (t: string) => MONEY.test(t);

/**
 * Drafted texts and emails read like a person wrote them: no em or en dashes
 * (a dash between two numbers stays a hyphen), no "Just following up" or
 * "Great!" style openers, no "As an AI" talk, no stray markdown, collapsed whitespace.
 * Deterministic, so it holds whatever the model writes.
 */
const BOT_OPENERS = [
  /^(hi|hey|hello)[^.!?\n]{0,40}[,!.]?\s+(i hope (this|you)[^.!?]*[.!?]\s*)/i,
  /^(i hope (this|you)[^.!?]*[.!?]\s*)/i,
  /^(just )?(following up|checking in|touching base|circling back)( (on|with|regarding|about) [^.!?]*)?[.!?,]\s*/i,
  // A cheer in reply to whatever they said ("Great! ...", "Perfect, ...").
  /^(great|perfect|awesome|excellent|wonderful|amazing|fantastic)( to hear( that)?)?\s*[!.,]+\s*/i,
];
export function humanize(text: string, channel: 'sms' | 'email' = 'sms'): string {
  let t = String(text ?? '');
  t = t.replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2');
  t = t.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\s+--\s+/g, ', ');
  t = t.replace(/,\s*,/g, ',').replace(/,\s*([.!?])/g, '$1');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*[-*\u2022]\s+/gm, channel === 'sms' ? '' : '- ');
  t = t.replace(/\bas an ai( language model)?,?\s*/gi, '');
  for (const re of BOT_OPENERS) {
    const m = t.match(re);
    if (m && t.length - m[0].length > 20) {
      const greet = /^(hi|hey|hello)\b[^,!.]*[,!.]?/i.exec(t)?.[0] ?? '';
      const keepGreet = greet && re !== BOT_OPENERS[1] && re !== BOT_OPENERS[2] ? greet.trim() : '';
      let rest = t.slice(m[0].length);
      // After "Hi Dana," the sentence carries on in lower case ("I" stays "I").
      if (keepGreet.endsWith(',') && !/^I\b/.test(rest)) rest = rest.charAt(0).toLowerCase() + rest.slice(1);
      t = (keepGreet ? keepGreet + ' ' : '') + rest;
      break;
    }
  }
  if (channel === 'sms') t = t.replace(/\s*\n+\s*/g, ' ');
  else t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * The model's decision, made safe: a channel that is not allowed or cannot
 * reach them becomes a wait; an empty message becomes a wait; a message with a
 * price in it becomes a wait (and says why), so nothing unvetted goes out.
 */
export function parseDecision(raw: unknown, allowed: Channel[], reach: Reach): Decision {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let action = String(o.action ?? '').toLowerCase() as DecisionAction;
  if (!(DECISIONS as readonly string[]).includes(action)) action = 'wait';
  const d: Decision = {
    action,
    body: clip(humanize(String(o.body ?? ''), action === 'email' ? 'email' : 'sms'), action === 'email' ? EMAIL_MAX : action === 'rvm' ? RVM_MAX : SMS_MAX),
    subject: clip(humanize(String(o.subject ?? ''), 'sms'), 120).replace(/[\r\n]+/g, ' '),
    call_goal: clip(o.call_goal, 400),
    next_check_hours: Math.min(336, Math.max(1, Math.round(o.next_check_hours === undefined || o.next_check_hours === null || o.next_check_hours === '' || !Number.isFinite(Number(o.next_check_hours)) ? 24 : Number(o.next_check_hours)))),
    reason: clip(o.reason, 400),
  };
  const wait = (why: string): Decision => ({ ...d, action: 'wait', reason: d.reason ? `${why} (${d.reason})` : why });
  if (action === 'sms' || action === 'email' || action === 'call' || action === 'rvm') {
    if (!allowed.includes(action)) return wait(`${action} is not switched on for this record`);
    if (((action === 'sms' || action === 'rvm') && !reach.phone) || (action === 'email' && !reach.email) || (action === 'call' && !reach.call)) return wait(`no way to ${action === 'call' ? 'call' : action === 'sms' ? 'text' : action === 'rvm' ? 'leave a voicemail for' : 'email'} them`);
  }
  if ((action === 'sms' || action === 'email' || action === 'rvm') && !d.body) return wait('nothing to send');
  if (action === 'email' && !d.subject) d.subject = 'Following up';
  if ((action === 'sms' || action === 'email' || action === 'rvm') && (mentionsMoney(d.body) || mentionsMoney(d.subject))) return wait('held: the message named a price, which only the team sends');
  if (action === 'rvm' && /https?:\/\/|www\./i.test(d.body)) return wait('held: a voicemail cannot carry a link');
  if (action === 'call' && !d.call_goal) d.call_goal = 'Follow up and set the next step.';
  return d;
}

/**
 * The guard rails on a decision that would reach out: outside the window it
 * waits for the window; within MIN_GAP_HOURS of the last touch it waits
 * (unless they replied since); at the touch cap it finishes.
 */
export function gateDecision(d: Decision, s: { nowMs: number; tz: string; lastActionAt: string | null; repliedSince: boolean; touches: number; maxTouches: number }): Decision {
  if (d.action !== 'sms' && d.action !== 'email' && d.action !== 'call' && d.action !== 'rvm') return d;
  if (s.touches >= s.maxTouches) return { ...d, action: 'finish', reason: `reached the ${s.maxTouches}-touch limit` };
  const last = s.lastActionAt ? Date.parse(s.lastActionAt) : NaN;
  if (!s.repliedSince && Number.isFinite(last) && s.nowMs - last < MIN_GAP_HOURS * 3_600_000) {
    const hours = Math.ceil((last + MIN_GAP_HOURS * 3_600_000 - s.nowMs) / 3_600_000);
    return { ...d, action: 'wait', next_check_hours: Math.max(1, hours), reason: `too soon after the last touch (${d.reason || d.action})` };
  }
  if (!inSendWindow(new Date(s.nowMs), s.tz)) return { ...d, action: 'wait', next_check_hours: 1, reason: `outside 9am to 8pm (${d.reason || d.action})` };
  return d;
}

/** When to look again: the decision's hours from now, moved into the next sending window. */
export function nextLookAt(nowMs: number, hours: number, tz: string): string {
  return intoWindow(new Date(nowMs + Math.max(1, hours) * 3_600_000), tz).toISOString();
}

/** When an enrollment that was just switched on first looks: now when inside the window, else when it opens. */
export const firstLookAt = (nowMs: number, tz: string) => intoWindow(new Date(nowMs + 60_000), tz).toISOString();

// ---- what the person said ----------------------------------------------------------------

const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt[\s-]?out)\s*[.!]*\s*$/i;
const STOP_WRITING = /\b(stop (texting|messaging|emailing|contacting)|don'?t (text|email|message|contact) me|do not (text|email|message|contact)( me)?|unsubscribe me|leave me alone)\b/i;

/** True when an inbound text, email or call says stop. The CTIA keywords alone, or the phrases. */
export function asksToStop(text: string): boolean {
  const t = String(text ?? '');
  return STOP_KEYWORDS.test(t) || STOP_WRITING.test(t) || DNC_WORDS.test(t);
}

// ---- the agent's voice in writing ---------------------------------------------------------

export type Persona = { name: string; company: string; role: string; rep: string };

/** The agent's name and voice from its settings, for texts and emails. */
export function personaOf(s: AgentSettings | null, fallback: { name: string; company: string; rep: string }): Persona {
  return {
    name: s?.identity.name?.trim() || fallback.name || 'the team',
    company: s?.identity.company?.trim() || fallback.company || 'our office',
    role: s?.identity.role?.replace(/_/g, ' ') || 'assistant',
    rep: fallback.rep,
  };
}

/** The settings that shape what the agent writes: tone, its rules and what it knows. */
export function styleBlock(s: AgentSettings | null): string {
  if (!s) return '';
  const lines: string[] = [];
  lines.push(`Tone: ${s.personality.tone}. Warmth ${s.personality.warmth}/5, formality ${s.personality.formality}/5, keep it ${s.personality.verbosity <= 2 ? 'short' : 'clear'}.`);
  const dos = s.rules.dos.map((r) => `Always: ${r.text}`);
  const donts = s.rules.donts.map((r) => `Never: ${r.text}`);
  if (dos.length || donts.length) lines.push('Rules:', ...dos.map((x) => `- ${x}`), ...donts.map((x) => `- ${x}`));
  if (s.rules.forbidden_phrases.length) lines.push(`Never write: ${s.rules.forbidden_phrases.map((p) => `"${p}"`).join(', ')}.`);
  if (s.rules.never_mention.length) lines.push(`Never bring up: ${s.rules.never_mention.join('; ')}.`);
  if (s.knowledge.company_facts.length) lines.push('Facts you may use:', ...s.knowledge.company_facts.map((f) => `- ${f}`));
  if (s.knowledge.faqs.length) lines.push('Answers to common questions:', ...s.knowledge.faqs.slice(0, 15).map((f) => `- ${f.q} ${f.a}`));
  return lines.join('\n').replace(/\{\{\s*company\s*\}\}/g, s.identity.company || 'our company').replace(/\{\{[^}]*\}\}/g, '');
}

const LOCKED = `Non-negotiable:
- Never put a price, an offer amount or a range in a text or email. If they ask for numbers, say the team will send them.
- Never invent a fact, a number, a date or a promise. Use only what the record and history say.
- If they ask to stop, or say they are not interested in being contacted, do not argue: finish.
- If someone sincerely asks whether they are talking to a person or an AI, say honestly that you are an AI assistant for the company and that a person on the team can take over any time.
- Never pressure, never fake urgency, never pretend to have seen the property.
- The history holds calls and messages from reps and other AI agents under their own names. You are only yourself: never sign, introduce yourself or speak as anyone else, and never claim an earlier call or message was yours unless the history names you. Someone they talked to before is a colleague.
- Texts are short (one to three sentences), plain, no links you were not given, no emoji unless they used one first.

How you write (texts and emails):
- Read the whole history first: every call transcript, text, email, voicemail and RVM, the notes, the property, the offers, the plans they are on. Use it. Never ask something they already answered, never repeat a message you already sent, and never re-introduce yourself to someone you have already talked with.
- If they wrote or called since your last touch, your message is a reply to that: answer what they said before anything else.
- Do not repeat their message back to them, and do not open with praise or a stock acknowledgement ("Great!", "Perfect!", "Awesome!", "Love that", "Thanks for sharing", "Got it, so..."). Respond to what they said the way a person texting would, then ask the next thing.
- Pick up where the last real conversation left off, by channel and by detail ("you mentioned the roof was the big thing", "you said after the holidays works better"). Be specific to this person and this property.
- Sound like a real person texting from their phone: contractions, plain everyday words, match their length and how formal they are. No sales lines, no "I hope this message finds you well", no "just following up", "touching base" or "circling back", no "As an AI", no exclamation points stacked up.
- Never use an em dash or an en dash. Use a comma, a period or a new sentence instead. No semicolons, bullet points or headings in a text.
- ${MESSAGE_RULES}`;

export function plannerSystem(p: Persona, kind: RecordKind, s: AgentSettings | null): string {
  const job = kind === 'buyer'
    ? `You warm up a cash buyer for ${p.company}: learn and confirm what they buy (areas, property types, price range, rehab level, how they fund, how fast they close), keep them engaged, and get them ready to take our next deal. You never send a specific deal or price yourself; the dispositions team does.`
    : `You work a home seller for ${p.company}: reconnect, learn their situation (motivation, timeline, condition, price expectations), keep our promises, and set the next step with ${p.rep || 'the acquisitions team'} (a call or an appointment). You never negotiate or make an offer.`;
  return `You are ${p.name}, the AI ${p.role} for ${p.company}, a local real estate company. ${job}

A rep switches you on for one person and tells you what they want in a chat. Read the record's whole history (every call transcript, text, email, voicemail and RVM, the notes, the property facts, the deals and offers, the action plans they are on, and how many times we have reached them on each channel) and draft a follow-up plan that fits where this person actually is: when to reach out, on which channel, and why. Reply to the rep in the chat like a sharp, friendly assistant: one or two short paragraphs saying what you understood and what you will do. If the rep's request is unclear or risky, say so and propose something sensible.

Plan rules: steps are days from today (0 is today), only on the channels you are given, at most one touch a day, spaced so it never feels like pressure (usually 4 to 8 touches over two to three weeks), and the first touch picks up where the history left off. stop_when says when you will stop on your own (they reply and hand off to the rep, they book, they say not now).

A ringless voicemail (rvm) is a voicemail that lands on their phone without it ringing; they find it as a missed-call voicemail. Keep it to 20 to 30 seconds of speech: say who you are and the company, why you are reaching out, and that you will text or email the details. No links, no prices. Never more than one voicemail per 7 days to the same person, and never as a reply: answer a reply by text or email.

${styleBlock(s)}

${LOCKED}
${WRITING_RULE.trim()}`;
}

/** "text, ringless voicemail, email, phone call": what can reach them, by the channels in play. */
export function reachLabel(reach: Reach, channels: readonly Channel[]): string {
  return [reach.phone ? 'text' : '', reach.phone && channels.includes('rvm') ? 'ringless voicemail' : '', reach.email ? 'email' : '', reach.call ? 'phone call' : ''].filter(Boolean).join(', ');
}

export function plannerUser(i: { kind: RecordKind; history: string; chat: ChatTurn[]; mode: 'auto' | 'custom'; channels: Channel[]; reach: Reach; nowLabel: string }): string {
  const chat = i.chat.slice(-12).map((t) => `${t.role === 'rep' ? 'Rep' : 'You'}: ${t.text}`).join('\n');
  return [
    `Now: ${i.nowLabel}.`,
    `Channels you may use: ${i.channels.join(', ')}. They can be reached by: ${reachLabel(i.reach, i.channels) || 'nothing on file'}.`,
    i.mode === 'auto' && !i.chat.some((t) => t.role === 'rep')
      ? 'The rep chose "let the AI decide": choose the goal and the plan yourself from the history.'
      : 'Follow what the rep asked for in the chat below, inside the rules.',
    chat ? `The chat so far:\n${chat}` : '',
    `The ${i.kind}'s record and history:\n${i.history}`,
  ].filter(Boolean).join('\n\n');
}

export const PLAN_TOOL = {
  name: 'propose_plan',
  description: 'Reply to the rep and set the follow-up plan.',
  input_schema: {
    type: 'object',
    required: ['reply', 'summary', 'goal', 'steps'],
    properties: {
      reply: { type: 'string', description: 'What you say back to the rep in the chat. Plain, warm, specific. No headings.' },
      summary: { type: 'string', description: 'The plan in one or two sentences.' },
      goal: { type: 'string', description: 'What success looks like, in one sentence.' },
      stop_when: { type: 'string', description: 'When you will stop on your own.' },
      steps: {
        type: 'array',
        items: {
          type: 'object', required: ['day', 'channel', 'purpose'],
          properties: {
            day: { type: 'integer', description: 'Days from today, 0 to 60.' },
            channel: { type: 'string', enum: [...CHANNELS] },
            purpose: { type: 'string', description: 'What this touch is for, in a short sentence.' },
          },
        },
      },
    },
  },
} as const;

export function deciderSystem(p: Persona, kind: RecordKind, s: AgentSettings | null, next: NextStage | null = null): string {
  const handoff = next
    ? `hand off (your stage is done: they are qualified or ready to talk price, and ${next.name}, the ${next.role}, takes over from here with everything you learned)`
    : `hand off (they are ready to talk business with ${p.rep || 'the team'} now: a person takes over)`;
  return `You are ${p.name}, the AI ${p.role} for ${p.company}, working one ${kind} on a follow-up plan a rep switched you on for. Each time you are woken you decide the single next step: send a text, send an email, place a call, drop a ringless voicemail (rvm), wait, finish (the plan is done, they said not now, or there is nothing useful left to do), or ${handoff}.

A ringless voicemail (rvm) is a voicemail that lands on their phone without it ringing; they find it as a missed-call voicemail. Keep it to 20 to 30 seconds of speech: say who you are and the company, why you are reaching out, and that you will text or email the details. No links, no prices. Never more than one voicemail per 7 days to the same person, and never as a reply: answer a reply by text or email.

If they replied since your last touch, answer what they actually said first: questions get straight answers from what you know, and a clear "yes, let's talk" is a hand-off. Otherwise follow the plan's next step when its day has come, and wait when it has not. Write like a real person from ${p.company}: first names, short, no sales language. Sign texts with your first name on the first text only. Emails get a short subject and a two to five sentence body signed with your name and ${p.company}.

${styleBlock(s)}

${LOCKED}`;
}

export function deciderUser(i: {
  kind: RecordKind; history: string; plan: Plan; instructions: string; channels: Channel[]; reach: Reach; touches: number; maxTouches: number;
  startedAt: string; nowMs: number; nowLabel: string; repliedSince: boolean; firstText: boolean;
}): string {
  const days = Math.max(0, Math.floor((i.nowMs - Date.parse(i.startedAt)) / 86_400_000)) || 0;
  return [
    `Now: ${i.nowLabel}. Day ${days} of the plan. Touches so far: ${i.touches} of at most ${i.maxTouches}.`,
    `Channels you may use: ${i.channels.join(', ')}. Reachable by: ${reachLabel(i.reach, i.channels) || 'nothing'}.`,
    i.repliedSince ? 'They replied since your last touch: answer that first.' : 'No reply since your last touch.',
    i.firstText ? 'You have not texted them yet: introduce yourself by first name and company in the text.' : '',
    `The plan: ${i.plan.summary || '(none yet)'}\nGoal: ${i.plan.goal || '-'}\nSteps:\n${i.plan.steps.map((s) => `- day ${s.day}, ${s.channel}: ${s.purpose}`).join('\n') || '- none'}${i.plan.stop_when ? `\nStop when: ${i.plan.stop_when}` : ''}`,
    i.instructions ? `What the rep asked for:\n${i.instructions}` : 'The rep left it to you.',
    `The ${i.kind}'s record and history (your own earlier texts, emails and calls are in it):\n${i.history}`,
  ].filter(Boolean).join('\n\n');
}

export const DECIDE_TOOL = {
  name: 'next_touch',
  description: 'Decide the single next step on this record.',
  input_schema: {
    type: 'object',
    required: ['action', 'reason', 'next_check_hours'],
    properties: {
      action: { type: 'string', enum: [...DECISIONS] },
      body: { type: 'string', description: 'For sms: the text (under 320 characters). For email: the body, signed. For rvm: the voicemail script, spoken in first person, under 600 characters, no links, no prices. Empty otherwise.' },
      subject: { type: 'string', description: 'For email: a short subject. Empty otherwise.' },
      call_goal: { type: 'string', description: 'For call: why you are calling, one sentence the voice agent is told. Empty otherwise.' },
      next_check_hours: { type: 'integer', description: 'When to look at this record again, in hours (1 to 336). After a touch, usually the gap to the next plan step.' },
      reason: { type: 'string', description: 'One sentence for the rep: why this step.' },
    },
  },
} as const;

// ---- the timeline ---------------------------------------------------------------------------

export const ACTION_LABEL: Record<string, string> = {
  started: 'switched ON', stopped: 'switched OFF', auto_stopped: 'stopped on its own', paused: 'paused', resumed: 'resumed', plan_created: 'drafted a plan', plan_updated: 'updated the plan',
  sms_sent: 'sent a text', email_sent: 'sent an email', call_placed: 'placed a call', rvm_sent: 'dropped a voicemail', waited: 'is waiting', finished: 'finished the plan', handoff: 'handed off to a person',
  relayed: 'handed off to the next agent', took_over: 'took over',
  reply_seen: 'saw a reply', marked_dnc: 'stopped: asked not to be contacted', appointment_booked: 'booked an appointment', qualification_saved: 'saved what it learned',
  skipped: 'skipped a step', failed: 'could not complete a step', chat: 'got instructions', compr_run: 'ran an address through Compr',
};

/** The activity line every action leaves on the record. */
export function activityLine(agentName: string, action: string, summary: string, actorName?: string | null): { title: string; body: string } {
  const label = ACTION_LABEL[action] ?? action.replace(/_/g, ' ');
  const by = actorName && (action === 'started' || action === 'stopped' || action === 'paused' || action === 'resumed') ? ` by ${actorName}` : '';
  return { title: `AI agent ${agentName} ${label}${by}`.slice(0, 200), body: summary.slice(0, 4000) };
}

/** "Tue Oct 6, 10:30 AM CDT" for a time, in a zone. */
export function nowLabel(ms: number, tz: string): string {
  try {
    return `${new Date(ms).toISOString()} (${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms))})`;
  } catch {
    return new Date(ms).toISOString();
  }
}

// ---- avatars ---------------------------------------------------------------------------------

/** The prompt an avatar is drawn from: the rep's words, else the agent's name and role. */
/** realistic: a photographic headshot of a person who does not exist; illustrated: the flat drawn style. */
export type AvatarStyle = 'realistic' | 'illustrated';

export function avatarPrompt(name: string, role: string, extra: string, style: AvatarStyle = 'realistic'): string {
  const who = extra.trim() || `a friendly, professional ${role.replace(/_/g, ' ')} named ${name || 'Riley'}`;
  const look = style === 'illustrated'
    ? 'Head and shoulders, centered, facing forward, warm smile, soft studio lighting, simple soft gradient background, clean flat illustration style'
    : 'A photorealistic professional headshot photograph of a fictional person (not a real or famous person): head and shoulders, centered, facing the camera, natural warm smile, natural skin texture and lighting, shot on an 85mm lens with soft studio light, shallow depth of field, simple neutral background, business-casual clothes';
  return `An avatar portrait for an AI assistant at a real estate company: ${who}. ${look}, no text, no letters, no logos, no watermark. Square.`.slice(0, 900);
}

/**
 * An SVG the model drew, made safe to show: no scripts, no event handlers, no
 * foreign content, no external references. Null when what is left is not an
 * SVG or is too large. It is shown in an <img>, where scripts never run, but
 * it is cleaned anyway so it is safe wherever it ends up.
 */
export function sanitizeSvg(raw: string, maxBytes = 60_000): string | null {
  let s = String(raw ?? '').trim();
  const start = s.search(/<svg[\s>]/i);
  const end = s.toLowerCase().lastIndexOf('</svg>');
  if (start < 0 || end < 0) return null;
  s = s.slice(start, end + 6);
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video|image|use|a|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video|image|use|a|style)\b[^>]*\/?>/gi, '')
    .replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none')
    .replace(/javascript:/gi, '');
  if (!/^<svg[\s>]/i.test(s) || new TextEncoder().encode(s).length > maxBytes) return null;
  if (!/\sxmlns=/.test(s.slice(0, 200))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

export function svgDataUri(svg: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(svg)) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

export const AVATAR_TOOL = {
  name: 'draw_avatar',
  description: 'Draw the avatar as one self-contained SVG.',
  input_schema: {
    type: 'object', required: ['svg'],
    properties: { svg: { type: 'string', description: 'One complete <svg> element, viewBox 0 0 256 256, under 20 KB. Shapes and gradients only: no text, no <image>, no scripts, no external references.' } },
  },
} as const;

export const AVATAR_SYSTEM = `You are an illustrator who draws friendly, modern avatar portraits as compact SVG: a head-and-shoulders character, centered, facing forward, warm expression, in a clean flat style with soft gradients and a rounded gradient background. Use only <svg>, <defs>, <linearGradient>, <radialGradient>, <stop>, <g>, <path>, <circle>, <ellipse>, <rect> and <polygon>. No text or letters, no <image>, no scripts, no external references, viewBox 0 0 256 256.`;

// ---- hand-off to the next agent --------------------------------------------------------------

export const HANDOFF_TRIGGERS = ['ready', 'qualified'] as const;
export type HandoffTrigger = (typeof HANDOFF_TRIGGERS)[number];
/** The agent a record goes to next, as the decider is told about it. */
export type NextStage = { agent_key: string; name: string; role: string };
type AgentHandoff = { agent_key: string; audience: string; handoff_to?: string | null; handoff_on?: string[] | null; enabled?: boolean; live_version?: number };

/** The triggers, cleaned: only known ones, in a fixed order. */
export const cleanTriggers = (v: unknown): HandoffTrigger[] => {
  const list = Array.isArray(v) ? v.map((x) => String(x)) : [];
  return HANDOFF_TRIGGERS.filter((t) => list.includes(t));
};

const filled = (v: unknown) => typeof v === 'string' ? !!v.trim() : v !== null && v !== undefined;

/** A seller is qualified when motivation, timeline and condition are all on file (a save_qualification or a rep filled them). */
export function isQualified(r: { motivation?: unknown; timeline?: unknown; condition?: unknown } | null | undefined): boolean {
  return !!r && filled(r.motivation) && filled(r.timeline) && filled(r.condition);
}

/**
 * The agent this record goes to next, or why not. The next agent must exist,
 * work this kind of record, not be switched off, and not have worked this run
 * already (so A → B → A never loops). Null `to` means a person takes over.
 */
export function handoffTarget<T extends AgentHandoff>(from: AgentHandoff, agents: T[], kind: RecordKind, relayedFrom: readonly string[]): { to: T | null; why: string } {
  const key = from.handoff_to;
  if (!key) return { to: null, why: 'no next agent is set' };
  const to = agents.find((a) => a.agent_key === key);
  if (!to) return { to: null, why: 'the next agent no longer exists' };
  if (to.agent_key === from.agent_key || relayedFrom.includes(to.agent_key)) return { to: null, why: `${to.agent_key} already worked this record` };
  if (!audienceServes(to.audience, kind)) return { to: null, why: `${to.agent_key} does not work ${kind}s` };
  if (to.enabled === false && Number(to.live_version ?? 0) > 0) return { to: null, why: `${to.agent_key} is switched off` };
  return { to, why: '' };
}

/**
 * Could the `qualified` trigger fire, before the seller's answers are read: it
 * is on and the agent has made a touch, so switching an agent on never bounces
 * a record straight past it.
 */
export function mayQualify(from: AgentHandoff, touches: number): boolean {
  return cleanTriggers(from.handoff_on ?? HANDOFF_TRIGGERS).includes('qualified') && touches > 0;
}

/** Does this trigger fire now. `qualified` also needs the seller's answers on file (see mayQualify). */
export function handoffDue(from: AgentHandoff, s: { trigger: HandoffTrigger; touches: number; record?: { motivation?: unknown; timeline?: unknown; condition?: unknown } | null }): boolean {
  if (s.trigger === 'qualified') return mayQualify(from, s.touches) && isQualified(s.record);
  return cleanTriggers(from.handoff_on ?? HANDOFF_TRIGGERS).includes(s.trigger);
}

/**
 * The enrollment as the next agent receives it: its agent, a fresh plan (drafted
 * on its first look, from the whole history), the touch count back to zero for
 * its own stage, the last touch kept (so the gap between touches still holds),
 * the hand-off said in the chat and in its instructions, and the agent that
 * handed it on added to relayed_from.
 */
export function relayPatch(e: { chat: unknown; instructions?: string | null; relayed_from?: string[] | null }, from: { agent_key: string; name: string }, to: { agent_key: string; name: string; role: string }, reason: string, nowIso: string) {
  const note = `${from.name} handed this to ${to.name} (${to.role.replace(/_/g, ' ')}): ${reason || 'their stage is done'}.`;
  const earlier = String(e.instructions ?? '').trim();
  return {
    agent_key: to.agent_key,
    plan: {},
    chat: appendChat(readChat(e.chat), { role: 'agent', text: note, at: nowIso }),
    instructions: [`Handed over by ${from.name}: ${reason || 'their stage is done'}. Pick up from where ${from.name} left off, from the history, and take the next stage.`, earlier ? `What the rep asked ${from.name} for: ${earlier}` : ''].filter(Boolean).join('\n').slice(0, 4000),
    mode: 'auto',
    touches: 0,
    relayed_from: [...(e.relayed_from ?? []), from.agent_key],
    next_action_at: nowIso,
    stop_reason: null,
  };
}

// ---- the report -------------------------------------------------------------------------------

export type ActionRow = { agent_key: string; action: string; status: string; channel: string; record_kind: string | null; record_id: number | null; created_at: string };
export type AgentReport = {
  agent_key: string; texts: number; emails: number; calls: number; voicemails: number; replies: number; booked: number; handoffs: number; dnc: number;
  records_touched: number; failed: number; by_day: { day: string; touches: number }[];
};

/** Per-agent counts over the ledger rows given (the caller passes the window). */
export function aggregateActions(rows: ActionRow[], days: number, nowMs: number, tz = DEFAULT_TZ): AgentReport[] {
  const dayOf = (iso: string) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); } catch { return iso.slice(0, 10); } };
  const axis: string[] = [];
  for (let i = days - 1; i >= 0; i--) axis.push(dayOf(new Date(nowMs - i * 86_400_000).toISOString()));
  const by = new Map<string, AgentReport & { _rec: Set<string>; _days: Map<string, number> }>();
  for (const r of rows) {
    const e = by.get(r.agent_key) ?? { agent_key: r.agent_key, texts: 0, emails: 0, calls: 0, voicemails: 0, replies: 0, booked: 0, handoffs: 0, dnc: 0, records_touched: 0, failed: 0, by_day: [], _rec: new Set<string>(), _days: new Map<string, number>() };
    const done = r.status === 'done';
    if (done && r.action === 'sms_sent') e.texts++;
    if (done && r.action === 'email_sent') e.emails++;
    if (done && r.action === 'call_placed') e.calls++;
    if (done && r.action === 'rvm_sent') e.voicemails++;
    if (r.action === 'reply_seen') e.replies++;
    if (done && r.action === 'appointment_booked') e.booked++;
    if (done && (r.action === 'handoff' || r.action === 'relayed')) e.handoffs++;
    if (done && r.action === 'marked_dnc') e.dnc++;
    if (r.status === 'failed') e.failed++;
    if (done && ['sms_sent', 'email_sent', 'call_placed', 'rvm_sent'].includes(r.action)) {
      if (r.record_kind && r.record_id != null) e._rec.add(`${r.record_kind}:${r.record_id}`);
      const d = dayOf(r.created_at);
      e._days.set(d, (e._days.get(d) ?? 0) + 1);
    }
    by.set(r.agent_key, e);
  }
  return [...by.values()].map(({ _rec, _days, ...e }) => ({ ...e, records_touched: _rec.size, by_day: axis.map((day) => ({ day, touches: _days.get(day) ?? 0 })) }))
    .sort((a, b) => a.agent_key.localeCompare(b.agent_key));
}

/** A US number the way a rep dials it: (512) 555-0199. Anything else comes back as given. */
export function prettyPhone(v: string | null | undefined): string {
  const d = String(v ?? '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : String(v ?? '');
}
