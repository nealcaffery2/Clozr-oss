// Settings → History: one row per skip trace and per import (migration 117),
// and the notification that tells whoever ran it that it is done.

import { supabase } from './supabase';

export type DataRun = {
  id: number; kind: 'skiptrace' | 'import'; entity: 'seller' | 'buyer' | 'vendor' | null; label: string | null;
  total: number; succeeded: number; failed: number; credits: number; detail: Record<string, unknown>;
  created_by: string | null; created_at: string;
};

/** The tag every skip-traced seller and buyer gets. */
export const SKIPTRACE_TAG = 'skiptrace completed';

/** Log a run. Never throws: history is a record of the work, not part of it. */
export async function logRun(workspaceId: number, run: Omit<DataRun, 'id' | 'created_by' | 'created_at'>): Promise<void> {
  if (!supabase) return;
  try { await supabase.from('data_runs' as never).insert({ workspace_id: workspaceId, ...run } as never); } catch { /* history only */ }
}

/** A system notification for one teammate (the bell and the realtime toast). */
export async function notifyUser(workspaceId: number, userId: string | null, n: { title: string; body?: string; category?: string; sellerId?: number | null; buyerId?: number | null }): Promise<void> {
  if (!supabase || !userId) return;
  try {
    await supabase.from('notifications').insert({
      workspace_id: workspaceId, user_id: userId, category: n.category ?? 'System', title: n.title, body: n.body ?? null,
      seller_id: n.sellerId ?? null, buyer_id: n.buyerId ?? null,
    } as never);
  } catch { /* the work is done either way */ }
}

export async function listRuns(workspaceId: number, limit = 200): Promise<DataRun[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('data_runs' as never).select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(limit);
  return (data ?? []) as unknown as DataRun[];
}
