/**
 * POST /docs-remind — the Clozr Docs clock. pg_cron calls it every 15 minutes
 * (migration 112, docs_remind_kick) with the service-role key.
 *
 *   1. Expiry: a sent contract past `expires_at` becomes `expired`, and its
 *      owner is told. Nothing can be signed on it afterwards (esign already
 *      refused; now the list and the deal say so too).
 *   2. Reminders: each unsigned signer whose turn it is gets a nudge by the
 *      contract's `reminder_policy` (default: 1 day after sending, then every
 *      2 days, at most 10), only between 8am and 8pm Central, and never to
 *      cc or viewers. Every nudge is an audit event. A recipient whose
 *      delivery is sms or both gets the nudge by text (migration 114,
 *      docs-flow deliverLinks), inside the same quiet hours.
 *   3. A heads-up to the sender when a contract expires within 24 hours.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL (for signing links).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, HARDENING, isServiceCaller } from '../_shared/security.ts';
import { type Any, loadCompany, logContractFeed, logEvent } from '../_shared/docs.ts';
import { deliverLinks } from '../_shared/docs-flow.ts';
import { inSendingHours, pendingApprovals, reminderDue, turn } from '../_shared/signing-order.ts';
import { publishContract } from '../_shared/contract-webhooks.ts';
import { wantsEmail } from '../_shared/docs-people.ts';
import { BLACKLIST_UNREAD } from '../../../lib/blacklist.ts';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...HARDENING, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  if (!(await isServiceCaller(admin, bearerOf(req)))) return json({ error: 'service only' }, 401);
  const origin = String(Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com');
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const out = { expired: 0, reminded: 0, warned: 0, errors: [] as string[] };

  const { data: open, error } = await admin.from('contracts')
    .select('id, workspace_id, name, status, expires_at, sent_at, approval_requested_at, message, signing_order_mode, reminder_policy, created_by, deal_id, seller_id, buyer_id, last_event, ref_number, kind, provider')
    .eq('provider', 'clozr').in('status', ['sent', 'viewed', 'awaiting_approval']).is('deleted_at', null).limit(500);
  if (error) return json({ error: error.message }, 500);

  const companies = new Map<number, Awaited<ReturnType<typeof loadCompany>>['company']>();
  const companyOf = async (ws: number) => {
    if (!companies.has(ws)) companies.set(ws, (await loadCompany(admin, ws)).company);
    return companies.get(ws)!;
  };

  for (const row of (open ?? []) as Any[]) {
    try {
      // ---- expiry
      if (row.expires_at && Date.parse(row.expires_at) < now) {
        await admin.from('contracts').update({ status: 'expired', expired_at: nowIso, last_event: { status: 'expired', source: 'docs-remind', at: nowIso } }).eq('id', row.id);
        await logEvent(admin, row, 'expired', { expires_at: row.expires_at });
        publishContract(admin, row, 'contract.expired');
        await logContractFeed(admin, row, `${row.name} expired unsigned`, 'Send a new one from the contracts card if the deal is still on.');
        if (row.created_by) {
          await admin.from('notifications').insert({ workspace_id: row.workspace_id, user_id: row.created_by, category: 'Contracts', title: `${row.name} expired unsigned`.slice(0, 120), body: 'Nobody can sign it now. Send a new one if the deal is still on.' });
        }
        out.expired++;
        continue;
      }
      // ---- heads-up a day before expiry (once)
      if (row.expires_at && Date.parse(row.expires_at) - now < 864e5 && !(row.last_event?.warned_expiry) && row.created_by) {
        await admin.from('notifications').insert({ workspace_id: row.workspace_id, user_id: row.created_by, category: 'Contracts', title: `${row.name} expires within a day`.slice(0, 120), body: 'Still waiting on a signature. Remind them, or extend it with a new send.' });
        await admin.from('contracts').update({ last_event: { ...(row.last_event ?? {}), warned_expiry: nowIso } }).eq('id', row.id);
        await logEvent(admin, row, 'expiry_warning', { expires_at: row.expires_at });
        // PandaDoc also warns the people who still have to sign. Not while it waits on an
        // internal approval: those signers have not been sent a link yet.
        if (row.status !== 'awaiting_approval') try {
          const { data: waiting } = await admin.from('contract_signers').select('id, name, email, status, recipient_type, token, sort').eq('contract_id', row.id);
          const company = await companyOf(row.workspace_id);
          const { esc, sendTracked } = await import('../_shared/parity/notify.ts');
          // Only whoever holds a live link now (their turn): later signers in a sequential order have not been sent one.
          for (const w of turn(waiting ?? [], row.signing_order_mode).filter((x) => x.email)) {
            const url = `${origin.replace(/\/$/, '')}/sign/?t=${w.token}`;
            await sendTracked(admin, row, { to: w.email, kind: 'expiring', signerId: w.id, replyTo: company.email || null,
              subject: `Expires tomorrow: ${row.name}`,
              html: `<p>Hi ${esc(String(w.name ?? '').split(' ')[0] || 'there')},</p><p><strong>${esc(row.name)}</strong> expires within 24 hours.</p><p><a href="${esc(url)}">Review and sign</a></p>`,
              text: `${row.name} expires within 24 hours. ${url}` });
          }
        } catch (e) { console.error('expiry warning mail', (e as Error).message); }
        out.warned++;
      }
      // ---- reminders
      if (!inSendingHours(new Date(now))) continue;
      const { data: signers } = await admin.from('contract_signers')
        .select('id, role, label, name, email, phone, delivery, seller_id, buyer_id, vendor_id, status, sort, recipient_type, token, signed_at, filled_at, approved_at, last_reminded_at, reminder_count')
        .eq('contract_id', row.id).order('sort');
      const all = (signers ?? []) as Any[];
      // In order, a turn starts when the previous signer signed; in parallel, when it was sent.
      // A filler finishing (filled_at) or an approver approving also starts the next turn.
      const lastSigned = all.flatMap((s) => [s.signed_at, s.filled_at, s.approved_at]).filter(Boolean).map(String).sort().pop() ?? null;
      const since = row.signing_order_mode === 'sequential' && lastSigned ? lastSigned : (row.sent_at ?? row.approval_requested_at);
      const approving = row.status === 'awaiting_approval';
      // Waiting on an internal approval: nudge the approvers, not the signers.
      const pool = approving ? pendingApprovals(all) : turn(all, row.signing_order_mode);
      const due = pool.filter((s) => (s.email || s.phone) && reminderDue(row.reminder_policy, since, s.last_reminded_at, Number(s.reminder_count ?? 0), now));
      if (!due.length) continue;
      const company = await companyOf(row.workspace_id);
      const d = await deliverLinks(admin, row, due, { company, origin, who: {}, senderId: row.created_by ?? null }, { reminder: true, approve: approving });
      const sent = d.emailed + d.texted;
      // A text held because the blacklist could not be read reached nobody: a text-only signer is not counted as reminded, so the next run tries again.
      const held = new Set(d.failed.filter((f) => f.reason === BLACKLIST_UNREAD).map((f) => f.id));
      for (const s of due) if (!held.has(s.id) || wantsEmail(s)) await admin.from('contract_signers').update({ last_reminded_at: nowIso, reminder_count: Number(s.reminder_count ?? 0) + 1 }).eq('id', s.id);
      await logEvent(admin, row, 'reminded', { to: due.map((s) => s.label || s.role), emailed: d.emailed, texted: d.texted, ...(d.failed.length ? { failed: d.failed } : {}), automatic: true });
      out.reminded += sent;
    } catch (e) {
      out.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return json({ ok: true, ...out, checked: (open ?? []).length });
});
