// A contract request from the dialer: acquisitions presses Request contract on
// a call, the form fills itself from the record on the line, and the TC gets
// a draft to review and send. Nothing here goes out for signature.
//
// Pure, so the auto-fill, the TC pick and the payload are tested without a
// browser (npx tsx tools/contract-request.test.ts). The IO is in
// lib/contract-request-api.ts; the screens are components/contract-request/*.

import { parseDollars } from './money';
import type { ContractKind } from './contracts';

/** Who is on the line, as the request reads them. */
export type RequestSide = 'seller' | 'buyer' | 'other';

/** The record on the call (or the number loaded in the dialer), with the money the request starts from. */
export type RequestRecord = {
  side: RequestSide;
  /** Database ids; null on the sample data and for a number with no record. */
  sellerId: number | null;
  buyerId: number | null;
  dealId: number | null;
  name: string;
  phone: string;
  email: string;
  /** Street, city, state ZIP as one line. */
  address: string;
  /** The offer on the deal (seller) or the assignment price (buyer), in dollars. */
  offer: number | null;
  mao: number | null;
  asking: number | null;
  /** "30 days", "Sept 30", "2026-11-14": whatever the record says. */
  desiredClose: string;
  /** A buyer with more than one live deal: each of them, best first, for the popup's deal picker. */
  deals?: RequestDeal[];
};

/** One of a buyer's deals, as the deal picker lists it and the request reads it. */
export type RequestDeal = { key: string; dealId: number | null; address: string; offer: number | null; desiredClose: string };

/** The record with `deal` as the one the request is about. */
export function withDeal(r: RequestRecord, deal: RequestDeal): RequestRecord {
  return { ...r, dealId: deal.dealId, address: deal.address, offer: deal.offer, desiredClose: deal.desiredClose };
}

/** "151 Juniper Trl, San Antonio, TX 78254": the parts there are, blanks and "—" left out. */
export function addressLine(street?: string | null, city?: string | null, state?: string | null, zip?: string | null): string {
  const ok = (x?: string | null) => !!x && x.trim() !== '' && x.trim() !== '—';
  return [street, city, [state, zip].filter(ok).join(' ')].filter(ok).map((x) => (x as string).trim()).join(', ');
}

/**
 * Which of a buyer's deals a request is about: the deal the call is about when
 * it is theirs, else their best live one by `rank` (an open contract, then the
 * newest). `live` is every unarchived deal of theirs, best first; more than one
 * means the popup asks which.
 */
export function pickBuyerDeal<D extends { id: string; buyerId?: string | null; archived?: boolean }>(
  deals: readonly D[], buyerId: string, contextDealId: string | null | undefined, rank: (d: D) => number,
): { deal: D | undefined; live: D[] } {
  const live = deals.filter((d) => d.buyerId === buyerId && !d.archived).sort((a, b) => rank(b) - rank(a));
  const fromCall = contextDealId ? live.find((d) => d.id === contextDealId) : undefined;
  return { deal: fromCall ?? live[0], live };
}

export type TranscriptLine = { who: string; text: string };

/** What the dialer hands the request (V.contractRequestFor). */
export type RequestContext = {
  record: RequestRecord | null;
  /** The number on the call (and a name, when the dialer knows one) when it has no seller or buyer record. */
  caller?: { name: string; phone: string } | null;
  /** Talkr's call id while a real call is up, for Listen and Barge. */
  callId: string | null;
  /** The person pressing the button. */
  requesterId: string | null;
  requesterName: string;
  transcript: TranscriptLine[];
  /** The call summary Talkr already wrote, when there is one. */
  summary: string | null;
  demo: boolean;
};

/** The popup's fields. Money and dates stay as typed until the payload is built. */
export type RequestForm = {
  kind: ContractKind;
  /** A doc_templates id, or null for "the TC picks the template". */
  templateId: number | null;
  templateName: string;
  side: RequestSide;
  partyName: string;
  partyPhone: string;
  partyEmail: string;
  address: string;
  price: string;
  closingDate: string;
  emd: string;
  /** Other fill-ins the template asks for, by token name. */
  terms: Record<string, string>;
  notes: string;
  summary: string;
};

/** A teammate as the TC pick reads them: CLOZR's team (D.team) or the roster. */
export type TeamLike = { id: string; name: string; memberRole?: string | null; role?: string | null; dept?: string | null };

const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '' : Math.round(n).toLocaleString('en-US'));

/** The default contract for who is on the line: a seller signs a purchase agreement, a buyer an assignment. */
export function kindFor(side: RequestSide): ContractKind {
  return side === 'buyer' ? 'assignment' : 'psa';
}

/**
 * A date the record states, as yyyy-mm-dd for a date field; '' when it is not
 * one ("30 days" stays in the notes, it is not a date). Relative to `today`.
 */
export function closingDateFrom(text: string, today: Date): string {
  const t = (text || '').trim();
  if (!t || t === '—') return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return t;
  const days = /^(\d{1,3})\s*days?$/i.exec(t);
  if (days) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(days[1]));
    return ymd(d);
  }
  const md = /^(?:before\s+|by\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/i.exec(t);
  if (md) {
    const month = MONTHS.findIndex((m) => md[1].toLowerCase().startsWith(m));
    if (month < 0) return '';
    let y = md[3] ? Number(md[3]) : today.getFullYear();
    const d = new Date(y, month, Number(md[2]));
    if (!md[3] && d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) { y += 1; d.setFullYear(y); }
    return ymd(d);
  }
  return '';
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The call so far, for the TC: the summary Talkr wrote when there is one,
 * else the last `n` lines of the transcript as said. No model writes here; a
 * summary is quoted as it came, so the TC reads what the call produced.
 */
export function requestSummary(summary: string | null | undefined, transcript: readonly TranscriptLine[], n = 8): string {
  const s = (summary ?? '').trim();
  if (s && s !== '—' && !/^summaris/i.test(s)) return s;
  const lines = transcript.filter((l) => l.text.trim()).slice(-n);
  return lines.map((l) => `${l.who}: ${l.text.trim().replace(/…$/, '')}`).join('\n');
}

/** The form, filled from the record on the line and the call. */
export function autofillRequest(ctx: RequestContext, today: Date = new Date()): RequestForm {
  const r = ctx.record;
  const side: RequestSide = r?.side ?? 'seller';
  const price = r ? (r.offer ?? r.mao ?? null) : null;
  // No record: the number on the call, and its name when it is one (not the number formatted).
  const callerName = !r && ctx.caller?.name && /[a-z]/i.test(ctx.caller.name) && ctx.caller.name !== '—' ? ctx.caller.name.trim() : '';
  return {
    kind: kindFor(side),
    templateId: null,
    templateName: '',
    side,
    partyName: r ? (r.name && r.name !== '—' ? r.name : '') : callerName,
    partyPhone: r ? (r.phone ?? '') : (ctx.caller?.phone ?? '').trim(),
    partyEmail: r?.email && r.email !== '—' ? r.email : '',
    address: r?.address ?? '',
    price: money(price),
    closingDate: r ? closingDateFrom(r.desiredClose, today) : '',
    emd: '',
    terms: {},
    notes: '',
    summary: requestSummary(ctx.summary, ctx.transcript),
  };
}

/** Where the price came from, for the hint under the field. */
export function priceSource(r: RequestRecord | null): string {
  if (!r) return '';
  if (r.offer != null) return r.side === 'buyer' ? 'From the assignment price' : 'From the offer on the deal';
  if (r.mao != null) return 'From the MAO';
  return '';
}

/**
 * Who hears about it: every member with the TC role; with none, the teammate
 * named Casey (lib/team.ts teamTc reads the same way); with neither, the
 * owner. Never the person asking. The database function request_contract
 * (migration 272) makes the same pick; this one names them in the popup.
 */
export function tcRecipients<T extends TeamLike>(team: readonly T[], requesterId: string | null): T[] {
  const others = team.filter((m) => m.id !== requesterId);
  const isTc = (m: T) => m.memberRole === 'tc' || (m.memberRole == null && (m.dept === 'TC' || /^tc$/i.test(m.role ?? '') || /transaction coord/i.test(m.role ?? '')));
  const tcs = others.filter(isTc);
  if (tcs.length) return tcs;
  const casey = others.filter((m) => /\bcasey\b/i.test(m.name));
  if (casey.length) return casey.slice(0, 1);
  return others.filter((m) => m.memberRole === 'owner' || /^owner$/i.test(m.role ?? '')).slice(0, 1);
}

/** "Casey", "Casey or Avery", "the TC". */
export function tcFirstNames(tcs: readonly { name: string }[]): string {
  const first = tcs.map((t) => t.name.trim().split(/\s+/)[0]).filter(Boolean);
  if (!first.length) return 'the TC';
  if (first.length === 1) return first[0];
  return `${first.slice(0, -1).join(', ')} or ${first[first.length - 1]}`;
}

/** "151 Juniper Trl" from "151 Juniper Trl, San Antonio, TX 78254". */
export const streetOf = (address: string) => (address || '').split(',')[0].trim();

/** The alert's headline: "Contract request from Morgan · 151 Juniper Trl". */
export function requestTitle(requesterName: string, address: string, partyName = ''): string {
  const first = (requesterName || '').trim().split(/\s+/)[0] || 'a teammate';
  const where = streetOf(address) || partyName.trim();
  return `Contract request from ${first}${where ? ` · ${where}` : ''}`;
}

/** Problems that stop Send to TC, in the order the fields read. */
export function requestProblems(f: RequestForm): string[] {
  const out: string[] = [];
  if (f.partyName.trim().length < 2) out.push(f.side === 'buyer' ? 'Add the buyer’s name.' : 'Add the seller’s name.');
  if (!f.address.trim() && f.side !== 'buyer') out.push('Add the property address.');
  const p = parseDollars(f.price);
  if (p.error) out.push(`Price: ${p.error}.`);
  const e = parseDollars(f.emd);
  if (e.error) out.push(`Earnest money: ${e.error}.`);
  if (f.closingDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.closingDate)) out.push('Closing date: pick a date.');
  return out;
}

/** The price token a contract of this kind reads. */
const PRICE_TOKENS: Partial<Record<ContractKind, string[]>> = {
  psa: ['Deal.PurchasePrice', 'Trec.SalesPrice', 'Offer.Amount'],
  offer: ['Offer.Amount', 'Deal.PurchasePrice'],
  option: ['Option.Price', 'Deal.PurchasePrice'],
  assignment: ['Deal.AssignmentPrice'],
};

/**
 * The form as template fill-ins (lib/contracts TOKEN_HELP names): what the
 * rep typed wins over the record, the way the New contract form's fill-ins do.
 * `recordAddress` is the record's own: the address goes in only when it was changed.
 */
export function requestTokens(f: RequestForm, recordAddress = ''): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const add = (names: string[] | undefined, value: string) => { if (value) for (const name of names ?? []) out.push({ name, value }); };
  const price = parseDollars(f.price).value;
  const emd = parseDollars(f.emd).value;
  add(PRICE_TOKENS[f.kind] ?? ['Deal.PurchasePrice'], price != null ? `$${money(price)}` : '');
  add(f.kind === 'assignment' ? ['Deal.BuyerEMD'] : ['Deal.EMD', 'Trec.EarnestMoney', 'Offer.EMD'], emd != null ? `$${money(emd)}` : '');
  add(['Deal.ClosingDate', 'Trec.ClosingDate'], f.closingDate ? longDate(f.closingDate) : '');
  if (f.address.trim() && f.address.trim() !== recordAddress.trim()) add(['Property.FullAddress'], f.address.trim());
  for (const [name, value] of Object.entries(f.terms)) if (value.trim()) out.push({ name, value: value.trim() });
  // A later entry for the same name wins (a term typed over the price).
  return [...new Map(out.map((t) => [t.name, t])).values()];
}

/** 2026-11-14 → November 14, 2026. */
export function longDate(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return isoDay;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** What request_contract stores and the TC's alert reads. */
export type RequestPayload = {
  contract_id: number | null;
  kind: ContractKind;
  template_id: number | null;
  template_name: string | null;
  seller_id: number | null;
  buyer_id: number | null;
  deal_id: number | null;
  party: { side: RequestSide; name: string; phone: string; email: string };
  address: string;
  price: number | null;
  closing_date: string | null;
  emd: number | null;
  terms: Record<string, string>;
  notes: string;
  summary: string;
  call_id: string | null;
  requester_name: string;
  title: string;
};

export function buildRequestPayload(f: RequestForm, ctx: RequestContext, ids: { contractId: number | null; sellerId: number | null; buyerId: number | null; dealId: number | null }): RequestPayload {
  const terms = Object.fromEntries(Object.entries(f.terms).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  return {
    contract_id: ids.contractId,
    kind: f.kind,
    template_id: f.templateId,
    template_name: f.templateName.trim() || null,
    seller_id: ids.sellerId,
    buyer_id: ids.buyerId,
    deal_id: ids.dealId,
    party: { side: f.side, name: f.partyName.trim(), phone: f.partyPhone.trim(), email: f.partyEmail.trim().toLowerCase() },
    address: f.address.trim(),
    price: parseDollars(f.price).value,
    closing_date: /^\d{4}-\d{2}-\d{2}$/.test(f.closingDate) ? f.closingDate : null,
    emd: parseDollars(f.emd).value,
    terms,
    notes: f.notes.trim().slice(0, 4000),
    summary: f.summary.trim().slice(0, 6000),
    call_id: ctx.callId,
    requester_name: ctx.requesterName,
    title: requestTitle(ctx.requesterName, f.address, f.partyName),
  };
}

/** One line for the bell and the alert: "Kara Mitchell · $181,000 · close Nov 13". */
export function requestLine(p: Pick<RequestPayload, 'party' | 'price' | 'closing_date'>): string {
  const bits = [p.party.name, p.price != null ? `$${money(p.price)}` : '', p.closing_date ? `close ${shortDate(p.closing_date)}` : ''];
  return bits.filter(Boolean).join(' · ');
}
const shortDate = (isoDay: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : isoDay;
};

/** Whether the TC can still join the call: it is on the live list. `null` list: this person cannot monitor. */
export function callStillLive(callId: string | null | undefined, live: readonly { call_id: string }[] | null): 'live' | 'ended' | 'no-access' | 'none' {
  if (!callId) return 'none';
  if (live === null) return 'no-access';
  return live.some((c) => c.call_id === callId) ? 'live' : 'ended';
}
