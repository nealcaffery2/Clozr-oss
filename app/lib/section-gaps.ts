// Side-panel reminders for a live pipeline deal whose sheet still has blanks.
//
// Acquisitions and transaction coordination are due on every active deal.
// Disposition is due only once an end buyer is on it (a buyer, a sold price,
// or a stage past Ready To Market). A deal still being acquired is not nagged
// for dispo. Each reminder goes to the rep assigned to that section. A section
// with nobody assigned is the workspace owner's to see, so it is not silent.

import { ACTIVE_DEAL_STAGES } from './stages';

export const SECTION_CATS = ['Acquisitions', 'Dispositions', 'Coordination'] as const;
export type SectionCat = (typeof SECTION_CATS)[number];
/** The bell's filter chip each section's reminder sits under. */
export const GAP_BELL_CAT: Record<SectionCat, string> = { Acquisitions: 'Seller', Dispositions: 'Dispo', Coordination: 'TC' };

export type GapFacts = {
  earnest: number | null;
  condition: string | null;
  occupancy: string | null;
  dispoRep: string | null;
  tcRep: string | null;
  titleVendor: boolean;
  titleContact: string | null;
  titleEmail: string | null;
  titlePhone: string | null;
  marketingStarted: string | null;
  /** The deal's title company vendor id ("v12"), for the contact fallbacks below. */
  titleVendorId?: string | null;
};

const filled = (v: string | null | undefined) => (v && v.trim() && v.trim() !== '—' ? v.trim() : null);

/**
 * Title facts as the deal sheet shows them: the deal's own, else the title
 * company's contact, else what the TC typed on the file. The reminder used
 * to read only the deal's columns, so a sheet that looked complete (it shows
 * the vendor's contact) kept saying the TC section was missing.
 */
export function withTitleFallbacks<T extends { id: string; facts?: GapFacts }>(
  deals: readonly T[],
  vendors: readonly { id: string; contact?: string | null; email?: string | null; phone?: string | null }[],
  files: readonly { dealId: string; titleCo?: string | null; titleContact?: string | null; titleEmail?: string | null; titlePhone?: string | null }[],
): T[] {
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const fileByDeal = new Map(files.filter((f) => f.dealId).map((f) => [f.dealId, f]));
  return deals.map((d) => {
    if (!d.facts) return d;
    const f = d.facts;
    const v = f.titleVendorId ? vendorById.get(f.titleVendorId) : undefined;
    const tx = fileByDeal.get(d.id);
    return {
      ...d,
      facts: {
        ...f,
        titleVendor: f.titleVendor || !!filled(tx?.titleCo),
        titleContact: filled(f.titleContact) ?? filled(v?.contact) ?? filled(tx?.titleContact),
        titleEmail: filled(f.titleEmail) ?? filled(v?.email) ?? filled(tx?.titleEmail),
        titlePhone: filled(f.titlePhone) ?? filled(v?.phone) ?? filled(tx?.titlePhone),
      },
    };
  });
}

export type GapDeal = {
  id: string;
  personId: string;
  archived?: boolean;
  stage?: string;
  addr?: string;
  owner: string | null;
  contract: number | null;
  arv: number | null;
  rehab: number | null;
  close: string | null;
  optionEndsOn?: string | null;
  buyerOptionEndsOn?: string | null;
  underwritingUrl?: string | null;
  buyerId?: string;
  tracker?: { contractDate: string | null; dispoPrice: number | null } | null;
  /** Absent on the sample graph. Those deals are not reminded. */
  facts?: GapFacts;
};

export type SectionGap = {
  id: string;
  cat: SectionCat;
  dealId: string;
  personId: string;
  addr: string;
  missing: string[];
  /** The rep this reminder is for. Null when the section has nobody yet. */
  assignee: string | null;
  text: string;
};

const PIPELINE = new Set<string>(ACTIVE_DEAL_STAGES);

const money = (v: number | null | undefined) => v != null && Number.isFinite(v);
const price = (v: number | null | undefined) => money(v) && (v as number) > 0;
const text = (v: string | null | undefined) => !!v && v.trim().length > 0;

/** An end buyer is on the deal, so disposition has something to fill. */
export function soldToEndBuyer(d: GapDeal): boolean {
  if (d.stage === 'Buyer Under Contract' || d.stage === 'In Escrow') return true;
  if (d.buyerId) return true;
  return price(d.tracker?.dispoPrice);
}

function blanks(pairs: [string, boolean][]): string[] {
  return pairs.filter(([, ok]) => !ok).map(([label]) => label);
}

function sentence(addr: string, section: string, missing: string[]): string {
  const show = missing.slice(0, 4);
  const rest = missing.length - show.length;
  const list = show.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
  return `${addr} is missing ${section}: ${list}.`;
}

/** The deal sheet's Acquisition section, as the reminders and the under-contract prompt read it. */
export type AcqFacts = {
  owner: string | null;
  contract: number | null;
  arv: number | null;
  rehab: number | null;
  earnest: number | null;
  contractDate: string | null;
  optionEndsOn: string | null;
  close: string | null;
  underwritingUrl: string | null;
  condition: string | null;
  occupancy: string | null;
};

/** What the Acquisition section still has blank, in the sheet's order. */
export function acquisitionBlanks(a: AcqFacts): string[] {
  return blanks([
    ['acquisitions rep', !!a.owner],
    ['under contract price', price(a.contract)],
    ['ARV', price(a.arv)],
    ['rehab estimate', money(a.rehab)],
    ['earnest money', money(a.earnest)],
    ['contract date', text(a.contractDate)],
    ['option period', text(a.optionEndsOn)],
    ['close date', text(a.close)],
    ['underwriting spreadsheet', text(a.underwritingUrl)],
    ['condition', text(a.condition)],
    ['occupancy', text(a.occupancy)],
  ]);
}

/** The deal sheet columns the under-contract prompt reads. */
export type SheetFacts = {
  transaction_type: string | null;
  owner_id: string | null;
  offer_amount: number | null;
  arv: number | null;
  rehab: number | null;
  earnest_money: number | null;
  contract_date: string | null;
  option_ends_on: string | null;
  close_date: string | null;
  underwriting_url: string | null;
  condition_notes: string | null;
  occupancy_notes: string | null;
};

/**
 * What a deal just put under contract still needs on its sheet: the deal type
 * at the top, then the Acquisition section. Empty when it is filled in.
 */
export function underContractBlanks(d: SheetFacts): string[] {
  return [
    ...(text(d.transaction_type) ? [] : ['deal type']),
    ...acquisitionBlanks({
      owner: d.owner_id, contract: d.offer_amount, arv: d.arv, rehab: d.rehab, earnest: d.earnest_money,
      contractDate: d.contract_date, optionEndsOn: d.option_ends_on, close: d.close_date,
      underwritingUrl: d.underwriting_url, condition: d.condition_notes, occupancy: d.occupancy_notes,
    }),
  ];
}

/**
 * One reminder per incomplete section, for this person only.
 * `seeUnassigned` is the owner (and admin): they see a section that has no rep yet.
 */
export function sectionGaps(deals: readonly GapDeal[], me: string, seeUnassigned: boolean): SectionGap[] {
  const out: SectionGap[] = [];
  for (const d of deals) {
    if (!d.facts || d.archived || !d.stage || !PIPELINE.has(d.stage)) continue;
    const addr = (d.addr || '').trim() || 'This deal';
    const f = d.facts;
    const acq = acquisitionBlanks({
      owner: d.owner, contract: d.contract, arv: d.arv, rehab: d.rehab, earnest: f.earnest,
      contractDate: d.tracker?.contractDate ?? null, optionEndsOn: d.optionEndsOn ?? null, close: d.close,
      underwritingUrl: d.underwritingUrl ?? null, condition: f.condition, occupancy: f.occupancy,
    });
    const dispo = soldToEndBuyer(d) ? blanks([
      ['dispo rep', !!f.dispoRep],
      ['buyer', !!d.buyerId],
      ['sold price', price(d.tracker?.dispoPrice)],
      ['buyer option', text(d.buyerOptionEndsOn)],
      ['marketing started', text(f.marketingStarted)],
    ]) : [];
    const tc = blanks([
      ['transaction coordinator', !!f.tcRep],
      ['title company', f.titleVendor],
      ['title contact', text(f.titleContact)],
      ['title email', text(f.titleEmail)],
      ['title phone', text(f.titlePhone)],
    ]);
    const rows: [SectionCat, string, string[], string | null][] = [
      ['Acquisitions', 'acquisitions information', acq, d.owner],
      ['Dispositions', 'disposition information', dispo, f.dispoRep],
      ['Coordination', 'transaction coordination', tc, f.tcRep],
    ];
    for (const [cat, section, missing, assignee] of rows) {
      if (!missing.length) continue;
      if (assignee ? assignee !== me : !seeUnassigned) continue;
      out.push({
        id: `gap-${cat}-${d.id}`,
        cat, dealId: d.id, personId: d.personId, addr, missing, assignee,
        text: sentence(addr, section, missing),
      });
    }
  }
  return out;
}
