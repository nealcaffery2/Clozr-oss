// The AI Sales Manager's grading frame: the acquisitions call flow every rep
// call (and every roleplay) is checked against, the "missed deal" flags, and
// the timestamped coaching insights.
//
// The stages are the acquisitions template's call flow
// (supabase/functions/_shared/voice-agent-templates.ts, ACQUISITIONS_SECTIONS):
// the same script the AI acquisitions agent follows is the one the humans are
// graded on. The model only reports what it heard (a status per stage and a
// handful of yes/no signals); the flags are decided here, by rule, so a flag
// means the same thing on every call and can be tested.
//
// Pure, no imports: lib/call-coaching.ts (browser + Deno) and
// lib/sales-scorecard.ts build on it.

export const FRAMEWORK_STAGES = [
  { id: 'intro', short: 'Intro', label: 'Intro and intent', hint: 'Said who they are and why, confirmed the seller still wants to sell.' },
  { id: 'price_discovery', short: 'Price ask', label: 'Price discovery', hint: 'Asked what price the seller wants, or a range when they dodged.' },
  { id: 'motivation', short: 'Motivation', label: 'Motivation and peeling the onion', hint: 'Asked why sell now, then dug: how long, what it is like, what happens if nothing changes.' },
  { id: 'reverse_sell', short: 'Reverse sell', label: 'Reverse selling', hint: 'Asked why not just list with a realtor, and framed speed, simplicity and certainty.' },
  { id: 'logistics', short: 'Logistics', label: 'Logistics', hint: 'Occupancy: living in it, vacant or rented, tenants and lease.' },
  { id: 'timeline', short: 'Timeline', label: 'Timeline', hint: 'Ideal timeframe, and whether they can move forward today.' },
  { id: 'property_payoff', short: 'Property & payoff', label: 'Property and payoff', hint: 'Beds, baths, repairs, mortgage payoff, and what they want to walk away with.' },
  { id: 'relationship_frame', short: 'Frame', label: 'Relationship frame', hint: 'Set the company promises: certainty, no fees or repairs, no retrading after contract.' },
  { id: 'price_anchor', short: 'Anchor', label: 'Loop back to price and anchor', hint: 'Asked how they got their number, then the best price for cash, as-is, on their timeline.' },
  { id: 'other_offers', short: 'Other offers', label: 'Other offers and decision frame', hint: 'Handled other offers and asked how they would choose between close numbers.' },
  { id: 'commitment', short: 'Commitment', label: 'Final commitment', hint: 'What a perfect buyer looks like, and whether they can wrap up today if the number is close.' },
  { id: 'close', short: 'Close', label: 'Future-framed close', hint: 'Made the offer inside the range, then stopped talking; or set a firm next step.' },
  { id: 'contract_review', short: 'Contract', label: 'Contract review', hint: 'Sent the agreement and walked them through price, name and closing date.' },
] as const;

export type StageId = (typeof FRAMEWORK_STAGES)[number]['id'];
export const STAGE_IDS: StageId[] = FRAMEWORK_STAGES.map((s) => s.id);
/** hit: done well. partial: started, not finished. miss: the call needed it and it did not happen. na: the call never got there for a fair reason. */
export type StageStatus = 'hit' | 'partial' | 'miss' | 'na';
export const STAGE_STATUSES: StageStatus[] = ['hit', 'partial', 'miss', 'na'];

/** What the model heard. Facts about the call, never judgements: the flags below do the judging. */
export type CallSignals = {
  /** Wrong number, not the owner, not selling at all, a buyer: nothing to flag. */
  not_a_seller: boolean;
  /** The seller gave a real reason to sell (a problem, a deadline, a pain). */
  seller_motivated: boolean;
  /** The rep asked what price the seller wants. */
  rep_asked_price: boolean;
  /** The seller said a number or a range. */
  seller_gave_price: boolean;
  /** The seller's number looked workable for a cash offer. Null when no number came up. */
  price_workable: boolean | null;
  /** An appointment was booked, an offer accepted, or an agreement sent. */
  appointment_or_agreement: boolean;
  /** A specific next step: a time, a person, and what happens. */
  next_step_set: boolean;
  /** How many times the rep cut the seller off mid-sentence. */
  rep_interruptions: number;
};

export type CallFramework = {
  version: 1;
  stages: Record<StageId, StageStatus>;
  /** 0 to 100: hit counts 1, partial a half, over the stages that were not na. Null when every stage was na. */
  hit_rate: number | null;
  signals: CallSignals;
};

export type CoachingInsight = {
  title: string;
  /** The words from the call this is about, copied. */
  quote: string;
  /** Seconds into the call, when the transcript had times. */
  at_s: number | null;
  /** What to do or say instead. */
  tip: string;
};

export const FLAG_DEFS = [
  { id: 'motivated_no_close', label: 'Motivated seller, no appointment', severity: 'high', hint: 'The seller gave a reason to sell and a workable number, and the call ended without an appointment or an agreement.' },
  { id: 'never_asked_price', label: 'Never asked price', severity: 'medium', hint: 'No price came up: the rep never asked what the seller wants.' },
  { id: 'no_next_step', label: 'No next step', severity: 'medium', hint: 'The call ended without a time, a person and what happens next.' },
  { id: 'talked_over', label: 'Talked over the seller', severity: 'low', hint: 'The rep interrupted three or more times, or did two thirds of the talking.' },
  { id: 'skipped_motivation', label: 'Skipped motivation', severity: 'low', hint: 'The rep never asked why the seller wants to sell.' },
] as const;

export type FlagId = (typeof FLAG_DEFS)[number]['id'];
export const FLAG_IDS: FlagId[] = FLAG_DEFS.map((f) => f.id);
export type FlagSeverity = 'high' | 'medium' | 'low';
export const flagLabel = (id: string): string => FLAG_DEFS.find((f) => f.id === id)?.label ?? id.replace(/_/g, ' ');

/** A call under this is not flagged: too short to have missed a deal. */
export const FLAG_MIN_SECONDS = 60;
export const TALK_OVER_INTERRUPTIONS = 3;
export const TALK_OVER_REP_SHARE = 65;

// ---- the model's half ------------------------------------------------------------

/** JSON schema properties the scorecard tool adds. Shared by the call scorecard and the roleplay grader. */
export const FRAMEWORK_TOOL_PROPERTIES = {
  stages: {
    type: 'object',
    description: 'Each acquisitions call stage: hit, partial, miss, or na when the call fairly never got there.',
    properties: Object.fromEntries(FRAMEWORK_STAGES.map((s) => [s.id, { type: 'string', enum: STAGE_STATUSES }])),
    required: STAGE_IDS,
  },
  signals: {
    type: 'object',
    properties: {
      not_a_seller: { type: 'boolean' },
      seller_motivated: { type: 'boolean' },
      rep_asked_price: { type: 'boolean' },
      seller_gave_price: { type: 'boolean' },
      price_workable: { type: ['boolean', 'null'] },
      appointment_or_agreement: { type: 'boolean' },
      next_step_set: { type: 'boolean' },
      rep_interruptions: { type: 'integer', minimum: 0 },
    },
    required: ['not_a_seller', 'seller_motivated', 'rep_asked_price', 'seller_gave_price', 'appointment_or_agreement', 'next_step_set', 'rep_interruptions'],
  },
  insights: {
    type: 'array',
    minItems: 2,
    maxItems: 3,
    description: 'The 2 or 3 moments that mattered most, each with the words said and the time.',
    items: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Four to eight words.' },
        quote: { type: 'string', description: 'Copied from the transcript.' },
        at: { type: 'string', description: 'The m:ss time of the quoted line, from the transcript. Empty when there are no times.' },
        tip: { type: 'string', description: 'One sentence: what to do or say instead.' },
      },
      required: ['title', 'quote', 'tip'],
    },
  },
} as const;

/** The prompt half that teaches the stages and signals. Appended to the scorecard system prompt. */
export const FRAMEWORK_PROMPT = `Also grade the call against the acquisitions call flow, in this order:
${FRAMEWORK_STAGES.map((s, i) => `${i + 1}. ${s.id}, ${s.label}. ${s.hint}`).join('\n')}

stages: for each one, hit when it was done well, partial when it was started and dropped, miss when the call needed it and it did not happen, na when the call fairly never got that far (the seller hung up, was not selling, or it was a short follow-up about one thing). Do not mark a stage hit because the seller volunteered it.

signals: facts only.
- not_a_seller: wrong number, not the owner, not selling at all, or not a seller call.
- seller_motivated: the seller gave a real reason to sell.
- rep_asked_price: the rep asked the seller's price or range.
- seller_gave_price: the seller said a number or range.
- price_workable: true when their number looked workable for a cash offer, false when it was clearly retail or above, null when no number came up.
- appointment_or_agreement: an appointment booked, an offer accepted, or an agreement sent.
- next_step_set: a specific time and what happens then.
- rep_interruptions: how many times the rep cut the seller off.

insights: the 2 or 3 moments that mattered most. Quote the words, give the m:ss time from the transcript line when it has one, and one sentence on what to do instead.`;

const clean = (v: unknown, cap: number): string => String(typeof v === 'string' ? v : '')
  .replace(/[—–]/g, ', ').replace(/\s+/g, ' ').trim().slice(0, cap);

/** "m:ss", "h:mm:ss", a number of seconds, or "[12] 3:04": seconds, or null. */
export function parseClock(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(raw ?? ''));
  if (!m) {
    const n = Number(String(raw ?? '').trim());
    return String(raw ?? '').trim() && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'yes';

export function stageHitRate(stages: Partial<Record<StageId, StageStatus>>): number | null {
  let got = 0;
  let of = 0;
  for (const id of STAGE_IDS) {
    const s = stages[id];
    if (!s || s === 'na') continue;
    of++;
    if (s === 'hit') got += 1;
    else if (s === 'partial') got += 0.5;
  }
  return of ? Math.round((got / of) * 100) : null;
}

/** The model's stages + signals, normalised. Null when the stages are missing (an old scorecard, or a slip). */
export function parseFramework(raw: unknown): CallFramework | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const st = body.stages && typeof body.stages === 'object' ? body.stages as Record<string, unknown> : null;
  if (!st) return null;
  const stages = {} as Record<StageId, StageStatus>;
  let seen = 0;
  for (const id of STAGE_IDS) {
    const v = String(st[id] ?? '').trim().toLowerCase();
    const s: StageStatus = v === 'hit' || v === 'pass' || v === 'yes' ? 'hit' : v === 'partial' ? 'partial' : v === 'miss' || v === 'missed' || v === 'no' ? 'miss' : 'na';
    if (st[id] !== undefined) seen++;
    stages[id] = s;
  }
  if (seen < Math.ceil(STAGE_IDS.length / 2)) return null;
  const sg = body.signals && typeof body.signals === 'object' ? body.signals as Record<string, unknown> : {};
  const pw = sg.price_workable;
  const n = Number(sg.rep_interruptions);
  const signals: CallSignals = {
    not_a_seller: bool(sg.not_a_seller),
    seller_motivated: bool(sg.seller_motivated),
    rep_asked_price: bool(sg.rep_asked_price),
    seller_gave_price: bool(sg.seller_gave_price),
    price_workable: pw === null || pw === undefined || pw === '' ? null : bool(pw),
    appointment_or_agreement: bool(sg.appointment_or_agreement),
    next_step_set: bool(sg.next_step_set),
    rep_interruptions: Number.isFinite(n) && n > 0 ? Math.min(99, Math.round(n)) : 0,
  };
  return { version: 1, stages, hit_rate: stageHitRate(stages), signals };
}

export function parseInsights(raw: unknown, max = 3): CoachingInsight[] {
  if (!Array.isArray(raw)) return [];
  const out: CoachingInsight[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = clean(r.title, 80);
    const tip = clean(r.tip, 240);
    if (!title || !tip) continue;
    out.push({ title, quote: clean(r.quote, 280).replace(/^["“]|["”]$/g, ''), at_s: parseClock(r.at ?? r.at_s), tip });
  }
  return out;
}

// ---- the rules' half -----------------------------------------------------------------

export type CallFlag = { id: FlagId; label: string; severity: FlagSeverity };

/**
 * The missed-deal flags for one graded call. Nothing on a call under a minute,
 * a non-seller call, or a call whose stages could not be read.
 */
export function missedDealFlags(
  fw: CallFramework | null,
  ctx: { durationS?: number | null; repTalk?: number | null; sellerCall?: boolean },
): CallFlag[] {
  if (!fw || fw.signals.not_a_seller || ctx.sellerCall === false) return [];
  if (ctx.durationS != null && ctx.durationS < FLAG_MIN_SECONDS) return [];
  const s = fw.signals;
  const on = new Set<FlagId>();
  if (s.seller_motivated && s.price_workable === true && !s.appointment_or_agreement) on.add('motivated_no_close');
  if (!s.rep_asked_price && !s.seller_gave_price) on.add('never_asked_price');
  if (!s.next_step_set && !s.appointment_or_agreement) on.add('no_next_step');
  if (s.rep_interruptions >= TALK_OVER_INTERRUPTIONS || (ctx.repTalk != null && ctx.repTalk >= TALK_OVER_REP_SHARE)) on.add('talked_over');
  if (fw.stages.motivation === 'miss' && !s.seller_motivated) on.add('skipped_motivation');
  return FLAG_DEFS.filter((f) => on.has(f.id)).map((f) => ({ id: f.id, label: f.label, severity: f.severity }));
}

export const SEVERITY_RANK: Record<FlagSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Reads flag ids back off a stored review, tolerating anything. */
export function flagIdsOf(review: unknown): FlagId[] {
  if (!review || typeof review !== 'object') return [];
  const ids = (review as { flag_ids?: unknown }).flag_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((x): x is FlagId => typeof x === 'string' && (FLAG_IDS as string[]).includes(x));
}

export function frameworkOf(review: unknown): CallFramework | null {
  if (!review || typeof review !== 'object') return null;
  const fw = (review as { framework?: unknown }).framework;
  if (!fw || typeof fw !== 'object') return null;
  const f = fw as CallFramework;
  return f.version === 1 && f.stages && typeof f.stages === 'object' ? f : null;
}

// ---- the four review sections -----------------------------------------------------
//
// Every review reads as four named sections, plus the overall score:
//   Identify Hidden Objections          objections the rep missed or glossed over
//   See Missed Closing Opportunities    the moments a close was possible and not tried
//   See Areas of Improvement            strengths, gaps, and actionable steps
//   Understand Emotional Engagement     tone, energy, cues, and where it was won or lost

export const REVIEW_SECTION_TITLES = {
  hidden_objections: 'Identify Hidden Objections',
  missed_closes: 'See Missed Closing Opportunities',
  improvement: 'See Areas of Improvement',
  emotional: 'Understand Emotional Engagement',
} as const;

export type HiddenObjection = { objection: string; quote: string; at_s: number | null; handle: string };
export type MissedClose = { quote: string; at_s: number | null; say: string };
export type EmotionalTurn = { quote: string; at_s: number | null; outcome: 'won' | 'lost' | 'neutral'; why: string };
export type ReviewSections = {
  hidden_objections: HiddenObjection[];
  missed_closes: MissedClose[];
  improvement: { strengths: string[]; gaps: string[]; steps: string[] };
  emotional: { summary: string; tone: string; energy: 'low' | 'medium' | 'high' | null; turning_points: EmotionalTurn[] };
};

const moment = { quote: { type: 'string', description: 'Copied from the transcript.' }, at: { type: 'string', description: 'm:ss of that line, empty when there are no times.' } };

export const SECTIONS_TOOL_PROPERTY = {
  sections: {
    type: 'object',
    description: 'The four review sections.',
    properties: {
      hidden_objections: {
        type: 'array', maxItems: 3,
        items: { type: 'object', properties: { objection: { type: 'string' }, ...moment, handle: { type: 'string', description: 'How to surface and handle it next time.' } }, required: ['objection', 'quote', 'handle'] },
      },
      missed_closes: {
        type: 'array', maxItems: 3,
        items: { type: 'object', properties: { ...moment, say: { type: 'string', description: 'The close to try right there.' } }, required: ['quote', 'say'] },
      },
      improvement: {
        type: 'object',
        properties: {
          strengths: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          gaps: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, description: 'Actionable steps for the next call.' },
        },
        required: ['strengths', 'gaps', 'steps'],
      },
      emotional: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Two or three sentences on the emotional arc.' },
          tone: { type: 'string', description: 'A few words on the rep tone, e.g. calm and warm, rushed, flat.' },
          energy: { type: 'string', enum: ['low', 'medium', 'high'] },
          turning_points: {
            type: 'array', maxItems: 3,
            items: { type: 'object', properties: { ...moment, outcome: { type: 'string', enum: ['won', 'lost', 'neutral'] }, why: { type: 'string' } }, required: ['quote', 'outcome', 'why'] },
          },
        },
        required: ['summary', 'tone', 'energy', 'turning_points'],
      },
    },
    required: ['hidden_objections', 'missed_closes', 'improvement', 'emotional'],
  },
} as const;

export const SECTIONS_PROMPT = `sections: the review in four parts.
- hidden_objections (${REVIEW_SECTION_TITLES.hidden_objections}): objections the seller raised or hinted at that the rep missed, glossed over, or answered without isolating. The objection in a few words, the quote and time, and how to surface and handle it. Empty when there were none.
- missed_closes (${REVIEW_SECTION_TITLES.missed_closes}): the exact moments a close or a firm next step was possible and the rep did not ask. Quote, time, and the close to try right there. Empty when the rep asked every time.
- improvement (${REVIEW_SECTION_TITLES.improvement}): up to three strengths, up to three gaps, and one to three actionable steps for the next call.
- emotional (${REVIEW_SECTION_TITLES.emotional}): the rep's tone and energy, the seller's emotional cues, and the turning points where the deal was won or lost emotionally, each with the quote, time and why.`;

const lineList = (v: unknown, max: number, cap = 240): string[] =>
  (Array.isArray(v) ? v : []).map((x) => clean(x, cap)).filter(Boolean).slice(0, max);
const unquote = (v: unknown) => clean(v, 280).replace(/^["“]|["”]$/g, '');

/** The model's four sections, normalised. Null when absent (older reviews). */
export function parseReviewSections(raw: unknown): ReviewSections | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!('hidden_objections' in s) && !('missed_closes' in s) && !('improvement' in s) && !('emotional' in s)) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] : []);
  const hidden = arr(s.hidden_objections).map((o) => ({
    objection: clean(o.objection, 120), quote: unquote(o.quote), at_s: parseClock(o.at ?? o.at_s), handle: clean(o.handle, 280),
  })).filter((o) => o.objection && o.handle).slice(0, 3);
  const closes = arr(s.missed_closes).map((o) => ({ quote: unquote(o.quote), at_s: parseClock(o.at ?? o.at_s), say: clean(o.say, 280) }))
    .filter((o) => o.say).slice(0, 3);
  const imp = (s.improvement && typeof s.improvement === 'object' ? s.improvement : {}) as Record<string, unknown>;
  const emo = (s.emotional && typeof s.emotional === 'object' ? s.emotional : {}) as Record<string, unknown>;
  const energy = emo.energy === 'low' || emo.energy === 'medium' || emo.energy === 'high' ? emo.energy : null;
  const turns = arr(emo.turning_points).map((t) => ({
    quote: unquote(t.quote), at_s: parseClock(t.at ?? t.at_s),
    outcome: (t.outcome === 'won' || t.outcome === 'lost' ? t.outcome : 'neutral') as EmotionalTurn['outcome'], why: clean(t.why, 240),
  })).filter((t) => t.why).slice(0, 3);
  return {
    hidden_objections: hidden,
    missed_closes: closes,
    improvement: { strengths: lineList(imp.strengths, 3), gaps: lineList(imp.gaps, 3), steps: lineList(imp.steps, 3) },
    emotional: { summary: clean(emo.summary, 600), tone: clean(emo.tone, 80), energy, turning_points: turns },
  };
}

export function sectionsOf(review: unknown): ReviewSections | null {
  if (!review || typeof review !== 'object') return null;
  const s = (review as { sections?: unknown }).sections;
  return s && typeof s === 'object' ? (s as ReviewSections) : null;
}

// ---- call scoring types (Submit a call for review) ----------------------------------

export const CALL_TYPES = [
  { id: 'seller_acquisitions', label: 'Seller acquisitions call', seller: true, prompt: 'Call type: a seller acquisitions call. Grade every stage.' },
  { id: 'seller_follow_up', label: 'Seller follow-up call', seller: true, prompt: 'Call type: a follow-up with a seller the rep has spoken to before. Stages plainly covered on an earlier call are na, not miss; the price anchor, commitment and close still count.' },
  { id: 'buyer_dispositions', label: 'Dispositions / buyer call', seller: false, prompt: 'Call type: a dispositions call with a cash buyer, not a seller. Mark the seller stages na unless they truly apply, set not_a_seller true, and grade the ten categories on how the rep qualified the buyer and moved the deal.' },
] as const;
export type CallTypeId = (typeof CALL_TYPES)[number]['id'];
export const callTypeById = (id: unknown) => CALL_TYPES.find((c) => c.id === id) ?? null;
