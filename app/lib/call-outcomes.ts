// The eight call outcomes, and the plan each one makes for a seller.
//
// Today's rail, the desk wrap-up and the phone's wrap-up all log a seller call
// through this file. One action (an outcome, then Enter) runs one plan: the
// picker renders `plan.lines` as "This will…", and the view-model's save
// executes exactly the same plan object, so the preview cannot drift from
// what is written.
//
// Pure: no React, no network. `now` and the zones come in from the caller so
// the tests can pin them (tools/call-outcomes.test.ts).

import { sellerStageGroup, type SellerStageGroup } from './stages';
import { fieldsFor, renderMerge, type Recipient, type SendContext } from './sms';

export type OutcomeKey = 'noanswer' | 'vm' | 'followup' | 'appt' | 'offer' | 'notint' | 'wrong' | 'dnc' | OfferOutcomeKey;
/** How the offer went: the acquisitions SOP's last step, after the house is underwritten. */
export type OfferOutcomeKey = 'accepted' | 'declined' | 'nooffer';
/** Which stage list the seller is on: the live acquisitions stages, or the demo's twelve. */
export type Vocab = 'live' | 'demo';
export type Chip = { id: string; label: string };
/** A Talkr disposition as /v1/dispositions returns it (lib/talkr.ts DispositionDto). */
export type TalkrDisposition = { slug: string; name: string; requires_follow_up?: boolean; adds_suppression?: boolean };

export type OutcomeDef = {
  key: OutcomeKey;
  /** The number key that picks it, 1–8; 0 for the offer outcomes, which have none. */
  n: number;
  label: string;
  /** What the Today row says once it is done ("Done: Voicemail"). */
  short: string;
  /** What the chip row under the outcome chooses. */
  chipKind: 'when' | 'reason' | null;
  /** The text offered after the call, with merge fields; null when none is. */
  text: string | null;
  /** A conversation happened, so the call summary's facts may be written. */
  conversation: boolean;
  /** How the outcome finds the org's own Talkr disposition. */
  talkr: { names: string[]; include: RegExp | null; exclude?: RegExp; suppression?: boolean };
};

/**
 * Keys 1–6 are the everyday outcomes. Wrong number and Do not call keep keys
 * of their own because they do different things to compliance: one marks the
 * number bad, the other stops every rep calling or texting the seller.
 */
export const OUTCOMES: OutcomeDef[] = [
  {
    key: 'noanswer', n: 1, label: 'No answer', short: 'No answer', chipKind: 'when', conversation: false,
    text: "Hi {{first_name}}, it's {{rep_first_name}} with {{company}}. Sorry I missed you just now about {{address}}. Is later today better?",
    talkr: { names: ['No answer'], include: /no.?answer|no.?contact|busy|unreachable/i },
  },
  {
    key: 'vm', n: 2, label: 'Left voicemail', short: 'Voicemail', chipKind: 'when', conversation: false,
    text: 'Hi {{first_name}}, {{rep_first_name}} with {{company}} here. I just left you a voicemail about {{address}}. Text me back here whenever works.',
    talkr: { names: ['Left voicemail', 'Voicemail'], include: /voice.?mail|left.?(vm|message)|\bvm\b/i },
  },
  {
    key: 'followup', n: 3, label: 'Talked, follow up', short: 'Follow up', chipKind: 'when', conversation: true, text: null,
    talkr: { names: ['Callback', 'Follow up'], include: /call.?back|follow.?up/i },
  },
  {
    key: 'appt', n: 4, label: 'Appointment set', short: 'Appointment', chipKind: 'when', conversation: true,
    text: 'Hi {{first_name}}, confirming our walkthrough at {{address}} on {{appt_when}}. Reply here if anything changes. {{rep_first_name}}, {{company}}',
    talkr: { names: ['Appointment set'], include: /appoint|walk.?through|\bappt\b/i },
  },
  {
    key: 'offer', n: 5, label: 'Ready for an offer', short: 'To underwriting', chipKind: null, conversation: true, text: null,
    // "Interested" is the chip CLOZR shows; `interest` counts only when the name is not a no.
    talkr: { names: ['Interested'], include: /offer|qualif|hot|motivated|interest/i, exclude: /not|no\b/i },
  },
  {
    key: 'notint', n: 6, label: 'Not interested', short: 'Not interested', chipKind: 'reason', conversation: true, text: null,
    talkr: { names: ['Not interested'], include: /not.?interest|no.?interest|nurture|not.?selling/i },
  },
  {
    key: 'wrong', n: 7, label: 'Wrong number', short: 'Wrong number', chipKind: 'reason', conversation: false, text: null,
    talkr: { names: ['Wrong number'], include: /wrong/i },
  },
  {
    key: 'dnc', n: 8, label: 'Do not call', short: 'Do not call', chipKind: null, conversation: false, text: null,
    talkr: { names: ['Do not call', 'DNC'], include: /dnc|do.?not.?call|remove/i, suppression: true },
  },
];
/**
 * The SOP's three ways an offer ends (step 5): Offer accepted goes to
 * contract, Declined keeps working them (a reason, a follow-up and a drip),
 * No offer is a reason and then Not Qualified or a follow-up. They sit beside
 * the eight call outcomes on the record and, once an offer is out, on Today.
 */
export const OFFER_OUTCOMES: OutcomeDef[] = [
  {
    key: 'accepted', n: 0, label: 'Offer accepted', short: 'Offer accepted', chipKind: null, conversation: true, text: null,
    talkr: { names: ['Offer accepted', 'Accepted'], include: /accept/i, exclude: /not|no\b/i },
  },
  {
    key: 'declined', n: 0, label: 'Offer declined', short: 'Declined', chipKind: 'when', conversation: true, text: null,
    talkr: { names: ['Offer declined', 'Declined'], include: /declin|reject/i },
  },
  {
    key: 'nooffer', n: 0, label: 'No offer', short: 'No offer', chipKind: 'reason', conversation: true, text: null,
    talkr: { names: ['No offer', 'Not qualified'], include: /no.?offer|not.?qualif|unqualif/i },
  },
];
export const isOfferOutcome = (k: OutcomeKey): k is OfferOutcomeKey => k === 'accepted' || k === 'declined' || k === 'nooffer';
export const outcomeByKey = (k: OutcomeKey) => (OUTCOMES.find((o) => o.key === k) ?? OFFER_OUTCOMES.find((o) => o.key === k))!;

/** Why they said no to the offer. The pick goes on the timeline. */
export const DECLINE_REASONS = ['Price too low', 'Going with another buyer', 'Listing with an agent', 'Wants to wait', 'Something else'];
/** Why we did not make one. */
export const NO_OFFER_REASONS = ['Numbers don’t work', 'Too much rehab', 'Bad location', 'Title or lien problem', 'Not the decision maker', 'Something else'];

/**
 * A power-dialer session walking a person's numbers stops at this outcome:
 * they were reached (a conversation) or asked not to be called. No answer,
 * voicemail and Wrong number go on to their next number.
 */
export const endsNumberWalk = (k: OutcomeKey): boolean => outcomeByKey(k).conversation || k === 'dnc';

// ---- stages -----------------------------------------------------------------

/** The demo's twelve stages (lib/clozr-data.ts STAGES), in pipeline order. */
export const DEMO_STAGES = ['New Lead', 'Contacted', 'Qualified', 'Appointment', 'Offer Sent', 'Negotiation', 'Under Contract', 'Dispo', 'Assigned', 'Closing', 'Closed', 'Lost'];
const DEMO_GROUP: Record<string, SellerStageGroup> = {
  'New Lead': 'lead', Contacted: 'working', Qualified: 'working', Appointment: 'working',
  'Offer Sent': 'offer', Negotiation: 'offer', 'Under Contract': 'contract', Dispo: 'contract',
  Assigned: 'contract', Closing: 'contract', Closed: 'closed', Lost: 'dead',
};

/** A stage's group in either vocabulary. */
export const stageGroup = (stage: string, vocab: Vocab): SellerStageGroup =>
  vocab === 'demo' ? DEMO_GROUP[stage] ?? 'other' : sellerStageGroup(stage);

/** The five-segment stage bar: Lead, Working, Offer, Contract, Closed. -1 for dead, refund and the rest. */
export const STAGE_BAR = ['Lead', 'Working', 'Offer', 'Contract', 'Closed'];
const BAR_INDEX: Partial<Record<SellerStageGroup, number>> = { lead: 0, working: 1, offer: 2, contract: 3, closed: 4 };
export const stageBarIndex = (stage: string, vocab: Vocab): number => BAR_INDEX[stageGroup(stage, vocab)] ?? -1;

/** Stages a brand-new, never-worked lead sits in. */
const NEW_LIVE = ['None', 'Self Generated', 'Lead'];
export const isNewStage = (stage: string, vocab: Vocab) => (vocab === 'demo' ? stage === 'New Lead' : NEW_LIVE.includes(stage));

/** Parked stages a conversation re-engages. */
const PARKED = ['Lead - No Contact', 'Lead - No Contact (Long Term)', 'Appointment Missed', 'Nurture - Short Term (Under 3 Months)', 'Nurture - Long Term (3+ Months)'];
/** An offer is out and waiting on the seller. */
const OFFER_OUT = ['Offer Made', 'Pending Response', 'Offer Made - Retail'];

/** Why they are out, for Not interested. `declined` is offered only once an offer is out. */
const NOT_INTERESTED: Record<string, { label: string; stage: string }> = {
  nurture: { label: 'Nurture 90 days', stage: 'Nurture - Long Term (3+ Months)' },
  notselling: { label: 'Not selling', stage: 'Not Selling' },
  listed: { label: 'Listed or sold', stage: 'Listed on MLS - Dead' },
  retail: { label: 'Asking retail', stage: 'Asking Retail / Not Motivated' },
  // Declined is worked, not buried: they stay on an offer follow-up with a check-back in 30 days.
  declined: { label: 'Offer declined', stage: 'Offer Made - Follow Up' },
};

/**
 * The live stage an outcome moves a seller to. An outcome never lowers the
 * stage: the only moves down are the ones named here — a conversation
 * re-engaging a parked seller, Nurture, and the dead and refund stages — and
 * those three only while the seller is still a lead, being worked, or has an
 * offer out. Under contract and beyond keep their stage.
 */
export function liveStage(key: OutcomeKey, from: string, chip?: string | null): string {
  const g = sellerStageGroup(from);
  const open = g === 'lead' || g === 'working' || g === 'offer';
  switch (key) {
    case 'noanswer':
    case 'vm':
      return NEW_LIVE.includes(from) ? 'Lead - No Contact' : from;
    case 'followup':
      if (PARKED.includes(from)) return 'Contacted - Follow Up Needed';
      if (OFFER_OUT.includes(from)) return 'Offer Made - Follow Up';
      if (g === 'lead') return 'Contacted - Follow Up Needed';
      return from;
    case 'appt':
      return g === 'lead' || g === 'working' ? 'Appointment Set' : from;
    case 'offer':
      return g === 'lead' || g === 'working' ? 'Underwriting' : from;
    case 'notint': {
      if (!open) return from;
      const r = NOT_INTERESTED[chip && (chip !== 'declined' || g === 'offer') ? chip : 'nurture'] ?? NOT_INTERESTED.nurture;
      return r.stage;
    }
    case 'wrong':
      return open ? (chip === 'refund' ? 'Refund - Wrong Info' : 'Dead - Wrong Info') : from;
    case 'dnc':
      return open ? 'Dead' : from;
    case 'accepted':
      return open ? 'Offer Accepted' : from;
    case 'declined':
      return open ? 'Offer Made - Follow Up' : from;
    case 'nooffer':
      if (!open) return from;
      return chip === 'nq' || !chip ? 'Not Qualified' : 'Contacted - Follow Up Needed';
  }
}

/** The same rule on the demo's twelve stages, forward only by their order. */
export function demoStage(key: OutcomeKey, from: string): string {
  const at = (s: string) => DEMO_STAGES.indexOf(s);
  const forward = (to: string) => (at(to) > at(from) ? to : from);
  switch (key) {
    case 'noanswer':
    case 'vm':
      return from;
    case 'followup':
      return from === 'New Lead' ? 'Contacted' : from;
    case 'appt':
      return forward('Appointment');
    case 'offer':
      return forward('Qualified');
    case 'notint':
    case 'wrong':
    case 'dnc':
      return at(from) >= 0 && at(from) < at('Under Contract') ? 'Lost' : from;
    case 'accepted':
      return forward('Negotiation');
    case 'declined':
      return from;
    case 'nooffer':
      return at(from) >= 0 && at(from) < at('Under Contract') ? 'Lost' : from;
  }
}

// ---- time -------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(zone: string, t: number) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    fmtCache.set(zone, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute),
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? ''),
  };
}
/** How far the zone's wall clock is ahead of UTC at instant t, in ms. */
function offsetAt(zone: string, t: number): number {
  const p = partsIn(zone, t);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(t / 60_000) * 60_000;
}
/** The instant a zone's wall clock reads y-m-d h:min. Correct across daylight-saving changes. */
export function wallToUtc(zone: string, y: number, m: number, d: number, h: number, min: number): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const o1 = offsetAt(zone, guess);
  const t = guess - o1;
  const o2 = offsetAt(zone, t);
  return o2 === o1 ? t : guess - o2;
}

export type DueSpec =
  | { hours: number }
  | { days: number; at: [number, number] }
  | { weekday: number; at: [number, number] };

/**
 * When a follow-up is due, as an ISO instant. `days` counts calendar days in
 * the zone, so "tomorrow 10 AM" is 10 AM on the zone's tomorrow even across a
 * daylight-saving change; `weekday` is the next one after today.
 */
export function dueAtIn(zone: string, spec: DueSpec, now: Date): string {
  if ('hours' in spec) return new Date(now.getTime() + spec.hours * 3_600_000).toISOString();
  const p = partsIn(zone, now.getTime());
  const days = 'days' in spec ? spec.days : ((spec.weekday - p.wd + 7) % 7) || 7;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return new Date(wallToUtc(zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), spec.at[0], spec.at[1])).toISOString();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "10:00 AM" on the zone's clock. */
export function clockIn(zone: string, t: number): string {
  const p = partsIn(zone, t);
  return `${p.h % 12 || 12}:${String(p.min).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}
/** "today 3:05 PM", "tomorrow 10:00 AM", "Fri 10:00 AM", "Dec 22 10:00 AM" on the zone's calendar. */
export function fmtWhen(iso: string, zone: string, now: Date): string {
  const t = Date.parse(iso);
  const a = partsIn(zone, now.getTime());
  const b = partsIn(zone, t);
  const diff = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  const day = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff > 1 && diff < 7 ? WEEKDAYS[b.wd] : `${MONTHS[b.m - 1]} ${b.d}`;
  return `${day} ${clockIn(zone, t)}`;
}

// ---- chips ------------------------------------------------------------------

const WHEN: Record<string, { label: string; spec: DueSpec }> = {
  in2h: { label: 'In 2 hours', spec: { hours: 2 } },
  tmrw10: { label: 'Tomorrow 10 AM', spec: { days: 1, at: [10, 0] } },
  in2d: { label: 'In 2 days', spec: { days: 2, at: [10, 0] } },
  tmrw: { label: 'Tomorrow', spec: { days: 1, at: [10, 0] } },
  in3d: { label: 'In 3 days', spec: { days: 3, at: [10, 0] } },
  nextwk: { label: 'Next week', spec: { weekday: 1, at: [10, 0] } },
  tmrw14: { label: 'Tomorrow 2 PM', spec: { days: 1, at: [14, 0] } },
  in30d: { label: 'In 30 days', spec: { days: 30, at: [10, 0] } },
};

/** The chips an outcome offers for this seller, and which one is picked when none has been. */
export function chipsFor(key: OutcomeKey, stage: string, vocab: Vocab, ai?: { followUp?: string | null; followUpAt?: string | null } | null): { chips: Chip[]; def: string | null } {
  const w = (ids: string[]) => ids.map((id) => ({ id, label: WHEN[id]!.label }));
  switch (key) {
    case 'noanswer': return { chips: w(['in2h', 'tmrw10', 'in2d']), def: 'tmrw10' };
    case 'vm': return { chips: w(['in2h', 'tmrw10', 'in2d']), def: 'in2d' };
    case 'followup': {
      const chips = w(['tmrw', 'in3d', 'nextwk']);
      if (ai?.followUp && ai.followUpAt) chips.push({ id: 'ai', label: ai.followUp });
      return { chips, def: 'tmrw' };
    }
    case 'appt': return { chips: [...w(['tmrw10', 'tmrw14']), { id: 'pick', label: 'Pick a time' }], def: 'tmrw10' };
    case 'notint': {
      const ids = ['nurture', 'notselling', 'listed', 'retail', ...(stageGroup(stage, vocab) === 'offer' ? ['declined'] : [])];
      return { chips: ids.map((id) => ({ id, label: NOT_INTERESTED[id]!.label })), def: 'nurture' };
    }
    case 'wrong': return { chips: [{ id: 'dead', label: 'Wrong info' }, { id: 'refund', label: 'Refund (paid lead)' }], def: 'dead' };
    case 'declined': return { chips: w(['in3d', 'nextwk', 'in30d']), def: 'nextwk' };
    case 'nooffer': return { chips: [{ id: 'nq', label: 'Not qualified' }, { id: 'in3d', label: 'Follow up in 3 days' }, { id: 'nextwk', label: 'Follow up next week' }], def: 'nq' };
    default: return { chips: [], def: null };
  }
}

// ---- Talkr ------------------------------------------------------------------

/**
 * The org's own Talkr disposition for an outcome: an exact name first, then
 * the outcome's pattern against the name, then against the slug, excludes
 * before includes. Do not call takes the disposition that adds to Talkr's
 * suppression list when the org has one.
 */
export function matchTalkrDisposition(key: OutcomeKey, list: TalkrDisposition[]): TalkrDisposition | null {
  const m = outcomeByKey(key).talkr;
  if (m.suppression) {
    const sup = list.find((d) => d.adds_suppression === true);
    if (sup) return sup;
  }
  const names = m.names.map((n) => n.toLowerCase());
  const exact = list.find((d) => names.includes(d.name.trim().toLowerCase()));
  if (exact) return exact;
  if (!m.include) return null;
  const pass = (s: string) => !(m.exclude && m.exclude.test(s)) && m.include!.test(s);
  return list.find((d) => pass(d.name)) ?? list.find((d) => pass(d.slug)) ?? null;
}

// ---- the plan ---------------------------------------------------------------

export type PlanPerson = {
  id: string; name: string; stage: string; phone: string; lastCommTs: number | null;
  property: { addr: string; city: string; st: string; zip: string };
};

export type PlanCtx = {
  person: PlanPerson;
  vocab: Vocab;
  /** The open overdue or today task that put the seller on Today (mine or unassigned), earliest first. */
  task: { id: string; title: string; type?: string } | null;
  /** An unassigned new lead: logging the call claims it. */
  claim: boolean;
  now: Date;
  /** The seller's zone ("their time") and the rep's. */
  zone: string;
  repZone: string;
  chip?: string | null;
  /** The appointment's time when "Pick a time" is the chip: a datetime-local value. */
  pickAt?: string | null;
  /** The rep's text toggle; null or undefined means the outcome's default. */
  textOn?: boolean | null;
  /** From the call summary: a suggested task, and a follow-up with its parsed time. */
  ai?: { task?: string | null; followUp?: string | null; followUpAt?: string | null } | null;
  /** The org's Talkr dispositions; null when there is no Talkr (the demo). */
  dispositions: TalkrDisposition[] | null;
  /** False for "Log without calling". */
  hasCall: boolean;
  notes?: string;
  /** Who a text would go to; null when the seller has no number to text. */
  recipient: Recipient | null;
  send: SendContext;
  /** The deal already has an MAO, so COMPR need not run. */
  hasMao: boolean;
  /**
   * The call went to one of the seller's other numbers (seller_phones), not
   * the record's own phone. Wrong number then marks that number only: the
   * stage, the tags and the task stay, and the session tries their next one.
   * The text after the call is off unless the rep turns it on, since it would
   * go to the record's phone, not the number that was rung.
   */
  otherNumber?: { id: number; label: string } | null;
  /**
   * How many other good numbers the person still has (a session walking
   * them). Wrong number on their own phone then marks that number and keeps
   * the lead; with none left it does what it always did.
   */
  moreNumbers?: number;
  /** Offer declined / No offer: why. Required before either saves. */
  reason?: string | null;
  /** Offer declined: the drip plan to enroll them in, if any. */
  enroll?: { id: string; name: string } | null;
};

export type OutcomePlan = {
  key: OutcomeKey;
  outcome: OutcomeDef;
  personId: string;
  name: string;
  first: string;
  claim: boolean;
  stageFrom: string;
  /** Null when the stage stays. */
  stage: { from: string; to: string } | null;
  task: {
    complete?: { id: string; title: string };
    reschedule?: { id: string; title: string; dueAt: string };
    create?: { title: string; type: string; dueAt: string };
  } | null;
  appointment: { title: string; startsAt: string } | null;
  tags: string[];
  /** Null when this outcome offers no text. */
  text: { body: string; on: boolean } | null;
  talkr: TalkrDisposition | null;
  talkrLine: string;
  followUpAt: string | null;
  compr: boolean;
  /** Do not call: off the rep's own call queue too. */
  dropFromQueue: boolean;
  /** Wrong number on one of their other numbers: the seller_phones row to mark wrong. */
  wrongNumberId: number | null;
  /** Wrong number on their own phone while other numbers remain: mark it, keep the lead. */
  wrongPrimary: boolean;
  chips: Chip[];
  chip: string | null;
  chipKind: 'when' | 'reason' | null;
  /** Save stays off, with this reason, until it is resolved. */
  blocked: string | null;
  /** Offer declined / No offer: the reasons to pick from, and the one picked. */
  reasons: string[] | null;
  reason: string | null;
  /** Offer declined: the drip plan they go on. */
  enroll: { id: string; name: string } | null;
  /** Offer accepted: the deal is opened and its sheet shown, to send the contract. */
  openDeal: boolean;
  /** "This will…", sentence case. */
  lines: string[];
  /** The success toast's parts, lower case. */
  toastParts: string[];
};

const firstOf = (name: string) => name.trim().split(/\s+/)[0] || name;

export function planOutcome(key: OutcomeKey, ctx: PlanCtx): OutcomePlan {
  const o = outcomeByKey(key);
  const p = ctx.person;
  const first = firstOf(p.name);
  const street = p.property.addr && p.property.addr !== '—' ? p.property.addr : 'the property';
  // Wrong number on one of their other numbers is about that number, not the seller.
  const other = ctx.otherNumber ?? null;
  // Their own phone is wrong but they have other numbers: the lead lives on.
  const primaryOnly = key === 'wrong' && !other && (ctx.moreNumbers ?? 0) > 0;
  const numberOnly = key === 'wrong' && (!!other || primaryOnly);
  const { chips, def } = numberOnly ? { chips: [] as Chip[], def: null } : chipsFor(key, p.stage, ctx.vocab, ctx.ai);
  const chip = ctx.chip && chips.some((c) => c.id === ctx.chip) ? ctx.chip : def;
  const theirs = ctx.zone !== ctx.repZone ? ', their time' : '';
  const when = (iso: string, zone = ctx.zone) => fmtWhen(iso, zone, ctx.now) + (zone === ctx.zone ? theirs : '');
  const whenShort = (iso: string, zone = ctx.zone) => fmtWhen(iso, zone, ctx.now);
  const at = (id: string | null): string | null => {
    if (!id) return null;
    if (id === 'ai') return ctx.ai?.followUpAt ?? null;
    if (id === 'pick') {
      const t = ctx.pickAt ? Date.parse(ctx.pickAt) : NaN;
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    const w = WHEN[id];
    return w ? dueAtIn(ctx.zone, w.spec, ctx.now) : null;
  };

  const to = numberOnly ? p.stage : ctx.vocab === 'demo' ? demoStage(key, p.stage) : liveStage(key, p.stage, chip);
  const stage = to !== p.stage ? { from: p.stage, to } : null;
  const lines: string[] = [];
  const toast: string[] = [o.short.toLowerCase()];
  let task: OutcomePlan['task'] = null;
  let appointment: OutcomePlan['appointment'] = null;
  const tags: string[] = [];
  let followUpAt: string | null = null;
  let blocked: string | null = null;
  const reasons = key === 'declined' ? DECLINE_REASONS : key === 'nooffer' ? NO_OFFER_REASONS : null;
  const reason = reasons && ctx.reason && ctx.reason.trim() ? ctx.reason.trim() : null;

  if (ctx.claim) lines.push(`Assigns ${first} to you`);
  lines.push(stage ? `Stage becomes ${stage.to}` : `Stage stays ${p.stage}`);
  if (stage) toast.push(`stage ${stage.to}`);
  const complete = ctx.task ? { id: ctx.task.id, title: ctx.task.title } : undefined;
  if (complete && key !== 'noanswer' && key !== 'vm' && !numberOnly) lines.push(`Completes “${complete.title}”`);

  switch (key) {
    case 'noanswer':
    case 'vm': {
      const due = at(chip)!;
      followUpAt = due;
      if (ctx.task) {
        task = { reschedule: { id: ctx.task.id, title: ctx.task.title, dueAt: due } };
        lines.push(`Call back ${when(due)}, moving “${ctx.task.title}”`);
      } else {
        task = { create: { title: `Call back ${first}`, type: 'Call', dueAt: due } };
        lines.push(`New task: Call back ${first}, ${when(due)}`);
      }
      toast.push(`call back ${whenShort(due)}`);
      break;
    }
    case 'followup': {
      const due = at(chip);
      if (!due) { blocked = 'Pick when to follow up'; break; }
      followUpAt = due;
      const title = ctx.ai?.task?.trim() || `Follow up with ${first}`;
      task = { complete, create: { title, type: 'Call', dueAt: due } };
      lines.push(`New task: ${title}, ${when(due)}`);
      toast.push(`follow-up ${whenShort(due)}`);
      break;
    }
    case 'appt': {
      const starts = at(chip);
      if (!starts) { blocked = 'Pick the walkthrough time'; lines.push('Walkthrough on your calendar once you pick a time'); break; }
      followUpAt = starts;
      appointment = { title: `Walkthrough at ${street}`, startsAt: starts };
      task = complete ? { complete } : null;
      lines.push(`Walkthrough on your calendar, ${when(starts)}`);
      toast.push(`walkthrough ${whenShort(starts)}`);
      break;
    }
    case 'offer': {
      // The rep's own deadline, on the rep's clock: today 5 PM, or tomorrow
      // 10 AM once it is too late in the day to turn an offer around.
      const late = partsIn(ctx.repZone, ctx.now.getTime()).h >= 15;
      const due = dueAtIn(ctx.repZone, late ? { days: 1, at: [10, 0] } : { days: 0, at: [17, 0] }, ctx.now);
      followUpAt = due;
      task = { complete, create: { title: `Send offer to ${first}`, type: 'Offer', dueAt: due } };
      lines.push(`New task: Send offer to ${first}, ${whenShort(due, ctx.repZone)}`);
      toast.push(`send offer ${whenShort(due, ctx.repZone)}`);
      break;
    }
    case 'notint': {
      // Nurture only while the seller was still open: past contract the stage
      // stays, and a check-back in 90 days would be noise.
      if (chip === 'nurture' && stage) {
        const due = dueAtIn(ctx.zone, { days: 90, at: [10, 0] }, ctx.now);
        followUpAt = due;
        task = { complete, create: { title: `Check back with ${first}`, type: 'Call', dueAt: due } };
        lines.push(`New task: Check back with ${first}, ${whenShort(due)}`);
        toast.push(`check back ${whenShort(due).replace(/ \d{1,2}:\d{2} [AP]M$/, '')}`);
      } else if (chip === 'declined' && (stage || stageGroup(p.stage, ctx.vocab) === 'offer')) {
        const due = dueAtIn(ctx.zone, { days: 30, at: [10, 0] }, ctx.now);
        followUpAt = due;
        task = { complete, create: { title: `Follow up with ${first} on the offer`, type: 'Call', dueAt: due } };
        lines.push(`New task: Follow up with ${first} on the offer, ${whenShort(due)}`);
        toast.push(`check back ${whenShort(due).replace(/ \d{1,2}:\d{2} [AP]M$/, '')}`);
      } else {
        task = complete ? { complete } : null;
        lines.push('No follow-up task');
      }
      lines.push('Off today’s list');
      break;
    }
    case 'wrong': {
      if (other) {
        lines.push(`Marks ${other.label} wrong. ${first} keeps their other numbers`);
        toast.push(`${other.label} marked wrong`);
        break;
      }
      if (primaryOnly) {
        const more = ctx.moreNumbers ?? 0;
        lines.push(`Marks their main number wrong. ${first} keeps ${more} other number${more === 1 ? '' : 's'}`);
        toast.push('main number marked wrong');
        break;
      }
      task = complete ? { complete } : null;
      tags.push('Wrong number');
      lines.push('Tags the record Wrong number');
      toast.push('tagged Wrong number');
      break;
    }
    case 'accepted': {
      // The rep's own clock: the contract goes out today, or tomorrow
      // morning once it is too late in the day (as Ready for an offer does).
      const late = partsIn(ctx.repZone, ctx.now.getTime()).h >= 15;
      const due = dueAtIn(ctx.repZone, late ? { days: 1, at: [10, 0] } : { days: 0, at: [17, 0] }, ctx.now);
      followUpAt = due;
      task = { complete, create: { title: `Send the contract to ${first}`, type: 'Contract', dueAt: due } };
      lines.push('Opens the deal and its sheet, to send the contract');
      lines.push(`New task: Send the contract to ${first}, ${whenShort(due, ctx.repZone)}`);
      toast.push('deal opened');
      break;
    }
    case 'declined': {
      const due = at(chip);
      if (!reason) blocked = 'Pick why they said no';
      if (!due) { blocked ??= 'Pick when to follow up'; break; }
      followUpAt = due;
      task = { complete, create: { title: `Follow up with ${first} on the offer`, type: 'Call', dueAt: due } };
      if (reason) lines.push(`Notes why: ${reason}`);
      lines.push(`New task: Follow up with ${first} on the offer, ${when(due)}`);
      if (ctx.enroll) lines.push(`Starts the “${ctx.enroll.name}” drip`);
      toast.push(`follow-up ${whenShort(due)}`);
      if (ctx.enroll) toast.push(`on ${ctx.enroll.name}`);
      break;
    }
    case 'nooffer': {
      if (!reason) blocked = 'Pick why there is no offer';
      if (reason) lines.push(`Notes why: ${reason}`);
      if (chip === 'nq' || !chip) {
        task = complete ? { complete } : null;
        lines.push('No follow-up task');
        break;
      }
      const due = at(chip)!;
      followUpAt = due;
      task = { complete, create: { title: `Follow up with ${first}`, type: 'Call', dueAt: due } };
      lines.push(`New task: Follow up with ${first}, ${when(due)}`);
      toast.push(`follow-up ${whenShort(due)}`);
      break;
    }
    case 'dnc': {
      task = complete ? { complete } : null;
      tags.push('DNC');
      lines.push('Tags DNC: no calls or texts from any rep');
      lines.push('Off your call queue and every CLOZR call list');
      toast.push('tagged DNC');
      break;
    }
  }

  // The text, rendered exactly as it will be sent.
  let text: OutcomePlan['text'] = null;
  if (o.text && ctx.recipient && key !== 'dnc' && !(key === 'appt' && !appointment)) {
    const extra: Record<string, string> = appointment ? { appt_when: fmtApptWhen(appointment.startsAt, ctx.zone) } : {};
    const r: Recipient = { ...ctx.recipient, extra: { ...ctx.recipient.extra, ...extra } };
    const body = renderMerge(o.text, fieldsFor(r, ctx.send, r.phone ?? ''));
    const def = !ctx.hasCall || other || primaryOnly ? false
      : key === 'noanswer' ? isNewStage(p.stage, ctx.vocab) && p.lastCommTs === null
        : true;
    const on = ctx.textOn ?? def;
    text = { body, on };
    if (on) lines.push(`Texts ${first} now`);
  }

  const compr = key === 'offer' && ctx.vocab === 'live' && !ctx.hasMao;
  if (compr) lines.push(`COMPR starts the underwrite for ${street}`);
  if ((ctx.notes ?? '').trim()) lines.push('Your notes land on the timeline');

  // Talkr's side, shown muted under the plan and never announced in a toast.
  let talkr: TalkrDisposition | null = null;
  let talkrLine: string;
  if (!ctx.hasCall) talkrLine = 'Talkr: no call to log';
  else if (ctx.dispositions === null) talkrLine = 'Talkr: not connected in the demo';
  else {
    talkr = matchTalkrDisposition(key, ctx.dispositions);
    talkrLine = talkr ? `Talkr: ${talkr.name}` : 'Talkr: no matching disposition, the call is logged without one';
    if (talkr?.requires_follow_up && !followUpAt) talkrLine += '. It expects a follow-up, so Talkr may refuse it';
  }
  if (key === 'dnc' && !talkr?.adds_suppression) talkrLine += '. CLOZR blocks calls and texts. Talkr’s own suppression list is not updated.';

  return {
    key, outcome: o, personId: p.id, name: p.name, first, claim: ctx.claim,
    stageFrom: p.stage, stage, task, appointment, tags, text, talkr, talkrLine, followUpAt, compr,
    dropFromQueue: key === 'dnc', wrongNumberId: numberOnly && other ? other.id : null, wrongPrimary: primaryOnly,
    chips, chip, chipKind: numberOnly ? null : o.chipKind, blocked,
    reasons, reason, enroll: key === 'declined' ? ctx.enroll ?? null : null, openDeal: key === 'accepted',
    lines, toastParts: toast,
  };
}

/** "Thu, Sep 24 at 10:00 AM" in their zone, for the confirmation text. */
function fmtApptWhen(iso: string, zone: string): string {
  const t = Date.parse(iso);
  const p = partsIn(zone, t);
  return `${WEEKDAYS[p.wd]}, ${MONTHS[p.m - 1]} ${p.d} at ${clockIn(zone, t)}`;
}

/** The success toast: "John Smith: voicemail, stage Lead - No Contact, call back Fri 10:00 AM." */
export function outcomeToast(plan: OutcomePlan, opts: { demo?: boolean; textQueued?: boolean; owner?: string | null } = {}): string {
  const parts = [...plan.toastParts];
  if (opts.owner) parts.push(`the lead is ${opts.owner}’s`);
  if (opts.demo) return `${plan.name}: ${parts.join(', ')} (demo)`;
  return `${plan.name}: ${parts.join(', ')}.` + (opts.textQueued ? ' Text sending.' : '');
}

/** The rep's own zone, from the browser. */
export function repZoneNow(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}
