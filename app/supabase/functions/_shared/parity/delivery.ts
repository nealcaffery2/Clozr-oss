/**
 * Per-recipient delivery tracking for document emails (PandaDoc shows
 * "delivered / opened / bounced" per recipient). The deliverability
 * function's Resend webhook (already verified with RESEND_WEBHOOK_SECRET)
 * hands every event here first; one webhook covers all of CLOZR's mail.
 *
 * Messages are matched by provider_message_id (sendTracked stores it) or by
 * the contract_id / signer_id tags docs emails carry. A hard bounce on a
 * signer logs `email_bounced` in the audit trail and posts a feed item.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { logContractFeed, logEvent } from '../docs.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const STATUS: Record<string, string> = {
  'email.sent': 'sent', 'email.delivered': 'delivered', 'email.opened': 'opened', 'email.clicked': 'clicked',
  'email.bounced': 'bounced', 'email.failed': 'failed', 'email.complained': 'complained', 'email.delivery_delayed': 'sent',
};
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, failed: 5, bounced: 6, complained: 7 };

/** Returns true when the event belonged to a document email (recorded), false otherwise. */
export async function recordDocsDelivery(admin: SupabaseClient, evt: { type: string; created_at: string; data: Any }): Promise<boolean> {
  const status = STATUS[evt.type];
  if (!status) return false;
  const msgId = String(evt.data?.email_id ?? '');
  const tags: Record<string, string> = Array.isArray(evt.data?.tags)
    ? Object.fromEntries(evt.data.tags.map((t: Any) => [t.name, t.value]))
    : (evt.data?.tags ?? {});
  let { data: d } = msgId
    ? await admin.from('contract_deliveries').select('*').eq('provider', 'resend').eq('provider_message_id', msgId).maybeSingle()
    : { data: null };
  if (!d && tags.contract_id) {
    const { data: c } = await admin.from('contracts').select('id, workspace_id').eq('id', Number(tags.contract_id)).maybeSingle();
    if (!c) return false;
    const { data: ins } = await admin.from('contract_deliveries').insert({
      workspace_id: c.workspace_id, contract_id: c.id, signer_id: tags.signer_id ? Number(tags.signer_id) : null, channel: 'email',
      kind: String(tags.kind ?? 'invite').replace(/^docs_/, '').replace(/^signing_reminder$/, 'reminder').replace(/^signing_completed$/, 'completed').replace(/^signing(_approval)?$/, 'invite') as Any,
      provider: 'resend', provider_message_id: msgId || null, to_address: Array.isArray(evt.data?.to) ? evt.data.to[0] : null, status: 'sent',
    }).select('*').single();
    d = ins;
  }
  if (!d) return false;

  const events = [...((d.events as Any[]) ?? []), { type: evt.type, at: evt.created_at, bounce: evt.data?.bounce?.type ?? null }].slice(-50);
  const next = RANK[status] >= RANK[d.status] ? status : d.status;
  await admin.from('contract_deliveries').update({ status: next, events, error: evt.data?.bounce?.message ?? d.error ?? null }).eq('id', d.id);
  if (d.signer_id) await admin.from('contract_signers').update({ last_delivery_status: next, last_delivery_at: evt.created_at }).eq('id', d.signer_id);

  if (status === 'bounced' || status === 'complained') {
    const { data: row } = await admin.from('contracts').select('id, workspace_id, name, deal_id, seller_id, buyer_id').eq('id', d.contract_id).single();
    if (!row) return true;
    const { data: s } = d.signer_id ? await admin.from('contract_signers').select('name, email, label, role').eq('id', d.signer_id).maybeSingle() : { data: null };
    await logEvent(admin, row, status === 'bounced' ? 'email_bounced' : 'email_complained', { to: d.to_address, kind: d.kind, bounce: evt.data?.bounce ?? null });
    await logContractFeed(admin, row, `Email to ${s?.name || d.to_address} ${status}`, `${row.name}: fix the address and resend from the document tracker.`);
  }
  return true;
}
