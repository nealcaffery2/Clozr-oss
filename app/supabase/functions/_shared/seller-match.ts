// Which seller an ingest match may attach a deal to.
//
// A merge leaves the old seller archived and tags it `merged-into-<id>`
// (people-stack treats that tag as bookkeeping, not a list). There is no
// merged-into column. The same token in lead_stage (the record's status) or
// notes counts too. This file imports nothing and is copied verbatim into
// supabase/functions/_shared/seller-match.ts; tools/seller-match.test.ts
// fails when the two copies drift. The SQL walk in
// resolve_live_seller (migration 164) follows the same rules.

export type SellerMatchRow = {
  id: number;
  archived_at?: string | null;
  tags?: readonly string[] | null;
  /** sellers.lead_stage, the record's status. */
  lead_stage?: string | null;
  notes?: string | null;
  phone?: string | null;
};

/** How far a merge chain may run before it is treated as no match. */
export const MERGE_HOP_LIMIT = 8;

const POINTER = /merged-into-(\d+)/i;

/** The seller id a `merged-into-<id>` tag, status, or note points at. Tags win, then status, then notes. */
export function mergedIntoId(row: Pick<SellerMatchRow, 'tags' | 'lead_stage' | 'notes'>): number | null {
  const chunks: string[] = [];
  for (const tag of row.tags ?? []) if (tag) chunks.push(tag);
  if (row.lead_stage) chunks.push(row.lead_stage);
  if (row.notes) chunks.push(row.notes);
  for (const chunk of chunks) {
    const m = POINTER.exec(chunk);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * The live seller a matched row should attach to.
 * An archived seller, or any seller that still carries a merged-into pointer,
 * is never the result: the pointer is followed, chains included. A cycle, a
 * missing target, a chain longer than MERGE_HOP_LIMIT, or an archived seller
 * with no pointer is no match.
 */
export function resolveLiveSeller(startId: number | null | undefined, byId: ReadonlyMap<number, SellerMatchRow>): number | null {
  if (startId == null) return null;
  const seen = new Set<number>();
  let id: number | null = startId;
  while (id != null) {
    if (seen.has(id) || seen.size >= MERGE_HOP_LIMIT) return null;
    seen.add(id);
    const row = byId.get(id);
    if (!row) return null;
    const next = mergedIntoId(row);
    if (!row.archived_at && next == null) return row.id;
    if (next == null) return null;
    id = next;
  }
  return null;
}

/** First candidate that resolves to a live seller. Candidates are already in match order. */
export function pickLiveSeller(candidateIds: readonly number[], byId: ReadonlyMap<number, SellerMatchRow>): number | null {
  for (const id of candidateIds) {
    const live = resolveLiveSeller(id, byId);
    if (live != null) return live;
  }
  return null;
}
