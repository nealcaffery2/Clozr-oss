// Which submissions in a partner's sheet CLOZR already has.
//
// A partner resends its sheet with the same houses on it, more or less every
// time. Each row is matched to a deal already in CLOZR before anything is
// written: by the row's own id (a Podio item, a sheet's ID column) on that
// partner, else by the house — the same property (the database files an
// address under one properties row by address_key, so this is the normalized
// address) on the same partner contact. A match fills the deal's blanks and
// is never a second deal, and never pulls COMPR again. An archived deal is
// not matched: a house the team let go that the partner sends again is a new
// submission.
//
// Pure: lib/submission-import.ts reads the rows; tools/submission-match.test.ts runs this.

/** A deal already in CLOZR, as the match reads it. */
export type ExistingSubmission = {
  id: number; sellerId: number | null; propertyId: number | null; sourceId: string | null; archived: boolean;
};
/** What a row of the sheet is matched on: the partner's contact, the house, and the row's own id. */
export type SubmissionKey = { sellerId: number | null; propertyId: number | null; sourceId: string | null | undefined };

const sourceKey = (sellerId: number | null, sourceId: string | null | undefined) => {
  const id = (sourceId ?? '').trim().toLowerCase();
  return sellerId != null && id ? `${sellerId}|${id}` : null;
};
const houseKey = (sellerId: number | null, propertyId: number | null) => (sellerId != null && propertyId != null ? `${sellerId}|${propertyId}` : null);

export type SubmissionIndex = { bySource: Map<string, number>; byHouse: Map<string, number> };

/** The open deals, keyed both ways. The newest deal on a key wins: that is the one the partner is resending. */
export function indexSubmissions(existing: ExistingSubmission[]): SubmissionIndex {
  const idx: SubmissionIndex = { bySource: new Map(), byHouse: new Map() };
  for (const d of [...existing].sort((a, b) => a.id - b.id)) addSubmission(idx, d);
  return idx;
}

/** Put a deal in the index (one just created, so a later row of the same file finds it too). */
export function addSubmission(idx: SubmissionIndex, d: ExistingSubmission): void {
  if (d.archived) return;
  const s = sourceKey(d.sellerId, d.sourceId);
  if (s) idx.bySource.set(s, d.id);
  const h = houseKey(d.sellerId, d.propertyId);
  if (h) idx.byHouse.set(h, d.id);
}

/** The deal this row already is, and what it matched on; null when it is a new submission. */
export function matchSubmission(idx: SubmissionIndex, row: SubmissionKey): { id: number; by: 'record id' | 'address' } | null {
  const s = sourceKey(row.sellerId, row.sourceId);
  const bySource = s ? idx.bySource.get(s) : undefined;
  if (bySource != null) return { id: bySource, by: 'record id' };
  const h = houseKey(row.sellerId, row.propertyId);
  const byHouse = h ? idx.byHouse.get(h) : undefined;
  return byHouse != null ? { id: byHouse, by: 'address' } : null;
}

/** The import's line for the counts: "12 new, 38 already in CLOZR (updated)". */
export function submissionCounts(created: number, updated: number): string {
  return `${created.toLocaleString('en-US')} new, ${updated.toLocaleString('en-US')} already in CLOZR (updated)`;
}
