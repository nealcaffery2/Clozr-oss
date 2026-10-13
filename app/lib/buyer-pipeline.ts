// Buyers filtered to a deal that is already on the pipeline.
//
// The Buyers list can narrow to the buyers matched to one live deal (or named
// as its buyer), and sort those by match score. Closed and prospect deals are
// not on that menu: the deal has to be one dispo is still working.

export const ON_PIPELINE_STAGES = ['Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow'] as const;

export type PipelineDeal = { id: string; stage: string; archived?: boolean; addr?: string | null };

/** Menu rows for deals still on the pipeline. Houses that share a label each get the deal id. */
export function pipelineDealOptions(deals: readonly PipelineDeal[]): { id: string; label: string }[] {
  const rows = deals
    .filter((d) => !d.archived && (ON_PIPELINE_STAGES as readonly string[]).includes(d.stage))
    .map((d) => ({ id: d.id, label: `${(d.addr || 'Deal').trim() || 'Deal'} · ${d.stage}` }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.label, (n.get(r.label) ?? 0) + 1);
  return rows.map((r) => ((n.get(r.label) ?? 0) > 1 ? { ...r, label: `${r.label} (${r.id})` } : r));
}

/**
 * Buyer id → best match score for the picked deal. Null when no deal is
 * picked (the list stays the whole book). An empty map means the pick is
 * on but nobody matches — the list is empty, not everyone.
 */
export function buyersForPipelineDeal(
  matches: readonly { buyerId: string; score: number }[],
  dealBuyerId: string | null | undefined,
  active: boolean,
): Map<string, number> | null {
  if (!active) return null;
  const scores = new Map<string, number>();
  for (const m of matches) {
    const prev = scores.get(m.buyerId);
    if (prev == null || m.score > prev) scores.set(m.buyerId, m.score);
  }
  if (dealBuyerId && !scores.has(dealBuyerId)) scores.set(dealBuyerId, 0);
  return scores;
}
