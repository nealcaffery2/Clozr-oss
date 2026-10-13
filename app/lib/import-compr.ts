// COMPR after a bulk import — which new leads may be underwritten. Pure, so
// the number a person confirms and the list that is queued come from one rule.
//
// Each COMPR report is billed, so an import never pulls one unless the person
// switched it on for this import and confirmed the count. Only sellers the
// import itself created, with a street address, are candidates: an updated
// record, a co-seller, a buyer or a vendor never is.

import type { Action } from './import-dedupe';

type Row = { addr?: string | null; problem: string | null };
type Reported = { row: number; result: string; id: number | null };

const hasAddress = (r: Row | undefined) => !!r && !r.problem && !!(r.addr ?? '').trim();

/** How many COMPR reports an import can queue at most: rows it will create with an address. Zero for buyers and vendors. */
export function comprCandidates(kind: string, records: Row[], actions: (Action | null)[]): number {
  if (kind !== 'sellers') return 0;
  return records.filter((r, i) => actions[i] === 'create' && hasAddress(r)).length;
}

/**
 * The sellers to underwrite once the import is done: created by it, with an
 * address, and never more than the person confirmed (`confirmed` is the count
 * they said yes to; 0 queues nothing).
 */
export function comprQueue(kind: string, report: Reported[], records: Row[], confirmed: number): number[] {
  if (kind !== 'sellers' || confirmed <= 0) return [];
  return report
    .filter((r) => r.result === 'created' && r.id != null && hasAddress(records[r.row - 1]))
    .map((r) => r.id as number)
    .slice(0, confirmed);
}

/** The confirm line: "Import, then run 240 COMPR reports on the new leads? Each report is billed." */
export const comprConfirmText = (n: number) =>
  `Import, then run ${n.toLocaleString('en-US')} COMPR report${n === 1 ? '' : 's'} on the new lead${n === 1 ? '' : 's'}? Each report is billed.`;
