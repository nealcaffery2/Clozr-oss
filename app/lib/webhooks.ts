// Zapier & webhooks — outbound subscriptions, the inbound flat contract's
// samples, and the Jotform backfill. Contract: docs/webhooks.md.

import type { WebhookDeliveryRow, WebhookSubscriptionRow } from './database.types';
import { supabase } from './supabase';

export type { WebhookDeliveryRow, WebhookSubscriptionRow };
type Result<T> = { ok: true; data: T } | { ok: false; message: string };

/** Mirrors public.webhook_events() (migration 41; contract events widened in 116). */
export const WEBHOOK_EVENTS: { name: string; label: string }[] = [
  { name: 'seller.created', label: 'Seller lead created' },
  { name: 'seller.stage_changed', label: 'Seller stage changed' },
  { name: 'deal.created', label: 'Deal created' },
  { name: 'deal.stage_changed', label: 'Deal stage changed (under contract, closed…)' },
  { name: 'buyer.created', label: 'Buyer created' },
  { name: 'task.completed', label: 'Task completed' },
  { name: 'offer.sent', label: 'Offer sent' },
  { name: 'contract.sent', label: 'Contract sent for signature' },
  { name: 'contract.viewed', label: 'Contract viewed' },
  { name: 'contract.signed', label: 'Contract signed by one signer' },
  { name: 'contract.completed', label: 'Contract fully signed' },
  { name: 'contract.declined', label: 'Contract declined' },
  { name: 'contract.expired', label: 'Contract expired unsigned' },
  { name: 'contract.voided', label: 'Contract voided' },
  { name: 'contract.extracted', label: 'Contract terms read by AI' },
  { name: 'communication.inbound', label: 'Text, email or call received' },
  { name: 'appointment.created', label: 'Appointment created' },
];

/** One copyable sample per inbound event — the flat contract. */
export const INBOUND_SAMPLES: Record<string, Record<string, unknown>> = {
  'lead.create': {
    event: 'lead.create', external_id: 'zap-123', first_name: 'Kara', last_name: 'Mitchell',
    phone: '(210) 555-0136', email: 'kara@example.com', address: '123 Oakview Dr', city: 'San Antonio',
    state: 'TX', zip: '78254', asking_price: 235000, lead_source: 'Facebook ads', tags: 'facebook, hot',
    stage: 'Lead', notes: 'Relocating for work',
  },
  'buyer.create': {
    event: 'buyer.create', external_id: 'zap-456', name: 'Dee Park', company: 'Park Homes LLC',
    phone: '(210) 555-0100', email: 'dee@parkhomes.com', markets: 'Bexar, Comal', max_purchase_price: 250000, tags: 'flipper',
  },
  'note.add': { event: 'note.add', email: 'kara@example.com', subject: 'From Zapier', body: 'Called back, wants an offer Friday' },
  'activity.log': { event: 'activity.log', phone: '(210) 555-0136', subject: 'Visited pricing page' },
  'email.opened': { event: 'email.opened', email: 'kara@example.com', subject: 'Your cash offer for 123 Oakview', occurred_at: '2026-09-13T15:04:00Z' },
  'wholesaler.create': {
    event: 'wholesaler.create', external_id: 'zap-900', company: 'A.B.C Exit Holdings',
    phone: '(575) 555-0165', email: 'abc.acquisitions@example.com', entity_name: 'A.B.C Exit Holdings',
    asking_price: 925000, arv: 1600000, rehab: 300000, occupancy: 'Yes - Occupied by Owner',
    motivation: 'Seller is motivated', property_type: 'Single Family', beds: 3, baths: 2.5, sqft: 3134, year_built: 1976,
  },
};

async function fnError(error: { message: string }): Promise<string> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx) return ((await ctx.json()) as { error?: string }).error ?? error.message;
  } catch { /* keep the transport message */ }
  return error.message;
}

export async function listSubscriptions(workspaceId: number): Promise<WebhookSubscriptionRow[]> {
  if (!supabase) return [];
  // Explicit columns: `secret` is not granted, so select('*') is refused.
  const { data } = await supabase
    .from('webhook_subscriptions')
    .select('id, workspace_id, url, events, active, description, created_by, created_at, last_status, last_error, last_delivered_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  return (data as WebhookSubscriptionRow[]) ?? [];
}

export async function listDeliveries(workspaceId: number): Promise<WebhookDeliveryRow[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from('webhook_deliveries')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(25);
  return (data as WebhookDeliveryRow[]) ?? [];
}

export async function subscribe(workspaceId: number, url: string, events: string[], description: string): Promise<Result<{ id: number; secret: string }>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.rpc('webhook_subscribe', {
    p_workspace_id: workspaceId, p_url: url, p_events: events, p_description: description || null,
  });
  return error ? { ok: false, message: error.message } : { ok: true, data: data as { id: number; secret: string } };
}

export async function setSubscriptionActive(id: number, active: boolean): Promise<Result<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('webhook_subscriptions').update({ active }).eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export async function deleteSubscription(id: number): Promise<Result<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('webhook_subscriptions').delete().eq('id', id);
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export async function sendTest(id: number): Promise<Result<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('webhook_send_test', { p_subscription_id: id });
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

export async function retryDelivery(id: number): Promise<Result<null>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('webhook_retry', { p_delivery_id: id });
  return error ? { ok: false, message: error.message } : { ok: true, data: null };
}

// ---- Jotform backfill --------------------------------------------------------

export type JotformForm = { id: string; title: string; count: number };
export type ImportPage = { created: number; deduped: number; updated?: number; skipped: number; next_offset: number | null };

async function jotformCall<T>(body: Record<string, unknown>): Promise<Result<T>> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('jotform-import', { body });
  if (error) return { ok: false, message: await fnError(error) };
  return { ok: true, data: data as T };
}

export const jotformForms = (workspaceId: number, keyId: number) =>
  jotformCall<{ forms: JotformForm[] }>({ workspace_id: workspaceId, key_id: keyId, action: 'forms' });

export const jotformImportPage = (workspaceId: number, keyId: number, formId: string, offset: number) =>
  jotformCall<ImportPage>({ workspace_id: workspaceId, key_id: keyId, action: 'import', form_id: formId, offset });
