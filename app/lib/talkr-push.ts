// A CLOZR call list as Talkr contacts, for a parallel (multi-line) session.
// Talkr can only ring people it knows, so Predictive pushes the list first
// (/v1/contacts/upsert) and builds the campaign from the ids it hands back.

import { personKey } from './dial-session';
import { zoneForRvm } from './rvm';
import { toE164 } from './talkr';

/** Talkr's dial-list limit: one campaign holds at most this many people. */
export const TALKR_LIST_MAX = 500;

export type PushRow = { external_id: string; name: string; phones: string[]; timezone: string };

/**
 * One row per person (first appearance wins), dialable numbers only, DNC and
 * other reps' claims left out. The seller's zone comes from the area code so
 * Talkr's 8am–8pm window is theirs, not San Antonio's.
 */
export function talkrPushRows<T extends { target: { name: string; phone: string; personId?: string | null; buyerId?: string | null } }>(
  list: readonly T[],
  skip: (item: T) => boolean,
): PushRow[] {
  const seen = new Set<string>();
  const rows: PushRow[] = [];
  for (const item of list) {
    const key = personKey(item.target);
    if (seen.has(key)) continue;
    seen.add(key);
    const phone = toE164(item.target.phone ?? '');
    if (!phone || skip(item)) continue;
    rows.push({ external_id: key, name: item.target.name ?? '', phones: [phone], timezone: zoneForRvm(phone) });
  }
  return rows;
}
