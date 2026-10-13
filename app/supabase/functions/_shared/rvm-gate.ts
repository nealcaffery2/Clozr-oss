// Who a queued ringless drop is for, and whether they may be dropped on.
// Lives here rather than in rvm-tick/index.ts because that file starts a
// server on import, so a test could not reach it.

import { blockReason, type BlockReason } from '../../../lib/blacklist.ts';

export type RvmPersonRow = {
  phone?: string | null; tags?: string[] | null;
  blacklisted_at?: string | null; wants_calls?: boolean;
  /** Buyers: where they buy. The first state among them picks the RVM pool line. */
  markets?: string[] | null;
  properties?: { state?: string | null; zip?: string | null } | { state?: string | null; zip?: string | null }[] | null;
};

type Query = { maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }> };
export type RvmGateDb = {
  from(table: 'sellers' | 'buyers'): { select(columns: string): { eq(column: string, value: number): Query } };
};

export type RvmPerson =
  | { ok: true; row: RvmPersonRow | null; blocked: BlockReason | null; dnc: boolean }
  /** The read failed: the drop is held, never sent on a guess. */
  | { ok: false; message: string };

/**
 * The seller's or buyer's row for this drop, read at send time (a blacklist
 * added after the drop was queued must still stop it), plus the verdict.
 * `blocked` is the blacklist or a DNC tag; `dnc` also folds in a buyer who
 * asked not to be called.
 */
export async function loadRvmPerson(admin: RvmGateDb, drop: { seller_id: number | null; buyer_id: number | null }): Promise<RvmPerson> {
  const res = drop.seller_id
    ? await admin.from('sellers').select('phone, tags, properties(state, zip)').eq('id', drop.seller_id).maybeSingle()
    : await admin.from('buyers').select('phone, tags, blacklisted_at, wants_calls, markets').eq('id', drop.buyer_id!).maybeSingle();
  if (res.error) return { ok: false, message: `could not check the blacklist: ${res.error.message}` };
  const row = res.data as RvmPersonRow | null;
  const blocked = blockReason(row);
  return { ok: true, row, blocked, dnc: blocked === 'do_not_call' || row?.wants_calls === false };
}
