// Clozr Docs variables: `{{deal.purchase_price|currency}}` and friends.
//
// Every variable resolves from a real CLOZR column when the contract is
// created, is frozen into it with the rest of the text, and can be overridden
// per document (a token named like the variable wins). This sits beside the
// older `[Deal.PurchasePrice]` tokens (esign-map.ts): a template can use
// either, and both report what the record could not answer so the form asks.
//
// Syntax
//   {{deal.purchase_price}}                     a value, in its default format
//   {{deal.purchase_price|currency}}            formatters chain left to right:
//       currency · number · words · date · date:long · date:short · date:iso ·
//       upper · lower · title · default:"N/A"
//   {{#if property.state == "TX"}}…{{else}}…{{/if}}   also !=, and a bare
//       {{#if seller2.name}} for "has a value". Blocks may nest.
//   {{sign:role}} is a signature block and is left alone.
//
// No I/O: tools/doc-vars.test.ts covers it.

export type VarType = 'text' | 'money' | 'date' | 'number';
export type VarValue = { value: string | number | null; type: VarType };
export type Vars = Record<string, VarValue>;

type Row = Record<string, unknown> | null | undefined;

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const s = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());
const n = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v: unknown): VarValue => ({ value: s(v), type: 'text' });
const money = (v: unknown): VarValue => ({ value: n(v), type: 'money' });
const date = (v: unknown): VarValue => ({ value: s(v), type: 'date' });

export type DocParties = {
  deal?: Row; seller?: Row; seller2?: Row; prop?: Row; buyer?: Row; offer?: Row;
  /** The title company vendor on the deal (deals.title_vendor_id), when there is one. */
  title?: Row;
  /** Team members on the deal: acquisitions (deal owner), dispositions, TC. */
  reps?: { acq?: Row; dispo?: Row; tc?: Row };
};
export type DocCompany = { name?: string; legal?: string; address?: string; signer?: string; title?: string; email?: string; phone?: string };

/** The variable catalog, resolved from one deal's records. Unknown values are null (and reported when used). */
export function docVars(p: DocParties, company: DocCompany, doc: { date?: string; ref?: string | number | null } = {}): Vars {
  const { deal, seller, seller2, prop, buyer, offer, title, reps } = p;
  const line1 = s(prop?.line1) ?? s(seller?.property_address);
  const city = s(prop?.city); const st = s(prop?.state); const zip = s(prop?.zip);
  const address = line1 ? [line1, [city, [st, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') : null;
  const price = n(deal?.offer_amount);
  const fee = n(deal?.assignment_fee);
  const total = n(deal?.sold_price) ?? (price != null ? price + (fee ?? 0) : null);
  const terms = (offer?.terms ?? {}) as Record<string, unknown>;
  const repName = (r: Row, fallback: unknown) => text(s(r?.full_name) ?? s(fallback));
  return {
    'property.address': text(address),
    'property.street': text(line1),
    'property.city': text(city),
    'property.state': text(st),
    'property.state_name': text(st ? STATE_NAMES[st.toUpperCase()] ?? st : null),
    'property.zip': text(zip),
    'property.county': text(prop?.county),
    'property.apn': text(prop?.apn),
    'property.legal_description': text(prop?.legal_description),

    'deal.purchase_price': money(price),
    'deal.assignment_fee': money(fee),
    'deal.assignment_total': money(total),
    'deal.buyer_emd': money(deal?.buyer_emd_amount ?? deal?.buyer_emd),
    'deal.inhouse_emd': money(deal?.inhouse_emd_amount ?? deal?.earnest_money),
    'deal.inhouse_emd_due': date(deal?.inhouse_emd_due_on),
    'deal.emd': money(deal?.earnest_money),
    'deal.arv': money(deal?.arv),
    'deal.repairs': money(deal?.rehab),
    'deal.contract_date': date(deal?.contract_date),
    'deal.close_date': date(deal?.close_date),
    'deal.option_ends': date(deal?.option_ends_on),
    // PandaDoc parity: the values Robin typed into every PSA / assignment / TREC by hand.
    'deal.option_fee': money(deal?.option_fee),
    'deal.option_days': { value: n(deal?.option_period_days), type: 'number' },
    'deal.emd_days': { value: n(deal?.emd_due_days), type: 'number' },
    'deal.buyer_option_ends': date(deal?.buyer_option_ends_on),
    'deal.marketed_price': money(deal?.marketed_price),
    'deal.special_terms': text(deal?.special_provisions),
    'deal.tc_fee': money(deal?.tc_fee),

    'title.company': text(s(title?.business_name) ?? s(deal?.title_company) ?? s(deal?.title_contact)),
    'title.contact': text(s(title?.contact_name) ?? s(deal?.title_contact)),
    'title.email': text(s(title?.email) ?? s(deal?.title_email)),
    'title.phone': text(s(title?.phone) ?? s(deal?.title_phone)),

    'seller.name': text(seller?.name),
    'seller.email': text(seller?.email),
    'seller.phone': text(seller?.phone),
    'seller.mailing_address': text([s(seller?.mailing_line1), [s(seller?.mailing_city), [s(seller?.mailing_state), s(seller?.mailing_zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null),
    'seller.first_name': text(s(seller?.name)?.split(/\s+/)[0] ?? null),
    'seller2.name': text(seller2?.name),
    'seller2.email': text(seller2?.email),
    'buyer.name': text(buyer?.name),
    'buyer.entity': text(s(buyer?.company) ?? s(buyer?.name)),
    'buyer.email': text(buyer?.email),
    'buyer.phone': text(buyer?.phone),

    'company.entity': text(s(company.legal) ?? s(company.name)),
    'company.name': text(company.name),
    'company.signer': text(company.signer),
    'company.title': text(company.title),
    'company.address': text(company.address),
    'company.email': text(company.email),
    'company.phone': text(company.phone),

    'rep.acq': repName(reps?.acq, deal?.acq_agent),
    'rep.dispo': repName(reps?.dispo, deal?.dispo_agent),
    'rep.tc': repName(reps?.tc, deal?.coordinator),
    // Agent block on TREC forms (was hardcoded per agent in PandaDoc, e.g. "Taylor's - One to Four 2026").
    'rep.acq_email': text(reps?.acq?.email),
    'rep.acq_phone': text(reps?.acq?.phone),
    'rep.acq_license': text(reps?.acq?.license_number),
    'company.brokerage_name': text((company as Row)?.brokerage_name),
    'company.brokerage_address': text((company as Row)?.brokerage_address),
    'company.brokerage_license': text((company as Row)?.brokerage_license),
    'company.supervisor_name': text((company as Row)?.supervisor_name),
    'company.supervisor_phone': text((company as Row)?.supervisor_phone),
    'company.supervisor_license': text((company as Row)?.supervisor_license),

    'offer.amount': money(offer?.amount),
    'offer.expires': date(offer?.expires_on),
    'offer.emd': money(terms.emd),
    'offer.close_days': { value: n(terms.close_days), type: 'number' },

    'doc.date': date(doc.date ?? new Date().toISOString()),
    'doc.ref': text(doc.ref),
  };
}

// ------------------------------------------------------------------ formatting

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(x: number): string {
  const h = Math.floor(x / 100); const r = x % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : '');
  return [h ? ONES[h] + ' hundred' : '', rest].filter(Boolean).join(' ');
}
/** 85000 → "Eighty-five thousand dollars"; cents become "and 50/100". */
export function moneyWords(amount: number): string {
  const whole = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - whole) * 100);
  if (whole === 0 && !cents) return 'Zero dollars';
  const scales = ['', ' thousand', ' million', ' billion'];
  const parts: string[] = [];
  let x = whole; let i = 0;
  while (x > 0 && i < scales.length) { const chunk = x % 1000; if (chunk) parts.unshift(under1000(chunk) + scales[i]); x = Math.floor(x / 1000); i++; }
  const words = (parts.join(' ') || 'zero') + (whole === 1 ? ' dollar' : ' dollars') + (cents ? ` and ${String(cents).padStart(2, '0')}/100` : '');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const asDate = (v: string | number): Date | null => {
  const raw = String(v);
  // A bare YYYY-MM-DD is a calendar day, not midnight UTC shifted a day back in Texas.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(raw + 'T12:00:00Z') : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};
const fmtDate = (v: string | number, style: string): string => {
  const d = asDate(v);
  if (!d) return String(v);
  if (style === 'iso') return d.toISOString().slice(0, 10);
  if (style === 'long') return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  return d.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Chicago' });
};
const usd = (x: number) => x.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 2 });

/** One value in its default format: money as $85,000, dates as MM/DD/YYYY. */
export function defaultFormat(v: VarValue): string {
  if (v.value == null || v.value === '') return '';
  if (v.type === 'money') return usd(Number(v.value));
  if (v.type === 'date') return fmtDate(v.value, 'short');
  if (v.type === 'number') return Number(v.value).toLocaleString('en-US');
  return String(v.value);
}

/** Split `currency|default:"N/A"` without breaking a quoted `|`. */
function splitPipes(spec: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (const ch of spec) {
    if (ch === '"') q = !q;
    if (ch === '|' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function applyFormatters(v: VarValue | undefined, pipes: string[]): { out: string; missing: boolean } {
  let raw: string | number | null = v?.value ?? null;
  const type = v?.type ?? 'text';
  let out: string | null = null;
  let fallback: string | null = null;
  for (const p of pipes) {
    const [name, ...argParts] = p.split(':');
    const arg = argParts.join(':').trim().replace(/^"(.*)"$/, '$1');
    if (name === 'default') { fallback = arg; continue; }
    if (raw == null || raw === '') continue;
    const num = Number(String(raw).replace(/[$,]/g, ''));
    switch (name) {
      case 'currency': out = Number.isNaN(num) ? String(raw) : usd(num); break;
      case 'number': out = Number.isNaN(num) ? String(raw) : num.toLocaleString('en-US'); break;
      case 'words': out = Number.isNaN(num) ? String(raw) : moneyWords(num); break;
      case 'date': out = fmtDate(raw, arg || 'short'); break;
      case 'upper': out = (out ?? defaultFormat({ value: raw, type })).toUpperCase(); break;
      case 'lower': out = (out ?? defaultFormat({ value: raw, type })).toLowerCase(); break;
      case 'title': out = (out ?? defaultFormat({ value: raw, type })).replace(/\b\w/g, (c) => c.toUpperCase()); break;
      default: break;
    }
    if (out != null) raw = out;
  }
  if (raw == null || raw === '') return fallback != null ? { out: fallback, missing: false } : { out: '', missing: true };
  return { out: out ?? defaultFormat({ value: raw, type }), missing: false };
}

// ------------------------------------------------------------------ rendering

const VAR = /\{\{\s*([a-z][a-z0-9_]*\.[a-z0-9_]+)\s*((?:\|[^}]*)?)\}\}/g;
const COND = /\{\{#if\s+([a-z][a-z0-9_]*\.[a-z0-9_]+)\s*(?:(==|!=)\s*"([^"]*)")?\s*\}\}/;

function truthOf(vars: Vars, key: string, op?: string, want?: string): boolean {
  const v = vars[key];
  const val = v?.value == null ? '' : String(v.value);
  if (!op) return val !== '';
  const eq = val.trim().toLowerCase() === (want ?? '').trim().toLowerCase();
  return op === '==' ? eq : !eq;
}

/** Resolve `{{#if}}` blocks innermost-first, so riders can nest. */
function resolveConditionals(body: string, vars: Vars): string {
  let out = body;
  for (let guard = 0; guard < 200; guard++) {
    // The last opening tag before the first closing tag is an innermost block.
    const close = out.indexOf('{{/if}}');
    if (close < 0) break;
    const head = out.slice(0, close);
    let open = -1; let m: RegExpExecArray | null = null;
    const re = new RegExp(COND.source, 'g');
    for (let x = re.exec(head); x; x = re.exec(head)) { open = x.index; m = x; }
    if (!m || open < 0) break;
    const inner = out.slice(open + m[0].length, close);
    const [yes, no = ''] = inner.split('{{else}}');
    const keep = truthOf(vars, m[1], m[2], m[3]) ? yes : no;
    out = out.slice(0, open) + keep + out.slice(close + '{{/if}}'.length);
  }
  return out;
}

/**
 * Fill every `{{var}}`. Overrides (a document's own values, by variable name)
 * win over the record. A variable with no value and no `|default` stays a
 * visible blank and is reported, so the send form asks for it.
 */
export function renderVars(body: string, vars: Vars, overrides: Record<string, string> = {}): { text: string; missing: string[] } {
  const merged: Vars = { ...vars };
  for (const [k, v] of Object.entries(overrides)) if (/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(k) && v !== '') merged[k] = { value: v, type: vars[k]?.type ?? 'text' };
  const missing: string[] = [];
  const text = resolveConditionals(body, merged).replace(VAR, (_m, key: string, pipes: string) => {
    const r = applyFormatters(merged[key], splitPipes(pipes.replace(/^\|/, '')));
    if (r.missing) { if (!missing.includes(key)) missing.push(key); return '______________'; }
    return r.out;
  });
  return { text, missing };
}

/** Every `{{var}}` a template mentions (outside signature blocks), in order. */
export const varsIn = (body: string): string[] => Array.from(new Set(Array.from(body.matchAll(VAR), (m) => m[1])));

/** The catalog as the template editor shows it: key and a short description. */
export const VAR_HELP: Array<[string, string]> = [
  ['property.address', 'Full property address'], ['property.county', 'County'], ['property.apn', 'APN / parcel'], ['property.state_name', 'State, spelled out'],
  ['deal.purchase_price', 'Purchase price (deals.offer_amount)'], ['deal.assignment_fee', 'Assignment fee'], ['deal.assignment_total', 'Price + fee, or sold price'],
  ['deal.buyer_emd', 'Buyer EMD'], ['deal.inhouse_emd', 'In-house EMD'], ['deal.inhouse_emd_due', 'In-house EMD due date'],
  ['deal.contract_date', 'Contract date'], ['deal.close_date', 'Closing date'], ['deal.option_ends', 'Option period ends'],
  ['deal.option_fee', 'Option fee'], ['deal.option_days', 'Option period (days)'], ['deal.emd_days', 'EMD due within (days)'],
  ['deal.special_terms', 'Special provisions'], ['deal.tc_fee', 'TC fee'], ['seller.mailing_address', 'Seller mailing address'], ['seller.first_name', 'Seller first name'],
  ['title.company', 'Title company'], ['title.email', 'Title email'], ['title.phone', 'Title phone'],
  ['seller.name', 'Seller'], ['seller.email', 'Seller email'], ['seller.phone', 'Seller phone'], ['seller2.name', 'Second seller (optional)'],
  ['buyer.name', 'Buyer'], ['buyer.entity', 'Buyer entity / company'], ['buyer.email', 'Buyer email'],
  ['company.entity', 'Your legal entity'], ['company.signer', 'Your signer'], ['company.address', 'Your address'],
  ['rep.acq', 'Acquisitions rep'], ['rep.dispo', 'Dispositions rep'], ['rep.tc', 'Transaction coordinator'],
  ['rep.acq_email', 'Acquisitions rep email'], ['rep.acq_phone', 'Acquisitions rep phone'], ['rep.acq_license', 'Acquisitions rep license'],
  ['company.brokerage_name', 'Brokerage'], ['company.brokerage_address', 'Brokerage address'], ['company.brokerage_license', 'Brokerage license'],
  ['company.supervisor_name', 'Supervising broker'], ['company.supervisor_phone', 'Supervisor phone'], ['company.supervisor_license', 'Supervisor license'],
  ['offer.amount', 'Offer amount'], ['offer.expires', 'Offer expires'], ['doc.date', 'Date sent'], ['doc.ref', 'Contract reference number'],
];
