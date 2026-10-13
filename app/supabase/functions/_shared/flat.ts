/**
 * Flat payloads → the ingest envelope.
 *
 * Zapier, Make, n8n and Jotform cannot build nested JSON comfortably, so the
 * `zapier` and `jotform` sources post one flat object and this maps it onto the
 * envelope `public.ingest_apply_flat` takes. Pure — no Deno, no network — so
 * flat.test.ts runs it directly:  deno run supabase/functions/_shared/flat.test.ts
 *
 * Contract: docs/webhooks.md
 */

export const FLAT_EVENTS = ['lead.create', 'buyer.create', 'wholesaler.create', 'note.add', 'activity.log', 'email.opened'] as const;
export type FlatEvent = (typeof FLAT_EVENTS)[number];
export type Flat = Record<string, unknown>;
export type IngestCreates = 'seller' | 'buyer' | 'wholesaler';

/** What the disposition form told us, stored on sellers.intake and shown under What we know. */
export type FlatIntake = {
  entity?: string; disposition?: string; location?: string; portfolio?: string; notes?: string;
  garage?: string; photos?: string; arv?: number; rehab?: number; lease_end?: string;
  mls?: string; investorlift?: string; lease_amount?: number; contract?: string; data_tape?: string;
};

export type FlatEnvelope = {
  source: string;
  source_id: string;
  type: FlatEvent;
  occurred_at?: string;
  mode: 'lead' | 'buyer' | 'wholesaler' | 'attach';
  property?: {
    line1?: string; city?: string; state?: string; zip?: string;
    beds?: number; baths?: number; sqft?: number; year_built?: number; property_type?: string;
  };
  person?: { name?: string; phone?: string; email?: string };
  deal?: { asking_price?: number; motivation?: string; notes?: string; arv?: number; rehab?: number; garage_spaces?: number };
  /** Seller columns the disposition form fills: occupancy, closing date, timeline, condition. */
  seller?: { occupancy?: string; desired_close?: string; timeline?: string; condition?: string };
  intake?: FlatIntake;
  lead?: { stage?: string; tags?: string[] };
  buyer?: {
    name?: string; company?: string; phone?: string; email?: string;
    markets?: string[]; max_purchase_price?: number; notes?: string; tags?: string[];
  };
  activity?: { kind: string; title: string; body?: string };
  raw: unknown;
};

// Field names people actually type into a Zapier field mapper.
const ALIAS: Record<string, string> = {
  full_name: 'name', fullname: 'name', contact_name: 'name',
  firstname: 'first_name', lastname: 'last_name',
  phone_number: 'phone', mobile: 'phone', cell: 'phone',
  email_address: 'email', recipient: 'email', recipient_email: 'email', to: 'email',
  street: 'address', address1: 'address', address_line_1: 'address', property_address: 'address',
  postal: 'zip', postal_code: 'zip', zipcode: 'zip', zip_code: 'zip',
  price: 'asking_price', asking: 'asking_price',
  source: 'lead_source', type: 'event', message: 'body', note: 'notes', id: 'external_id',
  max_price: 'max_purchase_price', budget: 'max_purchase_price', market: 'markets',
};

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = (Array.isArray(v) ? v.join(', ') : String(v)).trim();
  // "//", " - ", ", ,": what a Zap sends when the fields it joins are empty. No letter or digit is no value.
  return /[\p{L}\p{N}]/u.test(s) ? s : undefined;
};
const num = (v: unknown): number | undefined => {
  const s = str(v)?.replace(/[$,\s]/g, '').replace(/k$/i, '000');
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const list = (v: unknown): string[] | undefined => {
  const a = (Array.isArray(v) ? v.map(String) : (str(v) ?? '').split(/[,;]/)).map((x) => x.trim()).filter(Boolean);
  return a.length ? a : undefined;
};
/** Drop undefined keys so the stored payload stays readable. */
function clean<T extends object>(o: T): T | undefined {
  const e = Object.entries(o).filter(([, v]) => v !== undefined);
  return e.length ? (Object.fromEntries(e) as T) : undefined;
}

export function normalizeFlat(input: Flat): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const key = k.trim().toLowerCase().replace(/[\s-]+/g, '_');
    out[ALIAS[key] ?? key] ??= v;
  }
  return out;
}

/**
 * `sourceId` is the caller's external_id when given, otherwise a content hash
 * the edge function computes — so a Zap replaying the same step dedupes.
 */
export function flatToEnvelope(source: string, input: Flat, sourceId: string): FlatEnvelope | { error: string } {
  const f = normalizeFlat(input);
  const event = (str(f.event) ?? 'lead.create').toLowerCase() as FlatEvent;
  if (!FLAT_EVENTS.includes(event)) return { error: `event must be one of ${FLAT_EVENTS.join(', ')}` };

  const occurred = str(f.occurred_at);
  if (occurred && Number.isNaN(Date.parse(occurred))) return { error: 'occurred_at must be an ISO 8601 timestamp' };

  const personName = str(f.name) ?? str([str(f.first_name), str(f.last_name)].filter(Boolean).join(' '));
  // A disposition form often has an entity and no person's name. The company is the record.
  const name = personName ?? str(f.company);
  const phone = str(f.phone);
  const email = str(f.email)?.toLowerCase();
  const notes = str([str(f.notes), str(f.lead_source) && `Lead source: ${str(f.lead_source)}`].filter(Boolean).join('\n'));
  const base = { source, source_id: String(sourceId).slice(0, 256), type: event, occurred_at: occurred, raw: input };

  if (event === 'lead.create' || event === 'wholesaler.create') {
    if (!name && !phone && !email && !str(f.address)) {
      return { error: `${event} needs at least a name, phone, email or address` };
    }
    const asNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : num(v));
    return {
      ...base,
      mode: event === 'wholesaler.create' ? 'wholesaler' : 'lead',
      property: clean({
        line1: str(f.address), city: str(f.city), state: str(f.state), zip: str(f.zip),
        beds: asNum(f.beds), baths: asNum(f.baths), sqft: asNum(f.sqft),
        year_built: asNum(f.year_built), property_type: str(f.property_type),
      }),
      // ingest_apply only creates a person with a name; the contact is the next best label.
      person: { name: name ?? email ?? phone ?? str(f.address), phone, email },
      deal: clean({
        asking_price: num(f.asking_price), motivation: str(f.motivation), notes,
        arv: asNum(f.arv), rehab: asNum(f.rehab), garage_spaces: asNum(f.garage_spaces),
      }),
      seller: clean({
        occupancy: str(f.occupancy), desired_close: str(f.desired_close),
        timeline: str(f.timeline), condition: str(f.condition),
      }),
      intake: clean({
        entity: str(f.entity_name) ?? str(f.company),
        disposition: str(f.disposition), location: str(f.location), portfolio: str(f.portfolio),
        notes: str(f.form_notes), garage: str(f.garage), photos: str(f.photos),
        arv: asNum(f.arv), rehab: asNum(f.rehab), lease_end: str(f.lease_end),
        mls: str(f.mls), investorlift: str(f.investorlift), lease_amount: asNum(f.lease_amount),
        contract: str(f.contract_url), data_tape: str(f.data_tape),
        // Kept even when the form has no street address, so What we know still shows them.
        beds: asNum(f.beds), baths: asNum(f.baths), sqft: asNum(f.sqft),
        year_built: asNum(f.year_built), property_type: str(f.property_type),
      }),
      lead: clean({ stage: str(f.stage), tags: list(f.tags) }),
      activity: notes ? { kind: 'note', title: str(f.subject) ?? `New lead from ${source === 'jotform' ? 'Jotform' : 'Zapier'}`, body: notes } : undefined,
    };
  }

  if (event === 'buyer.create') {
    if (!name && !phone && !email) return { error: 'buyer.create needs at least a name, phone or email' };
    return {
      ...base,
      mode: 'buyer',
      buyer: clean({
        name: name ?? email ?? phone, company: str(f.company), phone, email,
        markets: list(f.markets), max_purchase_price: num(f.max_purchase_price), notes, tags: list(f.tags),
      }),
    };
  }

  // note.add / activity.log / email.opened: attach to someone who already exists, never create.
  if (!phone && !email) return { error: `${event} needs an email or phone to match on` };
  const title = str(f.subject) ?? (event === 'email.opened' ? 'Email opened' : event === 'note.add' ? 'Note' : 'Activity');
  return {
    ...base,
    mode: 'attach',
    person: { phone, email },
    activity: {
      kind: event === 'email.opened' ? 'email_open' : event === 'note.add' ? 'note' : 'activity',
      title: event === 'email.opened' && str(f.subject) ? `Opened: ${str(f.subject)}` : title,
      body: str([str(f.body), notes].filter(Boolean).join('\n')),
    },
  };
}

// ---- Jotform --------------------------------------------------------------

/** One answer, from either the webhook's rawRequest or the API's answers map. */
export type JotAnswer = { name: string; label: string; type?: string; answer: unknown };

const humanize = (s: string) =>
  s.replace(/^q\d+_/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
    .replace(/^./, (c) => c.toUpperCase());

/** Webhook body: rawRequest is a JSON string keyed q3_fullName, q4_phoneNumber, … */
export function jotAnswersFromRaw(rawRequest: unknown): JotAnswer[] {
  let raw: Record<string, unknown> = {};
  try {
    raw = typeof rawRequest === 'string' ? JSON.parse(rawRequest) : (rawRequest as Record<string, unknown>) ?? {};
  } catch { /* an unparseable rawRequest leaves nothing to map, which the caller reports */ }
  return Object.entries(raw)
    .filter(([k]) => /^q\d+_/.test(k))
    .map(([k, v]) => ({ name: k.replace(/^q\d+_/, ''), label: humanize(k), answer: v }));
}

/** API body: answers is { "3": { name, text, type, answer } }. */
export function jotAnswersFromApi(answers: Record<string, { name?: string; text?: string; type?: string; answer?: unknown }>): JotAnswer[] {
  return Object.values(answers ?? {})
    .filter((a) => a && a.answer !== undefined && !/^control_(head|text|button|divider|pagebreak|image)$/.test(a.type ?? ''))
    .map((a) => ({ name: a.name ?? '', label: a.text || humanize(a.name ?? ''), type: a.type, answer: a.answer }));
}

function answerText(v: unknown): string | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.full) return str(o.full);
    if (o.area || o.phone) return str(`${o.area ?? ''}${o.phone ?? ''}`);
    if (o.month && o.day && o.year) return `${o.year}-${o.month}-${o.day}`;
    return str(Object.values(o).map((x) => str(x)).filter(Boolean).join(' '));
  }
  return str(v);
}

/** Placeholders and dotted blanks ("..", "Add Notes...") are not answers. */
function blankish(t: string | undefined): boolean {
  if (!t) return true;
  const s = t.trim();
  return !s || /^[.\s…-]+$/.test(s) || /^add (another|notes|location|if leased)/i.test(s);
}

/**
 * Partners type opinion prices in thousands or millions: 1.6 is $1.6M, 160 is
 * $160,000, 925000 stays $925,000. Rehab uses a lower floor (a $300 rehab is
 * plausible). Same rule as the Podio importer.
 */
function opinionMoney(raw: string | undefined, floor: number): number | undefined {
  const n = num(raw);
  if (n == null || n <= 0) return undefined;
  if (n < 10) return Math.round(n * 1_000_000);
  if (n < floor) return Math.round(n * 1000);
  return Math.round(n);
}

/** One number, commas allowed. A string of several numbers is not a number. */
function oneNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/[$,]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function inRange(n: number | undefined, lo: number, hi: number): number | undefined {
  if (n == null || n < lo || n > hi) return undefined;
  return n;
}

function propertyTypeLabel(s: string): string {
  const t = s.trim();
  if (/^(sfr|single|single family)$/i.test(t)) return 'Single Family';
  if (/multi/i.test(t)) return 'Multi-Family';
  return t;
}

/** "Wed 30 September 2026, 12:00 AM" and Jotform's {year,month,day} both become a date label. */
function closeLabel(v: unknown): string | undefined {
  const t = answerText(v);
  if (!t || blankish(t)) return undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  const cleaned = t.replace(/^[A-Za-z]{3},?\s+/, '').replace(/,?\s+\d{1,2}:\d{2}.*$/, '').trim();
  const d = iso
    ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    : new Date(cleaned);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Map a submission onto the flat contract. Recognised answers become fields;
 * every other answer becomes a "Question: answer" line so nothing is dropped.
 */
export function jotformToFlat(
  answers: JotAnswer[],
  meta: { submissionId: string; formTitle?: string; creates?: IngestCreates; createdAt?: string },
): Flat {
  const f: Flat = {
    event: meta.creates === 'buyer' ? 'buyer.create' : meta.creates === 'wholesaler' ? 'wholesaler.create' : 'lead.create',
    external_id: meta.submissionId,
    lead_source: meta.formTitle ? `Jotform: ${meta.formTitle}` : 'Jotform',
    occurred_at: meta.createdAt,
  };
  const extra: string[] = [];
  const set = (k: string, v: unknown) => {
    if (v === undefined || f[k] !== undefined) return false;
    f[k] = v;
    return true;
  };

  for (const a of answers) {
    const key = `${a.name} ${a.label}`.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const flatKey = key.replace(/ /g, '');
    const v = a.answer;
    const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    let used = false;
    if (!obj && blankish(answerText(v))) continue;

    if (obj && ('first' in obj || 'last' in obj) && !/address/.test(flatKey)) {
      const first = set('first_name', str(obj.first));
      const last = set('last_name', str(obj.last));
      used = first || last;
    } else if (obj && ('addr_line1' in obj || 'postal' in obj)) {
      used = set('address', str([str(obj.addr_line1), str(obj.addr_line2)].filter(Boolean).join(' ')));
      set('city', str(obj.city)); set('state', str(obj.state)); set('zip', str(obj.postal));
      used = true;
    } else if (a.type === 'control_email' || /email/.test(flatKey)) used = set('email', answerText(v));
    else if (a.type === 'control_phone' || /phone|mobile|cell/.test(flatKey)) used = set('phone', answerText(v));
    else if (/firstname/.test(flatKey)) used = set('first_name', answerText(v));
    else if (/lastname/.test(flatKey)) used = set('last_name', answerText(v));
    else if (/^(name|yourname|fullname|contactname)/.test(flatKey) || /\b(full name|your name)\b/.test(key)) used = set('name', answerText(v));
    else if (/(property|street)address|^address/.test(flatKey)) used = set('address', answerText(v));
    else if (/^city/.test(flatKey)) used = set('city', answerText(v));
    else if (/^state/.test(flatKey)) used = set('state', answerText(v));
    else if (/zip|postal/.test(flatKey)) used = set('zip', answerText(v));
    else if (/company|llc|entity/.test(flatKey)) {
      const text = answerText(v);
      if (text && !blankish(text)) {
        set('company', text);
        set('entity_name', text);
        used = true;
      }
    } else if (meta.creates === 'buyer' && /market|county|areas/.test(flatKey)) used = set('markets', answerText(v));
    else if (meta.creates === 'buyer' && /budget|maxprice|maxpurchase|pricerange/.test(flatKey)) used = set('max_purchase_price', num(answerText(v)));
    else if (/arv|afterrepair/.test(flatKey)) used = set('arv', opinionMoney(answerText(v), 5000));
    else if (/rehab/.test(flatKey)) used = set('rehab', opinionMoney(answerText(v), 200));
    else if (/leaseamount/.test(flatKey)) used = set('lease_amount', opinionMoney(answerText(v), 50));
    else if (/asking|howmuch|wantfor|contractprice/.test(flatKey) || (/\bprice\b/.test(key) && !/lease|arv|rehab/.test(key))) {
      used = set('asking_price', opinionMoney(answerText(v), 5000));
    } else if (/reasonforsell|motivat|whysell|whyareyou/.test(flatKey)) used = set('motivation', answerText(v));
    else if (/occup/.test(flatKey)) used = set('occupancy', answerText(v));
    else if (/closingdate|desiredclose/.test(flatKey)) used = set('desired_close', closeLabel(v));
    else if (/timeline/.test(flatKey)) used = set('timeline', answerText(v));
    else if (/condition/.test(flatKey)) used = set('condition', answerText(v));
    else if (/bedroom/.test(flatKey)) used = set('beds', inRange(oneNumber(answerText(v)), 0.5, 20));
    else if (/bathroom/.test(flatKey)) used = set('baths', inRange(oneNumber(answerText(v)), 0.5, 20));
    else if (/squarefoot|sqft/.test(flatKey)) used = set('sqft', inRange(oneNumber(answerText(v)), 200, 50000));
    else if (/yearbuild|yearbuilt/.test(flatKey)) used = set('year_built', inRange(oneNumber(answerText(v)), 1800, new Date().getFullYear() + 1));
    else if (/propertytype/.test(flatKey)) {
      const text = answerText(v);
      if (text && !blankish(text)) used = set('property_type', propertyTypeLabel(text));
    } else if (/oneproperty|orportfolio/.test(flatKey)) used = set('portfolio', answerText(v));
    else if (/garage/.test(flatKey)) {
      const text = answerText(v);
      if (text && !blankish(text)) {
        used = set('garage', text);
        const spaces = /garage spaces:\s*(\d+(?:\.\d+)?)/i.exec(text);
        if (spaces) set('garage_spaces', Number(spaces[1]));
      }
    } else if (/photo/.test(flatKey)) used = set('photos', answerText(v));
    else if (/investorlift/.test(flatKey)) used = set('investorlift', answerText(v));
    else if (/listedonmls/.test(flatKey) || /\bmls\b/.test(key)) used = set('mls', answerText(v));
    else if (/leaseend|whenislease|mtmor/.test(flatKey)) used = set('lease_end', answerText(v));
    else if (/purchasecontract|copyofpurchase/.test(flatKey)) used = set('contract_url', answerText(v));
    else if (/datatape|bulkinfo/.test(flatKey)) used = set('data_tape', answerText(v));
    else if (/disposition/.test(flatKey)) used = set('disposition', answerText(v));
    else if (/(^| )notes?( |$)/.test(key) && !/fund notes|seller notes|title notes/.test(key)) used = set('form_notes', answerText(v));
    else if (/\blocation\b/.test(key)) used = set('location', answerText(v));

    const text = answerText(v);
    if (!used && text && !blankish(text)) extra.push(`${a.label}: ${text}`);
  }
  if (extra.length) f.notes = extra.join('\n');
  return f;
}

/** The buyers columns a buy-box form (the website's buyers list) can fill. */
export type BuyBox = Partial<{
  property_types: string[]; strategy_types: string[];
  min_purchase_price: number; max_purchase_price: number;
  beds_min: number; baths_min: number; sqft_min: number; sqft_max: number;
  year_built_min: number; year_built_max: number; preferred_channel: string;
}>;

/** Buy-box answers on a flat buyer.create → buyers columns. Unknown or blank answers are left out. */
export function buyBoxFromFlat(input: Flat): BuyBox {
  const f = normalizeFlat(input);
  const channel = str(f.preferred_channel)?.toLowerCase();
  return clean<BuyBox>({
    property_types: list(f.property_types), strategy_types: list(f.strategy_types),
    min_purchase_price: num(f.min_purchase_price), max_purchase_price: num(f.max_purchase_price),
    beds_min: num(f.beds_min), baths_min: num(f.baths_min), sqft_min: num(f.sqft_min), sqft_max: num(f.sqft_max),
    year_built_min: num(f.year_built_min), year_built_max: num(f.year_built_max),
    preferred_channel: channel === 'sms' || channel === 'email' ? channel : undefined,
  }) ?? {};
}

/** Only what the buyer row does not already have: CLOZR is the system of record, a form is a source. */
export function fillOnly(row: Record<string, unknown>, box: BuyBox): BuyBox {
  const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  return Object.fromEntries(Object.entries(box).filter(([k]) => empty(row[k]))) as BuyBox;
}
