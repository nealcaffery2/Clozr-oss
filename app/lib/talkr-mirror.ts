// Whether this browser may copy Talkr history onto a workspace's records.
// No row in talkr_connections (or a paused workspace) means no mirror. When
// the dialer already knows the Talkr org, it has to be the bound one.
import { supabase } from './supabase';
import { loadSettings } from './integrations';
import { activeTalkrBinding, gateTalkrWrite, TALKR_NOT_CONNECTED, type TalkrConnection } from '../supabase/functions/_shared/talkr-binding';

export { TALKR_NOT_CONNECTED };

export async function talkrMirrorAllowed(workspaceId: number, observedOrgId?: string | null): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.from('talkr_connections')
    .select('workspace_id, talkr_org_id, enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !data) return false;
  const settings = await loadSettings(workspaceId);
  const binding = activeTalkrBinding({ id: workspaceId, settings }, data as TalkrConnection);
  if (!binding) return false;
  if (observedOrgId == null || observedOrgId === '') return true;
  return gateTalkrWrite({ binding, observedOrgId }).ok;
}
