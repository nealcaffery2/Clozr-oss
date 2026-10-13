/**
 * Podio → CLOZR live sync: the pure half (podio-import's `sync` action does the IO).
 *
 * No network, no Deno, no Supabase, so the edge function and the assert check
 * (app/tools/podio-sync.test.ts, `npx tsx`) run the same code.
 *
 *   itemRow(item)          a Podio item → the row its Excel export would have been
 *                          (column names "Offer Price - amount", "Phone - Mobile",
 *                          "Who is underwriting/dispo? - name"…), so a live item is
 *                          read with the same keys as the 2026-09-13 snapshot
 *   readSubmission(item)   a Partnerships › Submissions item → address key, partner
 *                          key, contact, stage and the deal columns it fills
 *   submissionPrefix()     the source_id prefix the Excel import gave its deal
 *   pickSubmissionDeal()   which existing submission deal an item is
 *   pickPipelineDeal()     which existing deal a Deals-app item is
 *   syncPatch()            the field rule: fill what CLOZR left empty; overwrite
 *                          only where Podio's value changed since the sync last
 *                          applied it; never blank anything
 *   stageMove()            the same rule for a stage, plus "unmapped" and "a
 *                          person moved it in CLOZR since"
 *   podioTime() / sinceFrom()   Podio's UTC "YYYY-MM-DD HH:MM:SS" and the
 *                          incremental window
 */
import {
  type Address, addressKey, clean, cleanEntity, day, emailKey, entityKey, fundsIn, looseKey, money, multi, num, parseAddress, personKey, phoneKey, phoneOut, stateCode, submissionStage, thousands,
} from './podio-keys.ts';
import { clozrStage, readText, stripHtml } from './podio-map.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
export type Row = Record<string, string>;

const one = (v: unknown) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const blank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

// ---------------------------------------------------------------- the row

/** Podio's "2026-09-13 18:04:11" (UTC) → ISO. Anything else passes through. */
export const podioIso = (s: unknown): string | null => {
  const t = one(s);
  if (!t) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t;
};
/** A Date → Podio's filter format, UTC. */
export const podioTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
/** The incremental window: everything Podio touched since the last pass began, less an overlap for clock skew. */
export const sinceFrom = (lastPass: string | null, overlapMinutes = 10): string | null =>
  lastPass && !Number.isNaN(Date.parse(lastPass)) ? podioTime(new Date(Date.parse(lastPass) - overlapMinutes * 60_000)) : null;

/**
 * An item's fields as its Podio Excel export names them. Multi-value cells
 * join with ";\n" like the export. Unknown field types fall back to text.
 */
export function itemRow(item: Any): Row {
  const r: Row = {};
  const put = (k: string, v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    if (!k || !s) return;
    r[k] = r[k] ? `${r[k]};\n${s}` : s;
  };
  for (const f of item?.fields ?? []) {
    const label = one(f.label ?? f.config?.label ?? f.external_id);
    const vals: Any[] = f.values ?? [];
    if (f.type === 'money') { put(`${label} - amount`, vals[0]?.value); put(label, vals[0]?.value); }
    else if (f.type === 'date') { const d = vals[0]?.start ?? vals[0]?.start_date; put(`${label} - start`, d); put(label, d); }
    else if (f.type === 'phone' || f.type === 'email') for (const v of vals) { put(`${label} - ${cap(String(v.type ?? 'other'))}`, v.value); put(label, v.value); }
    else if (f.type === 'contact') {
      for (const v of vals) {
        const c = v.value ?? {};
        put(`${label} - name`, c.name); put(label, c.name);
        put(`${label} - mail`, Array.isArray(c.mail) ? c.mail[0] : c.mail);
      }
    } else put(label, readText({ type: f.type, values: vals }));
  }
  r['Created on'] = podioIso(item?.created_on)?.replace(/Z$/, '') ?? '';
  if (item?.created_by?.name) r['Created by'] = String(item.created_by.name);
  return r;
}

/** A column by its export name, forgiving case and runs of spaces (Podio labels drift). */
export function cell(r: Row, name: string): string {
  if (r[name] != null) return r[name];
  const want = one(name).toLowerCase();
  const k = Object.keys(r).find((x) => one(x).toLowerCase() === want);
  return k ? r[k] : '';
}

// ---------------------------------------------------------------- a submission

export type SubmissionCols = {
  asking_price: number | null; motivation: string | null; offer_amount: number | null; arv: number | null; rehab: number | null;
  mao: number | null; earnest_money: number | null; underwriting_url: string | null; occupancy_notes: string | null; market: string | null;
  /** The underwriter's low / high offer band (Podio "UW Suggested Low / High Offer"). */
  wholesale_offer: number | null; institutional_offer: number | null;
  /** thecompr.com/r/… from "Ai Compr Tool", beside underwriting_url. */
  compr_report_url: string | null;
  /** "Garage Info" when it parses as a number of spaces. */
  garage_spaces: number | null;
};
export type PodioContact = { name: string; email: string | null };
export type SubmissionFacts = { beds?: number; baths?: number; sqft?: number; year_built?: number; property_type?: string };
export type Submission = {
  item_id: number; created: string | null; last_event_on: string | null; link: string | null;
  address: ReturnType<typeof parseAddress>; address_keys: string[];
  /** Every parsed form of the address, including a directional-stripped line ("405 S Birchwood" and "405 Birchwood"). */
  variants: Address[];
  /** The raw Property Address text, for a zip when there is no street. */
  address_text: string;
  zip: string | null;
  entity: string | null; partner_key: string | null;
  person: string | null; phone: string | null; email: string | null;
  /** The raw Podio Stage label and the CLOZR stage it maps to (null = unmapped; '' label = New Submission). */
  podio_stage: string; stage: string | null; dead: boolean;
  /** A test entry (entity "Test", "test" in a name, or Acme Homes' own address): the Excel import skipped these too. */
  test: boolean;
  cols: SubmissionCols;
  facts: SubmissionFacts;
  /** "Who is underwriting/dispo?" and "Acquisitions", for the roster and deal_parties. */
  underwriters: PodioContact[]; acquisitions: PodioContact[];
  /** Funds named on the item (Excel fundsIn). */
  funds: string[];
  /** First photo link, fill-blank onto deals.photos_url. */
  photos_url: string | null;
  /** Every photo link on the Photos field. Each one is a deal_files row the Photos button opens. */
  photo_urls: string[];
  /** The marker-delimited notes section. Empty when the item has none of those fields. */
  block: string;
};

const realPerson = (v: string) => {
  const t = personKey(v).split(' ');
  return t.length >= 2 && t.every((w) => w.length >= 2) && new Set(t).size === t.length;
};

/** Every address key a location could have been keyed on: the typed text, Podio's formatted text, and its parts. */
export function addressKeysOf(raw: string, f?: Any): string[] {
  const keys = new Set<string>();
  const add = (a: ReturnType<typeof parseAddress>) => { const k = a && addressKey(a); if (k) keys.add(k); };
  add(parseAddress(raw));
  const v = f?.values?.[0];
  if (v) {
    if (typeof v.value === 'string') add(parseAddress(v.value));
    if (v.formatted) add(parseAddress(v.formatted));
    const line1 = [v.street_number, v.street_address].filter(Boolean).join(' ');
    if (/^\d/.test(line1) && v.postal_code) add({ line1, city: v.city ?? null, state: v.state ?? null, zip: String(v.postal_code).slice(0, 5) });
  }
  return [...keys];
}

const DIR = /^(?:north|south|east|west|northeast|northwest|southeast|southwest|ne|nw|se|sw|n|s|e|w)$/i;
/** "405 S Birchwood Ave" and "405 South Birchwood Ave" → "405 Birchwood Ave". A street that is only a directional is left as typed. */
export function stripDirectional(line1: string): string {
  const parts = one(line1).split(' ');
  if (parts.length >= 3 && /^\d/.test(parts[0]) && DIR.test(parts[1])) return [parts[0], ...parts.slice(2)].join(' ');
  return one(line1);
}

/** A 5-digit zip anywhere in an address line ("Durham, NC 27701" has no street and still has a zip). */
export function zipOf(raw: unknown): string | null {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(one(raw));
  return m?.[1] ?? null;
}

/** The first http(s) link in a cell, trailing punctuation peeled off. */
export function firstUrl(v: unknown): string | null {
  return allUrls(v)[0] ?? null;
}

/** Every http(s) link in a cell, trailing punctuation peeled off. */
export function allUrls(v: unknown): string[] {
  const found = one(v).match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const u = raw.replace(/[),.;]+$/, '');
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Excel's Property Type normalisation: SFR / single family, anything with "multi", else the typed words. */
export function propertyTypeOf(v: unknown): string | null {
  const t = one(v);
  if (!t) return null;
  if (/^(sfr|single|single family)$/i.test(t)) return 'Single Family';
  if (/multi/i.test(t)) return 'Multi-Family';
  return t.replace(/\S+/g, (w) => (w === w.toUpperCase() && w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w));
}

/** "2", "2 car", "2-car garage" → 2. More than one number, or none, stays text for the notes block. */
export function garageSpacesOf(v: unknown): number | null {
  const t = one(v);
  if (!t) return null;
  const m = t.match(/\d+/g);
  if (!m || m.length !== 1) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) && n >= 0 && n <= 20 ? n : null;
}

/** A contact field's names and emails, in order (Excel " - name" / " - mail" columns). */
function contactsOf(r: Row, label: string): PodioContact[] {
  const names = multi(cell(r, `${label} - name`));
  const mails = multi(cell(r, `${label} - mail`));
  if (!names.length) {
    const plain = one(cell(r, label));
    return plain ? [{ name: plain, email: null }] : [];
  }
  return names.map((name, i) => ({ name, email: mails[i] ? mails[i].toLowerCase() : null }));
}

/**
 * Every address a location could be stored under: the typed text, Podio's
 * formatted text, its street parts, and each of those with a leading
 * directional dropped, so "405 S Birchwood Ave" finds a property stored as
 * "405 Birchwood Ave".
 */
export function addressVariants(raw: string, f?: Any): Address[] {
  const out: Address[] = [];
  const add = (a: Address | null) => {
    if (!a || !/^\d/.test(one(a.line1))) return;
    for (const v of [a, { ...a, line1: stripDirectional(a.line1) }]) {
      const k = addressKey(v) ?? v.line1.toUpperCase();
      if (out.some((x) => (addressKey(x) ?? x.line1.toUpperCase()) === k)) continue;
      out.push(v);
    }
  };
  add(parseAddress(raw));
  const v = f?.values?.[0];
  if (v) {
    if (typeof v.value === 'string') add(parseAddress(v.value));
    if (v.formatted) add(parseAddress(v.formatted));
    const line1 = [v.street_number, v.street_address].filter(Boolean).join(' ');
    if (/^\d/.test(line1)) add({
      line1, city: one(v.city) || null, state: v.state ? stateCode(String(v.state)) ?? one(v.state) : null,
      zip: v.postal_code ? String(v.postal_code).slice(0, 5) : null,
    });
  }
  return out;
}

/** Two addresses are one property: the same address key, or the same house number + street word + zip once a leading directional is ignored. */
export function sameProperty(a: Address | null, b: Address | null): boolean {
  if (!a || !b) return false;
  const keys = (x: Address) => {
    const s = new Set<string>();
    for (const v of [x, { ...x, line1: stripDirectional(x.line1) }]) {
      const ak = addressKey(v); if (ak) s.add(ak);
      const lk = looseKey(v); if (lk) s.add('loose:' + lk);
    }
    return s;
  };
  const left = keys(a);
  for (const k of keys(b)) if (left.has(k)) return true;
  return false;
}

export const PODIO_BLOCK_START = '--- Podio fields (synced) ---';
export const PODIO_BLOCK_END = '--- end Podio ---';

/**
 * The Submissions fields that have no column of their own, in the Excel
 * importer's labelled lines. Empty when the item carries none of them.
 * The sync rewrites this whole section; text outside it is the user's.
 */
export function podioBlock(item: Any): string {
  const r = itemRow(item);
  const get = (k: string) => cell(r, k);
  const line = (label: string, v: unknown) => (one(v) ? `${label}: ${clean(v)}` : '');
  const flag = (label: string, v: unknown) => (one(v) ? `${label}: yes` : '');
  const leaseRaw = get('If leased, MTM or when is lease end?');
  const lease = /^\.+$/.test(one(leaseRaw)) ? '' : leaseRaw;
  const dispo = num(get('Suggested Dispo price'));
  const compr = /https?:\/\/[^\s<>]*thecompr\.(?:com|ai)\/r\/[^\s<>]+/.exec(get('Ai Compr Tool'))?.[0] ?? null;
  const analysis = get('Analysis');
  const buyer = clean(get('Ai Buyer Match'));
  const funds = [...new Set(['Funds Sent To', 'Send Email/SMS to funds'].flatMap((k) => fundsIn(get(k))))];
  const underwriters = contactsOf(r, 'Who is underwriting/dispo?').map((u) => u.name).filter(Boolean);
  const deadRaw = one(get('Dead') || get('Mark Deal as Dead'));
  const dead = /dead|^yes$/i.test(deadRaw);
  const groups = [
    [flag('Disposition request', get('Disposition Request')), line('Listed on MLS', get('Listed on MLS?')),
      line('Investorlift', get('Have you put the property on Investorlift?')), line('Property or portfolio', get('One Property or Portfolio?'))].filter(Boolean).join(' · '),
    [line('Lease', lease), line('Lease amount', money(num(get('If leased, lease amount? - amount'))))].filter(Boolean).join(' · '),
    garageSpacesOf(get('Garage Info')) == null ? line('Garage', get('Garage Info')) : '',
    line('Location', get('Location')),
    line('Photos', get('Photos')),
    line('Purchase contract', get('Copy of purchase contract')),
    line('Data tape', get('If Portfolio, Please upload data tape or bulk info')),
    [line('Underwriting/dispo', underwriters.join(', ')), line('Finished underwrite', get('Finished Underwrite')),
      flag('Sent to Compr', get('Send to Compr')), flag('Pushed', get('Push Deal')), flag('Request contract', get('Request Contract'))].filter(Boolean).join(' · '),
    line('Underwrite decline reason', get('Underwrite Decline Reason')),
    line('Suggested dispo price', dispo != null ? money(dispo) : ''),
    line('Analysis', analysis),
    compr ? line('Compr', compr) : '',
    line('Comps', ['Comp 1', 'Comp 2', 'Comp 3'].map((k) => one(get(k))).filter(Boolean).join(' , ')),
    buyer ? 'AI buyer match: ' + (buyer.length > 1500 ? buyer.slice(0, 1500) + '…' : buyer) : '',
    line('Funds sent to', funds.join(', ')),
    line('Funds to email/SMS', get('Send Email/SMS to funds')),
    line('Fund notes', get('Fund Notes')),
    dead ? 'Marked dead in Podio' : '',
    line('Closing needed', day(get('Closing Date Needed - start') || get('Closing Date Needed'))),
    line('Submission notes', get('Notes')),
  ].filter(Boolean);
  if (!groups.length) return '';
  return `${PODIO_BLOCK_START}\n${groups.join('\n')}\n${PODIO_BLOCK_END}`;
}

/** Replace the Podio section wholesale. Text outside the markers is kept, including when the block is emptied. */
export function mergePodioBlock(notes: string | null | undefined, block: string | null | undefined): string {
  const re = new RegExp(`\\n*${PODIO_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${PODIO_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n*`, 'g');
  const user = String(notes ?? '').replace(re, '\n\n').replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
  const b = (block ?? '').trim();
  if (!b) return user;
  const section = b.startsWith(PODIO_BLOCK_START) ? b : `${PODIO_BLOCK_START}\n${b}\n${PODIO_BLOCK_END}`;
  return user ? `${user}\n\n${section}` : section;
}

export function readSubmission(item: Any): Submission {
  const r = itemRow(item);
  const get = (k: string) => cell(r, k);
  const addrField = (item?.fields ?? []).find((f: Any) => one(f.label).toLowerCase() === 'property address');
  const address = parseAddress(get('Property Address'));
  const ent = cleanEntity(get('Entity Name'));
  const phones = ['Phone - Mobile', 'Phone - Work', 'Phone - Home', 'Phone - Main', 'Phone - Other'].map((k) => phoneKey(get(k))).filter(Boolean) as string[];
  const emails = ['Email - Work', 'Email - Home', 'Email - Other'].map((k) => emailKey(get(k))).filter(Boolean) as string[];
  const personRaw = [one(get('First Name')), one(get('Last Name'))].filter(Boolean).join(' ');
  const podioStage = one(get('Stage'));
  const n = (k: string) => num(get(k));
  const compr = /https?:\/\/[^\s<>]*thecompr\.(?:com|ai)\/r\/[^\s<>]+/.exec(get('Ai Compr Tool'))?.[0] ?? null;
  const analysis = /https?:\/\/\S+/.exec(get('Analysis'))?.[0] ?? null;
  const facts: SubmissionFacts = {};
  const beds = n('Bedrooms'); const baths = n('Bathrooms'); const sqft = n('Square Footage'); const yr = n('Year Build');
  if (beds != null && beds > 0 && beds <= 20) facts.beds = beds;
  if (baths != null && baths > 0 && baths <= 20) facts.baths = baths;
  if (sqft != null && sqft >= 200 && sqft <= 50000) facts.sqft = Math.round(sqft);
  if (yr != null && yr >= 1800 && yr <= 2027) facts.year_built = Math.round(yr);
  const propertyType = propertyTypeOf(get('Property Type'));
  if (propertyType) facts.property_type = propertyType;
  const addressText = get('Property Address');
  const variants = addressVariants(addressText, addrField);
  const deadRaw = one(get('Dead') || get('Mark Deal as Dead'));
  return {
    item_id: Number(item?.item_id), created: podioIso(item?.created_on), last_event_on: podioIso(item?.last_event_on ?? item?.last_edit_on ?? item?.created_on),
    link: item?.link ?? null,
    address, address_keys: addressKeysOf(addressText, addrField), variants, address_text: addressText,
    zip: address?.zip ?? variants.find((v) => v.zip)?.zip ?? zipOf(addressText),
    entity: ent.name, partner_key: entityKey(ent.name),
    person: realPerson(personRaw) ? personRaw : null,
    phone: phones[0] ? '+1' + phones[0] : null, email: emails[0] ?? ent.email ?? null,
    podio_stage: podioStage, stage: submissionStage(podioStage), dead: /dead|^yes$/i.test(deadRaw),
    test: entityKey(ent.name) === 'test' || /\btest\b/i.test(`${get('Entity Name')} ${get('First Name')} ${get('Last Name')}`)
      || /@yourcompany\.com\b/i.test(`${get('Email - Home')} ${get('Email - Work')}`),
    cols: {
      asking_price: thousands(n('What price are you asking? (Your contract price including your fee) - amount')),
      motivation: one(get('Reason for selling if you have it')) || null,
      offer_amount: n('Offer Price - amount'),
      arv: thousands(n('ARV in your opinion - amount')) || null,
      rehab: thousands(n('Rehab in your opinion - amount'), 200),
      mao: n('UW Suggested High Offer - amount'),
      wholesale_offer: n('UW Suggested Low Offer - amount'),
      institutional_offer: n('UW Suggested High Offer - amount'),
      earnest_money: n('EMD - amount'),
      underwriting_url: compr ?? analysis,
      compr_report_url: compr,
      garage_spaces: garageSpacesOf(get('Garage Info')),
      occupancy_notes: one(get('Occupied?')) || null,
      market: address?.state ?? null,
    },
    facts,
    underwriters: contactsOf(r, 'Who is underwriting/dispo?'),
    acquisitions: contactsOf(r, 'Acquisitions'),
    funds: [...new Set(['Funds Sent To', 'Send Email/SMS to funds'].flatMap((k) => fundsIn(get(k))))],
    photos_url: firstUrl(get('Photos')),
    photo_urls: allUrls(get('Photos')),
    block: podioBlock(item),
  };
}

/** The source_id prefix lib/podio-excel.ts gave a submission's lead (and, after migration 49, its deal). */
export const submissionPrefix = (addrKey: string, partnerKey: string | null) => `submission:${addrKey}|${partnerKey ?? '-'}|`;
/** The source_id a new submission deal gets: the Excel import's shape, so either importer finds it again. */
export const submissionSourceId = (s: Submission) =>
  `${submissionPrefix(s.address_keys[0], s.partner_key)}${(s.created ?? '').replace(/Z$/, '')}`;
/** The partner key inside a submission source_id ("submission:<address>|<partner>|<created>"). */
export const partnerOfSourceId = (sid: string | null | undefined): string | null => {
  const m = /^submission:.*\|([^|]*)\|[^|]*$/.exec(sid ?? '');
  return m && m[1] !== '-' ? m[1] : null;
};

// ---------------------------------------------------------------- matching

export type DealCandidate = {
  id: number; source_id: string | null; stage?: string | null; submitted_at?: string | null;
  /** The deal's seller (the partner contact), for a contact tie-break. */
  seller_phone_key?: string | null; seller_email?: string | null;
};
export type DealPick = { id: number; by: string } | { ambiguous: number[] } | null;

/**
 * Which submission deal an item is, among the Podio deals on its address
 * (source_id "submission:<address>|…"). Same partner first; then the deal whose
 * contact has the item's phone or email (a person-named entity the Excel
 * import folded into a company); then the only one, when the item names no
 * partner. A different partner on the same address is a different lead (that
 * is how the Excel import kept them), so it is not matched. Several left and
 * nothing to choose by: ambiguous — the caller logs it and writes nothing.
 */
export function pickSubmissionDeal(cands: DealCandidate[], s: Pick<Submission, 'partner_key' | 'phone' | 'email'>): DealPick {
  if (!cands.length) return null;
  if (s.partner_key) {
    const same = cands.filter((c) => partnerOfSourceId(c.source_id) === s.partner_key);
    if (same.length) return { id: newest(same).id, by: 'address + partner' };
  }
  const pk = s.phone ? phoneKey(s.phone) : null;
  const em = s.email?.toLowerCase() ?? null;
  const byContact = cands.filter((c) => (pk && phoneKey(c.seller_phone_key) === pk) || (em && c.seller_email?.toLowerCase() === em));
  if (byContact.length === 1) return { id: byContact[0].id, by: 'address + contact' };
  if (!s.partner_key) {
    if (cands.length === 1) return { id: cands[0].id, by: 'address' };
    return { ambiguous: cands.map((c) => c.id) };
  }
  if (byContact.length > 1) return { ambiguous: byContact.map((c) => c.id) };
  return null;
}

/**
 * Which deal a Deals-app item is, among the Podio deals on its address
 * ("deal:<address>" and "submission:<address>|…"). The Excel import put a
 * Deals row on one of them and moved it off Prospect, so a deal already on the
 * pipeline wins; then the wholesaler's own submission; then the newest.
 */
export function pickPipelineDeal(cands: DealCandidate[], wholesalerKey: string | null): DealPick {
  if (!cands.length) return null;
  const onPipeline = cands.filter((c) => c.stage && c.stage !== 'Prospect');
  const pool = onPipeline.length ? onPipeline : cands;
  if (pool.length === 1) return { id: pool[0].id, by: onPipeline.length ? 'address (on the pipeline)' : 'address' };
  if (wholesalerKey) {
    const same = pool.filter((c) => partnerOfSourceId(c.source_id) === wholesalerKey);
    if (same.length) return { id: newest(same).id, by: 'address + wholesaler' };
  }
  return { id: newest(pool).id, by: 'address (newest)' };
}

const newest = <T extends DealCandidate>(xs: T[]): T =>
  [...xs].sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? '') || b.id - a.id)[0];

// ---------------------------------------------------------------- merging

const same = (a: unknown, b: unknown) => {
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  const na = typeof a === 'number' ? a : Number(a); const nb = typeof b === 'number' ? b : Number(b);
  if (typeof a === 'number' || typeof b === 'number') return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.005;
  return String(a).trim() === String(b).trim();
};

/**
 * The update a Podio item makes to a CLOZR row.
 *   - an empty Podio value never touches anything
 *   - an empty CLOZR field takes Podio's value
 *   - a CLOZR value is overwritten only when Podio's value differs from what
 *     the sync last applied for that field (it changed in Podio since), so an
 *     edit made in CLOZR stands until someone changes it in Podio again
 * `last` is the ledger's `applied` snapshot (undefined the first time an item is linked).
 */
export function syncPatch(cur: Record<string, unknown>, inc: Record<string, unknown>, last?: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inc)) {
    if (blank(v) || same(cur[k], v)) continue;
    if (blank(cur[k])) out[k] = v;
    else if (last && k in last && !same(last[k], v)) out[k] = v;
  }
  return out;
}
/**
 * Bumped when the Submissions field map changes. A ledger row stamped with an
 * older `__v` is applied again even if Podio has not touched the item, so a
 * mapping change does not depend on clearing sync_cursor.
 */
export const MAPPING_VERSION = 2;

/** Podio has not touched the item since the sync last applied it. Acquisitions and Deals use this; Submissions also checks the field-map version. */
export function podioUntouched(
  led: { last_event_on?: string | null } | undefined,
  lastEvent: string | null,
): boolean {
  return !!(led?.last_event_on && lastEvent && Date.parse(led.last_event_on) >= Date.parse(lastEvent));
}

/**
 * Podio has not touched the item since the sync last applied it, AND that
 * apply used the current field map. An older `applied.__v` (or none) is not
 * unchanged: the caller re-applies the item once.
 */
export function unchangedSince(
  led: { last_event_on?: string | null; applied?: Record<string, unknown> | null } | undefined,
  lastEvent: string | null,
): boolean {
  if (!led?.last_event_on || !lastEvent || Date.parse(led.last_event_on) < Date.parse(lastEvent)) return false;
  return Number(led.applied?.__v ?? 0) >= MAPPING_VERSION;
}

/** The snapshot to store after applying: what Podio said, empties left out (so they never count as a change), stamped with the field-map version. */
export const appliedSnapshot = (last: Record<string, unknown> | null | undefined, inc: Record<string, unknown>) =>
  ({ ...(last ?? {}), ...Object.fromEntries(Object.entries(inc).filter(([, v]) => !blank(v))), __v: MAPPING_VERSION });

export type StageMove =
  | { kind: 'set'; to: string }
  | { kind: 'keep'; why: 'same' | 'unchanged in Podio' | 'moved in CLOZR since' | 'blank in Podio' }
  | { kind: 'unmapped'; label: string };

/**
 * A stage from Podio. Unmapped labels never move anything (the record's other
 * fields still update and the label is logged). A label that maps is applied
 * when it differs from CLOZR's stage and from what the sync last applied —
 * unless a person moved the record in CLOZR after Podio's change.
 */
export function stageMove(o: {
  label: string; mapped: string | null; current: string | null | undefined; lastApplied?: string | null;
  movedInClozrSince?: boolean; isNew?: boolean;
}): StageMove {
  const label = one(o.label);
  if (label && !o.mapped) return { kind: 'unmapped', label };
  if (!label && !o.isNew) return { kind: 'keep', why: 'blank in Podio' };
  if (!o.mapped || o.mapped === o.current) return { kind: 'keep', why: 'same' };
  if (o.lastApplied && o.lastApplied === o.mapped) return { kind: 'keep', why: 'unchanged in Podio' };
  if (o.movedInClozrSince) return { kind: 'keep', why: 'moved in CLOZR since' };
  return { kind: 'set', to: o.mapped };
}

/** A Deals-app stage label → CLOZR deal stage (the Excel importer's dealStage, which clozrStage already covers). */
export const pipelineStage = (label: string | null | undefined) => clozrStage(one(label)) ?? (/marketing/i.test(one(label)) ? 'Ready To Market' : null);

/**
 * The seller stages a submission sets on its partner contact. The contact
 * follows its newest submission (migration 49) only while it is in one of
 * these; a contact the deal trigger moved on (Under Contract, Closed…) stays.
 */
export const SUBMISSION_SELLER_STAGES = new Set([
  'Lead', 'New Submission', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete', 'Offer Made', 'Pending Response',
  'Pending Inspections', 'Offer Accepted', 'Underwrite Declined', 'Offer Declined', 'Auction.com',
]);

// ---------------------------------------------------------------- Acme Homes › Acquisitions (sellers)

/** E.164 like sellers.phone_key / normalize_phone(): "(210) 555-0101" → "+12105550101". */
export const e164 = (v: unknown): string | null => phoneOut(phoneKey(v));
const e164s = (v: string) => [...new Set(v.split(/;\s*\n?|\n|,/).map(e164).filter(Boolean) as string[])];
const emails = (v: string) => [...new Set(v.split(/;\s*\n?|\n|,/).map(emailKey).filter(Boolean) as string[])];

/** Podio's older spellings of seller stages, after punctuation and case are dropped. */
const STAGE_ALIAS: Record<string, string> = {
  trash: 'Dead', deniedoffer: 'Offer Declined', refundwronginfo: 'Dead - Wrong Info', refundwronginfoother: 'Dead - Wrong Info',
  contactedfuneeded: 'Contacted - Follow Up Needed', nurturelongterm3m: 'Nurture - Long Term (3+ Months)',
  nurtureshortterm3m: 'Nurture - Short Term (Under 3 Months)',
};
const stageKey = (v: unknown) => one(v).toLowerCase().replace(/[^a-z0-9]/g, '');

/** A Podio Lead Stage label → CLOZR's seller_stages label (same vocabulary, forgiving case and punctuation); null = unmapped. */
export const sellerStageOf = (label: string | null | undefined, labels: readonly string[]): string | null => {
  const want = stageKey(label);
  if (!want) return null;
  const hit = labels.find((l) => stageKey(l) === want);
  if (hit) return hit;
  const alias = STAGE_ALIAS[want];
  return alias && labels.includes(alias) ? alias : null;
};

export type Acquisition = {
  item_id: number; created: string | null; last_event_on: string | null; link: string | null;
  name: string | null; phones: string[]; emails: string[]; owner2: string | null;
  address: ReturnType<typeof parseAddress>; address_keys: string[];
  podio_stage: string;
  cols: { asking_price: number | null; motivation: string | null; timeline: string | null; occupancy: string | null; mortgage: string | null; notes: string | null };
  facts: Submission['facts'];
  source: string | null;
  /** Every non-empty Podio column, by its label (sellers.import_extra). */
  extra: Row;
};

/** Podio's own location parts, when it geocoded the address. */
function locationParts(f: Any): ReturnType<typeof parseAddress> {
  const v = f?.values?.[0];
  const line1 = one([v?.street_number, v?.street_address].filter(Boolean).join(' '));
  if (!/^\d/.test(line1)) return null;
  return { line1, city: one(v.city) || null, state: v.state ? stateCode(String(v.state)) ?? one(v.state) : null, zip: v.postal_code ? String(v.postal_code).slice(0, 5) : null };
}

/**
 * A typed lead address, which often carries the zip and state in front:
 * "44111 Ohio 3232 W 110th St", "OH 6340 Larkspur Drive",
 * "76112 Texas 5528 Fernley St, Fort Worth, TX 76112, USA".
 */
export function leadAddress(raw: string): ReturnType<typeof parseAddress> {
  const t = one(raw);
  const m = /^(\d{5})?\s*([A-Za-z][A-Za-z .]*?)?\s*(\d+[A-Za-z]?\s+\S.*)$/.exec(t);
  const pre = m && (m[1] || m[2]) ? { zip: m[1] ?? null, state: m[2] ? stateCode(m[2]) : null } : null;
  // A prefix that is not a zip or a state is part of the street ("North 5th…" stays as typed).
  const rest = pre && (pre.zip || pre.state) ? m![3] : t;
  const a = parseAddress(rest);
  if (!a) return null;
  return { ...a, state: a.state ?? pre?.state ?? null, zip: a.zip ?? pre?.zip ?? null };
}

/** One Acquisitions item: a seller lead with its property. */
export function readAcquisition(item: Any): Acquisition {
  const r = itemRow(item);
  const get = (k: string) => cell(r, k);
  const n = (k: string) => num(get(k));
  // The API names it "Property Address" (the table view says "Property Location").
  const locField = (item?.fields ?? []).find((f: Any) => ['property address', 'property location'].includes(one(f.label).toLowerCase()));
  const rawAddr = get('Property Address') || get('Property Location') || get('Address (temporary)');
  const address = locationParts(locField) ?? leadAddress(rawAddr) ?? leadAddress(get('Address (temporary)'));
  const name = one(get('Seller Name'));
  const facts: Submission['facts'] = {};
  const beds = n('Bedrooms'); const baths = n('Bathrooms'); const sqft = n('Property Size (Sq. Ft.)'); const yr = n('YEAR BUILD');
  if (beds != null && beds > 0 && beds <= 20) facts.beds = beds;
  if (baths != null && baths > 0 && baths <= 20) facts.baths = baths;
  if (sqft != null && sqft >= 200 && sqft <= 50000) facts.sqft = Math.round(sqft);
  if (yr != null && yr >= 1800 && yr <= 2027) facts.year_built = Math.round(yr);
  const notes = ([['Seller Notes', ''], ['other notes', 'Other notes'], ['NOTES', 'Notes'], ['OTHER PROPERTY NOTES', 'Property notes'], ['OFFER NOTES', 'Offer notes']] as const)
    .map(([k, label]) => { const v = clean(get(k)); return v ? (label ? `${label}: ${v}` : v) : ''; }).filter(Boolean).join('\n\n');
  return {
    item_id: Number(item?.item_id), created: podioIso(item?.created_on), link: item?.link ?? null,
    last_event_on: podioIso(item?.last_event_on ?? item?.last_edit_on ?? item?.created_on),
    // A street address is not a name (sellers_name_not_address refuses it anyway).
    name: name && !/^\d+\s/.test(name) ? name : null,
    phones: e164s(get('Seller Phone')), emails: emails(get('Seller Email')), owner2: one(get('Other Sellers')) || null,
    address, address_keys: addressKeysOf(rawAddr, locField),
    podio_stage: one(get('Lead Stage')),
    cols: {
      asking_price: thousands(n("Seller's Asking Price") ?? n('SELLER ASKING PRICE')),
      motivation: clean(get('Sellers Motivation')) || null,
      timeline: one(get('Ideal time-frame of sale')) || null,
      occupancy: one(get('Occupancy')) || null,
      mortgage: one(get('Mortgage Payoff')) || null,
      notes: notes || null,
    },
    facts,
    source: one(get('Lead Source 2') || get('Lead Source')) || null,
    extra: Object.fromEntries(Object.entries(r).filter(([k]) => !/ - (amount|start|Mobile|Work|Home|Main|Other|Fax|Private)$/.test(k))),
  };
}

// ---------------------------------------------------------------- Acme Homes › Communications (smrtPhone)

/** "25 Seconds", "1 Minute 5 Seconds", "2:05", "125" → seconds. */
export function durationSeconds(v: unknown): number | null {
  const t = one(v).toLowerCase();
  if (!t) return null;
  const hms = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(t);
  if (hms) return Number(hms[1] ?? 0) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  let s = 0; let hit = false;
  for (const [, q, u] of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hour|hours|hr|hrs|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g)) {
    hit = true;
    s += Number(q) * (u.startsWith('h') ? 3600 : u.startsWith('m') ? 60 : 1);
  }
  return hit ? Math.round(s) : null;
}

export type Comm = {
  item_id: number; last_event_on: string | null;
  /** communications columns (source 'podio', source_id the item id). */
  row: {
    channel: 'call' | 'sms'; direction: 'inbound' | 'outbound'; occurred_at: string; from_phone: string | null; to_phone: string | null;
    body: string | null; summary: string | null; transcript: string | null; duration_s: number | null; recording_url: string | null;
    status: string | null; recording_id: string | null;
  };
  /** The other party's number, and the Podio items the Contact field points at (Acquisitions, Buyers…). */
  contact_phone: string | null; contact_item_ids: number[]; owner: string | null;
};

/** One Communications item → a communications row; null when it is not a call or text (no type, no number). */
export function readComm(item: Any): Comm | null {
  const r = itemRow(item);
  const get = (k: string) => cell(r, k);
  const type = one(get('Type')).toLowerCase();
  const channel = /text|sms/.test(type) ? 'sms' : /call|voice/.test(type) ? 'call' : null;
  const direction = /incoming|inbound/.test(type) ? 'inbound' : /outgoing|outbound/.test(type) ? 'outbound' : null;
  const theirs = e164(get('Contact Number'));
  const ours = e164(get('smrtPhone Number'));
  if (!channel || !direction || (!theirs && !ours)) return null;
  // A date field's `start` is in the viewer's zone; `start_utc` is not.
  const dateVal = (item?.fields ?? []).find((f: Any) => one(f.label).toLowerCase() === 'created date')?.values?.[0];
  const when = podioIso(dateVal?.start_utc) ?? podioIso(item?.created_on);
  const rec = [get('Call Recording Link'), get('Call Recording')].map((v) => /https?:\/\/\S+/.exec(v)?.[0]).find(Boolean) ?? null;
  const status = one(get(direction === 'inbound' ? 'Inbound Status' : 'Outbound Status')) || one(get('smrtDialer Status')) || null;
  const body = channel === 'sms'
    ? clean(get('Text Message')) || null
    : [clean(get('Call Notes')), clean(get('Voicemail')) && `Voicemail: ${clean(get('Voicemail'))}`].filter(Boolean).join('\n\n') || null;
  const contactField = (item?.fields ?? []).find((f: Any) => one(f.label).toLowerCase() === 'contact');
  return {
    item_id: Number(item?.item_id), last_event_on: podioIso(item?.last_event_on ?? item?.last_edit_on ?? item?.created_on),
    row: {
      channel, direction, occurred_at: when ?? new Date(0).toISOString(),
      from_phone: direction === 'inbound' ? theirs : ours, to_phone: direction === 'inbound' ? ours : theirs,
      body, summary: clean(get('AI Summary')) || null,
      transcript: clean(get('AI Transcript')) || clean(get('Transcription')) || null,
      duration_s: durationSeconds(get('Duration')), recording_url: rec,
      status: status ? status.toLowerCase().replace(/\s*\/\s*/g, '_').replace(/\s+/g, '_') : null,
      recording_id: one(get('Call ID')) || null,
    },
    contact_phone: theirs,
    contact_item_ids: (contactField?.values ?? []).map((v: Any) => Number(v.value?.item_id)).filter((x: number) => x > 0),
    owner: one(get('Call Owner')) || null,
  };
}

/** Count unmapped labels for the sync notes (label → items). */
export function tally(into: Record<string, number>, label: string) {
  into[label] = (into[label] ?? 0) + 1;
  return into;
}

// ---------------------------------------------------------------- history

/** One Podio field value in words: a category's text, "$145,000", a contact's or item's name, a date. */
export function podioValueText(v: Any, type: string): string {
  if (v == null) return '';
  if (type === 'money') { const n = Number(v.value); return Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : one(v.value); }
  if (type === 'category') return one(v.value?.text);
  if (type === 'date') return one(v.start_date ?? v.start ?? '');
  if (type === 'contact' || type === 'app') return one(v.value?.name ?? v.value?.title);
  const x = v.value ?? v;
  return typeof x === 'object' ? one(x.text ?? x.title ?? x.name ?? '') : one(stripHtml(String(x)));
}

export type HistoryLine = { kind: 'stage' | 'offer'; title: string; field_id: number; label: string; raw: string };
const STAGE_LABEL = /\b(stage|status|dead)\b/i;
const OFFER_LABEL = /\b(offer|counter)/i;

/**
 * The lines a Podio revision diff (GET /item/{id}/revision/{from}/{to}) puts
 * on the timeline: stage-like categories ("Stage → Offer Made") and offer or
 * counter amounts ("Offer Price $145,000"). Other edits are left out; a value
 * cleared is not a line. `stageOf` maps a Podio stage label to CLOZR's.
 */
export function historyLines(diff: Any[], stageOf: (label: string) => string | null = () => null): HistoryLine[] {
  const out: HistoryLine[] = [];
  for (const f of diff ?? []) {
    const label = one(f.label);
    const raw = (f.to ?? []).map((v: Any) => podioValueText(v, f.type)).filter(Boolean).join(', ');
    if (!raw) continue;
    if (f.type === 'category' && STAGE_LABEL.test(label)) {
      const title = /dead/i.test(label) ? `${label}: ${raw}` : 'Stage → ' + (stageOf(raw) ?? raw);
      out.push({ kind: 'stage', title, field_id: Number(f.field_id), label, raw });
    } else if (OFFER_LABEL.test(label) && (f.type === 'money' || f.type === 'number' || /\d/.test(raw))) {
      out.push({ kind: 'offer', title: `${label} ${f.type === 'number' ? '$' + Math.round(Number(raw)).toLocaleString('en-US') : raw}`, field_id: Number(f.field_id), label, raw });
    }
  }
  return out;
}

/** A Podio comment's text: rich value with tags stripped, else the plain value. */
export const commentText = (c: Any) => stripHtml(String(c?.value ?? '')).trim();

// ---------------------------------------------------------------- CLOZR → Podio (stage write-back)

/** One option of a Podio category field (GET /app/{id}: fields[].config.settings.options). */
export type PodioOption = { id: number; text: string; status?: string };
const optKey = (v: unknown) => one(v).toLowerCase();

/** The Stage field's option for a CLOZR stage: the same words (case and spacing ignored), active options first; null when Podio has no such stage. */
export function podioOptionFor(stage: string, options: PodioOption[]): PodioOption | null {
  const want = optKey(stage);
  if (!want) return null;
  const hits = options.filter((o) => optKey(o.text) === want);
  return hits.find((o) => (o.status ?? 'active') === 'active') ?? hits[0] ?? null;
}

export type PushDecision =
  | { kind: 'put'; option: PodioOption }
  | { kind: 'done'; why: 'already in Podio' }
  | { kind: 'skip'; why: 'no such stage in Podio' | 'changed in Podio since' };

/**
 * Whether a stage a person set in CLOZR is written to its Podio item. The
 * mirror of stageMove: the later change wins. Podio's stage is kept when it
 * changed after the CLOZR move (the item was edited after the move and its
 * stage is no longer the one CLOZR saw when the move was made); the live sync
 * then brings Podio's stage over as usual.
 */
export function pushDecision(o: {
  to: string; options: PodioOption[]; podioNow: string; podioAtMove: string | null | undefined;
  itemLastEvent: string | null | undefined; movedAt: string;
}): PushDecision {
  const option = podioOptionFor(o.to, o.options);
  if (option && optKey(o.podioNow) === optKey(option.text)) return { kind: 'done', why: 'already in Podio' };
  const editedSince = !!(o.itemLastEvent && Date.parse(o.itemLastEvent) > Date.parse(o.movedAt));
  if (editedSince && optKey(o.podioNow) !== optKey(o.podioAtMove)) return { kind: 'skip', why: 'changed in Podio since' };
  if (!option) return { kind: 'skip', why: 'no such stage in Podio' };
  return { kind: 'put', option };
}

// ---------------------------------------------------------------- CLOZR → Podio (offer amounts)

/** The deal columns written back to a Submissions item, and the Podio money field each one is. */
export const SUBMISSION_MONEY_FIELDS = {
  wholesale_offer: 'UW Suggested Low Offer',
  institutional_offer: 'UW Suggested High Offer',
  offer_amount: 'Offer Price',
} as const;
export type MoneyKey = keyof typeof SUBMISSION_MONEY_FIELDS;
export const MONEY_KEYS = Object.keys(SUBMISSION_MONEY_FIELDS) as MoneyKey[];

const amount = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const sameAmount = (a: unknown, b: unknown) => {
  const x = amount(a); const y = amount(b);
  return x != null && y != null && Math.abs(x - y) < 0.005;
};

/** A money field's amount on a Podio item (GET /item/{id}), by label; null when blank or absent. */
export function podioMoney(item: Any, label: string): number | null {
  const want = one(label).toLowerCase();
  const f = (item?.fields ?? []).find((x: Any) => x.type === 'money' && one(x.label ?? x.config?.label).toLowerCase() === want);
  return amount(f?.values?.[0]?.value);
}

export type ValuesPush = { put: Partial<Record<MoneyKey, number>>; already: MoneyKey[]; skipped: MoneyKey[] };

/**
 * Which offer amounts set in CLOZR are written to the Podio item: the money
 * mirror of pushDecision. A blank in CLOZR never blanks Podio. A field Podio
 * already agrees on is done. A field edited in Podio after the CLOZR change
 * (the item moved on since and Podio's amount is no longer the one the sync
 * last applied) keeps Podio's; the live sync brings it over.
 */
export function valuesPush(o: {
  want: Partial<Record<MoneyKey, unknown>>; podioNow: Partial<Record<MoneyKey, number | null>>;
  applied: Record<string, unknown> | null | undefined; itemLastEvent: string | null | undefined; movedAt: string;
}): ValuesPush {
  const out: ValuesPush = { put: {}, already: [], skipped: [] };
  const editedSince = !!(o.itemLastEvent && Date.parse(o.itemLastEvent) > Date.parse(o.movedAt));
  for (const k of MONEY_KEYS) {
    if (!(k in o.want)) continue;
    const want = amount(o.want[k]);
    if (want == null) { out.skipped.push(k); continue; }
    const now = o.podioNow[k] ?? null;
    if (sameAmount(now, want)) { out.already.push(k); continue; }
    const podioChanged = now != null && !sameAmount(now, o.applied?.[k]);
    if (editedSince && podioChanged) { out.skipped.push(k); continue; }
    out.put[k] = want;
  }
  return out;
}

// ---------------------------------------------------------------- cross-source dedupe

export type PropertyDeal = DealCandidate & {
  lead_stage?: string | null;
  archived_at?: string | null;
  archived_reason?: string | null;
  created_at?: string | null;
  zip?: string | null;
};

const byNewest = <T extends DealCandidate>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? '') || b.id - a.id);

/**
 * One live deal on the property, whatever its source, is the submission.
 * Several: a deal that already has a submission stage, then the partner or
 * contact match, then the newest. Equal timestamps with nothing else to
 * choose by are ambiguous — the caller writes nothing.
 */
export function pickAnySourceDeal(cands: PropertyDeal[], s: Pick<Submission, 'partner_key' | 'phone' | 'email'>): DealPick {
  const live = cands.filter((c) => !c.archived_at);
  if (!live.length) return null;
  if (live.length === 1) return { id: live[0].id, by: 'address (any source)' };
  const staged = live.filter((c) => c.lead_stage != null && c.lead_stage !== '');
  const pool = staged.length ? staged : live;
  if (pool.length === 1) return { id: pool[0].id, by: 'address (any source)' };
  const pick = pickSubmissionDeal(pool, s);
  if (pick && 'id' in pick) return { id: pick.id, by: 'address (any source)' };
  const tied = pick && 'ambiguous' in pick ? pool.filter((c) => pick.ambiguous.includes(c.id)) : pool;
  const sorted = byNewest(tied);
  const top = sorted[0]?.submitted_at ?? '';
  const same = sorted.filter((x) => (x.submitted_at ?? '') === top);
  if (same.length > 1) return { ambiguous: same.map((x) => x.id) };
  return sorted[0] ? { id: sorted[0].id, by: 'address (any source)' } : null;
}

/**
 * The only deals on the property are archived as duplicates of something else.
 * Never recreate that submission. A live deal, when there is one, is linked
 * by pickAnySourceDeal instead; this note is only the "nothing live" case.
 */
export function duplicateArchiveNote(deals: { archived_at?: string | null; archived_reason?: string | null }[]): string | null {
  if (!deals.length || deals.some((d) => !d.archived_at)) return null;
  if (!deals.every((d) => /duplicate/i.test(d.archived_reason ?? ''))) return null;
  return 'Only an archived duplicate on this property: not recreated.';
}

const ZIP_TWIN_MS = 2 * 60 * 60 * 1000;

/**
 * No street ("Durham, NC 27701"): a live deal created within ±2 hours on the
 * same zip whose partner or contact matches. One match is the Jotform twin.
 */
export function pickZipTwin(
  cands: PropertyDeal[],
  s: Pick<Submission, 'created' | 'phone' | 'email' | 'partner_key'>,
  zip: string | null,
): DealPick {
  if (!zip || !s.created) return null;
  const t = Date.parse(s.created);
  if (Number.isNaN(t)) return null;
  const pk = s.phone ? phoneKey(s.phone) : null;
  const em = s.email?.toLowerCase() ?? null;
  const hits = cands.filter((c) => {
    if (c.archived_at) return false;
    if ((c.zip ?? '').slice(0, 5) !== zip) return false;
    const ct = Date.parse(c.created_at ?? '');
    if (Number.isNaN(ct) || Math.abs(ct - t) > ZIP_TWIN_MS) return false;
    const partner = !!(s.partner_key && partnerOfSourceId(c.source_id) === s.partner_key);
    const contact = !!((pk && phoneKey(c.seller_phone_key) === pk) || (em && c.seller_email?.toLowerCase() === em));
    return partner || contact;
  });
  if (hits.length === 1) return { id: hits[0].id, by: 'zip + contact' };
  if (hits.length > 1) return { ambiguous: hits.map((h) => h.id) };
  return null;
}

// ---------------------------------------------------------------- roster

export type RosterMember = { user_id: string; full_name?: string | null; email?: string | null };

/** A Podio contact → one workspace member, by email, else by full name. Several matches is no match. */
export function matchRoster(roster: readonly RosterMember[], person: { name?: string | null; email?: string | null }): string | null {
  const em = person.email ? person.email.toLowerCase() : null;
  if (em) {
    const byEmail = roster.filter((m) => m.email && m.email.toLowerCase() === em);
    if (byEmail.length === 1) return byEmail[0].user_id;
    if (byEmail.length > 1) return null;
  }
  const nk = person.name ? personKey(person.name) : '';
  if (!nk) return null;
  const byName = roster.filter((m) => m.full_name && personKey(m.full_name) === nk);
  return byName.length === 1 ? byName[0].user_id : null;
}

// ---------------------------------------------------------------- run bounds

/** Re-applied or created items one sync run will do before it saves the cursor and stops. */
export const SYNC_ITEM_CAP = 150;

/**
 * Stop the page loop. Wall clock and Podio calls, and also how many items
 * this run has actually applied — a mapping re-apply is CPU, not just requests,
 * and the cursor has to be on disk before that budget runs out.
 */
export function stopSyncPage(o: {
  applied: number; calls: number; callCap: number; now: number; deadline: number; itemCap?: number;
}): boolean {
  if (o.now > o.deadline) return true;
  if (o.calls >= o.callCap - 2) return true;
  if (o.applied >= (o.itemCap ?? SYNC_ITEM_CAP)) return true;
  return false;
}

export type PageCursor = {
  since: string | null; offset: number | null; pass_started: string | null;
  filter_key?: string; total?: number; retry?: number[];
};

/**
 * The cursor after a page. A page that ran out of items closes the pass
 * (`offset` null, `since` = when the pass began). A page that stopped early,
 * or a full page with more behind it, keeps the offset so the next run
 * resumes there instead of at the start.
 */
export function cursorAfterPage(
  cur: PageCursor,
  processed: number,
  page: { length: number; size: number },
): PageCursor {
  const offset = (cur.offset ?? 0) + processed;
  const finished = processed >= page.length && page.length < page.size;
  if (finished) {
    return { since: cur.pass_started, offset: null, pass_started: null, filter_key: cur.filter_key, total: cur.total, retry: cur.retry };
  }
  return { ...cur, offset };
}

/** Where the next run starts reading. A finished pass (`offset` null) starts at 0 of a new window. */
export const resumeOffset = (cur: { offset?: number | null } | null | undefined): number =>
  cur?.offset != null ? cur.offset : 0;

const APP_LABEL: Record<string, string> = {
  submissions: 'Submissions', deals: 'Deals', acquisitions: 'Acquisitions', communications: 'Communications',
};

/** Apps saved without a token. The wording is what last_sync_notes.warnings carries. */
export function tokenWarnings(apps: { key: string; app_token?: string | null }[]): string[] {
  return apps.filter((a) => !String(a.app_token ?? '').trim()).map((a) => `${APP_LABEL[a.key] ?? a.key} app has no token: not syncing`);
}

/**
 * History's Podio budget for Submissions while the outbox still has rows.
 * The write-back keeps `reserve` calls; history takes what is left and still
 * advances, instead of waiting until the queue is empty.
 */
export function historyCallCap(queued: number, cap: number, reserve = 80): number {
  if (!queued) return cap;
  return Math.max(12, cap - reserve);
}
