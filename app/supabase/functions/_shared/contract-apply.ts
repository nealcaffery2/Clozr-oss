// What a fully signed contract writes back onto the deal (and therefore the
// deal sheet). Prices, fees, close date, and option dates come from the
// tokens that were filled when it was sent. Profit itself is a generated
// column: writing the fee is what moves it.
//
// An amendment overwrites the date or the price it names. A termination
// clears both option clocks and marks the deal terminated. Nothing here
// pulls a deal backwards out of Closed.

export type Token = { name: string; value: string };
export type Side = 'seller' | 'buyer';

const BUYER_KINDS = new Set(['assignment', 'novation', 'jv']);
const SELLER_KINDS = new Set(['psa', 'offer', 'disclosure', 'option']);

export function contractSide(kind: string, roles: string[]): Side {
  if (BUYER_KINDS.has(kind)) return 'buyer';
  if (SELLER_KINDS.has(kind)) return 'seller';
  const hasBuyer = roles.some((r) => /buyer/i.test(r));
  const hasSeller = roles.some((r) => /seller/i.test(r));
  if (hasBuyer && !hasSeller) return 'buyer';
  return 'seller';
}

export function parseMoney(v: string | null | undefined): number | null {
  if (v == null) return null;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  if (!cleaned || cleaned === '______________') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** A contract date as YYYY-MM-DD. Long dates ("September 26, 2026") are read in Chicago. */
export function parseContractDate(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s || s === '______________') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  // "October 20, 2026" parses as midnight UTC, which is still the 19th in Chicago.
  // Noon keeps a date-only phrase on the calendar day it names.
  const when = /T\d/.test(s) ? new Date(t) : new Date(t + 12 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const yes = (v: string | undefined) => /^(y|yes|true|waive|waived)/i.test(String(v ?? '').trim());

function tokenMap(tokens: Token[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tokens) {
    if (!t?.name) continue;
    const v = String(t.value ?? '').trim();
    if (v && v !== '______________') m.set(t.name, v);
  }
  return m;
}

function firstMoney(m: Map<string, string>, names: string[]): number | null {
  for (const n of names) {
    const v = parseMoney(m.get(n));
    if (v != null) return v;
  }
  return null;
}

function firstDate(m: Map<string, string>, names: string[]): string | null {
  for (const n of names) {
    const v = parseContractDate(m.get(n));
    if (v) return v;
  }
  return null;
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export type SignedUpdate = {
  side: Side;
  patch: Record<string, string | number | boolean | null>;
  notes: string[];
};

/**
 * Columns to write, and a sentence each for the activity feed.
 * `signedOn` is YYYY-MM-DD, the day it became fully executed.
 */
export function signedDealUpdate(input: { kind: string; roles: string[]; tokens: Token[]; signedOn: string }): SignedUpdate {
  const side = contractSide(input.kind, input.roles);
  const m = tokenMap(input.tokens);
  const patch: Record<string, string | number | boolean | null> = {};
  const notes: string[] = [];
  const kind = input.kind;

  if (kind === 'termination') {
    patch.terminated = true;
    patch.terminated_on = input.signedOn;
    patch.contract_status = 'Terminated';
    patch.option_ends_on = null;
    patch.buyer_option_ends_on = null;
    notes.push('Termination signed — seller and buyer option clocks cleared');
    return { side, patch, notes };
  }

  const price = firstMoney(m, side === 'buyer'
    ? ['Deal.SoldPrice', 'Deal.AssignmentPrice', 'Amend.SalesPrice', 'Trec.SalesPrice']
    : ['Amend.SalesPrice', 'Deal.PurchasePrice', 'Deal.ContractPrice', 'Trec.SalesPrice']);
  if (price != null) {
    if (side === 'buyer') patch.sold_price = price;
    else patch.offer_amount = price;
    notes.push(`${side === 'buyer' ? 'Sold price' : 'Contract price'} ${money(price)}`);
  }

  const fee = firstMoney(m, ['Deal.AssignmentFee', 'Deal.DispoFee']);
  const purchase = firstMoney(m, ['Deal.PurchasePrice', 'Deal.ContractPrice']);
  const assignmentPrice = firstMoney(m, ['Deal.AssignmentPrice', 'Deal.SoldPrice']);
  const derived = fee ?? (side === 'buyer' && purchase != null && assignmentPrice != null && assignmentPrice > purchase
    ? Math.round((assignmentPrice - purchase) * 100) / 100
    : null);
  if (derived != null) {
    patch.assignment_fee = derived;
    patch.dispo_fee = derived;
    notes.push(`Assignment fee ${money(derived)} — profit on the deal sheet recalculates from this fee and COGS`);
  }

  const emd = firstMoney(m, side === 'buyer' ? ['Deal.BuyerEMD', 'Deal.EMD'] : ['Deal.EMD', 'Trec.EarnestMoney', 'Offer.EMD']);
  if (emd != null) {
    patch.earnest_money = emd;
    notes.push(`Earnest money ${money(emd)}`);
  }

  const close = firstDate(m, ['Amend.ClosingDate', 'Deal.ClosingDate', 'Trec.ClosingDate']);
  if (close) {
    patch.close_date = close;
    notes.push(`Close date ${close}`);
  }

  if (kind === 'psa' || kind === 'assignment' || kind === 'novation' || kind === 'offer') {
    patch.contract_date = firstDate(m, ['Deal.ContractDate']) ?? input.signedOn;
  }

  const optionKey = side === 'buyer' ? 'buyer_option_ends_on' : 'option_ends_on';
  const waiver = side === 'seller' && yes(m.get('Amend.OptionWaiver'));
  if (waiver) {
    patch.option_ends_on = null;
    notes.push('Seller option waived');
  } else {
    let optionEnd = firstDate(m, side === 'buyer'
      ? ['Buyer.OptionEnd', 'Amend.BuyerOptionEnd', 'Amend.OptionEnd', 'Option.End', 'Deal.OptionEnds']
      : ['Amend.OptionEnd', 'Option.End', 'Deal.OptionEnds']);
    if (!optionEnd) {
      const days = parseMoney(m.get('Trec.OptionDays'));
      const start = (patch.contract_date as string | undefined) ?? input.signedOn;
      if (days != null && days < 365) optionEnd = addDays(start, days);
    }
    if (optionEnd) {
      patch[optionKey] = optionEnd;
      notes.push(`${side === 'buyer' ? 'Buyer' : 'Seller'} option ends ${optionEnd}`);
    }
  }

  patch.contract_status = kind === 'amendment' ? 'Amended'
    : kind === 'addendum' ? 'Addendum executed'
    : kind === 'assignment' || kind === 'novation' || kind === 'jv' ? 'Buyer executed'
    : kind === 'psa' ? 'Fully executed'
    : 'Executed';

  return { side, patch, notes };
}

/** A purchase agreement, including a workspace copy whose name says so even if kind was left as other. */
export function isPurchaseContract(kind: string, templateKey?: string | null, templateName?: string | null): boolean {
  if (kind === 'psa') return true;
  const blob = `${templateKey ?? ''} ${templateName ?? ''}`.toLowerCase();
  if (/assign|terminat|amend|addend|option|disclos|lease|novation/.test(blob)) return false;
  return /\bpsa\b|purchase agreement|purchase contract|trec|one to four|residential contract/.test(blob);
}

const AT_OR_PAST_SELLER_CONTRACT = new Set([
  'Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed', 'Terminated', 'Realtor Referral',
]);

/** A stage to move to, or null when the deal should stay where it is. */
export function nextDealStage(current: string | null | undefined, kind: string, side: Side): string | null {
  if (kind === 'termination') return current === 'Terminated' ? null : 'Terminated';
  if (current === 'Closed' || current === 'Terminated') return null;
  // Fully executed purchase: we are under contract to buy the property.
  if (side === 'seller' && kind === 'psa') {
    const cur = String(current ?? '').trim();
    if (AT_OR_PAST_SELLER_CONTRACT.has(cur)) return null;
    return 'Under Contract Seller';
  }
  if (side === 'buyer' && (kind === 'assignment' || kind === 'novation' || kind === 'jv')) {
    if (current === 'In Escrow' || current === 'Buyer Under Contract') return null;
    return 'Buyer Under Contract';
  }
  return null;
}
