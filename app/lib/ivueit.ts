// iVueit → photos on the deal.
//
// A person orders from Files & photos (deal sheet, TC file); a local Vuer
// shoots the house and the ivueit function copies the photos onto the deal.
// The key and secret stay in workspace_integration_secrets: this file saves
// them (Settings → Integrations) and asks the function to do the rest.

import { supabase } from './supabase';

export type PhotoOrderRow = {
  id: number; deal_id: number; vue_id: string | null;
  status: 'ordered' | 'completed' | 'canceled' | 'failed';
  address: string | null; notes: string | null; urgent: boolean;
  photo_count: number; cost: number | null; error: string | null;
  created_at: string; checked_at: string | null; completed_at: string | null;
};
export type IvueitTemplate = { id: string; name: string; description: string; cost: number | null; slaHours: number | null; minutes: number | null };
export type IvueitStatus = {
  connected: boolean; staging: boolean; template_id: string | null; templates: IvueitTemplate[]; problem: string | null;
  address: string; address_ok: boolean; orders: PhotoOrderRow[];
};
export type IvueitSettings = { connected: boolean; base_url: string | null; template_id: string | null };

type Fail = { ok: false; message: string };

async function call<T>(workspaceId: number, body: Record<string, unknown>): Promise<({ ok: true } & T) | Fail> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('ivueit', { body: { workspace_id: workspaceId, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  return { ...(data as T), ok: true };
}

/** This deal's orders, newest first. No iVueit call: a plain read. */
export async function listPhotoOrders(dealId: number): Promise<PhotoOrderRow[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('photo_orders')
    .select('id, deal_id, vue_id, status, address, notes, urgent, photo_count, cost, error, created_at, checked_at, completed_at')
    .eq('deal_id', dealId).order('created_at', { ascending: false }).limit(10);
  return (data ?? []) as PhotoOrderRow[];
}

export const ivueitStatus = (ws: number, dealId: number) => call<IvueitStatus>(ws, { action: 'status', deal_id: dealId });
export const orderPhotos = (ws: number, dealId: number, o: { templateId?: string | null; notes?: string; urgent?: boolean; again?: boolean }) =>
  call<{ order_id: number; orders: PhotoOrderRow[] }>(ws, { action: 'order', deal_id: dealId, template_id: o.templateId || null, notes: o.notes ?? '', urgent: !!o.urgent, again: !!o.again });
export const checkPhotoOrder = (ws: number, orderId: number) => call<{ status: string; photos: number }>(ws, { action: 'check', order_id: orderId });
export const cancelPhotoOrder = (ws: number, orderId: number) => call<object>(ws, { action: 'cancel', order_id: orderId });
export const setupIvueit = (ws: number) =>
  call<{ templates: IvueitTemplate[]; template_id: string | null; webhook: string; staging: boolean }>(ws, { action: 'setup' });

export async function ivueitSettings(workspaceId: number): Promise<IvueitSettings | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('ivueit_settings', { p_workspace_id: workspaceId });
  return error ? null : (data as IvueitSettings);
}

/** Key and secret together ('' disconnects); null leaves a field as saved. */
export async function saveIvueit(workspaceId: number, v: { key?: string | null; secret?: string | null; baseUrl?: string | null; templateId?: string | null }): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('set_ivueit_keys', {
    p_workspace_id: workspaceId, p_key: v.key ?? null, p_secret: v.secret ?? null,
    p_base_url: v.baseUrl ?? null, p_template_id: v.templateId ?? null,
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** "Waiting on a Vuer", "32 photos in", for the order's line. */
export function orderLine(o: PhotoOrderRow, now = Date.now()): string {
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
  if (o.status === 'completed') return `${o.photo_count} photo${o.photo_count === 1 ? '' : 's'} in · ${day(o.completed_at)}`;
  if (o.status === 'canceled') return `Canceled · ordered ${day(o.created_at)}`;
  if (o.status === 'failed') return o.error || 'The order did not go through.';
  const hours = Math.max(0, Math.round((now - new Date(o.created_at).getTime()) / 3_600_000));
  return `Ordered ${day(o.created_at)}${o.urgent ? ' · rush' : ''} · waiting on a Vuer${hours >= 1 ? ` (${hours}h)` : ''}`;
}
