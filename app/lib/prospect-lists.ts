// Where a found buyer waits before they are a real buyer, and the lists
// Dispo markets to on their own.
//
// Genius, buyr and Facebook comment captures used to land on the Buyers
// screen next to people we already market to. Holding lists are that pen.
// A vetted or VIP buyer has been promoted and stays on Buyers even if an
// old holding tag is still on the row.
//
// Realtors is not a holding pen. The tag, or buyer_type `realtors`, keeps
// them on their own list next to Capital Raise Prospects, and a campaign
// can still send them a deal in their market.

export const PROSPECT_LISTS = [
  { id: 'buyer-prospect', label: 'Buyer Prospects', tag: 'buyer-prospect', holding: true },
  { id: 'capital-raise-prospect', label: 'Capital Raise Prospects', tag: 'capital-raise-prospect', holding: true },
  { id: 'realtors', label: 'Realtors', tag: 'realtors', holding: false },
] as const;

export type ProspectListId = (typeof PROSPECT_LISTS)[number]['id'];

/** Sources that discover buyers rather than record ones we already work. */
const DISCOVERY_SOURCES = new Set(['buyr', 'genius', 'investorbase']);

/**
 * A bulk import that stays in `buyers` and `vendors` for server jobs, and is
 * left out of every read that hydrates the shell. Workspace 11 holds ~128k
 * of these, all buyer_type realtors. Paging that corpus, 1,000 rows at a
 * time, is what PostgREST cancels at the 8s statement timeout (500).
 * Buyers › Realtors reads a page through search_free_agent_buyers instead.
 *
 * Callers drop it with `.isDistinct('source', BULK_BUYER_SOURCE)`. That is
 * `IS DISTINCT FROM`, so a null source stays, and it matches the partial
 * indexes `buyers_workspace_shell_idx` and `vendors_workspace_shell_idx`.
 * An `or` of `source.is.null` and `source.neq` does not match those indexes
 * and scans the whole table.
 */
export const BULK_BUYER_SOURCE = 'dispogenius-free-agents';

const tagSet = (tags: string[] | null | undefined) => new Set((tags ?? []).map((t) => t.toLowerCase().trim()));

export function prospectListId(
  tags: string[] | null | undefined,
  status?: string | null,
  source?: string | null,
  flags?: { vetted?: boolean; vip?: boolean; buyerType?: string | null },
): ProspectListId | null {
  if (/inactive/i.test(status ?? '')) return null;
  const set = tagSet(tags);
  const buyerType = (flags?.buyerType ?? '').toLowerCase().trim();
  for (const list of PROSPECT_LISTS) {
    const tagged = set.has(list.tag) || (list.id === 'realtors' && (buyerType === 'realtors' || buyerType === 'realtor'));
    if (!tagged) continue;
    if (list.holding && (flags?.vetted || flags?.vip)) return null;
    return list.id;
  }
  if (flags?.vetted || flags?.vip) return null;
  if (/prospect/i.test(status ?? '')) return 'buyer-prospect';
  if (DISCOVERY_SOURCES.has((source ?? '').toLowerCase())) return 'buyer-prospect';
  return null;
}

/** True when this person is still in a holding pen and must not be blasted. */
export function isBuyerProspect(
  tags: string[] | null | undefined,
  status?: string | null,
  source?: string | null,
): boolean {
  if (/prospect/i.test(status ?? '')) return true;
  const set = tagSet(tags);
  if (PROSPECT_LISTS.some((list) => list.holding && set.has(list.tag))) return true;
  return DISCOVERY_SOURCES.has((source ?? '').toLowerCase()) && !/inactive/i.test(status ?? '');
}

/** Deal Machine finds on the People screen, separate from worked leads. */
export function isDmProspect(source: string | null | undefined, tags: string[] | null | undefined): boolean {
  if ((source ?? '').toLowerCase() === 'deal_machine') return true;
  return (tags ?? []).some((t) => /^(dm-prospect|deal-machine|deal_machine)$/i.test(t.trim()));
}
