// Whether this browser may copy Talkr history onto a workspace's records.
// No row in talkr_connections (or a paused workspace) means no mirror. When
// the dialer already knows the Talkr org, it has to be the bound one.
import { supabase } from './supabase';
import { loadSettings } from './integrations';
import { activeTalkrBinding, gateTalkrWrite, TALKR_NOT_CONNECTED, type TalkrConnection } from '../supabase/functions/_shared/talkr-binding';

export { TALKR_NOT_CONNECTED };

/**
 * The connection row and settings, read once per workspace for a few minutes.
 * Every mirror pass and every filed call used to read both again, which a busy
 * dialer did several times a call.
 */
const BINDING_TTL_MS = 5 * 60_000;
const bindings = new Map<number, { at: number; binding: Promise<ReturnType<typeof activeTalkrBinding> | null> }>();

async function readBinding(workspaceId: number): Promise<ReturnType<typeof activeTalkrBinding> | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('talkr_connections')
    .select('workspace_id, talkr_org_id, enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  const settings = await loadSettings(workspaceId);
  return activeTalkrBinding({ id: workspaceId, settings }, data as TalkrConnection);
}

export async function talkrMirrorAllowed(workspaceId: number, observedOrgId?: string | null): Promise<boolean> {
  if (!supabase) return false;
  const hit = bindings.get(workspaceId);
  const fresh = hit && Date.now() - hit.at < BINDING_TTL_MS ? hit : null;
  const entry = fresh ?? { at: Date.now(), binding: readBinding(workspaceId).catch(() => null) };
  if (!fresh) bindings.set(workspaceId, entry);
  const binding = await entry.binding;
  // A failed or empty read is not kept: the next pass asks again.
  if (!binding) { bindings.delete(workspaceId); return false; }
  if (observedOrgId == null || observedOrgId === '') return true;
  return gateTalkrWrite({ binding, observedOrgId }).ok;
}
