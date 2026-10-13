// Loads talkr_connections for the edge functions. A missing table (migration
// 168 not applied yet) or a read error returns nothing, so the cron writes
// nowhere rather than falling back to every workspace of the owner.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { TalkrConnection } from './talkr-binding.ts';

export async function loadTalkrConnections(admin: SupabaseClient, ids?: number[]): Promise<TalkrConnection[]> {
  try {
    let q = admin.from('talkr_connections').select('workspace_id, talkr_org_id, enabled');
    if (ids && ids.length) q = q.in('workspace_id', ids);
    else q = q.eq('enabled', true);
    const { data, error } = await q;
    if (error) {
      console.error('talkr_connections', error.message);
      return [];
    }
    return ((data ?? []) as TalkrConnection[]).filter((row) => row && row.workspace_id != null && String(row.talkr_org_id ?? '').trim() !== '');
  } catch (err) {
    console.error('talkr_connections', err);
    return [];
  }
}
