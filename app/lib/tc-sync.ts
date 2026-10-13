// Pure helpers for the TC file: matching checklist lines to CRM tasks, and
// the stage a sent document implies. The write layer and the edge functions
// keep their own I/O; this file is the shared rule so a tick and a task
// completion cannot disagree on which line they mean.

import { D, type TcChecklist } from './clozr-types';

export function normTcTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

type CatalogItem = { id: string; t: string };

function catalog(): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const cl of Object.values(D.tcChecklists as Record<string, TcChecklist>)) {
    for (const ph of cl.phases) for (const t of ph.tasks) out.push({ id: t.id, t: t.t });
  }
  return out;
}

export function checklistItemById(id: string): CatalogItem | null {
  return catalog().find((t) => t.id === id) ?? null;
}

/** Match a CRM task title to a checklist line (exact, then a unique prefix). */
export function checklistIdForTitle(title: string): string | null {
  const n = normTcTitle(title);
  if (!n) return null;
  const items = catalog();
  const exact = items.find((t) => normTcTitle(t.t) === n);
  if (exact) return exact.id;
  const hits = items.filter((t) => n.startsWith(normTcTitle(t.t).slice(0, 48)) || normTcTitle(t.t).startsWith(n.slice(0, 48)));
  return hits.length === 1 ? hits[0].id : null;
}

/** Seller stages that already sit at or past an outbound offer. */
export const OFFER_SENT_LOCK = [
  'Offer Made', 'Pending Response', 'Offer Made - Follow Up', 'Offer Made - Retail',
  'Pending Inspections', 'Offer Accepted', 'Contract Sent to Seller',
  'Under Contract - Seller', 'Under Contract - Buyer', 'Memo Filed / Legal', 'Closed',
];

/** Seller stages that already sit at or past a PSA going out. */
export const PSA_SENT_LOCK = [
  'Contract Sent to Seller', 'Under Contract - Seller', 'Under Contract - Buyer',
  'Memo Filed / Legal', 'Closed',
];

/** What sending a document of this kind should do to the pipeline. */
export function sentDocStages(kind: string): { seller?: string; deal?: string; ping: string } | null {
  switch (kind) {
    case 'psa': return { seller: 'Contract Sent to Seller', ping: 'Purchase agreement sent' };
    case 'offer': return { seller: 'Offer Made', ping: 'Offer sent' };
    case 'addendum': return { ping: 'Addendum sent' };
    case 'termination': return { seller: 'Terminated', deal: 'Terminated', ping: 'Cancellation sent' };
    default: return null;
  }
}

/**
 * Submission stages a sent outbound offer moves to Offer Made. Same list as
 * offers_after_write (migration 174). Accepted, in inspections, or at auction
 * is not in this list and stays.
 */
export const SUBMISSION_TO_OFFER_MADE = [
  'New Submission', 'Lead', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete', 'Pending Response',
  'Underwrite Declined', 'Offer Declined',
] as const;

export function submissionMovesToOfferMade(leadStage: string | null | undefined): boolean {
  return !!leadStage && (SUBMISSION_TO_OFFER_MADE as readonly string[]).includes(leadStage);
}

/**
 * When an outbound offer write moves the seller and the submission.
 * A Draft insert is the letter someone can open. The move happens on a Sent
 * insert, or when a Draft is updated to Sent. Matches offers_after_write.
 */
export function offerWriteMovesStage(op: 'INSERT' | 'UPDATE', status: string | null | undefined, previous?: string | null): boolean {
  const advance = (status ?? '').trim().toLowerCase() !== 'draft';
  if (!advance) return false;
  if (op === 'INSERT') return true;
  return (previous ?? '').trim().toLowerCase() === 'draft';
}

export function sellerMayAdvance(current: string | null | undefined, next: string): boolean {
  if (!current) return true;
  if (next === 'Offer Made') return !OFFER_SENT_LOCK.includes(current);
  if (next === 'Contract Sent to Seller') return !PSA_SENT_LOCK.includes(current);
  if (next === 'Terminated') return current !== 'Closed' && current !== 'Terminated';
  return current !== next;
}
