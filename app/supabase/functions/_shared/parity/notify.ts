// Notices PandaDoc sends that Clozr did not (void, decline, correction,
// expiry extended), plus delivery tracking for every message the docs
// module sends. Each send is recorded in contract_deliveries and tagged with
// contract_id / signer_id so the Resend webhook (docs-delivery-webhook) can
// attach delivered / opened / bounced events back to the right recipient.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { sendResend, transactionalFrom } from '../resend.ts';
import type { Company } from '../docs.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type DeliveryKind = 'invite' | 'reminder' | 'turn' | 'code' | 'completed' | 'voided' | 'declined' | 'expiring' | 'corrected';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Send one tracked email. Returns the Resend id or null. */
export async function sendTracked(
  admin: SupabaseClient,
  row: { id: number; workspace_id: number },
  p: { to: string; subject: string; html: string; text?: string; kind: DeliveryKind; signerId?: number | null; cc?: string[]; replyTo?: string | null },
): Promise<string | null> {
  const from = transactionalFrom();
  if (!from) return null;
  const res = await sendResend({
    to: p.to, from: from.from, subject: p.subject, html: p.html, text: p.text, cc: p.cc, replyTo: p.replyTo ?? null,
    tags: { kind: `docs_${p.kind}`, contract_id: String(row.id), ...(p.signerId ? { signer_id: String(p.signerId) } : {}) },
    idempotencyKey: `docs-${row.id}-${p.kind}-${p.signerId ?? 'x'}-${p.to}-${new Date().toISOString().slice(0, 16)}`,
  });
  await admin.from('contract_deliveries').insert({
    workspace_id: row.workspace_id, contract_id: row.id, signer_id: p.signerId ?? null,
    channel: 'email', kind: p.kind, provider: 'resend', provider_message_id: res?.id ?? null,
    to_address: p.to, status: res ? 'sent' : 'failed', error: res ? null : 'resend rejected the message',
  });
  if (p.signerId) {
    await admin.from('contract_signers').update({ last_delivery_status: res ? 'sent' : 'failed', last_delivery_at: new Date().toISOString() }).eq('id', p.signerId);
  }
  return res?.id ?? null;
}

/** Record an SMS the existing docs-flow textRecipient already sent (it logs to communications). */
export async function recordSms(
  admin: SupabaseClient, row: { id: number; workspace_id: number }, signerId: number, to: string, kind: DeliveryKind,
  result: { ok: boolean; communication_id?: number | null; reason?: string },
) {
  await admin.from('contract_deliveries').insert({
    workspace_id: row.workspace_id, contract_id: row.id, signer_id: signerId, channel: 'sms', kind, provider: 'talkr',
    provider_message_id: result.communication_id ? `comm:${result.communication_id}` : null,
    to_address: to, status: result.ok ? 'sent' : 'failed', error: result.ok ? null : (result.reason ?? 'failed'),
  });
}

function shell(company: Company, title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#2c2c2c">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e3e6ea;border-radius:10px">
<tr><td style="padding:22px 28px;border-bottom:3px solid #F26B1D;font-weight:700;font-size:16px">${esc(company.name || 'Acme Homes')}</td></tr>
<tr><td style="padding:26px 28px"><h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${body}</td></tr>
<tr><td style="padding:16px 28px;color:#6b7280;font-size:12px;border-top:1px solid #e3e6ea">${esc(company.legal || company.name || '')}${company.address ? ' · ' + esc(company.address) : ''}${company.phone ? ' · ' + esc(company.phone) : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Everyone who had a live link learns the document was voided. PandaDoc does this; Clozr did not. */
export async function notifyVoided(admin: SupabaseClient, row: Any, company: Company, reason: string | null) {
  const { data: rs } = await admin.from('contract_signers').select('id, name, email, status, recipient_type').eq('contract_id', row.id);
  let n = 0;
  for (const r of rs ?? []) {
    if (!r.email || r.status === 'delegated') continue;
    const html = shell(company, `${row.name} was voided`, `<p>Hi ${esc(String(r.name ?? '').split(' ')[0] || 'there')},</p>
<p><strong>${esc(row.name)}</strong> has been voided by ${esc(company.name || 'the sender')} and can no longer be viewed or signed.</p>
${reason ? `<p style="background:#f4f6f8;padding:12px;border-radius:6px"><strong>Reason:</strong> ${esc(reason)}</p>` : ''}
<p>If you have questions, reply to this email.</p>`);
    if (await sendTracked(admin, row, { to: r.email, subject: `Voided: ${row.name}`, html, text: `${row.name} was voided. ${reason ?? ''}`, kind: 'voided', signerId: r.id, replyTo: company.email || null })) n++;
  }
  return n;
}

/** The sender (and the TC on the deal) hears about a decline right away. */
export async function notifyDeclined(admin: SupabaseClient, row: Any, company: Company, signer: Any, reason: string | null, appOrigin: string) {
  const to = new Set<string>();
  if (row.created_by) {
    const { data: p } = await admin.from('profiles').select('email').eq('id', row.created_by).maybeSingle();
    if (p?.email) to.add(String(p.email).toLowerCase());
  }
  if (row.deal_id) {
    const { data: d } = await admin.from('deals').select('tc_rep_id, owner_id, dispo_rep_id').eq('id', row.deal_id).maybeSingle();
    const ids = [d?.tc_rep_id, d?.owner_id, d?.dispo_rep_id].filter(Boolean);
    if (ids.length) {
      const { data: ps } = await admin.from('profiles').select('email').in('id', ids);
      for (const p of ps ?? []) if (p.email) to.add(String(p.email).toLowerCase());
    }
  }
  const link = `${appOrigin.replace(/\/$/, '')}/docs/?contract=${row.id}`;
  for (const addr of to) {
    const html = shell(company, `${signer.label || signer.role} declined ${row.name}`, `<p><strong>${esc(signer.name || signer.email)}</strong> declined to sign.</p>
${reason ? `<p style="background:#fff4ed;padding:12px;border-radius:6px"><strong>Reason:</strong> ${esc(reason)}</p>` : ''}
<p><a href="${esc(link)}" style="background:#F26B1D;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Open in Clozr</a></p>`);
    await sendTracked(admin, row, { to: addr, subject: `Declined: ${row.name}`, html, kind: 'declined' });
  }
  return to.size;
}
