// The one answer to "may we reach out to this person": a do-not-call tag, the
// secret blacklist tag, or a buyer's blacklisted_at. The Blacklist button only
// writes the secret tag (lib/secret-list.ts), so every path that dials, drops a
// voicemail or texts has to ask this, not test the tags it happens to know.
//
// Edge functions import this file directly (they already import lib/rvm.ts),
// so there is no second copy to drift. tools/blacklist.test.ts pins the table
// and checks the voice agent's predicate agrees.

import { hasDnc } from './rvm.ts';
import { isSecretBlacklisted } from './secret-list.ts';

/** What a blocked attempt says, in the UI and in a function's error body. */
export const BLACKLIST_MESSAGE = 'blocked: on the blacklist';

/** The shape of a seller, buyer or candidate row, whichever spelling it has. */
export type Contactable = {
  tags?: readonly string[] | null;
  /** buyers.blacklisted_at */
  blacklisted_at?: string | null;
  /** The view models' boolean form of the same column. */
  blacklisted?: boolean | null;
};

export type BlockReason = 'blacklisted' | 'do_not_call';

/** The blacklist alone: the secret tag, or a buyer's blacklisted_at. */
export function isBlacklisted(c: Contactable | null | undefined): boolean {
  return !!c && (isSecretBlacklisted(c.tags) || !!c.blacklisted_at || c.blacklisted === true);
}

/** Blacklisted or tagged do-not-call. */
export function isDoNotEngage(c: Contactable | null | undefined): boolean {
  return isBlacklisted(c) || hasDnc(c?.tags);
}

/** Why not, blacklist first: it is the stronger statement and the one the rep must see. */
export function blockReason(c: Contactable | null | undefined): BlockReason | null {
  if (isBlacklisted(c)) return 'blacklisted';
  return hasDnc(c?.tags) ? 'do_not_call' : null;
}

/** The narrow slice of a Supabase client this needs, so a test can hand in a fake. */
export type BlacklistDb = {
  from(table: 'sellers' | 'buyers'): {
    select(columns: string): {
      in(column: string, values: number[]): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

export type BlockedSet = { sellers: Set<number>; buyers: Set<number> };

/**
 * Which of these sellers and buyers are blacklisted right now, read from the
 * database rather than from whatever the screen loaded, so a row blacklisted
 * a minute ago in another tab still blocks. A failed read is an error, not an
 * empty set: the callers refuse the send, because "could not check" must not
 * read as "clear".
 */
export async function loadBlocked(
  db: BlacklistDb,
  ids: { sellerIds?: readonly (number | null | undefined)[]; buyerIds?: readonly (number | null | undefined)[] },
): Promise<{ ok: true; blocked: BlockedSet } | { ok: false; message: string }> {
  const uniq = (v: readonly (number | null | undefined)[] | undefined) =>
    [...new Set((v ?? []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)))];
  const sellerIds = uniq(ids.sellerIds);
  const buyerIds = uniq(ids.buyerIds);
  const blocked: BlockedSet = { sellers: new Set(), buyers: new Set() };
  // 200 ids per read keeps the query string well under any URL cap.
  const CHUNK = 200;
  for (let i = 0; i < sellerIds.length; i += CHUNK) {
    const { data, error } = await db.from('sellers').select('id, tags').in('id', sellerIds.slice(i, i + CHUNK));
    if (error) return { ok: false, message: `could not check the blacklist: ${error.message}` };
    for (const r of (data ?? []) as { id: number; tags: string[] | null }[]) if (isBlacklisted(r)) blocked.sellers.add(r.id);
  }
  for (let i = 0; i < buyerIds.length; i += CHUNK) {
    const { data, error } = await db.from('buyers').select('id, tags, blacklisted_at').in('id', buyerIds.slice(i, i + CHUNK));
    if (error) return { ok: false, message: `could not check the blacklist: ${error.message}` };
    for (const r of (data ?? []) as { id: number; tags: string[] | null; blacklisted_at: string | null }[]) if (isBlacklisted(r)) blocked.buyers.add(r.id);
  }
  return { ok: true, blocked };
}
