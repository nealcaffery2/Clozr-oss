// "From this call": the dialer's side of the call-profile edge function.
//
// While a call with no CLOZR record is up (or a buyer whose buy box has gaps),
// the dialer sends the live transcript to `call-profile` and shows who the
// caller seems to be and what they said they buy. Nothing here writes: the
// rep opens a form filled from it (the buyer profile, or Quick Add) and saves
// it there, or does not. The parsing and merging rules live in the edge
// function's pure module so both sides run the same code.

import {
  BUYER_TYPE_CODES, emptyProfile, filledFields, mergeProfiles, parseCallProfile, transcriptText,
  type CallProfile, type ProfileField, type ProfileKind,
} from '../supabase/functions/_shared/call-profile';
import {
  BUYER_TYPES, FUNDING, PROPERTY_TYPES, REHAB_LEVELS, STRATEGIES, emptyBuyBox, labelOf, normalizeBuyBox,
  type BuyBox, type LocationPref,
} from './buyer-profile';
import { stateCodeOf } from './place-names';
import { supabase } from './supabase';

export { emptyProfile, filledFields, mergeProfiles, parseCallProfile, transcriptText };
export type { CallProfile, ProfileField, ProfileKind };

/** The kinds the rep can pick, in chip order. */
export const PICKABLE_KINDS: ReadonlyArray<{ kind: Exclude<ProfileKind, 'unknown'>; label: string; action: string }> = [
  { kind: 'buyer', label: 'Buyer', action: 'Create buyer profile' },
  { kind: 'seller', label: 'Seller', action: 'Create seller lead' },
  { kind: 'agent', label: 'Agent', action: 'Create agent contact' },
  { kind: 'wholesaler', label: 'Wholesaler', action: 'Create wholesaler contact' },
  { kind: 'vendor', label: 'Vendor', action: 'Create vendor' },
];

export type ProfileLine = { rep: boolean; text: string };

type AskResult = { ok: true; profile: CallProfile } | { ok: false; message: string };

/** One ask of the edge function. */
export async function askCallProfile(input: {
  workspaceId: number; lines: readonly ProfileLine[]; repLabel: string; phone: string | null; knownKind: ProfileKind | null;
}): Promise<AskResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('call-profile', {
    body: {
      workspace_id: input.workspaceId,
      // The function reads only the last 6,000 characters; no need to send more.
      transcript: transcriptText(input.lines).slice(-8000),
      rep_label: input.repLabel,
      phone: input.phone ?? undefined,
      known_kind: input.knownKind ?? undefined,
    },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; profile?: unknown; error?: string };
  // Parsed again here: the evidence check is cheap and the function may be an older deploy.
  return r?.ok ? { ok: true, profile: parseCallProfile(r.profile ?? {}, transcriptText(input.lines)) } : { ok: false, message: r?.error ?? 'No profile came back.' };
}

// ---- what the card shows ---------------------------------------------------------------

const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `$${Math.round(n / 1000)}K`);

export function priceLabel(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${money(min)} – ${money(max)}`;
  if (max != null) return `Up to ${money(max)}`;
  if (min != null) return `From ${money(min)}`;
  return '';
}

export const BUYER_TYPE_LABEL = (code: string) => labelOf(BUYER_TYPES, code);

export const FIELD_LABELS: Record<ProfileField, string> = {
  name: 'Name', company: 'Company', email: 'Email', buyerType: 'Buyer type', markets: 'Markets', price: 'Price',
  propertyTypes: 'Property type', strategies: 'Strategy', rehabTolerance: 'Rehab', closingDays: 'Closes in', funding: 'Funding',
};

/** The buy-box fields; the rest are contact details. */
export const BUY_BOX_FIELDS: readonly ProfileField[] = ['buyerType', 'markets', 'price', 'propertyTypes', 'strategies', 'rehabTolerance', 'closingDays', 'funding'];

export type ProfileRow = { field: ProfileField; label: string; value: string; quote: string };

export function profileRows(p: CallProfile): ProfileRow[] {
  const b = p.buyBox;
  const value = (f: ProfileField): string => {
    switch (f) {
      case 'name': return p.name ?? '';
      case 'company': return p.company ?? '';
      case 'email': return p.email ?? '';
      case 'buyerType': return p.buyerType ? BUYER_TYPE_LABEL(p.buyerType) : '';
      case 'markets': return b.markets.join(', ');
      case 'price': return priceLabel(b.priceMin, b.priceMax);
      case 'propertyTypes': return b.propertyTypes.map((c) => labelOf(PROPERTY_TYPES, c)).join(', ');
      case 'strategies': return b.strategies.map((c) => labelOf(STRATEGIES, c)).join(', ');
      case 'rehabTolerance': return b.rehabTolerance ? `Up to ${labelOf(REHAB_LEVELS, b.rehabTolerance).toLowerCase()}` : '';
      case 'closingDays': return b.closingDays != null ? `${b.closingDays} day${b.closingDays === 1 ? '' : 's'}` : '';
      case 'funding': return b.funding.map((c) => labelOf(FUNDING, c)).join(', ');
    }
  };
  return filledFields(p).map((f) => ({ field: f, label: FIELD_LABELS[f], value: value(f), quote: p.evidence[f] ?? '' }));
}

// ---- what a form opens with -----------------------------------------------------------

/** What the buyer profile form (components/BuyerProfileModal) opens pre-filled with. */
export type BuyerProfileSeed = {
  name?: string; company?: string; phone?: string; email?: string; buyer_type?: string; notes?: string;
  box?: BuyBox;
};

/** "San Antonio", "Bexar County", "78209", "TX", "Austin, TX" as a buy-box location. */
export function marketPref(raw: string): LocationPref {
  const m = raw.trim();
  if (/^\d{5}$/.test(m)) return { name: m, type: 'zip' };
  const st = stateCodeOf(m);
  if (st) return { name: st, type: 'state' };
  const [name, tail] = m.split(',').map((x) => x.trim());
  const tailState = stateCodeOf(tail);
  return { name, type: /\bcounty$/i.test(name) ? 'county' : 'city', ...(tailState ? { state: tailState } : {}) };
}

/**
 * The buy box the call described, in the shape buyers.criteria stores.
 * `gaps`: for filling an existing buyer's box, so no type the call never
 * named (emptyBuyBox's single family) gets added to it.
 */
export function profileBuyBox(p: CallProfile, opts: { gaps?: boolean } = {}): BuyBox {
  const b = p.buyBox;
  const box = emptyBuyBox();
  return normalizeBuyBox({
    ...box,
    location_prefs: b.markets.map(marketPref),
    price: { min: b.priceMin, max: b.priceMax },
    // emptyBuyBox starts on single family; the call's types replace that.
    property_types: b.propertyTypes.length || opts.gaps ? b.propertyTypes : box.property_types,
    strategies: b.strategies,
    economics: { ...box.economics, funding: b.funding, close_days: b.closingDays, max_rehab_level: b.rehabTolerance },
  });
}

/** The notes line for a new record: the call's notes plus what has no field of its own on that form. */
export function profileNotes(p: CallProfile, opts: { withBuyBox?: boolean } = {}): string {
  const extra: string[] = [];
  if (opts.withBuyBox) {
    for (const r of profileRows(p)) if (['propertyTypes', 'strategies', 'rehabTolerance', 'closingDays', 'funding'].includes(r.field)) extra.push(`${r.label}: ${r.value}.`);
  }
  return [p.notes ?? '', ...extra].filter(Boolean).join(' ').trim();
}

export function buyerSeed(p: CallProfile, phone: string | null): BuyerProfileSeed {
  return {
    ...(p.name ? { name: p.name } : {}),
    ...(p.company ? { company: p.company } : {}),
    ...(phone ? { phone } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(p.buyerType && (BUYER_TYPE_CODES as readonly string[]).includes(p.buyerType) ? { buyer_type: p.buyerType } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
    box: profileBuyBox(p),
  };
}

/**
 * An existing buy box with the call's answers in its empty places only: a
 * location, a price end, a strategy or a funding source the record already
 * has stays as it is.
 */
export function fillBuyBoxGaps(current: BuyBox, fromCall: BuyBox): BuyBox {
  const box = normalizeBuyBox(current);
  const add = normalizeBuyBox(fromCall);
  const e = box.economics;
  return normalizeBuyBox({
    ...box,
    location_prefs: box.location_prefs.length ? box.location_prefs : add.location_prefs,
    price: { min: box.price.min ?? add.price.min ?? null, max: box.price.max ?? add.price.max ?? null },
    strategies: box.strategies.length ? box.strategies : add.strategies,
    // A stored box always has a type (single family by default), so the types the call named join it.
    property_types: Array.from(new Set([...box.property_types, ...add.property_types])),
    economics: {
      ...e,
      funding: e.funding?.length ? e.funding : add.economics.funding,
      close_days: e.close_days ?? add.economics.close_days ?? null,
      max_rehab_level: e.max_rehab_level ?? add.economics.max_rehab_level ?? null,
    },
  });
}

/** Quick Add's buyer type is a word its save path turns into a code ("Flipper" → flipper). */
const QUICK_TYPE: Record<string, string> = { developer: 'Developer', landlord: 'Landlord', flipper: 'Flipper', institutional: 'Institutional', fund: 'Fund', investor: 'Investor', wholesaler: 'Wholesaler', agent: 'Agent' };

/** The Quick Add form (useClozr ADD_SPECS) for a kind, filled from the call. */
export function quickAddSeed(kind: Exclude<ProfileKind, 'unknown'>, p: CallProfile, phone: string | null): { addKind: 'buyer' | 'seller' | 'vendor'; seed: Record<string, string> } {
  const base: Record<string, string> = {};
  if (phone) base.phone = phone;
  if (p.email) base.email = p.email;
  if (kind === 'buyer') {
    const b = p.buyBox;
    return {
      addKind: 'buyer',
      seed: {
        ...base,
        ...(p.name ? { name: p.name } : {}),
        ...(p.company ? { company: p.company } : {}),
        ...(p.buyerType ? { type: QUICK_TYPE[p.buyerType] ?? p.buyerType } : {}),
        ...(b.markets.length ? { markets: b.markets.join(', ') } : {}),
        ...(b.priceMin != null || b.priceMax != null ? { price: priceLabel(b.priceMin, b.priceMax) } : {}),
        ...(profileNotes(p, { withBuyBox: true }) ? { note: profileNotes(p, { withBuyBox: true }) } : {}),
      },
    };
  }
  if (kind === 'seller') {
    return { addKind: 'seller', seed: { ...base, ...(p.name ? { name: p.name } : {}), ...(p.notes ? { motivation: p.notes.slice(0, 120) } : {}) } };
  }
  const vendorKind = kind === 'agent' ? 'Realtor' : kind === 'wholesaler' ? 'Wholesaler' : '';
  return {
    addKind: 'vendor',
    seed: {
      ...base,
      // A vendor is a company; a one-person shop is filed under the person.
      ...(p.company || p.name ? { name: p.company || p.name || '' } : {}),
      ...(p.name && p.company ? { contact: p.name } : {}),
      ...(vendorKind ? { kind: vendorKind } : {}),
      ...(p.notes ? { note: p.notes } : {}),
    },
  };
}

/** Buy-box facts a buyer record is missing, by the labels the card uses. */
export function buyerGaps(b: { markets: readonly string[]; price: string; strategy: string; type: string }): string[] {
  const blank = (v: string) => !v || v === '—';
  return [
    ...(b.markets.length ? [] : ['Markets']),
    ...(blank(b.price) ? ['Price'] : []),
    ...(blank(b.strategy) ? ['Strategy'] : []),
    ...(blank(b.type) ? ['Property type'] : []),
  ];
}

// ---- the sample-data demo -------------------------------------------------------------

/**
 * The demo's call to a number with no record: a cash buyer calling about a
 * text. Eight lines, one every four seconds, like the seller script.
 */
export const DEMO_BUYER_LINES: ReadonlyArray<[rep: boolean, text: string]> = [
  [true, 'Acme Homes, this is Taylor.'],
  [false, 'Hey Taylor, Marcus Reed with Alamo Ridge Homes. I got your text about the house on Pecan Street.'],
  [true, 'Thanks for calling back. What are you buying right now?'],
  [false, 'Mostly flips in San Antonio and New Braunfels. Single family, some townhomes.'],
  [true, 'What price range works for you?'],
  [false, "Anywhere from 120 to 180. I'll take a heavy rehab, just no foundation work."],
  [true, 'How do you fund, and how fast can you close?'],
  [false, 'Cash, and I can close in ten days. Send deals to marcus at alamoridge dot com.'],
];

/** What the model would answer for the demo call, field by field, with the line each comes from. */
const DEMO_ANSWER: ReadonlyArray<{ line: number; patch: (r: Record<string, unknown>) => void }> = [
  { line: 1, patch: (r) => { r.kind = 'buyer'; r.confidence = 0.7; r.name = 'Marcus Reed'; r.company = 'Alamo Ridge Homes'; Object.assign(r.evidence as object, { name: 'Marcus Reed with Alamo Ridge Homes', company: 'Marcus Reed with Alamo Ridge Homes' }); } },
  { line: 3, patch: (r) => {
    r.confidence = 0.9; r.buyerType = 'flipper';
    Object.assign(r.buyBox as object, { markets: ['San Antonio', 'New Braunfels'], propertyTypes: ['single_family', 'townhouse'], strategies: ['fix_and_flip'] });
    Object.assign(r.evidence as object, { buyerType: 'Mostly flips', markets: 'Mostly flips in San Antonio and New Braunfels', propertyTypes: 'Single family, some townhomes', strategies: 'Mostly flips' });
  } },
  { line: 5, patch: (r) => {
    Object.assign(r.buyBox as object, { priceMin: 120000, priceMax: 180000, rehabTolerance: 'heavy' });
    Object.assign(r.evidence as object, { price: 'Anywhere from 120 to 180', rehabTolerance: "I'll take a heavy rehab" });
    r.notes = 'Will not take foundation work.';
  } },
  { line: 7, patch: (r) => {
    r.confidence = 0.95; r.email = 'marcus@alamoridge.com';
    Object.assign(r.buyBox as object, { funding: ['cash'], closingDays: 10 });
    Object.assign(r.evidence as object, { funding: 'Cash, and I can close in ten days', closingDays: 'I can close in ten days', email: 'marcus at alamoridge dot com' });
    r.notes = 'Will not take foundation work. Wants deals sent by email.';
  } },
];

/** The demo call's profile after `heard` lines, run through the same checks a real answer gets. */
export function demoCallProfile(heard: number): CallProfile {
  const lines = DEMO_BUYER_LINES.slice(0, heard).map(([rep, text]) => ({ rep, text }));
  const raw: Record<string, unknown> = { kind: 'unknown', confidence: 0, buyBox: {}, evidence: {} };
  for (const step of DEMO_ANSWER) if (step.line < heard) step.patch(raw);
  return parseCallProfile(raw, transcriptText(lines));
}
