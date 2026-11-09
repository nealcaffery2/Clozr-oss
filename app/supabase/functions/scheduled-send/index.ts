/**
 * POST /scheduled-send. Sends due scheduled texts (migration 367) and emails (373).
 *
 * pg_cron calls scheduled_kick() every minute while a row is due, with the
 * service-role key. scheduled_claim hands over the due rows (for update skip
 * locked), each goes out through textRecipient, the same path action-plan
 * texts take: carrier wording, the blacklist, Talkr's own opt-out and quiet
 * hours. Quiet hours push the row 30 minutes; anything else that fails is
 * written on the row as `error` so the thread shows it.
 *
 * A due email goes to google-sync send_email with as_user_id = the row's
 * user, so it is that rep's own Gmail send: the mailbox guard, read receipts
 * and the communications row are the same ones a Send now gets.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { isServiceCaller, jsonWith } from '../_shared/security.ts';
import { textRecipient } from '../_shared/docs-flow.ts';
import { slopFindings, slopReport } from '../_shared/no-ai-slop.ts';
import { expandCampaigns } from './expand.ts';
import { alertSendFailure } from '../_shared/send-alert.ts';
import { appPath } from '../_shared/app-paths.ts';

const json = jsonWith({});

type Row = {
  id: number; workspace_id: number; user_id: string; seller_id: number | null; buyer_id: number | null;
  phone: string; from_phone_number_id: string | null; body: string; media: unknown; send_at: string;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!(await isServiceCaller(admin, bearer))) return json({ error: 'service role only' }, 403);

  // Bulk campaigns first (migration 368): due batches become scheduled rows, which the claim below may already pick up.
  const expanded = await expandCampaigns(admin);
  const { data, error } = await admin.rpc('scheduled_claim', { p_limit: 20 });
  if (error) return json({ error: error.message }, 500);
  const rows = (data ?? []) as Row[];
  const tally = { sent: 0, waited: 0, failed: 0 };
  for (const row of rows) {
    try {
      await one(admin, row, tally);
    } catch (err) {
      tally.failed++;
      const why = err instanceof Error ? err.message : String(err);
      await mark(admin, row.id, { status: 'error', error: why });
      await alertFailed(admin, row, 'text', why);
    }
  }
  const mail = await dueEmails(admin, bearer);
  return json({ ok: true, ...tally, claimed: rows.length, campaigns: expanded, emails: mail });
});

type EmailRow = {
  id: number; workspace_id: number; user_id: string; seller_id: number | null; buyer_id: number | null;
  to: string; cc: string | null; bcc: string | null; subject: string; html: string; attachments: unknown; send_at: string;
};

async function dueEmails(admin: SupabaseClient, bearer: string) {
  const { data, error } = await admin.rpc('scheduled_email_claim', { p_limit: 20 });
  if (error) { console.error('scheduled_email_claim', error.message); return { claimed: 0, sent: 0, failed: 0 }; }
  const rows = (data ?? []) as EmailRow[];
  const tally = { claimed: rows.length, sent: 0, failed: 0 };
  const url = `${Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '')}/functions/v1/google-sync`;
  const stamp = (id: number, patch: Record<string, unknown>) =>
    admin.from('scheduled_emails').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  for (const row of rows) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          action: 'send_email', as_user_id: row.user_id, workspace_id: row.workspace_id,
          to: row.to, cc: row.cc ?? undefined, bcc: row.bcc ?? undefined, subject: row.subject, body_html: row.html,
          attachments: Array.isArray(row.attachments) && row.attachments.length ? row.attachments : undefined,
          seller_id: row.seller_id, buyer_id: row.buyer_id,
        }),
      });
      const r = await res.json().catch(() => ({})) as { ok?: boolean; connected?: boolean; message?: string; error?: string; communication_id?: number | null };
      if (res.ok && r.ok) {
        tally.sent++;
        await stamp(row.id, { status: 'sent', sent_communication_id: r.communication_id ?? null, error: null });
      } else {
        tally.failed++;
        const why = r.connected === false ? 'Gmail is not connected for the rep who scheduled it' : r.message ?? r.error ?? `google-sync answered ${res.status}`;
        await stamp(row.id, { status: 'error', error: why });
        await alertFailed(admin, row, 'email', why);
      }
    } catch (err) {
      tally.failed++;
      const why = err instanceof Error ? err.message : String(err);
      await stamp(row.id, { status: 'error', error: why });
      await alertFailed(admin, row, 'email', why);
    }
  }
  return tally;
}

async function one(admin: SupabaseClient, row: Row, tally: { sent: number; waited: number; failed: number }) {
  const slop = slopFindings(row.body);
  if (slop.length) {
    tally.failed++;
    await mark(admin, row.id, { status: 'error', error: `Reword it: ${slopReport(slop)}` });
    await alertFailed(admin, row, 'text', `Reword it: ${slopReport(slop)}`);
    return;
  }
  // `sending` before the send: scheduled_claim hands out `scheduled` rows only, so a tick killed
  // between Talkr accepting the text and the `sent` write (wall clock, OOM, a redeploy) does not
  // get the row back in 10 minutes and text the person again. A failed stamp sends nothing; the
  // claim lapses and the row is tried again.
  const { error: stamp } = await mark(admin, row.id, { status: 'sending' });
  if (stamp) {
    console.error('scheduled-send', row.id, `could not mark it sending; left claimed: ${stamp.message}`);
    tally.waited++;
    return;
  }
  // ponytail: media is kept on the row but not sent; textRecipient has no MMS path yet.
  const sent = await textRecipient(admin, { workspace_id: row.workspace_id, deal_id: null, created_by: row.user_id },
    { phone: row.phone, seller_id: row.seller_id, buyer_id: row.buyer_id }, row.body, row.user_id,
    { fromPhoneNumberId: row.from_phone_number_id, contractsLine: false });
  if (sent.ok) {
    tally.sent++;
    await closeSent(admin, row.id, { status: 'sent', sent_communication_id: sent.communication_id ?? null, error: null });
    return;
  }
  if (sent.reason === 'quiet hours') {
    tally.waited++;
    await mark(admin, row.id, { status: 'scheduled', claimed_at: null, send_at: new Date(Date.now() + 30 * 60_000).toISOString(), error: 'Quiet hours; trying again in 30 minutes' });
    return;
  }
  tally.failed++;
  await mark(admin, row.id, { status: 'error', error: sent.reason });
  await alertFailed(admin, row, 'text', sent.reason);
}

/** One alert per rep per hour for their scheduled texts, another for their emails. */
function alertFailed(admin: SupabaseClient, row: { workspace_id: number; user_id: string; seller_id: number | null; buyer_id: number | null }, what: 'text' | 'email', why: string) {
  return alertSendFailure(admin, {
    ws: row.workspace_id, key: `scheduled_${what}:${row.user_id}`, title: `A scheduled ${what} did not send`,
    reason: `Why: ${why}.`, path: row.buyer_id ? appPath.buyer(row.buyer_id) : appPath.seller(row.seller_id), place: 'the record',
    sellerId: row.seller_id, buyerId: row.buyer_id,
  });
}

function mark(admin: SupabaseClient, id: number, patch: Record<string, unknown>) {
  return admin.from('scheduled_messages').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
}

/**
 * A sent row's `sent` write, tried three times (plan-tick's closeSent). If it
 * never lands the row stays `sending`, which the claim never hands out, so
 * the text does not go out twice; the log says so for a person to close it.
 */
async function closeSent(admin: SupabaseClient, id: number, patch: Record<string, unknown>): Promise<boolean> {
  for (const ms of [0, 300, 1000]) {
    try {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      const { error } = await mark(admin, id, patch);
      if (!error) return true;
    } catch { /* tried again */ }
  }
  console.error('scheduled-send', id, 'SENT BUT NOT RECORDED: the sent write failed three times; left as sending so it is not sent again');
  return false;
}
