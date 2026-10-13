// Contract events out to the workspace's webhook subscriptions (migration 41's
// webhook_subscriptions / webhook_deliveries). The functions call
// publishContract right where they log the matching contract_events row; the
// database signs, sends and retries (webhook_enqueue → pg_net → webhook_tick).
//
// Publishing never holds up or breaks the thing that happened: the call is not
// awaited, runs after the response when the runtime allows (waitUntil), and a
// failure only reaches the log.
//
// PandaDoc contracts have no such call site; the row trigger in migration 116
// publishes theirs with the same payload keys.
/** Just what publishing needs of the service-role client (keeps this file importable from the app's tests). */
type Admin = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }> };

export const CONTRACT_EVENTS = [
  'contract.sent', 'contract.viewed', 'contract.signed', 'contract.completed',
  'contract.declined', 'contract.expired', 'contract.voided', 'contract.extracted',
] as const;
export type ContractEvent = (typeof CONTRACT_EVENTS)[number];

export type WebhookSigner = { name?: string | null; email?: string | null; role?: string | null; label?: string | null };
export type ContractExtra = {
  signer?: WebhookSigner | null;
  reason?: string | null;
  /** contract.extracted: how many terms were read, and which. */
  fields?: string[] | null;
  occurredAt?: string | null;
};

const APP = 'https://your-clozr-site.example.com';

/**
 * The payload one contract event carries. Flat, like every other CLOZR
 * webhook; webhook_enqueue adds `event`, `occurred_at` (when not given here)
 * and `workspace_id`, and drops nulls. No PDF link: deliveries are stored and
 * retried for days, longer than any signed URL lives.
 */
export function contractWebhookPayload(
  row: Record<string, unknown>, event: ContractEvent, extra: ContractExtra = {}, appUrl = APP,
): Record<string, unknown> {
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const s = extra.signer;
  const dealId = num(row.deal_id);
  return {
    record_type: 'contract',
    record_id: num(row.id),
    id: num(row.id),
    contract_id: num(row.id),
    ref_number: (row.ref_number as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    contract_name: (row.name as string | null) ?? null,
    kind: (row.kind as string | null) ?? null,
    status: statusFor(event, (row.status as string | null) ?? null),
    provider: (row.provider as string | null) ?? 'clozr',
    deal_id: dealId,
    seller_id: num(row.seller_id),
    buyer_id: num(row.buyer_id),
    signer: s && (s.name || s.email) ? { name: s.name ?? null, email: s.email ?? null, role: s.label || s.role || null } : null,
    reason: extra.reason ?? null,
    fields: extra.fields?.length ? extra.fields : null,
    ...(extra.occurredAt ? { occurred_at: extra.occurredAt } : {}),
    url: dealId ? `${appUrl.replace(/\/$/, '')}/app?deal=${dealId}` : null,
  };
}

/** The row in hand is often read before the update that the event is about. */
function statusFor(event: ContractEvent, current: string | null): string | null {
  switch (event) {
    case 'contract.sent': return current === 'draft' || !current ? 'sent' : current;
    case 'contract.completed': return 'completed';
    case 'contract.declined': return 'declined';
    case 'contract.expired': return 'expired';
    case 'contract.voided': return 'voided';
    case 'contract.viewed': return current === 'sent' ? 'viewed' : current;
    default: return current;
  }
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** Fire and forget. Safe to call without await from any function holding the service-role client. */
export function publishContract(admin: Admin, row: Record<string, unknown>, event: ContractEvent, extra: ContractExtra = {}): void {
  if (!row?.workspace_id || !row?.id) return;
  const p = (async () => {
    try {
      const app = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get('APP_URL') || APP;
      const { error } = await admin.rpc('webhook_enqueue', {
        p_workspace_id: Number(row.workspace_id), p_event: event, p_payload: contractWebhookPayload(row, event, extra, app),
      });
      if (error) console.error('contract webhook', event, row.id, error.message);
    } catch (e) {
      console.error('contract webhook', event, row.id, e instanceof Error ? e.message : String(e));
    }
  })();
  try { if (typeof EdgeRuntime !== 'undefined') EdgeRuntime?.waitUntil(p); } catch { /* the promise still runs */ }
}
