// InvestorBase buyer search → CRM buyer drafts.
//
// POST https://api.investorbase.com/v1/buyer-search returns one row per
// purchase. The CRM wants one buyer per person, so rows that share a phone,
// an email, or an entity name fold together. The purchase history stays in
// the notes and the buy box.

export type IbPurchase = {
  buyer_first_name?: string | null;
  buyer_last_name?: string | null;
  buyer_entity_name?: string | null;
  buyer_phone_number?: number | string | null;
  buyer_email?: string | null;
  address?: string | null;
  miles_from_subject?: number | null;
  buyer_type?: string | null;
  flip_purchase_transaction_date?: string | null;
  flip_purchase_transaction_price?: number | null;
  flip_sale_transaction_date?: string | null;
  flip_sale_transaction_price?: number | null;
  rental_purchase_transaction_date?: string | null;
  rental_purchase_transaction_price?: number | null;
};

export type CrmBuyerDraft = {
  key: string;
  name: string;
  company: string | null;
  phone: string | null;
  phoneKey: string | null;
  email: string | null;
  buyer_type: 'flipper' | 'landlord';
  entity_type: 'llc' | 'individual';
  tags: string[];
  source: 'investorbase';
  status: 'Prospect';
  notes: string;
  buy_box: string | null;
  criteria: {
    strategies: string[];
    price: { min: number | null; max: number | null };
    notes: string;
  };
};

const ENTITY = /\b(llc|l\.l\.c|inc|corp|corporation|trust|lp|llp|ltd|holdings|properties|investments|enterprises)\b/i;

export function phoneParts(raw: number | string | null | undefined): { display: string; key: string } | null {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length >= 10 ? digits.slice(-10) : '';
  if (ten.length !== 10 || ten === '0000000000') return null;
  return { display: `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`, key: ten };
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function personName(row: IbPurchase): string {
  return clean([row.buyer_first_name, row.buyer_last_name].filter(Boolean).join(' '));
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function purchaseLine(row: IbPurchase): string {
  const flip = row.buyer_type === 'flipper';
  const bought = flip ? row.flip_purchase_transaction_date : row.rental_purchase_transaction_date;
  const paid = flip ? row.flip_purchase_transaction_price : row.rental_purchase_transaction_price;
  const sold = flip ? row.flip_sale_transaction_date : null;
  const sale = flip ? row.flip_sale_transaction_price : null;
  const where = clean(row.address) || 'a nearby property';
  const dist = row.miles_from_subject != null && Number.isFinite(row.miles_from_subject)
    ? `${row.miles_from_subject} mi away` : '';
  const bits = [
    flip ? 'Flip' : 'Rental',
    where,
    bought ? `bought ${bought.slice(0, 10)}` : '',
    money(paid) ? `for ${money(paid)}` : '',
    sold ? `sold ${sold.slice(0, 10)}${money(sale) ? ` for ${money(sale)}` : ''}` : '',
    dist,
  ].filter(Boolean);
  return bits.join(', ');
}

/** Fold search rows into one CRM buyer per person. Rows with no name and no phone are dropped. */
export function buyersFromSearch(rows: IbPurchase[], subject: string): CrmBuyerDraft[] {
  const groups = new Map<string, IbPurchase[]>();
  for (const row of rows) {
    const phone = phoneParts(row.buyer_phone_number);
    const email = clean(row.buyer_email).toLowerCase();
    const entity = clean(row.buyer_entity_name).toLowerCase();
    const person = personName(row).toLowerCase();
    const key = phone ? `p:${phone.key}` : email ? `e:${email}` : entity ? `c:${entity}` : person ? `n:${person}` : '';
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const out: CrmBuyerDraft[] = [];
  for (const [key, list] of groups) {
    const named = list.map(personName).find(Boolean) ?? '';
    const entity = list.map((r) => clean(r.buyer_entity_name)).find(Boolean) ?? '';
    const phone = list.map((r) => phoneParts(r.buyer_phone_number)).find(Boolean) ?? null;
    const email = list.map((r) => clean(r.buyer_email).toLowerCase()).find(Boolean) || null;
    const corporate = ENTITY.test(entity);
    const name = named || entity;
    if (!name) continue;
    const company = entity && entity.toLowerCase() !== name.toLowerCase() ? entity : null;
    const flipper = list.some((r) => r.buyer_type === 'flipper');
    const prices = list.flatMap((r) => [
      r.buyer_type === 'flipper' ? r.flip_purchase_transaction_price : r.rental_purchase_transaction_price,
    ]).filter((n): n is number => !!n && n > 0);
    const min = prices.length ? Math.round(Math.min(...prices) * 0.7) : null;
    const max = prices.length ? Math.round(Math.max(...prices) * 1.3) : null;
    const near = clean(subject) || 'this property';
    const lines = list.map(purchaseLine).filter(Boolean).slice(0, 8);
    const extra = list.length > lines.length ? ` ${list.length - lines.length} more purchase${list.length - lines.length === 1 ? '' : 's'} on file.` : '';
    const notes = `Found by InvestorBase near ${near}. ${list.length} purchase${list.length === 1 ? '' : 's'}.\n` + lines.join('\n') + (extra ? `\n${extra.trim()}` : '');
    const band = min && max ? `${money(min)}–${money(max)}` : '';
    out.push({
      key,
      name,
      company,
      phone: phone?.display ?? null,
      phoneKey: phone?.key ?? null,
      email,
      buyer_type: flipper ? 'flipper' : 'landlord',
      entity_type: corporate ? 'llc' : 'individual',
      tags: ['investorbase', 'buyer-prospect'],
      source: 'investorbase',
      status: 'Prospect',
      notes,
      buy_box: band || null,
      criteria: {
        strategies: flipper ? ['fix_and_flip'] : ['buy_and_hold'],
        price: { min, max },
        notes,
      },
    });
  }
  return out;
}

const PROP = new Set(['SFR', 'MFR', 'LAND', 'CONDO', 'MOBILE', 'OTHER']);

export type SearchInput = {
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  radius_miles?: number | null;
  lookback_years?: number | null;
  buyer_types?: string[] | null;
  property_types?: string[] | null;
  min_bedrooms?: number | null;
  max_bedrooms?: number | null;
  min_bathrooms?: number | null;
  max_bathrooms?: number | null;
  min_purchase_price?: number | null;
  max_purchase_price?: number | null;
  hide_non_arms_length?: boolean | null;
  hide_hedge_fund?: boolean | null;
  hide_no_phone?: boolean | null;
};

/** The body InvestorBase accepts. Out-of-range filters are clamped to the API's limits. */
export function searchBody(input: SearchInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const address = clean(input.address ?? '');
  if (address) body.address = address.slice(0, 300);
  const lat = Number(input.latitude);
  const lng = Number(input.longitude);
  if (!body.address && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    body.latitude = lat;
    body.longitude = lng;
  }
  const radius = Number(input.radius_miles);
  if (Number.isFinite(radius) && radius > 0) body.radius_miles = Math.min(10, radius);
  const years = Number(input.lookback_years);
  if (Number.isFinite(years) && years > 0) body.lookback_years = Math.min(5, years);
  const types = (input.buyer_types ?? []).filter((t) => t === 'flipper' || t === 'landlord');
  if (types.length === 1) body.buyer_types = types;
  const props = (input.property_types ?? []).map((t) => t.toUpperCase()).filter((t) => PROP.has(t));
  if (props.length) body.property_types = props;
  const int = (n: number | null | undefined, max: number) => {
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : null;
  };
  const beds = int(input.min_bedrooms, 20);
  const bedsMax = int(input.max_bedrooms, 20);
  const baths = input.min_bathrooms;
  const bathsMax = input.max_bathrooms;
  if (beds != null) body.min_bedrooms = beds;
  if (bedsMax != null) body.max_bedrooms = bedsMax;
  if (baths != null && Number.isFinite(Number(baths))) body.min_bathrooms = Number(baths);
  if (bathsMax != null && Number.isFinite(Number(bathsMax))) body.max_bathrooms = Number(bathsMax);
  const price = (n: number | null | undefined) => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  };
  const minP = price(input.min_purchase_price);
  const maxP = price(input.max_purchase_price);
  if (minP != null) body.min_purchase_price = minP;
  if (maxP != null) body.max_purchase_price = maxP;
  if (input.hide_non_arms_length != null) body.hide_non_arms_length = input.hide_non_arms_length;
  if (input.hide_hedge_fund != null) body.hide_hedge_fund = input.hide_hedge_fund;
  if (input.hide_no_phone != null) body.hide_no_phone = input.hide_no_phone;
  return body;
}
