// Loads talkr_connections for the edge functions. A missing table (migration
// 168 not applied yet) or a read error returns nothing, so the cron writes
// nowhere rather than falling back to every workspace of the owner.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { activeTalkrBinding, talkrFlagEnabled, type TalkrBinding, type TalkrConnection } from './talkr-binding.ts';

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

/**
 * The Talkr org a workspace's server texts go through: its own connection,
 * or, for a workspace with none, the connection of the workspace whose
 * settings.talkr.elsewhere names it (migration 275). A Talkr org belongs to
 * one workspace (talkr_connections.talkr_org_id is unique), and a workspace
 * riding another's org has none: its people text on that org's lines, so its plan, AI agent and
 * lifecycle texts were held as "Talkr not connected". The sender's own token
 * still has to see that org (gateTalkrWrite), so nobody texts through an org
 * they are not in, and the text is filed in the workspace that sent it.
 */
export async function textingBinding(admin: SupabaseClient, ws: { id: number; settings: unknown }): Promise<TalkrBinding | null> {
  const own = activeTalkrBinding(ws, (await loadTalkrConnections(admin, [ws.id]))[0] ?? null);
  if (own || !talkrFlagEnabled(ws.settings)) return own;
  const { data, error } = await admin.from('workspaces').select('id, settings').contains('settings', { talkr: { elsewhere: [ws.id] } });
  if (error) { console.error('texting binding', error.message); return null; }
  for (const host of (data ?? []) as { id: number; settings: unknown }[]) {
    if (Number(host.id) === ws.id) continue;
    const b = activeTalkrBinding({ id: Number(host.id), settings: host.settings }, (await loadTalkrConnections(admin, [Number(host.id)]))[0] ?? null);
    if (b) return b;
  }
  return null;
}
