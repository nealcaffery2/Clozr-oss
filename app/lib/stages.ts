// The two stage lists, mirrored from migrations 27, 44 and 231 (seller_stages, deal_stages).
//
// sellers.lead_stage is the acquisitions list Acme Homes runs: 54 stages in
// groups, Not Qualified (231) included. deals.stage is the seven stages a deal moves through, plus
// 'Prospect' — the placeholder a deal sheet opened on a lead sits at, never a
// pipeline column. The database keeps the two in step (a seller moved to
// Under Contract - Seller gets a deal; a deal moved to Closed closes the
// seller), so the client only ever writes the side the user touched.

export type SellerStageGroup = 'lead' | 'working' | 'offer' | 'contract' | 'closed' | 'dead' | 'refund' | 'referral' | 'other';
export type SellerStage = { label: string; grp: SellerStageGroup; dealStage?: DealStage };

export const DEAL_STAGES = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed', 'Terminated', 'Realtor Referral'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
/** The stages that count as active dispo inventory. */
export const ACTIVE_DEAL_STAGES: DealStage[] = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow'];
export const PIPELINE_STAGES: DealStage[] = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow', 'Closed'];

/**
 * Where a buyer is with us, kept on buyers.status. Older rows say 'active' in
 * lower case; buyerStageOf reads those as Active.
 */
export const BUYER_STAGES = ['Prospect', 'Contacted', 'Active', 'Qualified', 'Closed With Us', 'Inactive'] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];
export const buyerStageOf = (status: string | null | undefined): string => {
  const s = (status ?? '').trim();
  return BUYER_STAGES.find((x) => x.toLowerCase() === s.toLowerCase()) ?? (s || 'Active');
};

export const SELLER_STAGES: SellerStage[] = [
  { label: 'None', grp: 'lead' },
  { label: 'Self Generated', grp: 'lead' },
  { label: 'New Submission', grp: 'lead' },
  { label: 'Lead', grp: 'lead' },
  { label: 'Lead - No Contact', grp: 'lead' },
  { label: 'Lead - No Contact (Long Term)', grp: 'lead' },
  { label: 'Contacted - Follow Up Needed', grp: 'working' },
  { label: 'Appointment Set', grp: 'working' },
  { label: 'Appointment Missed', grp: 'working' },
  { label: 'Nurture - Short Term (Under 3 Months)', grp: 'working' },
  { label: 'Nurture - Long Term (3+ Months)', grp: 'working' },
  { label: 'Underwriting', grp: 'offer' },
  { label: 'Underwriting - Need Info', grp: 'offer' },
  { label: 'Underwriting Complete', grp: 'offer' },
  { label: 'Make Offer', grp: 'offer' },
  { label: 'Offer Made', grp: 'offer' },
  { label: 'Pending Response', grp: 'offer' },
  { label: 'Offer Made - Follow Up', grp: 'offer' },
  { label: 'Offer Made - Retail', grp: 'offer' },
  { label: 'Pending Inspections', grp: 'offer' },
  { label: 'Offer Accepted', grp: 'offer' },
  { label: 'Contract Sent to Seller', grp: 'contract' },
  { label: 'Under Contract - Seller', grp: 'contract', dealStage: 'Under Contract Seller' },
  { label: 'Under Contract - Buyer', grp: 'contract', dealStage: 'Buyer Under Contract' },
  { label: 'Memo Filed / Legal', grp: 'contract' },
  { label: 'Closed', grp: 'closed', dealStage: 'Closed' },
  { label: 'Referred to Realtor', grp: 'referral', dealStage: 'Realtor Referral' },
  { label: 'Realtor', grp: 'referral', dealStage: 'Realtor Referral' },
  { label: 'Terminated', grp: 'dead', dealStage: 'Terminated' },
  { label: 'Terminated - Price Drop', grp: 'dead', dealStage: 'Terminated' },
  { label: 'Underwrite Declined', grp: 'dead' },
  { label: 'Offer Declined', grp: 'dead' },
  { label: 'Under Contract with Other Investor', grp: 'dead' },
  { label: 'Duplicate Lead', grp: 'dead' },
  { label: 'Asking Retail / Not Motivated', grp: 'dead' },
  // Migration 231: the "No offer" outcome for a house we passed on.
  { label: 'Not Qualified', grp: 'dead' },
  { label: 'Not Selling', grp: 'dead' },
  { label: 'Listed on MLS - Dead', grp: 'dead' },
  { label: 'Negative Equity', grp: 'dead' },
  { label: 'Ghosted', grp: 'dead' },
  { label: 'Sold Elsewhere', grp: 'dead' },
  { label: 'Unresponsive', grp: 'dead' },
  { label: 'Bad Location', grp: 'dead' },
  { label: 'Dead', grp: 'dead' },
  { label: 'Dead - Wrong Info', grp: 'dead' },
  { label: 'Refund - Wrong Info', grp: 'refund' },
  { label: 'Refund - Listed', grp: 'refund' },
  { label: 'Refund - Not Selling', grp: 'refund' },
  { label: 'Refund - Wrong Info / Other', grp: 'refund' },
  { label: 'Wholesaler', grp: 'other' },
  { label: 'Buyer', grp: 'other' },
  { label: 'Buyer Prospect', grp: 'other' },
  { label: 'Land', grp: 'other' },
  { label: 'Auction.com', grp: 'other' },
];

/** People › Smart lists for partner submissions (Podio Partnerships). */
export const UNDERWRITING_STAGES = ['New Submission', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete'];
export const DECLINED_STAGES = ['Underwrite Declined', 'Offer Declined'];

/**
 * Podio Submissions › Views order (Partnerships app).
 * "New Submissions" is the early bucket; "Total Submissions" is every
 * submission stage in the order Podio shows them. "US" is a Podio stage with
 * no Clozr label — imports park those at New Submission and keep `Podio stage: US` in notes.
 */
export const PODIO_NEW_SUBMISSIONS = ['New Submission', 'Underwriting'] as const;
export const PODIO_TOTAL_SUBMISSIONS = [
  'New Submission',
  'Underwriting',
  'Underwrite Declined',
  'Underwriting - Need Info',
  'Underwriting Complete',
  'Offer Made',
  'Pending Response',
  'Offer Declined',
  'Offer Accepted',
  // Not a Podio view: CLOZR's own tab for accepted houses now under contract.
  'Under Contract - Seller',
  'Auction.com',
  'US',
] as const;
/** Stage labels that are real seller_stages rows (everything in Total except US). */
export const PODIO_SUBMISSION_STAGES = PODIO_TOTAL_SUBMISSIONS.filter((s) => s !== 'US');

export const SELLER_STAGE_LABELS = SELLER_STAGES.map((s) => s.label);

export const SELLER_GROUPS: { grp: SellerStageGroup; label: string }[] = [
  { grp: 'lead', label: 'New leads' }, { grp: 'working', label: 'Working' }, { grp: 'offer', label: 'Offers' },
  { grp: 'contract', label: 'Under contract' }, { grp: 'closed', label: 'Closed' }, { grp: 'referral', label: 'Referrals' },
  { grp: 'dead', label: 'Dead' }, { grp: 'refund', label: 'Refunds' }, { grp: 'other', label: 'Other' },
];

const GROUP_COLOR: Record<SellerStageGroup, string> = {
  lead: '#0284c7', working: '#2563eb', offer: '#d97706', contract: '#1f7a4d', closed: '#18181b',
  dead: '#dc2626', refund: '#b91c1c', referral: '#7c3aed', other: '#71717a',
};
const DEAL_COLOR: Record<string, string> = {
  Prospect: '#a1a1aa', 'Under Contract Seller': '#1f7a4d', 'Ready To Market': '#ff7a45', 'Buyer Under Contract': '#c026d3',
  'In Escrow': '#2563eb', Closed: '#18181b', Terminated: '#dc2626', 'Realtor Referral': '#7c3aed',
};

export const sellerStageGroup = (label: string): SellerStageGroup => SELLER_STAGES.find((s) => s.label === label)?.grp ?? 'other';
/** Dead and refund stages: moving a lead there asks why (the record, bulk). */
export const isDeadStage = (label: string) => ['dead', 'refund'].includes(sellerStageGroup(label));
/** Stages that open or move a deal in the database: a bulk move there asks twice. */
export const opensDeal = (label: string) => !!SELLER_STAGES.find((s) => s.label === label)?.dealStage || sellerStageGroup(label) === 'contract';
export const sellerStageColor = (label: string) => GROUP_COLOR[sellerStageGroup(label)];
export const dealStageColor = (label: string) => DEAL_COLOR[label] ?? '#71717a';
export const isDealStage = (s: string): s is DealStage => (DEAL_STAGES as readonly string[]).includes(s);
export const isActiveInventory = (s: string) => (ACTIVE_DEAL_STAGES as string[]).includes(s);
/**
 * A stage or contract status that takes a deal off Dispo even while its deal
 * stage still reads active: Closed, Terminated (and Terminated - Price Drop),
 * or Memo Filed / Legal. That seller stage has no deal stage of its own, so
 * without this a deal in legal stayed on the marketing lists at Under
 * Contract Seller.
 */
export const offDispo = (mark: string | null | undefined) => /^(closed|terminated\b.*|memo filed( \/ legal)?|legal)$/i.test((mark ?? '').trim());
/** True when a deal belongs on the Dispo lists and counts: an active deal stage and no seller stage or contract status that ends it. */
export const onDispoBoard = (dealStage: string, ...marks: (string | null | undefined)[]) =>
  isActiveInventory(dealStage) && !marks.some(offDispo);
/** True once the seller is under contract or beyond (the stages that imply a deal). */
export const sellerUnderContract = (label: string) => ['contract', 'closed'].includes(sellerStageGroup(label)) && label !== 'Contract Sent to Seller';
/** The seller stage a deal stage implies, for optimistic UI before the database answers. */
export const sellerStageForDeal = (d: string): string | null => ({
  'Under Contract Seller': 'Under Contract - Seller', 'Ready To Market': 'Under Contract - Seller',
  'Buyer Under Contract': 'Under Contract - Buyer', 'In Escrow': 'Under Contract - Buyer',
  Closed: 'Closed', Terminated: 'Terminated', 'Realtor Referral': 'Referred to Realtor',
} as Record<string, string>)[d] ?? null;

/**
 * One Podio Submissions item, from the sync's ledger (podio_items, app_key
 * 'submissions'): Podio's own current Category label, whatever CLOZR did with
 * the item (merged a resubmission onto one deal, skipped a test or an
 * address-less row, moved the deal on). Counting these is counting Podio.
 */
export type PodioSubmission = {
  itemId: number; dealId: string | null; stage: string; createdOn: string | null; note: string | null;
  /** Its deal's stage when a person moved it in CLOZR and nothing has moved it since (clozrHeldStage); Podio never hears of that move. */
  clozrStage?: string | null;
};

/**
 * A deal's stage as a person left it in CLOZR, or null. CLOZR does not write
 * stage moves back to Podio, so an item moved here keeps its old Podio
 * Category; the sync keeps CLOZR's stage until Podio's own stage changes (and
 * that move is the System's, which ends the hold).
 * `personMove` is the to_stage of the deal's latest lead_stage move with a person behind it.
 */
export function clozrHeldStage(leadStage: string | null | undefined, personMove: string | null | undefined): string | null {
  const now = (leadStage ?? '').trim();
  return now && personMove != null && personMove.trim() === now ? podioStageLabel(now) : null;
}

/** The stage a Submissions row shows and is listed under: a stage moved here this session, then a person's move in CLOZR, then Podio's. */
export const podioRowStage = (i: PodioSubmission, override?: string | null): string => override || i.clozrStage || i.stage;

/** Podio's Category label as the Submissions list it belongs to (case and spacing ignored); an unknown label is kept as written. */
export function podioStageLabel(raw: string | null | undefined): string {
  const t = (raw ?? '').trim().replace(/\s+/g, ' ');
  return (PODIO_TOTAL_SUBMISSIONS as readonly string[]).find((l) => l.toLowerCase() === t.toLowerCase()) ?? t;
}

/** True when a Podio item belongs on this Submissions list, the way Podio's own views count it. Total is every item. */
export function podioItemInList(stage: string, list: string): boolean {
  if (list === 'Total Submissions') return true;
  if (list === 'New Submissions') return (PODIO_NEW_SUBMISSIONS as readonly string[]).includes(stage);
  return stage === list;
}

/**
 * A submission taken past Offer Accepted stays on Submissions as accepted, the
 * way Podio kept the item at Offer Accepted while the deal moved on. Under
 * Contract - Seller has its own tab. Only submissions carry a lead stage, so seller leads never land here.
 */
export const SUBMISSION_PAST_ACCEPTED = ['Contract Sent to Seller', 'Under Contract - Buyer', 'Memo Filed / Legal', 'Closed'] as const;

/** Deal stages where the contract is over without a close: off every accepted / under contract list. */
const CONTRACT_ENDED = ['Terminated', 'Realtor Referral'];

/**
 * People › Submissions lists are one row per deal, matched on deals.lead_stage.
 * `dealStage` is the deal's own stage: a contract that was terminated keeps its
 * lead stage (Offer Accepted, Under Contract - Seller) but is not accepted or
 * under contract any more, so it lists on Total Submissions only (404 N Magnolia St).
 */
export function submissionListMatch(leadStage: string | null | undefined, list: string, dealStage?: string | null): boolean {
  const raw = (leadStage ?? '').trim();
  const stage = (SUBMISSION_PAST_ACCEPTED as readonly string[]).includes(raw) ? 'Offer Accepted' : raw;
  if (CONTRACT_ENDED.includes((dealStage ?? '').trim()) && (stage === 'Offer Accepted' || stage === 'Under Contract - Seller')) {
    return list === 'Total Submissions';
  }
  if (list === 'New Submissions') return (PODIO_NEW_SUBMISSIONS as readonly string[]).includes(stage);
  if (list === 'Total Submissions') return (PODIO_SUBMISSION_STAGES as readonly string[]).includes(stage);
  // "US" has no deal stage. Imports park those rows at New Submission.
  if (list === 'US') return false;
  return stage === list;
}

/**
 * A vendor sheet (iFinder, Offerpad) writes deals with no Podio item. When the
 * Submissions lists are Podio's own items, these deals still belong on the
 * same lists. A deal Podio already has is left to that item, so it is not counted twice.
 */
export function nativeSubmissionDeals<T extends { id: string; leadStage?: string | null; stage?: string | null; archived?: boolean }>(
  deals: readonly T[],
  podioDealIds: ReadonlySet<string>,
  list: string,
): T[] {
  return deals.filter((d) => !d.archived && !!d.id && !podioDealIds.has(d.id) && submissionListMatch(d.leadStage, list, d.stage));
}

// ---- The one source for stage pickers ---------------------------------------
// Every screen that offers a stage reads these. Deal stages are the
// deal_stages table (migration 27): Prospect is a real, paged pipeline column.
// Lead stages keep every value live rows carry (the seller_stages table,
// checked against `select distinct lead_stage from sellers`), grouped the way
// a rep thinks about them. A legacy duplicate still displays on a record that
// has it but is not offered as a new pick.

/** deals.stage, in pipeline order, Prospect first. */
export const DEAL_STAGE_OPTIONS = ['Prospect', ...DEAL_STAGES] as const;
export type DealStageOption = (typeof DEAL_STAGE_OPTIONS)[number];

export type LeadStageGroup = 'Active' | 'Offer' | 'Contract' | 'Nurture' | 'Dead' | 'Refund' | 'Other';

/** Values that duplicate another stage. Shown where a row has one; never offered as a pick. */
export const LEGACY_LEAD_STAGES: ReadonlySet<string> = new Set([
  'None', // no stage; the field empty says the same
  'Realtor', // same as Referred to Realtor (both map to Realtor Referral)
  'Dead - Wrong Info', // same as Refund - Wrong Info
  'Refund - Wrong Info / Other', // same as Refund - Wrong Info
]);

/** The group a lead stage sits in. Unknown values (old imports) are Other, never dropped. */
export function leadStageGroup(stage: string | null | undefined): LeadStageGroup {
  const label = (stage ?? '').trim();
  if (/^nurture\b/i.test(label)) return 'Nurture';
  const grp = SELLER_STAGES.find((s) => s.label === label)?.grp;
  switch (grp) {
    case 'lead': case 'working': return 'Active';
    case 'offer': return 'Offer';
    case 'contract': case 'closed': return 'Contract';
    case 'dead': return 'Dead';
    case 'refund': return 'Refund';
    default: return 'Other';
  }
}

/**
 * Lead stages in picker order, grouped. `stages` lists every label, legacy
 * ones included (for display and filters); `picks` is what a picker offers.
 */
export const LEAD_STAGE_GROUPS: { group: LeadStageGroup; stages: string[]; picks: string[] }[] = (
  ['Active', 'Nurture', 'Offer', 'Contract', 'Dead', 'Refund', 'Other'] as LeadStageGroup[]
).map((group) => {
  const stages = SELLER_STAGE_LABELS.filter((l) => leadStageGroup(l) === group);
  return { group, stages, picks: stages.filter((l) => !LEGACY_LEAD_STAGES.has(l)) };
});

/**
 * The picks for a record's stage menu: every non-legacy stage, plus the
 * record's own value when it is legacy or unknown, so the menu always shows
 * where it is now.
 */
export function leadStagePicks(current?: string | null): { group: LeadStageGroup; stages: string[] }[] {
  const cur = (current ?? '').trim();
  return LEAD_STAGE_GROUPS.map(({ group, picks }) => ({
    group,
    stages: cur && leadStageGroup(cur) === group && !picks.includes(cur) ? [cur, ...picks] : picks,
  }));
}
