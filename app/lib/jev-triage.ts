// Jev (TypeSafe System One) lead triage — schema, state, stub, and mapping.
//
// Jev is a decision model, not a chat model: one `state` plus typed questions
// (`choice`, `noul`, `score`) come back as structured answers with probabilities
// and confidence. This module is the CLOZR-side contract. Nothing here writes
// a seller, a stage, or a task — the playground and the evaluate function both
// stop at a suggestion. Wiring ingest or the Home queue is a later PR.
//
// Canonical endpoint (later, behind TYPESAFE_API_KEY):
//   POST https://api.typesafe.ai/v1/systemone
//   { model: 'jev-latest', state, questions: TRIAGE_QUESTIONS }
// Cloudflare Workers AI exposes the same body as model `typesafe/jev`; CLOZR
// does not have a Workers AI binding, so the native TypeSafe API is the path.

import { CLOZR_DATA } from './clozr-data';
import type { Person } from './clozr-types';
import { sellerStageGroup, type SellerStageGroup } from './stages';

export const JEV_MODEL = 'jev-latest';
export const JEV_MODEL_PIN = 'jev-1.13.0';

export const DISPOSITIONS = ['pursue', 'nurture', 'skip'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const NEXT_ACTIONS = ['call_now', 'follow_up', 'underwrite', 'nurture_sequence', 'close_out'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** Loose input: a live Person, a mock Person, or a thin ingest-shaped row. */
export type LeadTriageInput = {
  name?: string | null;
  stage?: string | null;
  source?: string | null;
  tags?: string[] | null;
  assigned?: string | null;
  motivation?: string | null;
  asking?: string | number | null;
  created?: string | null;
  phone?: string | null;
  email?: string | null;
  lastCommTs?: number | null;
  nextTask?: string | null;
  market?: string | null;
  timeline?: string | null;
  condition?: string | null;
  occupancy?: string | null;
  mortgage?: string | null;
  desiredClose?: string | null;
  offer?: string | number | null;
  arv?: number | null;
  rehab?: number | null;
  mao?: number | null;
  property?: {
    addr?: string | null;
    city?: string | null;
    st?: string | null;
    zip?: string | null;
    beds?: number | null;
    baths?: number | null;
    sqft?: number | null;
    year?: number | null;
    type?: string | null;
  } | null;
};

/**
 * What Jev actually sees. Street, name, phone and email stay out: triage does
 * not need PII, and a Deal Machine scrape often has none of those yet.
 */
export type LeadTriageState = {
  lead: {
    stage: string;
    stage_group: SellerStageGroup;
    source: string | null;
    tags: string[];
    assigned: boolean;
    motivation: string | null;
    asking_price: number | null;
    created: string | null;
  };
  property: {
    city: string | null;
    state: string | null;
    zip: string | null;
    beds: number | null;
    baths: number | null;
    sqft: number | null;
    year_built: number | null;
    type: string | null;
    condition: string | null;
    occupancy: string | null;
    market: string | null;
  };
  contact: {
    has_phone: boolean;
    has_email: boolean;
    never_contacted: boolean;
    last_contact_minutes_ago: number | null;
    open_task: string | null;
  };
  underwriting: {
    offer_amount: number | null;
    arv: number | null;
    rehab: number | null;
    mao: number | null;
    timeline: string | null;
    mortgage: string | null;
    desired_close: string | null;
  };
};

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};
export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
};
export type JevQuestion = ChoiceQuestion | NoulQuestion;

/**
 * The questions CLOZR asks Jev in one call. Each is independent against the
 * same state — do not collapse "what to do" into the disposition prompt.
 * Keep this object in step with supabase/functions/_shared/jev-triage.ts.
 */
export const TRIAGE_QUESTIONS = {
  disposition: {
    type: 'choice',
    instructions:
      'Should an acquisitions manager pursue this seller lead now, nurture it for later, or skip it? Judge from stage, motivation, contactability, timeline and numbers — not from the lead\'s name.',
    criteria: {
      pursue:
        'Worth a live conversation or an offer path now: motivated or time-sensitive seller, reachable (phone or email), a plausible wholesale path, and not already dead, listed-retail, or junk.',
      nurture:
        'Not ready to work this week but could be later: long timeline, exploring options, missing contact info, thin facts, or already sitting in a nurture stage.',
      skip:
        'Do not work: not selling, duplicate, asking retail, listed with an agent, bad location, negative equity, ghosted, refund, or otherwise dead.',
    },
  } satisfies ChoiceQuestion,
  urgent: {
    type: 'noul',
    instructions:
      'Does this lead need acquisitions action inside the next 24 hours?',
    criteria: {
      true:
        'Time-sensitive: foreclosure or behind on payments, relocating soon, inbound and unanswered, a new uncontacted lead with a phone, or a stated ASAP / days-not-months timeline.',
      false:
        'Can wait: long-term nurture, no timeline, already in a working follow-up, no way to contact, or a skip.',
    },
  } satisfies NoulQuestion,
  next_action: {
    type: 'choice',
    instructions: 'What should the acquisitions manager do next with this lead?',
    criteria: {
      call_now: 'Dial now — new, uncontacted, reachable, or time-sensitive.',
      follow_up: 'Scheduled follow-up — already contacted or waiting on them.',
      underwrite: 'Run COMPR / gather numbers before the next live conversation.',
      nurture_sequence: 'Enroll in a nurture plan; no live work this week.',
      close_out: 'Move to a dead/skip stage and stop working it.',
    },
  } satisfies ChoiceQuestion,
} as const;

export type TriageQuestions = typeof TRIAGE_QUESTIONS;

export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type NoulAnswer = {
  type: 'noul';
  noul: number;
};
export type JevAnswer = ChoiceAnswer | NoulAnswer;

export type JevResponse = {
  model: string;
  answers: {
    disposition: ChoiceAnswer;
    urgent: NoulAnswer;
    next_action: ChoiceAnswer;
  };
  usage: { input_tokens: number; output_tokens: number };
  /** Set when this came from the local stub, not TypeSafe. */
  stub?: boolean;
};

export type QueueTag = 'Hot' | 'New lead' | 'Nurture' | 'Skip' | 'Follow-up';

export type TriageSuggestion = {
  disposition: Disposition;
  dispositionConfidence: number;
  dispositionProbabilities: Record<string, number>;
  urgent: number;
  nextAction: NextAction;
  nextActionConfidence: number;
  nextActionProbabilities: Record<string, number>;
  suggestedStage: string;
  queueTag: QueueTag;
  model: string;
  stub: boolean;
};

export type HumanOverride = {
  disposition?: Disposition;
  nextAction?: NextAction;
  note?: string;
};

const MISSING = /^(?:—|-|n\/a|na|none|unknown)?$/i;

export function present(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return !s || MISSING.test(s) ? null : s;
}

export function money(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = present(v);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function hasContact(v: string | null | undefined): boolean {
  const s = present(v);
  return !!s && s !== '—';
}

/** Build the Jev `state` object from a CRM person or a thin ingest-shaped row. */
export function buildLeadTriageState(input: LeadTriageInput): LeadTriageState {
  const stage = present(input.stage) ?? 'Lead';
  return {
    lead: {
      stage,
      stage_group: sellerStageGroup(stage),
      source: present(input.source),
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      assigned: !!present(input.assigned),
      motivation: present(input.motivation),
      asking_price: money(input.asking),
      created: present(input.created),
    },
    property: {
      city: present(input.property?.city),
      state: present(input.property?.st),
      zip: present(input.property?.zip),
      beds: num(input.property?.beds),
      baths: num(input.property?.baths),
      sqft: num(input.property?.sqft),
      year_built: num(input.property?.year),
      type: present(input.property?.type),
      condition: present(input.condition),
      occupancy: present(input.occupancy),
      market: present(input.market),
    },
    contact: {
      has_phone: hasContact(input.phone),
      has_email: hasContact(input.email),
      never_contacted: input.lastCommTs == null,
      last_contact_minutes_ago: input.lastCommTs ?? null,
      open_task: present(input.nextTask),
    },
    underwriting: {
      offer_amount: money(input.offer),
      arv: num(input.arv),
      rehab: num(input.rehab),
      mao: num(input.mao),
      timeline: present(input.timeline),
      mortgage: present(input.mortgage),
      desired_close: present(input.desiredClose),
    },
  };
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function jevRequestBody(state: LeadTriageState) {
  return { model: JEV_MODEL, state, questions: TRIAGE_QUESTIONS };
}

function peaked(choice: string, options: readonly string[], peak = 0.82): Record<string, number> {
  const rest = (1 - peak) / Math.max(1, options.length - 1);
  const out: Record<string, number> = {};
  for (const o of options) out[o] = o === choice ? peak : rest;
  return out;
}

function choiceAnswer(choice: string, options: readonly string[], peak = 0.82): ChoiceAnswer {
  const probabilities = peaked(choice, options, peak);
  return { type: 'choice', choice, probabilities, confidence: peak };
}

/**
 * Local stand-in so the playground works without a TypeSafe key. Same response
 * shape as Jev. Not a model — a few honest heuristics over fields CLOZR already
 * has, so a reviewer can see the wiring before TYPESAFE_API_KEY is set.
 */
export function stubEvaluate(state: LeadTriageState): JevResponse {
  const g = state.lead.stage_group;
  const stage = state.lead.stage.toLowerCase();
  const tags = state.lead.tags.map((t) => t.toLowerCase());
  const blob = [
    state.lead.motivation, state.underwriting.timeline, state.underwriting.mortgage,
    state.underwriting.desired_close, tags.join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

  const listed = tags.some((t) => t.includes('listed')) || /listed with agent|on mls/.test(blob);
  const long = /12 month|6 months|year|not urgent|long-term|long term/.test(blob) || tags.includes('long-term') || stage.includes('nurture');
  const hot = /asap|foreclos|behind on|pre-foreclos|relocating|inherited|probate|divorce/.test(blob);
  const thin = !state.lead.motivation && !state.contact.has_phone && !state.lead.asking_price;

  let disposition: Disposition = 'pursue';
  if (g === 'dead' || g === 'refund' || listed) disposition = 'skip';
  else if (thin || long) disposition = 'nurture';

  let next: NextAction = 'follow_up';
  if (disposition === 'skip') next = 'close_out';
  else if (disposition === 'nurture') next = 'nurture_sequence';
  else if (state.contact.never_contacted && state.contact.has_phone) next = 'call_now';
  else if (!state.underwriting.arv && (state.lead.asking_price || state.property.sqft)) next = 'underwrite';

  let urgent = 0.28;
  if (disposition === 'skip') urgent = 0.04;
  else if (disposition === 'nurture') urgent = long ? 0.08 : 0.22;
  else if (hot || (state.contact.never_contacted && state.contact.has_phone)) urgent = hot ? 0.91 : 0.78;

  return {
    model: 'stub',
    stub: true,
    usage: { input_tokens: 0, output_tokens: 0 },
    answers: {
      disposition: choiceAnswer(disposition, DISPOSITIONS, disposition === 'skip' ? 0.9 : 0.8),
      urgent: { type: 'noul', noul: urgent },
      next_action: choiceAnswer(next, NEXT_ACTIONS, 0.76),
    },
  };
}

export function isDisposition(v: string): v is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(v);
}
export function isNextAction(v: string): v is NextAction {
  return (NEXT_ACTIONS as readonly string[]).includes(v);
}

/** Suggested CLOZR seller stage — never applied automatically. */
export function suggestedStageFor(state: LeadTriageState, disposition: Disposition): string {
  if (disposition === 'skip') return 'Dead';
  if (disposition === 'nurture') {
    const blob = `${state.underwriting.timeline ?? ''} ${state.lead.tags.join(' ')}`.toLowerCase();
    if (/12 month|year|6 months|long/.test(blob)) return 'Nurture - Long Term (3+ Months)';
    return 'Nurture - Short Term (Under 3 Months)';
  }
  if (state.contact.never_contacted) return 'Lead - No Contact';
  return 'Lead';
}

export function queueTagFor(disposition: Disposition, urgent: number, next: NextAction): QueueTag {
  if (disposition === 'skip') return 'Skip';
  if (disposition === 'nurture') return 'Nurture';
  if (urgent >= 0.7 || next === 'call_now') return 'Hot';
  if (next === 'follow_up' || next === 'underwrite') return 'Follow-up';
  return 'New lead';
}

export function interpretTriage(state: LeadTriageState, res: JevResponse, override?: HumanOverride): TriageSuggestion {
  const rawDisp = res.answers.disposition.choice;
  const rawNext = res.answers.next_action.choice;
  const disposition = override?.disposition ?? (isDisposition(rawDisp) ? rawDisp : 'nurture');
  const nextAction = override?.nextAction ?? (isNextAction(rawNext) ? rawNext : 'follow_up');
  const urgent = res.answers.urgent.noul;
  return {
    disposition,
    dispositionConfidence: res.answers.disposition.confidence,
    dispositionProbabilities: res.answers.disposition.probabilities,
    urgent,
    nextAction,
    nextActionConfidence: res.answers.next_action.confidence,
    nextActionProbabilities: res.answers.next_action.probabilities,
    suggestedStage: suggestedStageFor(state, disposition),
    queueTag: queueTagFor(disposition, urgent, nextAction),
    model: res.model,
    stub: !!res.stub,
  };
}

/** Re-interpret a model result after an AM override. Does not call Jev again. */
export function applyOverride(state: LeadTriageState, model: TriageSuggestion, override?: HumanOverride): TriageSuggestion {
  if (!override?.disposition && !override?.nextAction) return model;
  const disposition = override.disposition ?? model.disposition;
  const nextAction = override.nextAction ?? model.nextAction;
  return {
    ...model,
    disposition,
    nextAction,
    suggestedStage: suggestedStageFor(state, disposition),
    queueTag: queueTagFor(disposition, model.urgent, nextAction),
  };
}

export type PlaygroundFixture = {
  id: string;
  label: string;
  why: string;
  input: LeadTriageInput;
};

const fromPerson = (p: Person): LeadTriageInput => p;

/** Sample + thin-ingest fixtures. The thin one is what Deal Machine often sends. */
export function playgroundFixtures(): PlaygroundFixture[] {
  const people = CLOZR_DATA.people;
  const pick = (id: string) => people.find((p) => p.id === id)!;
  const john = pick('p3');
  const denise = pick('p13');
  const bruce = pick('p14');
  const harold = pick('p12');
  const teresa = pick('p11');
  return [
    { id: 'p3', label: `${john.name} · new PPC`, why: 'Uncontacted, behind on payments, ASAP — expect pursue + urgent.', input: fromPerson(john) },
    { id: 'p13', label: `${denise.name} · long-term`, why: '12-month horizon, Long-term tag — expect nurture.', input: fromPerson(denise) },
    { id: 'p14', label: `${bruce.name} · listed`, why: 'Lost + listed with agent — expect skip.', input: fromPerson(bruce) },
    { id: 'p12', label: `${harold.name} · pre-foreclosure`, why: 'Appointment already set, foreclosure timeline — expect pursue + urgent.', input: fromPerson(harold) },
    { id: 'p11', label: `${teresa.name} · exploring`, why: 'Six-month timeline, exploring options — expect nurture or soft pursue.', input: fromPerson(teresa) },
    {
      id: 'thin',
      label: 'Thin Deal Machine scrape',
      why: 'Address + beds only, no phone, no motivation — the ingest envelope after a scrape, before skip-trace.',
      input: {
        name: 'No name',
        stage: 'Lead',
        source: 'deal_machine',
        tags: [],
        assigned: null,
        motivation: null,
        asking: null,
        created: 'just now',
        phone: null,
        email: null,
        lastCommTs: null,
        nextTask: null,
        market: 'San Antonio',
        property: { city: 'San Antonio', st: 'TX', zip: '78254', beds: 3, baths: 2, sqft: 1480, year: 1984, type: 'SFR' },
      },
    },
  ];
}
