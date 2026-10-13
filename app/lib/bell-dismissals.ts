// Bell rows dismissed on the server (migration 189), so a missed call or text
// marked read on the desk is gone on the phone too. Only the rows with no
// notifications row of their own (bell-call-*, bell-sms-*, deal sheet gaps):
// a real notification is marked read where it lives (notifications.read_at).
//
// Until 189 is applied the table is missing; both calls then answer "not
// here" and the bell keeps using localStorage (lib/notif-dismiss), as before.
'use client';

import { supabase } from './supabase';

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''));

/** This member's dismissed bell ids, newest first; null when the table is not there (or no project). */
export async function loadBellDismissals(workspaceId: number, userId: string): Promise<string[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('bell_dismissals' as never).select('item_id')
    .eq('workspace_id', workspaceId).eq('user_id', userId)
    .order('dismissed_at', { ascending: false }).limit(1000);
  if (error) {
    if (!missing(error)) console.warn('bell dismissals', error.message);
    return null;
  }
  return ((data ?? []) as unknown as { item_id: string }[]).map((r) => r.item_id);
}

/** Remember these as dismissed. Real notification ids (n123) are skipped: they have read_at. */
export async function saveBellDismissals(workspaceId: number, userId: string, ids: string[]): Promise<boolean> {
  const rows = ids.filter((id) => !/^n\d+$/.test(id)).map((item_id) => ({ workspace_id: workspaceId, user_id: userId, item_id }));
  if (!supabase || !rows.length) return false;
  const { error } = await supabase.from('bell_dismissals' as never)
    .upsert(rows as never, { onConflict: 'workspace_id,user_id,item_id', ignoreDuplicates: true });
  if (error && !missing(error)) console.warn('bell dismissals', error.message);
  return !error;
}
