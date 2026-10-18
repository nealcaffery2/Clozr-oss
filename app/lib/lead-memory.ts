// Lead memory (migration 110): the brief and facts every channel reads.
//
// Pure: no imports, so the browser card, the lead-memory edge function and
// the voice agent (Deno) share one definition of what a memory is, how raw
// model output is cleaned, and the deterministic fallback used when there is
// no ANTHROPIC_API_KEY or the model call fails.

export type RecordKind = 'seller' | 'buyer';

export type LeadFacts = {
  first_name: string | null;
  preferred_name: string | null;
  property_address: string | null;
  motivation: string | null;
  asking_price: number | null;
  offer_made: number | null;
  timeline: string | null;
  condition_notes: string | null;
  objections: string[];
  promises_made: string[];
  next_step: string | null;
  do_not_mention: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  last_contact_at: string | null;
  last_contact_summary: string | null;
  open_questions: string[];
};

export type LeadMemory = {
  workspace_id: number;
  record_kind: RecordKind;
  record_id: number;
  brief: string;
  facts: LeadFacts;
  source_count: number;
  last_source_at: string | null;
  model: string | null;
  updated_at: string;
};

export const BRIEF_MAX = 1200;

/** One row of history, whatever channel it came from. */
export type HistoryItem = {
  at: string;
  kind: string; // call, voicemail, sms, email, note, activity, offer, appointment, task
  direction: 'inbound' | 'outbound' | null;
  text: string;
  /** A recent call transcript: kept whole (up to TRANSCRIPT_FULL) instead of trimmed. */
  full?: boolean;
};

/** How much of a recent call's transcript an agent reads. */
export const TRANSCRIPT_FULL = 8000;

/** What the refresh reads for one record. */
export type LeadHistory = {
  kind: RecordKind;
  id: number;
  name: string;
  record: Record<string, unknown>;
  items: HistoryItem[];
  deals: Record<string, unknown>[];
  offers: { amount: number | null; status: string | null; direction: string | null; at: string | null }[];
  /** How many times we and they reached each other, by channel, and when last. */
  counts?: Record<string, unknown>;
  /** Everything else on file: the property and its facts, other phones and emails, plans, agents, import extras. */
  context?: Record<string, unknown>;
};

/**
 * The rows of one history read. A failed read throws, so no memory (and no
 * agent decision) is made from a history with parts missing; the record stays
 * dirty and is read again. `optional` reads skip only a table or column this
 * database lacks.
 */
export function historyRows<T>(res: { data: T | null; error: { message: string } | null }, what: string, optional = false): T | null {
  if (!res.error) return res.data;
  if (optional && /does not exist|schema cache/i.test(res.error.message)) return null;
  throw new Error(`lead history ${what} unread: ${res.error.message}`);
}

/** The JSON schema the model answers in (structured outputs). */
export const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string' },
    facts: {
      type: 'object',
      properties: {
        first_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        preferred_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        property_address: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        motivation: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        asking_price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        offer_made: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        timeline: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        condition_notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        objections: { type: 'array', items: { type: 'string' } },
        promises_made: { type: 'array', items: { type: 'string' } },
        next_step: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        do_not_mention: { type: 'array', items: { type: 'string' } },
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'unknown'] },
        last_contact_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        last_contact_summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        open_questions: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'first_name', 'preferred_name', 'property_address', 'motivation', 'asking_price', 'offer_made', 'timeline',
        'condition_notes', 'objections', 'promises_made', 'next_step', 'do_not_mention', 'sentiment',
        'last_contact_at', 'last_contact_summary', 'open_questions',
      ],
      additionalProperties: false,
    },
  },
  required: ['brief', 'facts'],
  additionalProperties: false,
} as const;

/** The model is told never to use one; this is the belt to that brace. */
const noDash = (s: string) => s.replace(/\s*\u2014\s*/g, ', ');

const str = (v: unknown, max = 400): string | null => {
  if (typeof v !== 'string') return null;
  const t = noDash(v.replace(/\s+/g, ' ').trim());
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const list = (v: unknown, max = 8): string[] =>
  (Array.isArray(v) ? v : []).map((x) => str(x, 240)).filter((x): x is string => !!x).slice(0, max);

export function firstNameOf(name: string | null | undefined): string | null {
  const w = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  if (!w || /\d|@/.test(w) || /^(llc|inc|the|unknown|owner)$/i.test(w)) return null;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

export function emptyFacts(): LeadFacts {
  return {
    first_name: null, preferred_name: null, property_address: null, motivation: null, asking_price: null, offer_made: null,
    timeline: null, condition_notes: null, objections: [], promises_made: [], next_step: null, do_not_mention: [],
    sentiment: 'unknown', last_contact_at: null, last_contact_summary: null, open_questions: [],
  };
}

/** Any object (model output, a stored jsonb) into clean facts. Unknown keys are dropped. */
export function normalizeFacts(raw: unknown): LeadFacts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sentiment = ['positive', 'neutral', 'negative', 'unknown'].includes(String(o.sentiment)) ? o.sentiment as LeadFacts['sentiment'] : 'unknown';
  const at = str(o.last_contact_at, 40);
  return {
    first_name: str(o.first_name, 60), preferred_name: str(o.preferred_name, 60), property_address: str(o.property_address, 200),
    motivation: str(o.motivation, 300), asking_price: num(o.asking_price), offer_made: num(o.offer_made),
    timeline: str(o.timeline, 200), condition_notes: str(o.condition_notes, 400),
    objections: list(o.objections), promises_made: list(o.promises_made), next_step: str(o.next_step, 240),
    do_not_mention: list(o.do_not_mention), sentiment,
    last_contact_at: at && Number.isFinite(Date.parse(at)) ? at : null,
    last_contact_summary: str(o.last_contact_summary, 400), open_questions: list(o.open_questions),
  };
}

export function clampBrief(s: unknown): string {
  const t = noDash(String(s ?? '').replace(/[ \t]+/g, ' ').trim());
  if (t.length <= BRIEF_MAX) return t;
  const cut = t.slice(0, BRIEF_MAX);
  const stop = cut.lastIndexOf('. ');
  return (stop > BRIEF_MAX * 0.6 ? cut.slice(0, stop + 1) : cut.slice(0, BRIEF_MAX - 1) + '\u2026').trim();
}

const money = (n: number | null) => (n == null ? null : '$' + n.toLocaleString('en-US'));
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
};
const labelOf = (i: HistoryItem) => {
  const who = i.direction === 'inbound' ? 'they' : i.direction === 'outbound' ? 'we' : '';
  const what = i.kind === 'sms' ? 'text' : i.kind;
  return who ? `${what} (${who})` : what;
};

/**
 * No model: the record's own fields plus the newest touches, so the card and
 * the phone agent still have a name, an address, a price and what was said last.
 */
export function fallbackMemory(h: LeadHistory): { brief: string; facts: LeadFacts } {
  const r = h.record;
  const items = [...h.items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const now = Date.now();
  const last = items.find((i) => i.text.trim() && !['task', 'appointment'].includes(i.kind) && Date.parse(i.at) <= now);
  const latestOffer = [...h.offers].filter((o) => o.amount).sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''))[0];
  const facts: LeadFacts = {
    ...emptyFacts(),
    first_name: firstNameOf(h.name),
    property_address: str(r.property_address, 200),
    motivation: str(r.motivation, 300),
    asking_price: num(r.asking_price),
    offer_made: latestOffer?.amount ?? num(r.offer_amount),
    timeline: str(r.timeline, 200),
    condition_notes: str(r.condition, 400),
    last_contact_at: last?.at ?? null,
    last_contact_summary: last ? oneLine(`${labelOf(last)}: ${last.text}`, 300) : null,
    next_step: str(r.next_task, 240),
  };
  const bits = [
    facts.property_address ? `${h.kind === 'seller' ? 'Property' : 'Buys around'}: ${facts.property_address}.` : '',
    facts.motivation ? `Motivation: ${facts.motivation}.` : '',
    facts.asking_price ? `Asking ${money(facts.asking_price)}.` : '',
    facts.offer_made ? `Our latest offer ${money(facts.offer_made)}.` : '',
    facts.timeline ? `Timeline: ${facts.timeline}.` : '',
    r.lead_stage || r.status ? `Stage: ${String(r.lead_stage ?? r.status)}.` : '',
    last ? `Last touch ${String(last.at).slice(0, 10)}, ${oneLine(`${labelOf(last)}: ${last.text}`, 220)}` : 'No conversations on file yet.',
    facts.next_step ? `Next: ${facts.next_step}.` : '',
  ].filter(Boolean);
  return { brief: clampBrief(bits.join(' ')), facts };
}

/**
 * Who spoke for our side on a call or message, by name. Several AI agents
 * (Riley, Jordan, Avery, Cody...) and reps work one record and all read its
 * memory, so an unnamed "Rep:" line is read by the next agent as its own.
 */
export function ourSide(c: { call_origin?: unknown; ai_agent_key?: unknown; direction?: unknown }, agentNames: Record<string, string>): string {
  const key = typeof c.ai_agent_key === 'string' ? c.ai_agent_key : '';
  const name = (key && agentNames[key]) || '';
  const who = name ? `the AI agent ${name}` : 'one of our AI agents';
  if (c.call_origin === 'ai_agent') return `(Call by ${who}; "Rep" in the transcript is ${name || 'that agent'}.)`;
  if (key && c.direction === 'outbound') return `(Sent by ${who}.)`;
  return '';
}

/** The history as the model reads it: record, deals, offers, then touches oldest first. */
export function historyText(h: LeadHistory, maxItems = 120): string {
  const items = [...h.items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-maxItems);
  const lines = items.map((i) => `[${String(i.at).slice(0, 16).replace('T', ' ')}] ${labelOf(i)}: ${oneLine(i.text, i.full ? TRANSCRIPT_FULL : 1500)}`);
  return [
    `Record (${h.kind}): ${JSON.stringify(h.record)}`,
    ...(h.counts ? [`Touch counts: ${JSON.stringify(h.counts)}`] : []),
    ...(h.context && Object.keys(h.context).length ? [`Also on file: ${JSON.stringify(h.context)}`] : []),
    h.deals.length ? `Deals: ${JSON.stringify(h.deals)}` : 'Deals: none',
    h.offers.length ? `Offers: ${JSON.stringify(h.offers)}` : 'Offers: none',
    `History, oldest first (${items.length} of ${h.items.length}):`,
    ...lines,
  ].join('\n');
}

/** Model JSON (text) into a memory; null when it is not usable, so the caller falls back. */
export function parseModelMemory(text: string): { brief: string; facts: LeadFacts } | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { brief?: unknown; facts?: unknown };
  const brief = clampBrief(o.brief);
  if (!brief) return null;
  return { brief, facts: normalizeFacts(o.facts) };
}

/** Stored row (any shape) into a LeadMemory, or null. */
export function rowToMemory(row: unknown): LeadMemory | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.record_kind !== 'seller' && r.record_kind !== 'buyer') return null;
  return {
    workspace_id: Number(r.workspace_id), record_kind: r.record_kind, record_id: Number(r.record_id),
    brief: String(r.brief ?? ''), facts: normalizeFacts(r.facts), source_count: Number(r.source_count ?? 0),
    last_source_at: typeof r.last_source_at === 'string' ? r.last_source_at : null,
    model: typeof r.model === 'string' ? r.model : null, updated_at: String(r.updated_at ?? ''),
  };
}

/** The few lines a drafting prompt gets: the brief plus what must never be said. */
export function briefForPrompt(m: Pick<LeadMemory, 'brief' | 'facts'> | null): string {
  if (!m || !m.brief.trim()) return '';
  const dnm = m.facts.do_not_mention.length ? `\nDo not mention: ${m.facts.do_not_mention.join('; ')}` : '';
  return `${m.brief.trim()}${dnm}`;
}
