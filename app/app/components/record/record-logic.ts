// The seller record's pure rules: where a stage sits on the five-step bar,
// which stages are likely next, and what the Make offer sheet may promise.
// No React here, so tools/record-stage.test.ts can run it with tsx.

import { sellerStageGroup, type SellerStageGroup } from '../../../lib/stages';
import { parseDollars } from '../../../lib/money';

/** The bar the record draws: every stage the business walks lands on one of these. */
export const STAGE_STEPS = ['Lead', 'Working', 'Offer', 'Contract', 'Closed'] as const;
export type StageStep = (typeof STAGE_STEPS)[number];

/** The demo's twelve sample stages, which are not in the live seller list. */
const DEMO_GROUPS: Record<string, SellerStageGroup> = {
  'New Lead': 'lead',
  Contacted: 'working', Qualified: 'working', Appointment: 'working',
  'Offer Sent': 'offer', Negotiation: 'offer',
  'Under Contract': 'contract', Dispo: 'contract', Assigned: 'contract', Closing: 'contract',
  Closed: 'closed',
  Lost: 'dead',
};

const ON_PATH: SellerStageGroup[] = ['lead', 'working', 'offer', 'contract', 'closed'];

/** The group a stage belongs to, for either list. */
export const stageGroup = (stage: string): SellerStageGroup => DEMO_GROUPS[stage] ?? sellerStageGroup(stage);

export type StageBar = {
  /** Which of the five steps the stage sits on, or null when it is off the path (dead, refund, referral, other). */
  index: number | null;
  offPath: boolean;
  /** What the bar says in words: "Offer" or "Off the path · Ghosted". */
  label: string;
  steps: { label: StageStep; state: 'done' | 'current' | 'todo' }[];
};

export function stageBar(stage: string): StageBar {
  const i = ON_PATH.indexOf(stageGroup(stage));
  const index = i >= 0 ? i : null;
  return {
    index,
    offPath: index === null,
    label: index === null ? 'Off the path · ' + stage : STAGE_STEPS[index],
    steps: STAGE_STEPS.map((label, k) => ({
      label,
      state: index === null ? 'todo' : k < index ? 'done' : k === index ? 'current' : 'todo',
    })),
  };
}

/** Acquisition, in order. Memo is not a stage on this path. */
export const ACQ_STAGES = ['Underwriting', 'Underwriting Complete', 'Offer Made'] as const;
/** After an offer is out, the next stage is one of these. */
export const OFFER_FORK = ['Offer Accepted', 'Offer Declined'] as const;
/** Once under contract, the next stage is the deal's, in this order. */
export const DEAL_PATH = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed'] as const;

const OFFER_OUT = new Set([
  'Make Offer', 'Offer Made', 'Pending Response', 'Offer Made - Follow Up', 'Offer Made - Retail', 'Pending Inspections',
  'Offer Sent', 'Negotiation',
]);
const DEMO_CONTRACT = new Set(['Under Contract', 'Dispo', 'Assigned', 'Closing']);
const ACCEPT_RE = /\b(accept|comfortable with the price|we(?:'|’)ll take|let(?:'|’)s do it|move forward)\b/i;
const DECLINE_RE = /\b(declin|not interested|no thanks|pass on|rejected the offer)\b/i;

export type ActivityHit = { type: string; title?: string; body?: string };

export type StageRead = {
  stage: string;
  dealStage?: string | null;
  offerAmount?: string | null;
  activity: ActivityHit[];
};

export type StagePick = {
  stage: string | null;
  reason: string;
  chips: string[];
};

const hitText = (a: ActivityHit) => `${a.type} ${a.title ?? ''} ${a.body ?? ''}`;

function dealAt(stage: string, dealStage?: string | null): number {
  if (dealStage && (DEAL_PATH as readonly string[]).includes(dealStage)) return DEAL_PATH.indexOf(dealStage as (typeof DEAL_PATH)[number]);
  if (stage === 'Under Contract - Buyer' || stage === 'Assigned') return DEAL_PATH.indexOf('Buyer Under Contract');
  if (stage === 'Closing') return DEAL_PATH.indexOf('In Escrow');
  if (stage === 'Dispo') return DEAL_PATH.indexOf('Ready To Market');
  if (stage === 'Memo Filed / Legal' || stage === 'Under Contract - Seller' || stage === 'Contract Sent to Seller' || stage === 'Under Contract' || stage === 'Offer Accepted') {
    return DEAL_PATH.indexOf('Under Contract Seller');
  }
  return -1;
}

/**
 * The likely next stage from the activity, not from the next row in the
 * stage list. Memo Filed is never a suggestion. Before a contract the path
 * is underwrite, underwrite complete, offer made, then accepted or declined.
 * Under contract, the suggestion is the next deal stage.
 */
export function recommendStage(read: StageRead): StagePick {
  const g = stageGroup(read.stage);
  if (g === 'closed' || read.stage === 'Closed' || read.dealStage === 'Closed') {
    return { stage: null, reason: 'Closed. Nothing further on the path.', chips: [] };
  }
  if (g === 'dead' || g === 'refund' || read.stage === 'Lost' || read.stage === 'Offer Declined' || read.stage === 'Underwrite Declined') {
    return { stage: null, reason: 'Off the path.', chips: [] };
  }

  // Entry by entry, stopping at the first hit: no pattern spans two entries,
  // and joining a record's every email body into one string first cost
  // hundreds of milliseconds on a busy record.
  const said = (re: RegExp) => read.activity.some((a) => re.test(hitText(a)));
  const hasCompr = read.activity.some((a) => a.type === 'compr') || said(/underwrit|compr|\barv\b/i);
  const offerTouched = read.activity.some((a) => a.type === 'offer') || said(/\boffer\b/i)
    || !!(read.offerAmount && !/^(—|no offer)/i.test(read.offerAmount));
  const accepted = said(ACCEPT_RE) || read.stage === 'Offer Accepted';
  const declined = said(DECLINE_RE);

  if (read.stage === 'Offer Accepted') {
    return { stage: 'Under Contract Seller', reason: 'Offer accepted. Next is the deal: Under Contract Seller.', chips: ['Under Contract Seller'] };
  }

  const onContract = g === 'contract' || DEMO_CONTRACT.has(read.stage) || read.stage === 'Memo Filed / Legal'
    || (!!read.dealStage && (DEAL_PATH as readonly string[]).includes(read.dealStage) && read.dealStage !== 'Under Contract Seller');
  if (onContract) {
    const i = dealAt(read.stage, read.dealStage);
    const next = i >= 0 && i < DEAL_PATH.length - 1 ? DEAL_PATH[i + 1] : null;
    if (!next) return { stage: null, reason: 'End of the deal path.', chips: [] };
    return { stage: next, reason: `Under contract. The deal’s next stage is ${next}.`, chips: [next] };
  }

  if (accepted && (offerTouched || OFFER_OUT.has(read.stage) || read.stage === 'Offer Accepted')) {
    return { stage: 'Offer Accepted', reason: 'The activity leans yes on the offer. Likely next is Offer Accepted.', chips: ['Offer Accepted'] };
  }

  const offerOut = offerTouched || OFFER_OUT.has(read.stage);
  const stillUnderwriting = read.stage === 'Underwriting' || read.stage === 'Underwriting Complete' || read.stage === 'Underwriting - Need Info';
  if (offerOut && !stillUnderwriting) {
    if (declined && !accepted) {
      return { stage: 'Offer Declined', reason: 'The activity reads as a no. Likely next is Offer Declined.', chips: ['Offer Declined', 'Offer Accepted'] };
    }
    return {
      stage: 'Offer Accepted',
      reason: 'An offer is out. Next is Offer Accepted or Offer Declined, from how the conversation goes.',
      chips: ['Offer Accepted', 'Offer Declined'],
    };
  }

  if (read.stage === 'Underwriting Complete' || (hasCompr && (read.stage === 'Underwriting' || read.stage === 'Underwriting - Need Info'))) {
    return { stage: 'Offer Made', reason: 'The underwrite is done. Next is Offer Made.', chips: ['Offer Made'] };
  }
  if (hasCompr) {
    return { stage: 'Underwriting Complete', reason: 'A COMPR report is on the file. Likely next is Underwriting Complete.', chips: ['Underwriting Complete'] };
  }
  if (read.stage === 'Underwriting' || read.stage === 'Underwriting - Need Info') {
    return { stage: 'Underwriting Complete', reason: 'Underwrite is open. Next is Underwriting Complete.', chips: ['Underwriting Complete'] };
  }
  return { stage: 'Underwriting', reason: 'No underwrite on the activity yet. Likely next is Underwriting.', chips: ['Underwriting'] };
}

/** Chips for a stage with no activity yet: the path, never Memo. */
export function likelyNext(stage: string, _list?: readonly string[]): string[] {
  return recommendStage({ stage, activity: [] }).chips;
}

export type OfferCopy = {
  /** The one line under the amount that says how it travels. */
  sendBy: string;
  /** "When you send": what happens, in order. */
  when: string[];
  /** The primary button. */
  action: string;
};

/**
 * What the Make offer sheet says. Making an offer on the record logs it: the
 * amount goes on the deal as its offer price and on the timeline, and the
 * record moves to Offer Made. No letter is drafted and nobody is pinged.
 */
export function offerCopy(o: { live: boolean }): OfferCopy {
  const when = [
    'The offer is logged on the timeline and goes on the deal as its offer price.',
    'The record moves to Offer Made.',
    'Nothing is sent and no letter is drafted.',
  ];
  if (!o.live) when.push('This is the demo: nothing is saved.');
  return { sendBy: 'Logs it now.', when, action: 'Log offer' };
}

/**
 * "$231,500", "231500", "231.5k" or "1.2m" as whole dollars (lib/money); null
 * when it is not an amount. "185k" used to read as $185, and the offers
 * trigger then moved the seller to Offer Made on a $185 offer.
 */
export function parseMoney(raw: string): number | null {
  const r = parseDollars(raw);
  if (r.error || r.value === null) return null;
  const n = Math.round(r.value);
  return n > 0 ? n : null;
}

/**
 * What the low/high offer field should write when it blurs.
 * `keep` means the text was empty already, unchanged, or not a number.
 * `null` clears a number that was there. A number replaces it.
 */
export function nextOfferBand(current: number | null, raw: string): number | null | 'keep' {
  const t = raw.trim();
  if (!t || t === '—') return current == null ? 'keep' : null;
  const n = parseMoney(t);
  if (n == null || n === current) return 'keep';
  return n;
}

/** The record's composer form (Composer.tsx); single-letter keys never fire from inside it. */
export const RECORD_COMPOSER = '[data-testid="record-composer"]';

/**
 * Whether a single-letter record shortcut may run for this key event.
 * Never while typing (inputs, textareas, selects, contenteditable), never
 * with a modifier, never mid-IME composition or on auto-repeat. Never from
 * anything inside the composer either: after a click on Save note the focus
 * sits on that button, and the next note starting "Called back…" dialed.
 */
export function shortcutAllowed(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number; defaultPrevented?: boolean },
  target: { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  const tag = (target?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME' || target?.isContentEditable) return false;
  if (target?.closest?.(RECORD_COMPOSER)) return false;
  return true;
}
