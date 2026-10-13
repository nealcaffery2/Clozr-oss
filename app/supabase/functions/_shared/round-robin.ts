/**
 * Deal a freshly landed lead to the next rep in its key's round robin
 * (migration 121). The rotation, the lock and the "already assigned" check all
 * live in public.round_robin_assign_lead, so this is one RPC and safe to call
 * on every delivery: a repeat or an assigned lead consumes no turn.
 *
 * Best-effort by design: the lead is already applied and ledgered, so a missing
 * migration or a failed pick is logged, never turned into an error the sender
 * would retry.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export async function roundRobinLead(
  db: SupabaseClient,
  ingestSourceId: number,
  sellerId: number | null | undefined,
): Promise<{ assigned: boolean; user_id?: string; reason?: string } | null> {
  if (!sellerId) return null;
  const { data, error } = await db.rpc('round_robin_assign_lead', {
    p_ingest_source_id: ingestSourceId,
    p_seller_id: sellerId,
  });
  if (error) {
    console.error('round_robin_assign_lead failed', ingestSourceId, sellerId, error.message);
    return null;
  }
  return data as { assigned: boolean; user_id?: string; reason?: string };
}

/** Whether a key has a rotation at all, so keys without one skip the RPC. */
export function hasRoundRobin(settings: unknown): boolean {
  const v = (settings as { round_robin?: string } | null)?.round_robin;
  return !!v && v !== 'off';
}
