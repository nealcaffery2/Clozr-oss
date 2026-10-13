/**
 * Podio → CLOZR: the pure half of the importer.
 *
 * No network, no Deno, no Supabase — so the podio-import function and the
 * assert check (app/tools/podio-map.test.ts, `npx tsx`) run the same code.
 *
 *   guessMapping(fields)   label keywords + field type → which Podio field fills each CLOZR target
 *   clozrStage(text)       a Podio stage option → CLOZR deal stage (lib/stages.ts DEAL_STAGES)
 *   read*(field)           a Podio item field's `values` → a plain CLOZR value
 *   personFromItem(item)   a referenced Podio item (a contact/vendor/buyer app) → name, email, phone, company
 *
 * Podio item field values (developers.podio.com/doc/items):
 *   text        [{ value: "html or plain" }]
 *   number      [{ value: "1234.0000" }]           money [{ value: "1000.0000", currency }]
 *   calculation [{ value: "1234.5" }]               date  [{ start_date: "2026-01-02", start: "2026-01-02 00:00:00" }]
 *   category    [{ value: { id, text } }]           app   [{ value: { item_id, title, app: { app_id } } }]
 *   contact     [{ value: { profile_id, user_id?, name, mail?: [], phone?: [] } }]
 *   location    [{ value, formatted?, street_number?, street_address?, city?, state?, postal_code? }]
 *   phone/email [{ type, value }]                   link/embed [{ embed: { url } }]
 */

// deno-lint-ignore no-explicit-any
type Any = any;

export type PodioField = {
  field_id: number; external_id: string; type: string; label: string;
  options?: { id: number; text: string; clozr?: string | null }[]; referenced_apps?: number[];
};

export type TargetKind = 'stage' | 'address' | 'party' | 'date' | 'money' | 'text' | 'email' | 'phone';
export type Target = { key: string; label: string; group: string; kind: TargetKind; role?: PartyRole; types: string[] };

export type PartyRole =
  | 'seller' | 'buyer' | 'title' | 'photographer' | 'wholesaler' | 'listing_agent' | 'buyers_agent' | 'realtor'
  | 'tc' | 'acquisitions' | 'dispositions' | 'lender' | 'contractor' | 'other';

const PEOPLE = ['app', 'contact', 'text'];
const REF = ['app', 'contact'];
const MONEY = ['money', 'number', 'calculation'];

type Rule = [key: string, label: string, group: string, kind: TargetKind, re: RegExp, types: string[], role?: PartyRole];

/**
 * Order matters twice: a field is claimed by the first rule that matches it,
 * and a target keeps the first field it gets. Specific labels come before
 * general ones ("Earnest money lost" before "Earnest money", "Buyer's agent"
 * before "Buyer", "Title contact" before "Title company").
 */
const RULES: Rule[] = [
  ['stage', 'Deal stage', 'Deal', 'stage', /stage|^(deal |current )?status$/, ['category']],
  ['address', 'Property address', 'Deal', 'address', /address|^property$|^location$|street|^property (location|name)$/, ['location', 'text', 'app']],

  ['title_email', 'Title email', 'Title', 'email', /(title|escrow).*e-?mail/, ['email', 'text']],
  ['title_phone', 'Title phone', 'Title', 'phone', /(title|escrow).*(phone|tel|cell)/, ['phone', 'text']],
  ['title_contact', 'Title contact / escrow officer', 'Title', 'party', /(title|escrow).*(contact|officer|closer|agent|rep|processor)|escrow officer/, PEOPLE, 'title'],
  ['title_company', 'Title company', 'Title', 'party', /\btitle\b|escrow/, ['app', 'contact', 'category'], 'title'],
  ['title_company', 'Title company', 'Title', 'party', /title (company|co\b|agency)|escrow company/, ['text'], 'title'],

  ['cogs_earnest_lost', 'COGS · earnest money lost', 'COGS', 'money', /(earnest|emd).*lost/, MONEY],
  ['cogs_photos', 'COGS · photos', 'COGS', 'money', /photo/, MONEY],
  ['cogs_contractor', 'COGS · contractor', 'COGS', 'money', /contractor/, MONEY],
  ['cogs_realtor', 'COGS · realtor commissions', 'COGS', 'money', /(realtor|agent) comm/, MONEY],
  ['cogs_title_fees', 'COGS · title fees', 'COGS', 'money', /title fee/, MONEY],
  ['cogs_bonuses', 'COGS · bonuses', 'COGS', 'money', /bonus/, MONEY],
  ['cogs_lockbox', 'COGS · lockbox', 'COGS', 'money', /lock ?box/, MONEY],
  ['cogs_lead', 'COGS · lead cost', 'COGS', 'money', /lead (cost|fee)|marketing cost/, MONEY],
  ['cogs_notary', 'COGS · notary', 'COGS', 'money', /notary/, MONEY],
  ['cogs_transactional', 'COGS · transactional funding', 'COGS', 'money', /transactional/, MONEY],
  ['cogs_flat_fee', 'COGS · flat fee', 'COGS', 'money', /flat fee/, MONEY],
  ['cogs_concessions', 'COGS · concessions', 'COGS', 'money', /concession/, MONEY],
  ['team_commissions_paid', 'Team commissions paid', 'COGS', 'money', /team comm/, MONEY],
  ['lac_pct', 'LAC %', 'COGS', 'money', /\blac\b|listing agent comm/, MONEY],
  ['bac_pct', 'BAC %', 'COGS', 'money', /\bbac\b|buyer'?s? agent comm/, MONEY],

  // Relationship fields (app/contact) match on a word; free-text fields only on a label that names a person.
  ['photographer', 'Photographer', 'Deal team', 'party', /photo/, REF, 'photographer'],
  ['photographer', 'Photographer', 'Deal team', 'party', /photographer/, ['text'], 'photographer'],
  ['wholesaler', 'Wholesaler / JV partner', 'Deal team', 'party', /wholesal|\bjv\b|joint venture/, PEOPLE, 'wholesaler'],
  ['listing_agent', 'Listing agent', 'Deal team', 'party', /listing agent|list agent|seller'?s? agent/, PEOPLE, 'listing_agent'],
  ['buyers_agent', "Buyer's agent", 'Deal team', 'party', /buyer'?s? agent|selling agent/, PEOPLE, 'buyers_agent'],
  ['lender', 'Lender', 'Deal team', 'party', /lender|loan officer|hard money/, PEOPLE, 'lender'],
  ['contractor', 'Contractor', 'Deal team', 'party', /contractor/, REF, 'contractor'],
  ['tc', 'Transaction coordinator', 'Team', 'party', /\btc\b|transaction coord/, REF, 'tc'],
  ['tc', 'Transaction coordinator', 'Team', 'party', /^tc( rep| name)?$|transaction coordinator/, ['text'], 'tc'],
  ['dispositions2', 'Second dispo rep', 'Team', 'party', /(dispo|disposition).*(2|second|secondary)/, REF, 'dispositions'],
  ['dispositions', 'Dispo rep', 'Team', 'party', /dispo/, REF, 'dispositions'],
  ['dispositions', 'Dispo rep', 'Team', 'party', /dispo.*(rep|manager)/, ['text'], 'dispositions'],
  ['acquisitions', 'Acquisitions rep', 'Team', 'party', /\bacq|acquisition|lead manager|deal owner/, REF, 'acquisitions'],
  ['acquisitions', 'Acquisitions rep', 'Team', 'party', /(acq|acquisitions?).*(rep|manager)/, ['text'], 'acquisitions'],
  ['realtor', 'Realtor', 'Deal team', 'party', /realtor|\bagent\b|broker/, REF, 'realtor'],
  ['realtor', 'Realtor', 'Deal team', 'party', /^realtor( name)?$/, ['text'], 'realtor'],
  ['buyer', 'Buyer', 'Parties', 'party', /buyer|assignee/, REF, 'buyer'],
  ['buyer', 'Buyer', 'Parties', 'party', /^(end )?buyers?( name)?$|assignee/, ['text'], 'buyer'],
  ['seller', 'Seller', 'Parties', 'party', /seller|homeowner|property owner|related contact|^contacts?$|^lead$/, REF, 'seller'],
  ['seller', 'Seller', 'Parties', 'party', /^sellers?( name)?$|^homeowner$/, ['text'], 'seller'],

  ['closed_on', 'Closed on', 'Dates', 'date', /closed (on|date)|date closed|actual clos/, ['date']],
  ['option_ends_on', 'Option period ends', 'Dates', 'date', /option|inspection|feasibility|due diligence/, ['date']],
  ['marketing_started_on', 'Marketing started', 'Dates', 'date', /marketing/, ['date']],
  ['close_date', 'Close date', 'Dates', 'date', /clos|\bcoe\b/, ['date']],
  ['contract_date', 'Contract date', 'Dates', 'date', /contract|\buc\b/, ['date']],

  ['earnest_money', 'Earnest money', 'Money', 'money', /earnest|\bemd\b/, MONEY],
  ['sold_price', 'Sold price', 'Money', 'money', /sold|sale price|selling price|dispo price|buyer'?s? price|assignment price/, MONEY],
  ['assignment_fee', 'Assignment fee', 'Money', 'money', /assignment fee|wholesale fee|spread/, MONEY],
  ['mao', 'MAO', 'Money', 'money', /\bmao\b|max(imum)? (allowable )?offer/, MONEY],
  ['offer_amount', 'Under contract price', 'Money', 'money', /contract price|purchase price|offer|acquisition price|contract amount|\buc price/, MONEY],
  ['arv', 'ARV', 'Money', 'money', /\barv\b|after repair/, MONEY],
  ['rehab', 'Rehab estimate', 'Money', 'money', /rehab|repair/, MONEY],

  ['underwriting_url', 'Underwriting spreadsheet', 'Notes', 'text', /underwriting|comp sheet|spreadsheet/, ['link', 'embed', 'text']],
  ['condition_notes', 'Condition', 'Notes', 'text', /condition/, ['text']],
  ['occupancy_notes', 'Occupancy / vacate', 'Notes', 'text', /occupan|vacat/, ['text', 'category']],
  ['market', 'Market', 'Notes', 'text', /market\b|region/, ['category', 'text']],
  ['notes', 'Notes', 'Notes', 'text', /notes?|comments?|description|details/, ['text']],
];

/** Which Podio field types a target can read, for the mapping dropdowns. */
export const targetTypes = (key: string): string[] => [...new Set(RULES.filter((r) => r[0] === key).flatMap((r) => r[5]))];

export const TARGETS: Target[] = [...new Map(RULES.map(([key, label, group, kind, , , role]): [string, Target] => [key, { key, label, group, kind, role, types: targetTypes(key) }])).values()];

export type Mapping = Record<string, string>; // target key → Podio external_id

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();

/** The auto mapping: every target a field plausibly fills, each field used once. */
export function guessMapping(fields: PodioField[]): Mapping {
  const out: Mapping = {};
  const used = new Set<string>();
  for (const [key, , , , re, types] of RULES) {
    if (out[key]) continue;
    for (const f of fields) {
      if (used.has(f.external_id) || !types.includes(f.type)) continue;
      if (!re.test(norm(f.label))) continue;
      out[key] = f.external_id; used.add(f.external_id);
      break;
    }
  }
  return out;
}

/**
 * A Podio stage option → CLOZR deal stage. Matches by contains so "UC - Seller",
 * "Under Contract (Buyer)" and "In Escrow / Closing" land where they should.
 */
export function clozrStage(text: string | null | undefined): string | null {
  const t = norm(text ?? '');
  if (!t) return null;
  if (/terminat|cancel|dead|lost/.test(t)) return 'Terminated';
  if (/escrow|closing|clear to close/.test(t)) return 'In Escrow';
  if (/closed|funded|sold/.test(t)) return 'Closed';
  if (/buyer/.test(t) && /contract|\buc\b|assign/.test(t)) return 'Buyer Under Contract';
  if (/assigned/.test(t)) return 'Buyer Under Contract';
  if (/market|dispo/.test(t)) return 'Ready To Market';
  if (/contract|\buc\b/.test(t)) return 'Under Contract Seller';
  if (/realtor|referr/.test(t)) return 'Realtor Referral';
  return null;
}
/** The three stages the owner asked for — ticked by default in the stage picker. */
export const DEFAULT_IMPORT_STAGES = ['Under Contract Seller', 'In Escrow', 'Buyer Under Contract'];

/** The seller lead_stage a deal stage implies (mirrors lib/stages.ts sellerStageForDeal and the deals_stage_after trigger). */
export const sellerStageFor = (dealStage: string): string => ({
  'Under Contract Seller': 'Under Contract - Seller', 'Ready To Market': 'Under Contract - Seller',
  'Buyer Under Contract': 'Under Contract - Buyer', 'In Escrow': 'Under Contract - Buyer',
  Closed: 'Closed', Terminated: 'Terminated', 'Realtor Referral': 'Referred to Realtor',
} as Record<string, string>)[dealStage] ?? 'Under Contract - Seller';

/** Vendor service_type per role (vendors.service_type is free text). */
export const VENDOR_TYPE: Partial<Record<PartyRole, string>> = {
  title: 'Title', photographer: 'Photographer', wholesaler: 'Wholesaler', listing_agent: 'Realtor',
  buyers_agent: 'Realtor', realtor: 'Realtor', lender: 'Lender', contractor: 'Contractor',
};
export const TEAM_ROLES: PartyRole[] = ['tc', 'acquisitions', 'dispositions'];

// ---- reading values ---------------------------------------------------------

export const stripHtml = (s: string) => s.replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

export const fieldOf = (item: Any, externalId: string | undefined): Any | null =>
  externalId ? (item?.fields ?? []).find((f: Any) => f.external_id === externalId) ?? null : null;

export function readText(f: Any): string | null {
  if (!f?.values?.length) return null;
  const parts = f.values.map((v: Any) => {
    const x = v.value;
    if (typeof x === 'string' || typeof x === 'number') return stripHtml(String(x));
    if (x?.text) return x.text;            // category
    if (x?.title) return x.title;          // app reference
    if (x?.name) return x.name;            // contact
    if (v.embed?.url) return v.embed.url;  // link
    return v.formatted ?? '';
  }).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function readNumber(f: Any): number | null {
  const raw = f?.values?.[0]?.value;
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(raw).match(/\d/) ? n : null;
}

export function readDate(f: Any): string | null {
  const v = f?.values?.[0];
  const d = v?.start_date ?? (typeof v?.start === 'string' ? v.start.slice(0, 10) : null);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export const readCategories = (f: Any): string[] => (f?.values ?? []).map((v: Any) => v.value?.text).filter(Boolean);

export type Address = { line1: string; city: string | null; state: string | null; zip: string | null; full: string };

/** "123 Oak St, San Antonio, TX 78254, USA" → parts; Podio's location parts when it sent them. */
export function parseAddress(raw: string | null | undefined): Address | null {
  const full = (raw ?? '').replace(/\s+/g, ' ').trim().replace(/,\s*(USA|United States)$/i, '');
  if (!full) return null;
  const parts = full.split(',').map((p) => p.trim()).filter(Boolean);
  let zip: string | null = null; let state: string | null = null;
  const last = parts[parts.length - 1] ?? '';
  const m = /^([A-Za-z]{2})\s*(\d{5}(?:-\d{4})?)?$/.exec(last);
  if (parts.length > 1 && m) { state = m[1].toUpperCase(); zip = m[2] ?? null; parts.pop(); }
  else if (parts.length > 1 && /^\d{5}(-\d{4})?$/.test(last)) { zip = last; parts.pop(); }
  const line1 = parts[0] ?? full;
  const city = parts.length > 1 ? parts[parts.length - 1] : null;
  return { line1, city, state, zip, full };
}

export function readAddress(f: Any): Address | null {
  const v = f?.values?.[0];
  if (!v) return null;
  if (f.type === 'location' && (v.street_address || v.city)) {
    const line1 = [v.street_number, v.street_address].filter(Boolean).join(' ') || (v.formatted ?? v.value ?? '').split(',')[0];
    return { line1, city: v.city ?? null, state: v.state ?? null, zip: v.postal_code ?? null, full: v.formatted ?? v.value ?? line1 };
  }
  return parseAddress(readText(f));
}

/** US numbers the way normalize_phone() keys them, so a match here is a match in sellers_phone_uniq. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}

/** One person or company a deal field points at, before it is matched to a CLOZR row. */
export type PodioPerson = {
  ref: 'item' | 'profile' | 'text';
  /** "item:123" / "profile:456" / "text:<name>" — the stable source_id for re-runs. */
  source_id: string;
  item_id?: number; app_id?: number; user_id?: number;
  name: string; email: string | null; phone: string | null; company: string | null;
};

/** The people a deal field references. A text field is one name (or a comma list of them). */
export function readPeople(f: Any): PodioPerson[] {
  if (!f?.values?.length) return [];
  if (f.type === 'app') {
    return f.values.map((v: Any) => ({
      ref: 'item', source_id: 'item:' + v.value?.item_id, item_id: v.value?.item_id, app_id: v.value?.app?.app_id,
      name: (v.value?.title ?? '').trim(), email: null, phone: null, company: null,
    })).filter((p: PodioPerson) => p.item_id);
  }
  if (f.type === 'contact') {
    return f.values.map((v: Any) => {
      const c = v.value ?? {};
      const mail = Array.isArray(c.mail) ? c.mail[0] : c.mail;
      const phone = Array.isArray(c.phone) ? c.phone[0] : c.phone;
      return {
        ref: 'profile', source_id: 'profile:' + c.profile_id, user_id: c.user_id ?? undefined,
        name: (c.name ?? '').trim(), email: mail ?? null, phone: phone ?? null, company: c.organization ?? null,
      };
    }).filter((p: PodioPerson) => p.name);
  }
  const text = readText(f);
  if (!text) return [];
  return text.split(/\n|;/).map((s) => s.trim()).filter(Boolean).map((name) => ({
    ref: 'text', source_id: 'text:' + name.toLowerCase(), name, email: null, phone: null, company: null,
  }));
}

/** A referenced Podio item (a Contacts / Buyers / Vendors app row) → the details a CLOZR row needs. */
export function personFromItem(item: Any): Pick<PodioPerson, 'name' | 'email' | 'phone' | 'company'> {
  const fields: Any[] = item?.fields ?? [];
  const pick = (type: string, re?: RegExp) => fields.find((f) => f.type === type && (!re || re.test(norm(f.label ?? ''))));
  const email = pick('email') ?? pick('text', /e-?mail/);
  const phone = pick('phone') ?? pick('text', /phone|cell|mobile/);
  const company = pick('text', /company|business|brokerage|entity|llc/) ?? pick('app', /company|business|brokerage/);
  const contact = pick('contact');
  const emailVal = email?.type === 'email' ? email.values?.[0]?.value : readText(email);
  const phoneVal = phone?.type === 'phone' ? phone.values?.[0]?.value : readText(phone);
  const contactVal = contact?.values?.[0]?.value;
  return {
    name: String(item?.title ?? contactVal?.name ?? '').trim(),
    email: emailVal ?? (Array.isArray(contactVal?.mail) ? contactVal.mail[0] : null) ?? null,
    phone: phoneVal ?? (Array.isArray(contactVal?.phone) ? contactVal.phone[0] : null) ?? null,
    company: readText(company),
  };
}

/** Deal columns a mapping fills straight from a field (dates, money, text). */
export function dealColumns(item: Any, mapping: Mapping): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const { key, kind } of TARGETS) {
    const f = fieldOf(item, mapping[key]);
    if (!f) continue;
    if (kind === 'date') out[key] = readDate(f);
    else if (kind === 'money') out[key] = readNumber(f);
    else if (kind === 'text' || kind === 'email' || kind === 'phone') out[key] = readText(f);
  }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/** Loose name equality for matching teammates and existing rows ("Diego Ortiz III" ~ "diego nava"). */
export const nameKey = (s: string | null | undefined) =>
  norm(s ?? '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
