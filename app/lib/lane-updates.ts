// What Lane heard on a file (migration 80, lane_updates), and the TC's say on it.
//
// lane-listen writes the rows: a tick or a finished task it was sure of is
// already applied, everything else waits here. Accepting does exactly what a
// person doing it by hand would (setTcTick, a task row, a deal-team row, a
// date on the file), so the checklist, Tasks, the deal team and the activity
// feed all move together; undo reverses an applied tick or task completion.

import type { Json, LaneUpdateRow } from './database.types';
import { setTcTick } from './crm-write';
import { saveDealParty } from './deal-parties';
import { supabase } from './supabase';

export type LaneUpdate = LaneUpdateRow;
type Result = { ok: boolean; message?: string };
type P = Record<string, Json | undefined>;

const str = (v: Json | undefined) => (typeof v === 'string' ? v : v == null ? null : String(v));

/** A file's updates: everything waiting, then the last few days of what was applied. */
export async function loadLaneUpdates(transactionId: number): Promise<LaneUpdate[]> {
  if (!supabase) return [];
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await supabase.from('lane_updates').select('*').eq('transaction_id', transactionId)
    .or(`status.eq.pending,created_at.gt.${since}`).order('created_at', { ascending: false }).limit(60);
  return (data ?? []) as LaneUpdate[];
}

async function mark(u: LaneUpdate, status: LaneUpdate['status'], me: string | null): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('lane_updates').update({ status, decided_by: me, decided_at: new Date().toISOString() }).eq('id', u.id);
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Do what the update says, then mark it applied. */
export async function acceptLaneUpdate(u: LaneUpdate, workspaceId: number, me: string | null): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const p = (u.payload ?? {}) as P;
  if (u.kind === 'tick') {
    const r = await setTcTick(u.transaction_id, 'checklist', String(p.item_id), true, me);
    if (!r.ok) return r;
  } else if (u.kind === 'task_done') {
    const { error } = await supabase.from('tasks').update({ done: true, completed_at: new Date().toISOString() }).eq('id', Number(p.task_id));
    if (error) return { ok: false, message: error.message };
  } else if (u.kind === 'task_add') {
    const due = new Date();
    due.setDate(due.getDate() + Number(p.due_in_days ?? 1));
    due.setHours(9, 0, 0, 0);
    const { error } = await supabase.from('tasks').insert({
      workspace_id: workspaceId, seller_id: u.seller_id, deal_id: u.deal_id, title: str(p.title) ?? u.summary,
      task_type: 'TC', priority: 'Medium', due_at: due.toISOString(), assigned_to: me, created_by: me,
      notes: u.evidence ? `Lane heard: “${u.evidence}”` : null,
    });
    if (error) return { ok: false, message: error.message };
  } else if (u.kind === 'party') {
    if (!u.deal_id) return { ok: false, message: 'This update has no deal to add them to.' };
    const e = await saveDealParty(workspaceId, u.deal_id, {
      role: (str(p.role) ?? 'other') as Parameters<typeof saveDealParty>[2]['role'],
      vendor_id: p.vendor_id ? Number(p.vendor_id) : null, buyer_id: null, user_id: null,
      name: str(p.name), company: str(p.company), email: str(p.email), phone: str(p.phone),
    });
    if (e) return { ok: false, message: e };
  } else if (u.kind === 'date') {
    const field = str(p.field) as 'close_date' | 'ctc_target' | 'option_ends_on' | 'emd_received_at' | null;
    const value = str(p.value);
    if (!field || !value || !['close_date', 'ctc_target', 'option_ends_on', 'emd_received_at'].includes(field)) return { ok: false, message: 'Nothing to set.' };
    const patch: Partial<Record<NonNullable<typeof field>, string>> = { [field]: value };
    const { error } = await supabase.from('transactions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', u.transaction_id);
    if (error) return { ok: false, message: error.message };
    // The board, the calendar and the countdown read the deal's own close date.
    if (field === 'close_date' && u.deal_id) await supabase.from('deals').update({ close_date: value }).eq('id', u.deal_id);
  }
  return mark(u, 'applied', me);
}

export const dismissLaneUpdate = (u: LaneUpdate, me: string | null) => mark(u, 'dismissed', me);

/** Reverse something Lane applied on its own. */
export async function undoLaneUpdate(u: LaneUpdate, me: string | null): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const p = (u.payload ?? {}) as P;
  if (u.kind === 'tick') {
    const r = await setTcTick(u.transaction_id, 'checklist', String(p.item_id), false, me);
    if (!r.ok) return r;
  } else if (u.kind === 'task_done') {
    const { error } = await supabase.from('tasks').update({ done: false, completed_at: null }).eq('id', Number(p.task_id));
    if (error) return { ok: false, message: error.message };
  }
  return mark(u, 'undone', me);
}

/** "Catch Lane up": read this file now rather than on the next ten-minute run. */
export async function catchLaneUp(transactionId: number): Promise<{ ok: boolean; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('lane-listen', { body: { action: 'listen', transaction_id: transactionId } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { heard?: number; updates?: number; applied?: number; skipped?: string };
  if (r.skipped) return { ok: true, message: r.skipped === 'deal not live' ? 'This deal is not live, so Lane is not listening.' : 'Lane just read this file.' };
  if (!r.updates) return { ok: true, message: r.heard ? `Lane read ${r.heard} new message${r.heard === 1 ? '' : 's'} — nothing to change.` : 'Nothing new on this file since Lane last read it.' };
  return { ok: true, message: `Lane: ${r.applied ?? 0} updated, ${(r.updates ?? 0) - (r.applied ?? 0)} to review.` };
}
