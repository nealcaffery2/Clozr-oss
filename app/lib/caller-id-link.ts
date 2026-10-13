// The writes behind lib/caller-id-sync.ts. Every write is gated by
// talkrMirrorAllowed, so a workspace whose Talkr is paused or bound to another
// org never gets Talkr's choice copied in. Failures only log: the Talkr side
// already changed, and the caller ID the rep picked still dials.
import { supabase } from './supabase';
import { talkrMirrorAllowed } from './talkr-mirror';
import { talkr, type MeDto } from './talkr';
import { callerIdSyncPlan, clozrPickFor, type CallerIdRow } from './caller-id-sync';

async function myRows(workspaceId: number, userId: string): Promise<CallerIdRow[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('rep_phone_numbers' as never)
    .select('phone_e164, user_id, is_caller_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  if (error) {
    console.warn('caller ID sync: could not read rep_phone_numbers', error.message);
    return null;
  }
  return (data ?? []) as unknown as CallerIdRow[];
}

async function flagInClozr(workspaceId: number, phone: string): Promise<boolean> {
  const { error } = await supabase!.rpc('set_line_caller_id' as never, { p_workspace: workspaceId, p_phone: phone } as never);
  if (error) console.warn('caller ID sync: CLOZR kept the old caller ID', error.message);
  return !error;
}

/** After a dialer pick on Talkr: the same line becomes the rep's CLOZR caller ID. */
export async function pushCallerIdPick(input: {
  workspaceId: number | null;
  userId: string | null;
  talkrOrgId: string | null | undefined;
  phone: string | null | undefined;
}): Promise<void> {
  const { workspaceId, userId, talkrOrgId, phone } = input;
  if (!workspaceId || !userId || !phone) return;
  try {
    const rows = await myRows(workspaceId, userId);
    const pick = rows && clozrPickFor(userId, rows, phone);
    if (!pick || !(await talkrMirrorAllowed(workspaceId, talkrOrgId))) return;
    await flagInClozr(workspaceId, pick);
  } catch (err) {
    console.warn('caller ID sync failed', err);
  }
}

/**
 * Once per dialer load. Returns Talkr's new profile when Talkr was the side
 * written, so the dialer shows it without a refetch.
 */
export async function reconcileCallerId(input: { workspaceId: number; userId: string; me: MeDto }): Promise<MeDto | null> {
  const { workspaceId, userId, me } = input;
  try {
    const rows = await myRows(workspaceId, userId);
    if (!rows) return null;
    const plan = callerIdSyncPlan(userId, rows, me);
    if (plan.write === 'none' || !(await talkrMirrorAllowed(workspaceId, me.org?.id))) return null;
    if (plan.write === 'clozr') {
      await flagInClozr(workspaceId, plan.phone);
      return null;
    }
    return await talkr.updateMe({ default_phone_number_id: plan.numberId });
  } catch (err) {
    console.warn('caller ID sync failed', err);
    return null;
  }
}
