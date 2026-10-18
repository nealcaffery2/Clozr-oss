/**
 * The `optins` action's rows, worked out in memory so one upsert on
 * (workspace_id, domain) writes them all. Pure, so the merge is testable
 * without a database: npx tsx tools/deal-machine-optins.test.ts
 */

/** One reported outcome, already cleaned by index.ts (domain lowercased, no www.). */
export type Optin = { domain: string; url: string | null; status: string; method: string | null; detail: string | null; at: string };
/** What a row already in dm_optins carries into the merge. */
export type OptinHave = { domain: string; url: string | null; status: string; attempts: number; first_at: string };
export type OptinRow = {
  workspace_id: number; domain: string; url: string | null; status: string; method: string | null; detail: string | null;
  attempts: number; run_id: number | null; device_id: string | null; first_at: string; last_at: string;
};

/**
 * The rows to upsert, one per domain, the same end state as writing the items
 * one at a time in order: a new domain is inserted with one attempt; a known
 * one (in the table, or earlier in this batch) gets one more attempt, keeps its
 * url when the item has none and its first_at, and an opt-in that once
 * succeeded stays succeeded.
 */
export function mergeOptins(
  items: Optin[],
  have: Map<string, OptinHave>,
  ctx: { workspace_id: number; run_id: number | null; device_id: string | null },
): OptinRow[] {
  const out = new Map<string, OptinRow>();
  for (const o of items) {
    const prev = out.get(o.domain) ?? have.get(o.domain);
    out.set(o.domain, {
      ...ctx, domain: o.domain, method: o.method, detail: o.detail, last_at: o.at,
      ...(prev
        ? { url: o.url ?? prev.url, status: prev.status === 'opted_in' ? 'opted_in' : o.status, attempts: prev.attempts + 1, first_at: prev.first_at }
        : { url: o.url, status: o.status, attempts: 1, first_at: o.at }),
    });
  }
  return [...out.values()];
}
