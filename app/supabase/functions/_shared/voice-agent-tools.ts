// The three write tools the voice agent calls mid-call: book_appointment,
// save_qualification and mark_do_not_contact. Pure: the request shapes, the
// open-slot maths, what each one writes and the words it answers with, so
// voice-agent-tools.test.ts runs them under tsx or deno. voice-agent/index.ts
// does the reads and writes; voice-agent-admin.ts sends the tool configs.
//
// Every answer is written for the agent to read out loud or act on: `ok`, and
// a `say` line (what to tell the caller) or a `note` (what to do next). A tool
// never reports success it did not have; the prompt tells the agent to only
// say a thing is booked or saved after the tool confirms it.
import { withinHours } from './voice-agent-calls.ts';
import type { Hours } from './voice-agent-settings.ts';

// ---- book_appointment ----------------------------------------------------------

export const SLOT_MINUTES = 30;
/** The soonest a slot can start, so a rep has time to see it. */
export const LEAD_MINUTES = 60;
export const DAYS_AHEAD = 7;
export const MAX_SLOTS = 6;
/** How far out a booking may be: past this the agent is told to pick a sooner time. */
export const MAX_BOOK_DAYS = 30;

export const APPOINTMENT_KINDS = { call: 'Call', walkthrough: 'Walkthrough', appointment: 'Appointment' } as const;
export type AppointmentKind = keyof typeof APPOINTMENT_KINDS;

export type Busy = { start: number; end: number };
export type Slot = { starts_at: string; label: string };

/** "Tue Oct 6, 10:30 AM CDT" in the window's own time zone. */
export function slotLabel(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The local calendar date (YYYY-MM-DD) of `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const overlaps = (a: Busy, b: Busy) => a.start < b.end && b.start < a.end;

/** Is a slot of `minutes` starting at `ms` inside the hours (start and last minute) and clear of every busy block. */
export function slotFree(ms: number, minutes: number, hours: Hours, busy: Busy[]): boolean {
  const end = ms + minutes * 60_000;
  if (!withinHours(hours, ms) || !withinHours(hours, end - 60_000)) return false;
  return !busy.some((b) => overlaps(b, { start: ms, end }));
}

// ---- deal_lookup -------------------------------------------------------------------

export const DEAL_LOOKUP_MAX = 8;
/** The deal stages a buyer can hear about: on the dispo list, not closed, not terminated. */
export const DEAL_LOOKUP_STAGES = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract'] as const;

export type DealRow = {
  id: number; stage: string | null; contract_status: string | null; arv: unknown; offer_amount: unknown; assignment_fee: unknown; target_assignment: unknown;
  marketed_price: unknown; bin_price: unknown; marketing_headline: string | null; buyer_id: unknown;
  properties: { line1: string | null; city: string | null; state: string | null; zip: string | null; beds: unknown; baths: unknown; sqft: unknown; year_built: unknown } | null;
};
export type DealForBuyer = {
  deal_id: number; address: string; asking_price: string; arv: string; beds: string; baths: string; sqft: string; year_built: string; status: string; headline: string;
};

const money = (n: unknown): string => { const x = Number(n); return Number.isFinite(x) && x > 0 ? '$' + Math.round(x).toLocaleString('en-US') : ''; };
const numStr = (n: unknown): string => { const x = Number(n); return Number.isFinite(x) && x > 0 ? String(x) : ''; };

/** What we ask buyers: the marketed price, else the buy-it-now price, else what we have it under contract for plus the assignment we want. */
export function askingPrice(d: Pick<DealRow, 'marketed_price' | 'bin_price' | 'offer_amount' | 'assignment_fee' | 'target_assignment'>): number | null {
  for (const v of [d.marketed_price, d.bin_price]) { const x = Number(v); if (Number.isFinite(x) && x > 0) return Math.round(x); }
  const base = Number(d.offer_amount);
  const fee = Number(d.target_assignment ?? d.assignment_fee);
  if (Number.isFinite(base) && base > 0 && Number.isFinite(fee) && fee > 0) return Math.round(base + fee);
  return null;
}

/** Where the deal stands, in a buyer's words. */
export function dealStatus(d: Pick<DealRow, 'stage' | 'contract_status' | 'buyer_id'>): string {
  if (d.stage === 'Buyer Under Contract' || d.buyer_id) return 'under contract with a buyer, taking backup offers';
  if (d.stage === 'Ready To Market') return 'available';
  if (d.stage === 'Under Contract Seller') return 'coming soon, we are finishing the paperwork';
  return String(d.stage ?? 'available');
}

/** The dispo list for a buyer's ears: address, ask, ARV, beds, baths; `query` narrows by address, city or ZIP. Deals with no address are left out. */
export function dealsForBuyer(rows: DealRow[], query = '', max = DEAL_LOOKUP_MAX): DealForBuyer[] {
  const q = clean(query, 80).toLowerCase();
  const out: DealForBuyer[] = [];
  for (const d of rows) {
    const p = d.properties;
    if (!p?.line1) continue;
    const address = [p.line1, p.city, p.state, p.zip].filter(Boolean).join(', ');
    if (q && !address.toLowerCase().includes(q)) continue;
    out.push({
      deal_id: Number(d.id), address, asking_price: money(askingPrice(d)), arv: money(d.arv), beds: numStr(p.beds), baths: numStr(p.baths), sqft: numStr(p.sqft), year_built: numStr(p.year_built),
      status: dealStatus(d), headline: clean(d.marketing_headline, 160),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Open times inside the agent's call hours, on the half hour, clear of the
 * rep's appointments, at least LEAD_MINUTES out. At most two a day, spread
 * across the day, so "later today or tomorrow?" has real choices on both.
 * `day` narrows to one local date (YYYY-MM-DD).
 */
export function openSlots(opts: { nowMs: number; hours: Hours; busy: Busy[]; minutes?: number; count?: number; day?: string | null; daysAhead?: number }): Slot[] {
  const minutes = opts.minutes ?? SLOT_MINUTES;
  const count = opts.count ?? MAX_SLOTS;
  const step = SLOT_MINUTES * 60_000;
  const first = Math.ceil((opts.nowMs + LEAD_MINUTES * 60_000) / step) * step;
  const last = opts.nowMs + (opts.daysAhead ?? DAYS_AHEAD) * 86_400_000;
  const byDay = new Map<string, number[]>();
  for (let t = first; t <= last; t += step) {
    const d = localDate(t, opts.hours.tz);
    if (opts.day && d !== opts.day) continue;
    if (slotFree(t, minutes, opts.hours, opts.busy)) (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t);
  }
  const out: Slot[] = [];
  for (const times of byDay.values()) {
    // One early in the day's open time and one later, or every one when a day was asked for.
    const picks = opts.day ? times : times.length > 1 ? [times[0], times[Math.floor(times.length * 0.6)]] : times;
    for (const t of picks) {
      if (out.length >= count) return out;
      if (!out.some((s) => s.starts_at === new Date(t).toISOString())) out.push({ starts_at: new Date(t).toISOString(), label: slotLabel(t, opts.hours.tz) });
    }
  }
  return out;
}

export type BookingInput = {
  starts_at: number | null;
  kind: AppointmentKind;
  day: string | null;
  notes: string;
  best_phone: string;
};

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The LLM's arguments, validated. A starts_at that does not parse is an error the agent is told about, never a guess. */
export function parseBooking(body: Record<string, unknown>): { ok: true; input: BookingInput } | { ok: false; note: string } {
  const raw = clean(body.starts_at, 64);
  let starts: number | null = null;
  if (raw) {
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return { ok: false, note: 'starts_at was not a time. Call book_appointment without starts_at to get the open times, then pass one of their starts_at values exactly.' };
    starts = t;
  }
  const k = clean(body.kind, 20).toLowerCase();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(clean(body.day, 10)) ? clean(body.day, 10) : null;
  return {
    ok: true,
    input: {
      starts_at: starts,
      kind: (k in APPOINTMENT_KINDS ? k : 'call') as AppointmentKind,
      day, notes: clean(body.notes, 600), best_phone: clean(body.best_phone, 40),
    },
  };
}

/** Why a requested time cannot be booked, or null when it can. */
export function bookingProblem(startMs: number, nowMs: number, hours: Hours, busy: Busy[], minutes = SLOT_MINUTES): string | null {
  if (startMs < nowMs + 15 * 60_000) return 'That time has passed or is too soon. Offer one of the open times instead.';
  if (startMs > nowMs + MAX_BOOK_DAYS * 86_400_000) return `That is more than ${MAX_BOOK_DAYS} days out. Offer a sooner time.`;
  if (!withinHours(hours, startMs) || !withinHours(hours, startMs + (minutes - 1) * 60_000)) return 'That time is outside our hours. Offer one of the open times instead.';
  if (busy.some((b) => overlaps(b, { start: startMs, end: startMs + minutes * 60_000 }))) return 'That time was just taken. Offer one of the other open times.';
  return null;
}

/** The appointment row the booking writes (the record's id and the workspace are added by the caller). */
export function appointmentRow(i: { startMs: number; kind: AppointmentKind; name: string | null; agentName: string; notes: string; best_phone: string; minutes?: number }) {
  const minutes = i.minutes ?? SLOT_MINUTES;
  const who = i.name?.trim() || 'caller';
  const lines = [
    `Booked by the AI agent ${i.agentName} on a phone call.`,
    i.best_phone ? `Best number: ${i.best_phone}.` : '',
    i.notes ? `Notes: ${i.notes}` : '',
  ].filter(Boolean);
  return {
    title: `${APPOINTMENT_KINDS[i.kind]} with ${who}`.slice(0, 300),
    kind: APPOINTMENT_KINDS[i.kind],
    starts_at: new Date(i.startMs).toISOString(),
    ends_at: new Date(i.startMs + minutes * 60_000).toISOString(),
    notes: lines.join('\n'),
    source: 'clozr' as const,
  };
}

// ---- save_qualification ----------------------------------------------------------

export const OUTCOMES = ['booked', 'callback', 'transferred', 'agreement_sent', 'signed', 'above_range', 'not_interested', 'wrong_person', 'do_not_contact', 'no_answer'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Every field the tool takes, with the label the activity line uses. */
export const QUAL_FIELDS = {
  motivation: 'Motivation', timeline: 'Timeline', condition: 'Condition', major_repairs: 'Major repairs', occupancy: 'Occupancy',
  tenant_status: 'Tenant status', asking_price: 'Asking price', mortgage_payoff: 'Mortgage payoff', desired_net: 'Desired net',
  range_quoted: 'Range quoted', other_offers: 'Other offers', decision_factors: 'Decision factors', decision_makers: 'Decision makers',
  appointment_time: 'Appointment time', best_phone: 'Best phone', email: 'Email', callback_preference: 'Callback preference',
  offer_property: 'Offer on', offer_amount: 'Offer amount', notes: 'Notes',
} as const;
export type QualField = keyof typeof QUAL_FIELDS;

/** Seller columns a qualification fills (only when blank). The rest go into sellers.intake. */
const SELLER_COLUMN: Partial<Record<QualField, string>> = {
  motivation: 'motivation', timeline: 'timeline', condition: 'condition', occupancy: 'occupancy', mortgage_payoff: 'mortgage',
  decision_makers: 'decision_makers', email: 'email',
};
const INTAKE_KEYS: QualField[] = ['major_repairs', 'tenant_status', 'desired_net', 'range_quoted', 'other_offers', 'decision_factors', 'callback_preference'];

export type Qualification = { values: Partial<Record<QualField, string>>; outcome: Outcome | null };

export function parseQualification(body: Record<string, unknown>): Qualification {
  const values: Partial<Record<QualField, string>> = {};
  for (const k of Object.keys(QUAL_FIELDS) as QualField[]) {
    const v = clean(body[k], k === 'notes' ? 1500 : 400);
    if (v && !/^(n\/?a|none|unknown|null|undefined|-)$/i.test(v)) values[k] = v;
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) delete values.email;
  const o = clean(body.outcome, 40).toLowerCase().replace(/[\s-]+/g, '_');
  return { values, outcome: (OUTCOMES as readonly string[]).includes(o) ? o as Outcome : null };
}

/** A dollar figure out of "about 210 thousand", "$210,000" or "210k"; null when there is none. */
export function moneyOf(text: string | undefined): number | null {
  const t = String(text ?? '').toLowerCase().replace(/,/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?\b/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === 'k' || m[2] === 'thousand') n *= 1_000;
  if (m[2] === 'm' || m[2] === 'million') n *= 1_000_000;
  return n >= 1_000 && n < 100_000_000 ? Math.round(n) : null;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim());

export type QualificationWrite = {
  /** Seller columns to update (blank ones only). Empty for a buyer. */
  patch: Record<string, unknown>;
  /** What was kept because the record already said something else: label, on file, heard. */
  kept: { label: string; on_file: string; heard: string }[];
  /** The activity line: title and body. */
  title: string;
  body: string;
};

/**
 * What a qualification writes. Blank seller columns are filled; a column that
 * already says something else is left as the rep wrote it and the difference
 * is listed in the activity line instead, so a rep reads both. Answers with no
 * column go into sellers.intake, again only when blank.
 */
export function qualificationWrite(kind: 'seller' | 'buyer', q: Qualification, current: Record<string, unknown>, agentName: string): QualificationWrite {
  const patch: Record<string, unknown> = {};
  const kept: QualificationWrite['kept'] = [];
  if (kind === 'seller') {
    for (const [field, col] of Object.entries(SELLER_COLUMN) as [QualField, string][]) {
      const heard = q.values[field];
      if (!heard) continue;
      if (blank(current[col])) patch[col] = heard;
      else if (String(current[col]).trim().toLowerCase() !== heard.toLowerCase()) kept.push({ label: QUAL_FIELDS[field], on_file: String(current[col]).slice(0, 200), heard });
    }
    const asking = moneyOf(q.values.asking_price);
    if (asking !== null) {
      const cur = Number(current.asking_price);
      if (!Number.isFinite(cur) || cur <= 0) patch.asking_price = asking;
      else if (cur !== asking) kept.push({ label: 'Asking price', on_file: String(cur), heard: q.values.asking_price! });
    }
    const intakeNow = current.intake && typeof current.intake === 'object' && !Array.isArray(current.intake) ? current.intake as Record<string, unknown> : {};
    const intake = { ...intakeNow };
    let changed = false;
    for (const k of INTAKE_KEYS) {
      const heard = q.values[k];
      if (heard && blank(intake[k])) { intake[k] = heard; changed = true; }
    }
    if (changed) patch.intake = intake;
  }
  const lines = (Object.keys(QUAL_FIELDS) as QualField[]).filter((k) => q.values[k]).map((k) => `${QUAL_FIELDS[k]}: ${q.values[k]}`);
  if (kept.length) lines.push('', 'Kept what was on file (the call said something else):', ...kept.map((x) => `${x.label}: on file "${x.on_file}", heard "${x.heard}"`));
  const outcome = q.outcome ? q.outcome.replace(/_/g, ' ') : null;
  return {
    patch, kept,
    title: `AI agent ${agentName} · qualification saved${outcome ? ` · ${outcome}` : ''}`.slice(0, 200),
    body: (lines.join('\n') || 'Nothing new was learned.').slice(0, 4000),
  };
}

// ---- mark_do_not_contact ----------------------------------------------------------

export const DNC_TAG = 'DNC';

/** The tags with DNC added, or null when one of them already says do not contact. */
export function withDncTag(tags: readonly string[] | null | undefined, isDnc: (t: readonly string[] | null | undefined) => boolean): string[] | null {
  const list = [...(tags ?? [])];
  if (isDnc(list)) return null;
  return [...list, DNC_TAG];
}

/**
 * The contact_opt_outs row (migration 228) for a caller who asked not to be
 * contacted. Keyed by the number, so it holds with a record behind it or
 * without one: a caller nobody has on file is still opted out.
 */
export function optOutRow(ws: number, phoneKey: string, reason: string, c: { kind: 'seller' | 'buyer'; id: number } | null) {
  return { workspace_id: ws, phone_key: phoneKey, channel: 'call', said: reason, record_kind: c?.kind ?? null, record_id: c?.id ?? null };
}

// ---- ElevenLabs tool configs -------------------------------------------------------

/** The ElevenLabs tool name of each write tool, and the route that serves it. */
export const WRITE_TOOLS = {
  book_appointment: { route: 'book-appointment' },
  save_qualification: { route: 'save-qualification' },
  mark_do_not_contact: { route: 'mark-do-not-contact' },
  get_compr_offer: { route: 'get-compr-offer' },
  deal_lookup: { route: 'deal-lookup' },
} as const;
export type WriteTool = keyof typeof WRITE_TOOLS;

const SYSTEM_PROPS = {
  caller_id: { type: 'string', dynamic_variable: 'system__caller_id' },
  called_number: { type: 'string', dynamic_variable: 'system__called_number' },
  agent_id: { type: 'string', dynamic_variable: 'system__agent_id' },
  conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
  // Ours, not a system variable: a console test says so here (isTestCall), and the tool writes nothing.
  call_goal: { type: 'string', dynamic_variable: 'call_goal' },
};

/**
 * The condition words COMPR's underwrite API takes as condition_self, its condition override
 * (move_in, cosmetic, medium, heavy, gut). From the caller's own description it sets the
 * rehab scope when COMPR has no interior photos, and can only raise a photo-graded scope.
 */
export const REHAB_LEVELS = ['move-in ready', 'needs paint & carpet', 'needs kitchen or bath', 'needs everything', 'uninhabitable'] as const;
export type RehabLevel = (typeof REHAB_LEVELS)[number];

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });

const TOOL_DEFS: Record<WriteTool, { description: string; properties: Record<string, unknown> }> = {
  book_appointment: {
    description: 'Get real open times, then book one. Call it first WITHOUT starts_at: it returns open times (starts_at and a label to read out). Offer two. When the caller picks one, call it again WITH that exact starts_at to book. Only tell the caller they are booked when this returns booked: true.',
    properties: {
      starts_at: str('Leave empty to get open times. To book: the exact starts_at value of the open time the caller chose, copied from the earlier result.'),
      day: str('Optional, when the caller wants a particular day: that day as YYYY-MM-DD. Only for getting open times.'),
      kind: str('What is being booked: call (a callback from the team), walkthrough (someone visits the property) or appointment.', { enum: ['call', 'walkthrough', 'appointment'] }),
      best_phone: str('The best number to reach them at, as they confirmed it. Empty if they did not give one.'),
      notes: str('One or two sentences for the rep: what the appointment is about and anything they asked for.'),
      contact_name: str("The caller's name: when several people share the number, or when the caller has no record yet"),
      property_address: str('Only for a caller with no record yet: the property address they gave, street, city and state.'),
    },
  },
  save_qualification: {
    description: 'Save what you learned on this call to the lead\'s record before you end the call. Fill only what the caller actually said; leave the rest empty. Never guess.',
    properties: {
      motivation: str('Why they might sell, in their words.'), timeline: str('When they want or need to sell.'),
      condition: str('The condition of the property.'), major_repairs: str('Major repairs needed (roof, foundation, HVAC, plumbing, electrical).'),
      occupancy: str('Who lives there: owner, tenant, vacant.'), tenant_status: str('If tenanted: lease terms, rent, whether the tenant will stay.'),
      asking_price: str('The price the seller said they want, as they said it.'), mortgage_payoff: str('What they owe on the mortgage.'),
      desired_net: str('What they want to walk away with.'), range_quoted: str('The price range you quoted, if any.'),
      other_offers: str('Other offers or agents they mentioned.'), decision_factors: str('What matters most to them in deciding.'),
      decision_makers: str('Who else decides (spouse, siblings, heirs).'), appointment_time: str('The appointment or callback time agreed, as said.'),
      best_phone: str('The best phone number they confirmed.'), email: str('Their email address, if they gave one.'),
      callback_preference: str('When and how they prefer to be contacted.'),
      offer_property: str('A buyer only: the address of our deal they made an offer on, as deal_lookup returned it.'),
      offer_amount: str('A buyer only: the amount they offered on that deal, as they said it.'),
      notes: str('Anything else the rep should know, in one or two sentences.'),
      outcome: str('How the call ended.', { enum: [...OUTCOMES] }),
      contact_name: str("The caller's name: when several people share the number, or when the caller has no record yet"),
      property_address: str('Only for a caller with no record yet: the property address they gave, street, city and state.'),
    },
  },
  get_compr_offer: {
    description: 'Get the offer range COMPR underwrites for the seller\'s house. Ask about the condition first and pass it as rehab_level: COMPR prices the repairs from it, so the offer is accurate. COMPR takes about a minute. Call it once you know the basics (why, timeline, condition, occupancy), before you say any number. If it answers ready: false, keep the conversation going and call it again in about a minute with the same property_address and rehab_level. Never say a price until it answers ready: true, and then only inside offer_low to offer_high.',
    properties: {
      rehab_level: str('How much work the house needs, from what the caller said about its condition. Pick the closest.', { enum: [...REHAB_LEVELS] }),
      property_address: str('The full address (street, city, state, and ZIP if they gave it) when the caller names a house that is not the one on file, or when there is no address on file.'),
      contact_name: str("The caller's name, only when several people share the number"),
    },
  },
  deal_lookup: {
    description: 'Our properties for sale right now (the dispo list): address, asking price, ARV, beds, baths, square feet and where each one stands. Call it when a buyer asks what we have, asks about a property, or names an address; pass query to narrow it. Quote only what it returns. To take an offer, note it with save_qualification (offer_property, offer_amount).',
    properties: {
      query: str('Optional: an address, street, city or ZIP to narrow the list. Empty for everything we have.'),
    },
  },
  mark_do_not_contact: {
    description: 'Record that the person asked not to be contacted again. Call it as soon as they ask, then end the call politely.',
    properties: {
      reason: str('What they said, in a few words.'),
      contact_name: str("The caller's name, only when several people share the number"),
    },
  },
};

/** The webhook tool body for one write tool, POSTing to its route with the shared tool secret. */
export function writeToolBody(tool: WriteTool, baseUrl: string, header: string, secret: string) {
  const def = TOOL_DEFS[tool];
  return {
    tool_config: {
      type: 'webhook',
      name: tool,
      description: def.description,
      response_timeout_secs: 20,
      api_schema: {
        url: `${baseUrl.replace(/\/+$/, '')}/tool/${WRITE_TOOLS[tool].route}`,
        method: 'POST',
        content_type: 'application/json',
        request_headers: { [header]: secret },
        request_body_schema: { type: 'object', required: ['caller_id', 'called_number'], properties: { ...SYSTEM_PROPS, ...def.properties } },
      },
    },
  };
}
