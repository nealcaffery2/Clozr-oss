// Field mapping for CLOZR's own contracts. No PDF, no network: the contract
// function and the tests both use this. A template token the record can
// answer is filled; one it cannot stays a blank the New contract form asks for.

import { renderVars, type Vars } from './doc-vars.ts';

export type Party = Record<string, unknown> | null | undefined;
export type Token = { name: string; value: string };
export type CompanyBits = {
  name?: string; legal?: string; address?: string; signer?: string; title?: string;
  email?: string; phone?: string; escrow?: string;
};

export const money = (n: unknown) => (n == null || n === '' || Number.isNaN(Number(n)) ? '' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
export const longDate = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' }) : '');
export const str = (v: unknown) => (v == null ? '' : String(v));

/** Every token value the records can answer. Templates may use any subset. */
export function buildTokens(
  p: { deal?: Party; seller?: Party; seller2?: Party; prop?: Party; buyer?: Party; offer?: Party },
  company: CompanyBits,
  signer?: { name?: string | null; email?: string | null; phone?: string | null },
): Token[] {
  const { deal, seller, seller2, prop, buyer, offer } = p;
  const address = str(prop?.line1 || seller?.property_address);
  const city = str(prop?.city); const state = str(prop?.state); const zip = str(prop?.zip);
  const full = address && (city || state || zip) ? `${address}, ${[city, state].filter(Boolean).join(', ')} ${zip}`.trim() : address;
  const sellerName = str(seller?.name); const [sFirst, ...sRest] = sellerName.split(/\s+/);
  const seller2Name = str(seller2?.name);
  const buyerName = str(buyer?.name); const [bFirst, ...bRest] = buyerName.split(/\s+/);
  const price = deal?.offer_amount; const sold = deal?.sold_price;
  const assignmentPrice = sold ?? (price != null ? Number(price) + Number(deal?.assignment_fee ?? 0) : null);
  const pairs: Record<string, string> = {
    'Property.Address': address, 'Property.City': city, 'Property.State': state, 'Property.Zip': zip, 'Property.FullAddress': full, 'Property.County': str(prop?.county),
    'Property.Beds': str(prop?.beds), 'Property.Baths': str(prop?.baths), 'Property.Sqft': str(prop?.sqft), 'Property.YearBuilt': str(prop?.year_built), 'Property.APN': str(prop?.apn),
    'Property.LegalDescription': str(prop?.legal_description),
    'Seller.Name': sellerName, 'Seller.FullName': sellerName, 'Seller.FirstName': sFirst ?? '', 'Seller.LastName': sRest.join(' '), 'Seller.Email': str(seller?.email), 'Seller.Phone': str(seller?.phone),
    'Seller2.Name': seller2Name, 'Seller2.FullName': seller2Name, 'Seller2.Email': str(seller2?.email), 'Seller2.Phone': str(seller2?.phone),
    'Buyer.Name': buyerName, 'Buyer.FullName': buyerName, 'Buyer.FirstName': bFirst ?? '', 'Buyer.LastName': bRest.join(' '), 'Buyer.Company': str(buyer?.company || buyer?.name), 'Buyer.Email': str(buyer?.email), 'Buyer.Phone': str(buyer?.phone),
    'Deal.PurchasePrice': money(price), 'Deal.ContractPrice': money(price), 'Deal.SoldPrice': money(sold), 'Deal.AssignmentPrice': money(assignmentPrice),
    'Deal.AssignmentFee': money(deal?.assignment_fee), 'Deal.EMD': money(deal?.earnest_money), 'Deal.ARV': money(deal?.arv), 'Deal.Repairs': money(deal?.rehab), 'Deal.MAO': money(deal?.mao),
    'Deal.ContractDate': longDate(deal?.contract_date), 'Deal.ClosingDate': longDate(deal?.close_date), 'Deal.OptionEnds': longDate(deal?.option_ends_on),
    'Deal.TitleCompany': str(deal?.title_contact), 'Deal.TitleContact': str(deal?.title_contact), 'Deal.TitlePhone': str(deal?.title_phone), 'Deal.TitleEmail': str(deal?.title_email),
    'Offer.Amount': money(offer?.amount), 'Offer.Expires': longDate(offer?.expires_on), 'Offer.EMD': money((offer?.terms as { emd?: unknown } | undefined)?.emd), 'Offer.CloseDays': str((offer?.terms as { close_days?: unknown } | undefined)?.close_days),
    'Option.Price': money(price), 'Option.Start': longDate(deal?.contract_date), 'Option.End': longDate(deal?.option_ends_on),
    'Trec.SalesPrice': money(price), 'Trec.CashPortion': money(price), 'Trec.TitleCompany': str(deal?.title_contact),
    'Trec.EarnestMoney': money(deal?.earnest_money), 'Trec.ClosingDate': longDate(deal?.close_date),
    'Amend.SalesPrice': money(price), 'Amend.CashPortion': money(price), 'Amend.ClosingDate': longDate(deal?.close_date),
    'Company.Name': str(company.name), 'Company.Legal': str(company.legal), 'Company.Address': str(company.address), 'Company.Escrow': str(company.escrow || company.legal),
    'Company.Signer': str(company.signer || signer?.name), 'Company.Title': str(company.title), 'Company.Email': str(company.email || signer?.email), 'Company.Phone': str(company.phone || signer?.phone),
    'Date.Today': longDate(new Date().toISOString()),
  };
  return Object.entries(pairs).filter(([, v]) => v !== '').map(([name, value]) => ({ name, value }));
}

/** Every [Token] a template mentions, in order of first appearance. */
export const tokensIn = (body: string): string[] => Array.from(new Set(Array.from(body.matchAll(/\[([A-Z][A-Za-z0-9]*\.[A-Za-z0-9]+)\]/g), (m) => m[1])));

/**
 * Fill tokens; unknown ones stay as a visible blank and are reported.
 * With `vars`, the `{{deal.purchase_price|currency}}` variables and
 * `{{#if}}` riders (doc-vars.ts) are resolved first; a token named like a
 * variable (lower-case, dotted) is that document's override for it.
 */
export function fill(body: string, tokens: Token[], vars?: Vars): { text: string; missing: string[] } {
  const map = new Map(tokens.map((t) => [t.name, t.value]));
  const missing: string[] = [];
  let src = body;
  if (vars) {
    const overrides = Object.fromEntries(tokens.filter((t) => /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(t.name)).map((t) => [t.name, t.value]));
    const r = renderVars(body, vars, overrides);
    src = r.text;
    missing.push(...r.missing);
  }
  const text = src.replace(/\[([A-Z][A-Za-z0-9]*\.[A-Za-z0-9]+)\]/g, (_m, name: string) => {
    const v = map.get(name);
    if (v == null || v === '') { if (!missing.includes(name)) missing.push(name); return '______________'; }
    return v;
  });
  return { text, missing };
}

/** Tokens this template uses that the record already answered. */
export function mappedFromRecord(tokens: Token[], used: string[]): Token[] {
  const map = new Map(tokens.map((t) => [t.name, t.value]));
  return used.filter((n) => map.get(n)).map((n) => ({ name: n, value: map.get(n)! }));
}

/** Who fills a template role: the seller, a second seller on the property, the buyer, or the company signer. */
export function partySigner(
  r: { role?: unknown; label?: unknown; party?: unknown; optional?: unknown },
  ctx: { seller?: Party; seller2?: Party; buyer?: Party; company: CompanyBits },
) {
  const role = String(r.role); const label = String(r.label ?? role); const optional = !!r.optional;
  const person = (p: Party) => ({ role, label, optional, name: str(p?.name) || null, email: str(p?.email) || null, phone: str(p?.phone) || null });
  switch (r.party) {
    case 'seller': return person(ctx.seller);
    case 'seller2': return person(ctx.seller2);
    case 'buyer': return person(ctx.buyer);
    case 'company': return { role, label, optional, name: ctx.company.signer || null, email: ctx.company.email || null, phone: ctx.company.phone || null };
    default: return { role, label, optional: true, name: null, email: null, phone: null };
  }
}
