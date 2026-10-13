// AI roleplay: the seller personas a rep practises on, the objection drills,
// the prompt that makes the model (ElevenLabs by voice, Claude by text) play
// the SELLER, and the grader that scores the session with the same scorecard
// and acquisitions framework real calls get (lib/call-coaching.ts,
// lib/sales-framework.ts), plus objection handling and a model answer for the
// hardest moment.
//
// Pure. Shared by the roleplay function and the Roleplay screen.

import {
  COACHING_SYSTEM, COACHING_TOOL, buildReview, cleanCoachingCopy, type CallCoachingReview,
} from './call-coaching.ts';

export type Persona = {
  id: string;
  label: string;
  /** One line for the picker. */
  blurb: string;
  /** The seller's first name, used in the opener and the scorecard. */
  name: string;
  /** Who they are, what happened, what they want. The model plays this. */
  brief: string;
  /** Facts the rep can uncover if they ask well. */
  facts: string;
  /** How they open when the rep calls. */
  opener: string;
};

export const PERSONAS: Persona[] = [
  {
    id: 'inheritor', label: 'Motivated inheritor', name: 'Donna',
    blurb: 'Inherited her late mother\'s house two states away. Wants it handled.',
    brief: 'You inherited your mother\'s three bedroom house eight months ago. You live four hours away. The house is full of her things, the yard is overgrown, and you are paying taxes and utilities on it. Your brother wants to keep it in the family but will not pay for anything. You feel guilty selling but you are exhausted.',
    facts: 'No mortgage. Roof is about 20 years old, the kitchen is original from 1978, there was a small leak under the bathroom sink. Taxes are about 3,100 a year. You think it is worth around 180,000 because a neighbour sold for that, but theirs was remodeled. You would be happy to walk away with 140,000 if it meant you never had to clean it out. Probate closed last month.',
    opener: 'Hello? Yes, this is Donna.',
  },
  {
    id: 'tired_landlord', label: 'Tired landlord, bad tenants', name: 'Rick',
    blurb: 'Two years of late rent and a tenant who will not leave.',
    brief: 'You own a rental duplex you bought fifteen years ago. One tenant is three months behind and you have started an eviction. The other unit is fine. You are 64 and done being a landlord. You are suspicious of investors who lowball.',
    facts: 'Mortgage payoff about 62,000. Rents are 950 and 1,050 when they pay. Water heater in unit B is leaking, the back porch is rotting. You want 210,000. You would take less if you never had to deal with the eviction yourself. Eviction court date is in five weeks.',
    opener: 'Yeah, Rick here. Who is this?',
  },
  {
    id: 'pre_foreclosure', label: 'Pre-foreclosure', name: 'Marcus',
    blurb: 'Behind on payments, auction date coming, embarrassed about it.',
    brief: 'You lost your job last year and fell five payments behind. The bank sent a notice of default and there is an auction date in about seven weeks. You are embarrassed and do not want to say it at first. You want to save your credit and walk away with something.',
    facts: 'Owe about 168,000 including arrears. House needs paint, carpet and a new HVAC. You think it is worth 240,000. Your wife does not know how bad it is yet. You found a new job two months ago but cannot catch up. Auction is on the 14th of next month.',
    opener: 'Hello. This is Marcus.',
  },
  {
    id: 'just_a_number', label: '"Just give me a number"', name: 'Gary',
    blurb: 'Busy, impatient, wants a price before answering anything.',
    brief: 'You are busy and you have had a dozen investors call. You want them to give you a number right now, and you push back on any question with "just tell me what you will pay". You do respond to someone confident who explains why they ask.',
    facts: 'Vacant three bedroom, two bath. Moved into your new place six months ago. Mortgage about 90,000. Needs a roof and the foundation has a crack you do not mention unless asked about repairs. You want 200,000. You would close fast for a fair number.',
    opener: 'Yeah. Look, I am busy, what are you paying for the house?',
  },
  {
    id: 'wants_retail', label: '"I want retail"', name: 'Linda',
    blurb: 'Read Zillow, wants full market value, mildly offended by cash offers.',
    brief: 'You checked Zillow and it says 310,000. You think investors are vultures. You are only talking because you need to move for your husband\'s job in three months and do not want showings with two dogs.',
    facts: 'Mortgage 140,000. Dated bathrooms, carpet needs replacing, roof is newer. The move date is firm. Showings with the dogs and kids would be a nightmare. You would consider a lower number for a fixed date and no showings, but you will not say that until the rep earns it.',
    opener: 'Hi, this is Linda. I hope this is not one of those lowball cash offers.',
  },
  {
    id: 'divorce', label: 'Divorced couple disagreeing', name: 'Tanya',
    blurb: 'Divorce settlement says sell. Her ex wants more and drags his feet.',
    brief: 'You and your ex husband have to sell the house as part of the divorce. You want it done fast and clean. He wants top dollar and keeps stalling. You need his signature too. You get emotional when the rep asks about the situation, and you test whether they will take sides.',
    facts: 'Mortgage 120,000. Both names on the title. The decree says sell within 90 days, 60 are left. Your ex thinks it is worth 280,000, you think 240,000 is fine. Basement had water last spring. You want the rep to talk to both of you together.',
    opener: 'This is Tanya. If this is about the house, I need to tell you it is complicated.',
  },
  {
    id: 'hostile', label: 'Hostile and skeptical', name: 'Frank',
    blurb: 'Thinks this is a scam. Sharp, interrupts, tests the rep.',
    brief: 'You did not ask for this call, or you forgot you filled out a form. You think this is a scam. You are sharp, you interrupt, and you ask how they got your number and who they are. You do actually have a house you need to sell, but you only open up if the rep stays calm and earns it.',
    facts: 'Your mother moved to assisted living and her house sits empty. It needs everything. No mortgage. You need money for her care, about 4,000 a month. You would want around 150,000.',
    opener: 'Who is this and how did you get this number?',
  },
  {
    id: 'engineer', label: 'Analytical engineer', name: 'Priya',
    blurb: 'Wants the math. Asks how you calculate offers, compares three investors.',
    brief: 'You are an engineer. You are methodical and want to understand exactly how the offer is calculated, ARV, repair estimates, the investor margin. You have two other offers and a spreadsheet. You respect transparency and process and dislike pressure.',
    facts: 'Relocating for work in four months. Mortgage 210,000. Other offers are 265,000 (a hedge fund, with inspection contingency) and 250,000 (local investor, cash, 14 day close). Foundation report from last year shows minor settling. You want certainty of close more than the last dollar, but you will not say so until asked how you decide.',
    opener: 'Hi, Priya speaking. Before we start, can you tell me how your company calculates its offers?',
  },
];

export const DIFFICULTIES = [
  { id: 'easy', label: 'Easy', rule: 'You are fairly open. You answer most questions, you warm up quickly to a polite rep, and you raise one mild objection.' },
  { id: 'medium', label: 'Medium', rule: 'You are guarded. You give short answers until the rep asks good follow-ups, and you raise two real objections and hold them until they are handled well.' },
  { id: 'hard', label: 'Hard', rule: 'You are tough. You dodge, deflect and push back. You raise three objections, repeat the strongest one, and only agree to a next step if the rep has earned your trust and isolated your real concern.' },
] as const;
export type DifficultyId = (typeof DIFFICULTIES)[number]['id'];

export const OBJECTIONS = [
  { id: 'too_low', label: 'Your offer is too low', line: 'When a number comes up, push back hard that it is too low and insulting.' },
  { id: 'spouse', label: 'I need to talk to my spouse', line: 'When asked to decide, say you need to talk to your spouse first. Only move if the rep finds out what the spouse would care about or offers to include them.' },
  { id: 'other_investor', label: 'Another investor offered more', line: 'Say another investor offered more, and hold it until the rep asks how you would decide between close offers.' },
  { id: 'realtor', label: 'Why not list with a realtor?', line: 'Say you are thinking of just listing it with a realtor for more money.' },
  { id: 'think_about_it', label: 'I need to think about it', line: 'At the decision point, say you need to think about it. Only move if the rep isolates what you are unsure about.' },
  { id: 'not_in_a_hurry', label: 'I\'m not in a hurry', line: 'Say you are not in any hurry and might wait a year.' },
] as const;
export type ObjectionId = (typeof OBJECTIONS)[number]['id'];

export const personaById = (id: string) => PERSONAS.find((p) => p.id === id) ?? null;
export const difficultyById = (id: string) => DIFFICULTIES.find((d) => d.id === id) ?? null;
export const objectionById = (id: string | null | undefined) => OBJECTIONS.find((o) => o.id === id) ?? null;

/** The system prompt that makes the model the seller. One for voice (ElevenLabs) and text (Claude). */
export function sellerPrompt(opts: { persona: Persona; difficulty: DifficultyId; objection?: ObjectionId | null; company?: string | null; voice?: boolean }): string {
  const d = difficultyById(opts.difficulty) ?? DIFFICULTIES[1];
  const o = objectionById(opts.objection);
  return [
    `You are ${opts.persona.name}, a homeowner. An acquisitions rep${opts.company ? ` from ${opts.company}` : ''}, a company that buys houses directly for cash, is calling you. This is a sales practice roleplay: you play the SELLER, never the rep, and you never break character, coach, or mention that this is practice.`,
    `Who you are: ${opts.persona.brief}`,
    `What you know, revealed only when the rep asks the right question: ${opts.persona.facts}`,
    `How hard to be: ${d.rule}`,
    o ? `Objection drill: ${o.line}` : '',
    'Rules: talk like a real person on the phone. Short turns, one to three sentences, plain words. Do not volunteer your motivation, your bottom line or the hidden facts. Reward good questions (why now, what happens if nothing changes, how did you get to that number) with more honest answers. If the rep is pushy, interrupts or talks at you, get shorter and colder. If the rep makes a fair offer inside what you would accept and has earned trust, you may agree to a next step or to receive an agreement. If the rep is rude or wastes your time, end it.',
    opts.voice ? 'You are speaking out loud. No lists, no stage directions, no emojis.' : 'Reply with only what you say, no stage directions, no quotes, no names before the line.',
  ].filter(Boolean).join('\n\n');
}

// ---- transcript -----------------------------------------------------------------

export type RoleplayLine = { role: 'rep' | 'seller'; text: string; at_s?: number | null };

export function parseLines(raw: unknown, max = 200): RoleplayLine[] {
  if (!Array.isArray(raw)) return [];
  const out: RoleplayLine[] = [];
  for (const r of raw) {
    if (out.length >= max) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const role = o.role === 'rep' || o.role === 'user' ? 'rep' : o.role === 'seller' || o.role === 'agent' ? 'seller' : null;
    const text = String(o.text ?? o.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!role || !text) continue;
    const at = Number(o.at_s ?? o.time_in_call_secs);
    out.push({ role, text, at_s: Number.isFinite(at) && at >= 0 ? Math.floor(at) : null });
  }
  return out;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "Rep: …\nSeller: …" for the scorecard, with "[m:ss]" when times are known. */
export function transcriptText(lines: RoleplayLine[], names: { rep: string; seller: string }, withTimes = false): string {
  return lines.map((l) => `${withTimes && l.at_s != null ? `[${clock(l.at_s)}] ` : ''}${l.role === 'rep' ? names.rep : names.seller}: ${l.text}`).join('\n');
}

/** Words each side said, as the rep's share 0 to 100. Null when one side said nothing. */
export function talkRatio(lines: RoleplayLine[]): { rep: number; seller: number } | null {
  let rep = 0;
  let seller = 0;
  for (const l of lines) {
    const n = l.text.split(/\s+/).filter(Boolean).length;
    if (l.role === 'rep') rep += n; else seller += n;
  }
  if (!rep || !seller) return null;
  const r = Math.round((rep / (rep + seller)) * 100);
  return { rep: r, seller: 100 - r };
}

/** Enough said to grade: three turns from the rep and something back. */
export function gradable(lines: RoleplayLine[]): boolean {
  const rep = lines.filter((l) => l.role === 'rep');
  return rep.length >= 3 && lines.some((l) => l.role === 'seller') && rep.reduce((n, l) => n + l.text.split(/\s+/).length, 0) >= 25;
}

// ---- grading -------------------------------------------------------------------

export const ROLEPLAY_GRADER_EXTRA = `This was a practice roleplay: the prospect was an AI playing a seller. Grade the rep exactly as you would a real call.

Also return:
objection: how well the rep handled the main objection, 0 to 10, and one sentence why. When no objection came up, score what the rep did with the seller's pushback.
hardest_moment: the moment the rep struggled most. quote is what the seller said right then, copied. model_answer is what a top rep would say back, one to three sentences, in a natural voice.`;

export const ROLEPLAY_TOOL = {
  ...COACHING_TOOL,
  name: 'roleplay_scorecard',
  description: 'Feedback for one practice roleplay.',
  input_schema: {
    ...COACHING_TOOL.input_schema,
    properties: {
      ...COACHING_TOOL.input_schema.properties,
      objection: {
        type: 'object',
        properties: { score: { type: 'integer', minimum: 0, maximum: 10 }, note: { type: 'string' } },
        required: ['score', 'note'],
      },
      hardest_moment: {
        type: 'object',
        properties: { quote: { type: 'string' }, model_answer: { type: 'string' } },
        required: ['quote', 'model_answer'],
      },
    },
    required: [...COACHING_TOOL.input_schema.required, 'objection', 'hardest_moment'],
  },
} as const;

export const ROLEPLAY_SYSTEM = COACHING_SYSTEM + '\n\n' + ROLEPLAY_GRADER_EXTRA;

export type RoleplayFeedback = CallCoachingReview & {
  objection: { score: number; note: string } | null;
  hardest_moment: { quote: string; model_answer: string } | null;
};

export function buildRoleplayFeedback(raw: unknown, ctx: { repName: string; sellerName: string; lines: RoleplayLine[] }):
  { ok: true; feedback: Omit<RoleplayFeedback, 'model' | 'source' | 'scored_at'> } | { ok: false; error: string } {
  const t = talkRatio(ctx.lines);
  const built = buildReview(raw, {
    repName: ctx.repName, prospectName: ctx.sellerName, talk: t ? { rep: t.rep, prospect: t.seller } : null, sellerCall: true,
  });
  if (!built.ok) return built;
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ob = body.objection && typeof body.objection === 'object' ? body.objection as Record<string, unknown> : null;
  const hm = body.hardest_moment && typeof body.hardest_moment === 'object' ? body.hardest_moment as Record<string, unknown> : null;
  const obScore = Number(ob?.score);
  const objection = ob && Number.isFinite(obScore)
    ? { score: Math.max(0, Math.min(10, Math.round(obScore))), note: cleanCoachingCopy(String(ob.note ?? '')).slice(0, 280) }
    : null;
  const answer = hm ? cleanCoachingCopy(String(hm.model_answer ?? '')).slice(0, 500) : '';
  const hardest = hm && answer ? { quote: String(hm.quote ?? '').replace(/\s+/g, ' ').trim().slice(0, 280), model_answer: answer } : null;
  // A roleplay is practice: no missed-deal flags on the rep's record.
  const rest = { ...built.review };
  delete rest.flags;
  delete rest.flag_ids;
  return { ok: true, feedback: { ...rest, objection, hardest_moment: hardest } };
}

export function isRoleplayFeedback(raw: unknown): raw is RoleplayFeedback {
  return !!raw && typeof raw === 'object' && (raw as { status?: string }).status === 'completed' && typeof (raw as { overall?: unknown }).overall === 'number';
}

/** Practice trend: the scores oldest to newest, and the change from the first half to the second. */
export function scoreTrend(scores: { at: string; score: number | null }[]): { points: number[]; delta: number | null } {
  const points = [...scores].filter((s) => typeof s.score === 'number').sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((s) => s.score as number);
  if (points.length < 2) return { points, delta: null };
  const half = Math.floor(points.length / 2);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { points, delta: Math.round(avg(points.slice(half)) - avg(points.slice(0, half))) };
}

// ---- the ElevenLabs roleplay agent -------------------------------------------------

/**
 * One ElevenLabs agent per workspace plays every persona: its prompt and its
 * opener are dynamic variables the browser fills per session, so a new
 * persona never needs a publish. Signed URLs only (auth on), like the AI Agent.
 */
export const ROLEPLAY_AGENT_VARIABLES = {
  persona_prompt: 'You are a homeowner who might sell your house. Play the seller.',
  first_message: 'Hello?',
} as const;

/** What the phone line needs so it answers as the armed persona and reports back: voice-agent's own webhooks. */
export type RoleplayWiring = { personalizeUrl: string; secretHeader: string; personalizeSecret: string; webhookId: string | null };

export function roleplayAgentBody(opts: { company?: string | null; voiceId?: string | null; wiring?: RoleplayWiring | null }) {
  const w = opts.wiring ?? null;
  return {
    name: `${opts.company || 'CLOZR'} roleplay seller`.slice(0, 100),
    tags: ['clozr', 'roleplay'],
    conversation_config: {
      agent: {
        first_message: '{{first_message}}',
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: ROLEPLAY_AGENT_VARIABLES },
        prompt: { prompt: '{{persona_prompt}}', built_in_tools: { end_call: { type: 'system', name: 'end_call', params: { system_tool_type: 'end_call' } } } },
      },
      tts: { model_id: 'eleven_flash_v2_5', ...(opts.voiceId ? { voice_id: opts.voiceId } : {}) },
      conversation: { max_duration_seconds: 900 },
      turn: { turn_eagerness: 'normal', silence_end_call_timeout: 30 },
    },
    platform_settings: {
      auth: { enable_auth: true },
      // A phone call has no browser to send the persona: the initiation webhook does (voice-agent /personalize).
      ...(w ? {
        overrides: {
          enable_conversation_initiation_client_data_from_webhook: true,
          conversation_config_override: { agent: { first_message: true } },
        },
        workspace_overrides: {
          conversation_initiation_client_data_webhook: { url: w.personalizeUrl, request_headers: { [w.secretHeader]: w.personalizeSecret } },
          ...(w.webhookId ? { webhooks: { post_call_webhook_id: w.webhookId, events: ['transcript'], transcript_format: 'json' } } : {}),
        },
      } : {}),
    },
  };
}

// ---- the roleplay phone line ----------------------------------------------------------

/** An armed session waits this long for the rep to call the line. */
export const ARM_TTL_MINUTES = 30;

export type ArmedCandidate = { id: number; status: string; mode: string; started_at: string };

/** The rep's most recent armed phone session still inside the window. */
export function pickArmedSession<T extends ArmedCandidate>(sessions: T[], now = Date.now()): T | null {
  const live = sessions.filter((s) => s.status === 'armed' && s.mode === 'phone'
    && now - Date.parse(s.started_at) <= ARM_TTL_MINUTES * 60_000 && Date.parse(s.started_at) <= now + 60_000);
  return live.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] ?? null;
}

/** ElevenLabs' conversation_initiation_client_data for the line. */
export function phoneInitiation(prompt: string, opener: string) {
  return {
    type: 'conversation_initiation_client_data',
    dynamic_variables: { persona_prompt: prompt, first_message: opener },
    conversation_config_override: { agent: { first_message: opener } },
  };
}

/** What the line says when it cannot run a roleplay: the caller is not a rep we know, or nothing is armed. */
export function lineNotice(kind: 'unknown_caller' | 'not_armed') {
  const say = kind === 'unknown_caller'
    ? 'This is the CLOZR roleplay line. I do not recognise this number. Add your cell phone to your CLOZR profile, pick a scenario under Coaching, then call back.'
    : 'This is the CLOZR roleplay line. You have no scenario armed. In CLOZR, open Coaching, then Roleplay, pick a seller and choose Call the roleplay line, then call back within thirty minutes.';
  return phoneInitiation(`You answer the CLOZR roleplay phone line. Say exactly this, then end the call: ${say}`, say);
}

/** ElevenLabs' stored conversation transcript ({ role: user|agent, message, time_in_call_secs }) as roleplay lines. */
export function linesFromElevenLabs(raw: unknown): RoleplayLine[] {
  const t = raw && typeof raw === 'object' ? (raw as { transcript?: unknown }).transcript : null;
  return parseLines(Array.isArray(t) ? t.filter((x) => x && typeof (x as { message?: unknown }).message === 'string') : []);
}
