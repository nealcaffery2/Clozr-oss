/**
 * The bulk send's row claim, apart from index.ts so
 * tools/docs-bulk-claim.test.ts can run two overlapping ticks against a fake
 * client.
 *
 * bulk_create sends its first rows itself and the cron's bulk_tick drains the
 * rest, so two runs can read the same queued rows. Each row is claimed before
 * its contract is created and sent: one conditional update, where the row is
 * still queued, that returns it. Only the run that flipped it sends.
 * bulk_send_items has no in-flight status (179 allows queued, sent, failed,
 * skipped), so the claim writes failed with UNKNOWN_OUTCOME, and the run then
 * marks it sent, skipped or failed with the real error. A run killed mid-send
 * (the runtime's wall clock) leaves a row that says what happened, and no
 * later tick sends it again. If it held the batch's last rows, no tick
 * recounts the batch; docs_bulk_kick settles it from its rows (355).
 */

type Any = any;

export const UNKNOWN_OUTCOME = 'send outcome unknown; not retried';

/** True only for the run whose update flipped the row. A failed update is not a claim. */
export async function claimBulkItem(db: Any, id: number): Promise<boolean> {
  const { data, error } = await db.from('bulk_send_items').update({ status: 'failed', error: UNKNOWN_OUTCOME }).eq('id', id).eq('status', 'queued').select('id');
  return !error && !!data?.length;
}
