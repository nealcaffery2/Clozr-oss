/**
 * POST /dispo-campaign-tick — sends what dispo campaigns have due (migration 53).
 *
 * Called every minute by pg_cron through dispo_campaign_kick(), with the
 * service-role key as the bearer; nobody else may call it. Idempotent: a
 * message is claimed (queued → sending) before anything goes out, so two
 * overlapping ticks never send it twice.
 *
 * For each due message:
 *   - skipped when the campaign is paused/cancelled, the buyer opted out or was
 *     stopped, or it is a follow-up and the buyer has since replied or offered
 *   - email: Resend on the workspace blast pool when email_provider is
 *     resend (MAIL_FROM_BLASTS / deals.yourcompany.com), else the connected
 *     Gmail pool. A campaign rotates only the launching rep's addresses, and
 *     the send is filed on that rep (communications.rep_id). Each address has
 *     its own warm-up ramp. Consecutive buyers start on the next of that
 *     rep's addresses that still has room. Both go through the
 *     mailbox guard (sending window, daily/hourly caps, spacing, suppressions,
 *     email verification, domain checks) with one-click unsubscribe. An
 *     address that verification refuses is skipped like a suppression: this
 *     message and the buyer's later queued emails are cancelled, not retried.
 *     Reply-To is that address's
 *     rep. A refusal that is only this address's cap tries the next address;
 *     when every address is full the message waits for the soonest next_at.
 *     AgentMail is not on this path.
 *   - SMS: through Talkr as the rep who launched the campaign, with the chosen
 *     from number and MMS media. Talkr trusts this project's tokens, so the
 *     function mints a five-minute token for that rep signed with
 *     TALKR_PARTNER_JWT_SECRET (the same secret Talkr holds as
 *     PARTNER_JWT_SECRET). Without that secret texts stay queued and the
 *     campaign panel offers "Send due texts now" from the browser. Quiet hours
 *     and per-number caps reschedule to the next 9:00 in the campaign's time
 *     zone; an opted-out number stops that buyer's texts.
 *   - rvm (migration 192): a row in rvm_drops at the message's send time, with
 *     the campaign's recording when one was attached, else the script spoken;
 *     the RVM tick sends it and files its own communications row
 *   - ai_call (migration 192): the ai-agent function's deal_call, which rings
 *     the buyer from the workspace's dispo agent with the brief as the call
 *     goal; outside the agent's hours the message waits for them
 *   - every send is written to communications with buyer_id and stamps
 *     deal_buyer_matches.sent_at (dispo_message_sent)
 *
 * Replies: for active SMS recipients it reads their Talkr thread (at most 40
 * per tick, each at most every 5 minutes) and writes inbound texts to
 * communications with buyer_id; the migration's trigger does the rest.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { jsonWith } from '../_shared/security.ts';
import { type Account, SCOPE, accessFor, has, messageIdOf, sendMail, textToHtml } from '../_shared/google.ts';
import { FREE_MAIL, cycleOrder, domainOf, pickReplyTo, repSenderPool } from '../_shared/deliverability-rules.ts';
import { ensureRepBlastSenders, gmailBulkPool, guardSend, guardSendResend, markSendProvider, release, unsubscribeToken, unsubscribeUrl } from '../_shared/mailguard.ts';
import { type EnvLike, blastFrom, sendResend } from '../_shared/resend.ts';
import { resendEnvFor } from '../_shared/workspace-email.ts';
import { intoWindow } from '../_shared/dispo-rules.ts';
import { withOptOut } from '../_shared/sms-compliance.ts';
import { BLACKLIST_MESSAGE, loadBlocked } from '../../../lib/blacklist.ts';
import { outreachItem, type OutreachItem } from '../../../lib/talkr-outreach.ts';
import { postOutreach, tokenCache } from '../_shared/talkr-outreach.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from '../_shared/talkr-binding.ts';
import { loadTalkrConnections } from '../_shared/talkr-connect.ts';

type Any = any;
const json = jsonWith({});
const TALKR_DEFAULT_URL = 'https://talkr.example.com';
const MAX_PER_TICK = 60;
const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

async function talkr(base: string, token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: Any }> {
  try {
    const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: 'unreachable' } };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  // The cron's key (vault clozr_service_role_key) and this runtime's env key can be
  // different issues of the service key; accept exactly either one (migration 193).
  if (!bearer || (bearer !== serviceKey && (await admin.rpc('is_cron_key', { p_key: bearer })).data !== true)) return json({ error: 'service role only' }, 403);
  const started = Date.now();
  const tally = { sent: 0, skipped: 0, rescheduled: 0, failed: 0, held: 0, replies: 0 };

  const { data: due } = await admin.from('dispo_campaign_messages')
    .select('id, workspace_id, campaign_id, recipient_id, buyer_id, channel, kind, subject, body, body_html, media_urls, send_at, only_if_no_reply, attempts')
    .eq('status', 'queued').lte('send_at', new Date().toISOString()).order('send_at').limit(MAX_PER_TICK);

  const campaigns = new Map<number, Any>();
  const recipients = new Map<number, Any>();
  const settings = new Map<number, Any>();
  const accounts = new Map<number, { account: Account | null; access: string | null }>();
  const resendPools = new Map<number, Awaited<ReturnType<typeof ensureRepBlastSenders>>>();
  const resendEnvs = new Map<number, EnvLike>();
  const resendEnv = async (ws: number) => {
    if (!resendEnvs.has(ws)) resendEnvs.set(ws, (await resendEnvFor(admin, ws)).env);
    return resendEnvs.get(ws)!;
  };
  const gmailPools = new Map<number, Awaited<ReturnType<typeof gmailBulkPool>>>();
  const PACE = new Set(['daily_cap', 'hourly_cap', 'gap', 'paused', 'window']);
  // Mailboxes the Gmail sync reads: a blast's Reply-To should be one of them,
  // or the reply never reaches the buyer's record or marks them replied.
  const syncedBoxes = new Map<number, { email: string; user_id: string | null }[]>();
  const syncedFor = async (ws: number) => {
    if (!syncedBoxes.has(ws)) {
      const { data } = await admin.from('google_accounts').select('email, user_id').eq('workspace_id', ws).eq('status', 'active').eq('gmail_read', true);
      syncedBoxes.set(ws, ((data ?? []) as Any[]).map((a) => ({ email: String(a.email ?? ''), user_id: a.user_id ?? null })));
    }
    return syncedBoxes.get(ws)!;
  };
  // Blast emails Talkr cannot see: told to Talkr so a buyer who calls back rings that rep.
  const outreach: { ws: number; item: OutreachItem | null }[] = [];

  const campaignOf = async (id: number) => {
    if (!campaigns.has(id)) campaigns.set(id, (await admin.from('dispo_campaigns').select('*').eq('id', id).maybeSingle()).data);
    return campaigns.get(id);
  };
  const talkrBase = async (ws: number) => {
    if (!settings.has(ws)) settings.set(ws, (await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle()).data?.settings ?? {});
    return String(settings.get(ws)?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  };
  // One partner token per rep per tick (_shared/talkr-outreach.ts mints it).
  const tokenFor = tokenCache(admin);
  const bindingCache = new Map<number, { orgId: string } | null>();
  const orgCache = new Map<string, string | null>();
  const talkrBinding = async (ws: number) => {
    if (bindingCache.has(ws)) return bindingCache.get(ws) ?? null;
    if (!settings.has(ws)) settings.set(ws, (await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle()).data?.settings ?? {});
    const conn = (await loadTalkrConnections(admin, [ws]))[0] ?? null;
    const binding = activeTalkrBinding({ id: ws, settings: settings.get(ws) }, conn);
    bindingCache.set(ws, binding);
    return binding;
  };
  const observedOrg = async (ws: number, token: string) => {
    const key = ws + ':' + token.slice(0, 24);
    if (orgCache.has(key)) return orgCache.get(key) ?? null;
    const base = await talkrBase(ws);
    const org = await readTalkrOrg((path) => talkr(base, token, path));
    orgCache.set(key, org);
    return org;
  };
  const accountFor = async (id: number | null) => {
    if (!id) return { account: null, access: null };
    if (!accounts.has(id)) {
      const { data } = await admin.from('google_accounts').select('id, workspace_id, user_id, email, scopes, calendar_id, status, gmail_send').eq('id', id).maybeSingle();
      const account = data as Account | null;
      accounts.set(id, { account, access: account && account.status === 'active' ? await accessFor(admin, account) : null });
    }
    return accounts.get(id)!;
  };
  const mark = (id: number, patch: Record<string, unknown>) => admin.from('dispo_campaign_messages').update(patch).eq('id', id);
  const reschedule = async (m: Any, at: Date, why: string) => {
    tally.rescheduled++;
    await mark(m.id, { status: 'queued', send_at: at.toISOString(), last_error: why, attempts: (m.attempts ?? 0) + 1 });
  };
  const resendPool = async (ws: number) => {
    if (!resendPools.has(ws)) resendPools.set(ws, await ensureRepBlastSenders(admin, ws, await resendEnv(ws)));
    return resendPools.get(ws)!;
  };
  const gmailPool = async (ws: number) => {
    if (!gmailPools.has(ws)) gmailPools.set(ws, await gmailBulkPool(admin, ws));
    return gmailPools.get(ws)!;
  };

  for (const m of (due ?? []) as Any[]) {
    if (Date.now() - started > 100_000) break;
    // Claim it: only one tick gets past this.
    const { data: claimed } = await admin.from('dispo_campaign_messages').update({ status: 'sending' }).eq('id', m.id).eq('status', 'queued').select('id');
    if (!claimed?.length) continue;
    const c = await campaignOf(m.campaign_id);
    if (!recipients.has(m.recipient_id)) recipients.set(m.recipient_id, (await admin.from('dispo_campaign_recipients').select('*').eq('id', m.recipient_id).maybeSingle()).data);
    const r = recipients.get(m.recipient_id);
    if (!c || !r) { await mark(m.id, { status: 'failed', last_error: 'campaign or recipient is gone' }); tally.failed++; continue; }
    if (c.status === 'paused') { await mark(m.id, { status: 'queued', send_at: new Date(Date.now() + 15 * 60_000).toISOString(), last_error: 'campaign paused' }); tally.held++; continue; }
    if (c.status === 'cancelled') { await mark(m.id, { status: 'cancelled', last_error: 'campaign cancelled' }); tally.skipped++; continue; }
    if (['opted_out', 'stopped'].includes(r.status)) { await mark(m.id, { status: 'skipped', last_error: `buyer ${r.status.replace('_', ' ')}` }); tally.skipped++; continue; }
    if (m.only_if_no_reply && (r.replied_at || r.offered_at || !['active'].includes(r.status))) {
      await mark(m.id, { status: 'skipped', last_error: r.offered_at ? 'buyer made an offer' : 'buyer replied' }); tally.skipped++; continue;
    }
    // A buyer blacklisted after this was queued: cancelled at send time, on
    // either channel. A failed read holds it, since "could not check" is not "clear".
    if (m.buyer_id != null) {
      const gate = await loadBlocked(admin as never, { buyerIds: [m.buyer_id] });
      if (!gate.ok) { await reschedule(m, new Date(Date.now() + 5 * 60_000), gate.message); continue; }
      if (gate.blocked?.buyers.has(m.buyer_id)) {
        await mark(m.id, { status: 'skipped', last_error: BLACKLIST_MESSAGE });
        tally.skipped++; continue;
      }
    }
    if ((m.attempts ?? 0) >= 30) { await mark(m.id, { status: 'failed', last_error: 'gave up after 30 attempts' }); tally.failed++; continue; }
    const tz = c.timezone || 'America/Chicago';
    const nextMorning = () => intoWindow(new Date(Date.now() + 11 * 3_600_000), tz);

    if (m.channel === 'email') {
      if (!r.email) { await mark(m.id, { status: 'failed', last_error: 'buyer has no email' }); tally.failed++; continue; }
      const skipBlocked = async (message: string, why: string) => {
        await mark(m.id, { status: 'skipped', last_error: message });
        await admin.from('dispo_campaign_messages').update({ status: 'cancelled', last_error: why }).eq('recipient_id', r.id).eq('channel', 'email').eq('status', 'queued');
        tally.skipped++;
      };
      const useResend = (c.email_provider ?? 'gmail') === 'resend';
      if (useResend) {
        const env = await resendEnv(m.workspace_id);
        const fromAddr = blastFrom(env);
        const pool = cycleOrder(repSenderPool(await resendPool(m.workspace_id), c.created_by ?? null), m.id);
        if (!pool.length || !fromAddr) { await reschedule(m, new Date(Date.now() + 3_600_000), 'Resend is not configured for this workspace. Set its Resend key and blast sender in Settings, Outbound OS, or RESEND_API_KEY and MAIL_FROM_BLASTS on the project.'); continue; }
        const { account } = await accountFor(c.email_account_id);
        let held: { at: string | null; message: string } | null = null;
        let sentThis = false;
        for (const sender of pool) {
          const claim = await guardSendResend(admin, sender, [r.email], 'bulk');
          if (!claim.ok) {
            if (claim.code === 'suppressed' || claim.code === 'unverified_unsafe') { await skipBlocked(claim.message, claim.code === 'suppressed' ? 'email suppressed' : 'email not safe to send'); sentThis = true; break; }
            if (claim.code === 'domain') {
              await reschedule(m, new Date(Date.now() + 6 * 3_600_000), claim.message);
              sentThis = true;
              break;
            }
            if (PACE.has(claim.code)) {
              if (!held || (claim.next_at && (!held.at || claim.next_at < held.at))) held = { at: claim.next_at, message: claim.message };
              continue;
            }
            await reschedule(m, claim.next_at ? new Date(claim.next_at) : new Date(Date.now() + 3_600_000), claim.message);
            sentThis = true;
            break;
          }
          const link = unsubscribeUrl(await unsubscribeToken({ w: m.workspace_id, e: r.email, a: account?.id }));
          const text = `${m.body}\n\n--\nDon't want these emails? Unsubscribe: ${link}`;
          const html = (m.body_html || textToHtml(m.body)) + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#71717a;margin-top:24px">Don't want these emails? <a href="${esc(link)}" style="color:#71717a">Unsubscribe</a></p>`;
          const display = String(sender.from_name || c.from_name || fromAddr.name || '').replace(/["\r\n<>]/g, '').trim();
          const from = display ? `${display} <${sender.from_email}>` : sender.from_email;
          const replyTo = pickReplyTo(sender, await syncedFor(m.workspace_id), account?.email ?? null);
          const sent = await sendResend({
            to: r.email, subject: m.subject || '(no subject)', html, text, from, replyTo,
            headers: { 'List-Unsubscribe': `<${link}>${replyTo ? `, <mailto:${replyTo}?subject=unsubscribe>` : ''}`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
            tags: { workspace: String(m.workspace_id), campaign: String(c.id), kind: String(m.kind) },
            idempotencyKey: `dispo:${m.id}`,
          }, env);
          if (!sent) { await release(admin, claim.ids); await reschedule(m, new Date(Date.now() + 1_800_000), 'Resend refused that send'); sentThis = true; break; }
          await markSendProvider(admin, claim.ids, sent.id);
          const { data: comm } = await admin.from('communications').upsert({
            workspace_id: m.workspace_id, buyer_id: m.buyer_id, rep_id: sender.user_id, channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(),
            subject: m.subject, body: m.body.slice(0, 20_000), from_email: sender.from_email, to_email: r.email, status: 'sent', source: 'resend', source_id: sent.id,
          }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
          await admin.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: sent.id, p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: null });
          outreach.push({ ws: m.workspace_id, item: outreachItem({ phone: r.phone, userId: sender.user_id ?? c.created_by, channel: 'email', at: new Date(), ref: `email:${m.id}` }) });
          tally.sent++;
          sentThis = true;
          break;
        }
        if (!sentThis && held) await reschedule(m, held.at ? new Date(held.at) : new Date(Date.now() + 3_600_000), held.message);
        continue;
      }
      const pinned = c.email_account_id as number | null;
      const pool = cycleOrder(repSenderPool((await gmailPool(m.workspace_id)).filter((a) => !FREE_MAIL.has(domainOf(a.email)) || a.id === pinned), c.created_by ?? null), m.id);
      if (!pool.length) {
        const { account } = await accountFor(pinned);
        if (!account) { await mark(m.id, { status: 'failed', last_error: 'the sending Gmail account is gone' }); tally.failed++; continue; }
        await reschedule(m, new Date(Date.now() + 6 * 3_600_000), 'Every connected mailbox is paused. An admin can resume one in Settings → Outbound OS.');
        continue;
      }
      let held: { at: string | null; message: string } | null = null;
      let sentThis = false;
      for (const pick of pool) {
        const { account, access } = await accountFor(pick.id);
        if (!account || !access || !account.gmail_send || !has(account, SCOPE.gmailSend)) {
          held = held ?? { at: new Date(Date.now() + 3_600_000).toISOString(), message: 'Gmail needs reconnecting before this can send' };
          continue;
        }
        const claim = await guardSend(admin, account, [r.email], 'bulk');
        if (!claim.ok) {
          if (claim.code === 'suppressed' || claim.code === 'unverified_unsafe') { await skipBlocked(claim.message, claim.code === 'suppressed' ? 'email suppressed' : 'email not safe to send'); sentThis = true; break; }
          if (PACE.has(claim.code) || claim.code === 'domain') {
            const wait = claim.next_at ?? new Date(Date.now() + 3_600_000 * (claim.code === 'domain' ? 6 : 1)).toISOString();
            if (!held || wait < (held.at ?? wait)) held = { at: claim.next_at ?? wait, message: claim.message };
            continue;
          }
          await reschedule(m, claim.next_at ? new Date(claim.next_at) : new Date(Date.now() + 3_600_000), claim.message);
          sentThis = true;
          break;
        }
        const link = unsubscribeUrl(await unsubscribeToken({ w: m.workspace_id, e: r.email, a: account.id }));
        const text = `${m.body}\n\n--\nDon't want these emails? Unsubscribe: ${link}`;
        const html = (m.body_html || textToHtml(m.body)) + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#71717a;margin-top:24px">Don't want these emails? <a href="${esc(link)}" style="color:#71717a">Unsubscribe</a></p>`;
        const from = c.from_name ? `"${String(c.from_name).replace(/["\r\n<>]/g, '')}" <${account.email}>` : null;
        const sent = await sendMail(access, {
          to: r.email, subject: m.subject || '(no subject)', html, text, from,
          headers: { 'List-Unsubscribe': `<${link}>, <mailto:${account.email}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        if (!sent) { await release(admin, claim.ids); await reschedule(m, new Date(Date.now() + 1_800_000), 'Gmail refused that send'); sentThis = true; break; }
        const messageId = (await messageIdOf(access, sent.id)) ?? `gmail:${sent.id}`;
        const { data: comm } = await admin.from('communications').upsert({
          workspace_id: m.workspace_id, buyer_id: m.buyer_id, rep_id: account.user_id, channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(),
          subject: m.subject, body: m.body.slice(0, 20_000), from_email: account.email.toLowerCase(), to_email: r.email, status: 'sent', source: 'gmail', source_id: messageId,
        }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
        await admin.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: messageId, p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: null });
        outreach.push({ ws: m.workspace_id, item: outreachItem({ phone: r.phone, userId: account.user_id ?? c.created_by, channel: 'email', at: new Date(), ref: `email:${m.id}` }) });
        tally.sent++;
        sentThis = true;
        break;
      }
      if (!sentThis && held) await reschedule(m, held.at ? new Date(held.at) : new Date(Date.now() + 3_600_000), held.message);
      continue;
    }

    // Ringless voicemail (migration 192): handed to rvm_drops at its send
    // time, so the RVM tick drops it with the campaign's recording or the
    // script spoken. The drop's own callbacks and results stay on rvm_drops.
    if (m.channel === 'rvm') {
      if (!r.phone) { await mark(m.id, { status: 'failed', last_error: 'buyer has no phone' }); tally.failed++; continue; }
      const clip = c.settings?.brief?.rvmRecording ?? null;
      const { data: drop, error } = await admin.from('rvm_drops').insert({
        workspace_id: m.workspace_id, buyer_id: m.buyer_id, phone_e164: r.phone, script: String(m.body ?? '').slice(0, 4500),
        library_id: clip && Number(clip.libraryId) > 0 ? Number(clip.libraryId) : null, variant_group: clip && Number(clip.libraryId) > 0 ? String(clip.variantGroup ?? 'default') : 'default',
        status: 'queued', scheduled_at: new Date().toISOString(), created_by: c.created_by ?? null,
      }).select('id').maybeSingle();
      if (error || !drop) { await reschedule(m, new Date(Date.now() + 600_000), `could not queue the voicemail: ${error?.message ?? 'no row'}`); continue; }
      await mark(m.id, { status: 'sent', sent_at: new Date().toISOString(), rvm_drop_id: drop.id, provider_id: `rvm:${drop.id}` });
      tally.sent++; continue;
    }

    // An AI call (migration 192): the ai-agent function places it through the
    // workspace's dispo agent with the deal brief as the call goal. Outside
    // the agent's call hours it waits; a buyer the agent must not engage is skipped.
    if (m.channel === 'ai_call') {
      if (!r.phone) { await mark(m.id, { status: 'failed', last_error: 'buyer has no phone' }); tally.failed++; continue; }
      let res: Response | null = null;
      try {
        res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-agent`, {
          method: 'POST', headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'deal_call', workspace_id: m.workspace_id, buyer_id: m.buyer_id, deal_id: c.deal_id, campaign_id: c.id, rep_id: c.created_by ?? null, call_goal: String(m.body ?? '').slice(0, 2000) }),
          signal: AbortSignal.timeout(25_000),
        });
      } catch { /* unreachable: retried below */ }
      const out = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok || !out?.ok) {
        const why = String(out?.error ?? (res ? `ai-agent answered ${res.status}` : 'ai-agent unreachable'));
        if (out?.stop) { await mark(m.id, { status: 'skipped', last_error: why }); tally.skipped++; continue; }
        const hours = Number(out?.retry_hours) || 1;
        if (hours >= 24 && (m.attempts ?? 0) >= 3) { await mark(m.id, { status: 'failed', last_error: why }); tally.failed++; continue; }
        await reschedule(m, hours >= 12 ? nextMorning() : new Date(Date.now() + hours * 3_600_000), why);
        continue;
      }
      await mark(m.id, { status: 'sent', sent_at: new Date().toISOString(), conversation_id: out.conversation_id ?? null, provider_id: out.conversation_id ? `call:${out.conversation_id}` : null });
      tally.sent++; continue;
    }

    // SMS. Email above is workspace-scoped and keeps sending. Talkr texts
    // require this workspace's binding, then a token org that matches it.
    const smsBinding = await talkrBinding(m.workspace_id);
    if (!smsBinding) {
      await mark(m.id, { status: 'queued', last_error: TALKR_NOT_CONNECTED });
      tally.held++; continue;
    }
    const token = await tokenFor(c.created_by);
    if (!token) {
      await mark(m.id, { status: 'queued', last_error: 'waiting for a browser send: server texting is not configured (TALKR_PARTNER_JWT_SECRET)' });
      tally.held++; continue;
    }
    if (!gateTalkrWrite({ binding: smsBinding, observedOrgId: await observedOrg(m.workspace_id, token) }).ok) {
      await mark(m.id, { status: 'queued', last_error: TALKR_NOT_CONNECTED });
      tally.held++; continue;
    }
    if (!r.phone) { await mark(m.id, { status: 'failed', last_error: 'buyer has no phone' }); tally.failed++; continue; }
    const base = await talkrBase(m.workspace_id);
    // First touch carries the opt-out line; follow-ups only reach people who
    // already got one. Without it the text does not match the samples filed on
    // the 10DLC campaign, which is grounds for the campaign to be pulled.
    const smsBody = m.kind === 'followup' ? m.body : withOptOut(m.body);
    const res = await talkr(base, token, '/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        to_number: r.phone, body: smsBody,
        ...(m.media_urls?.length ? { media_urls: m.media_urls } : {}),
        ...(c.from_phone_number_id ? { from_phone_number_id: c.from_phone_number_id } : {}),
      }),
    });
    if (!res.ok) {
      const code = String(res.body?.error ?? '');
      if (code === 'suppressed') {
        await mark(m.id, { status: 'skipped', last_error: 'number opted out of texts' });
        await admin.from('dispo_campaign_recipients').update({ status: 'opted_out' }).eq('id', r.id);
        await admin.from('dispo_campaign_messages').update({ status: 'cancelled', last_error: 'number opted out of texts' }).eq('recipient_id', r.id).eq('channel', 'sms').eq('status', 'queued');
        tally.skipped++; continue;
      }
      if (code === 'quiet_hours') { await reschedule(m, nextMorning(), 'Talkr quiet hours'); continue; }
      if (res.status === 429 || /cap|limit/i.test(code)) { await reschedule(m, nextMorning(), `Talkr limit: ${code || res.status}`); continue; }
      if (res.status === 401) { await reschedule(m, new Date(Date.now() + 3_600_000), 'Talkr did not accept the server token (check TALKR_PARTNER_JWT_SECRET matches Talkr)'); continue; }
      if (res.status === 0 || res.status >= 500) { await reschedule(m, new Date(Date.now() + 600_000), `Talkr unavailable (${res.status})`); continue; }
      await mark(m.id, { status: 'failed', last_error: `Talkr refused: ${code || res.status}`, attempts: (m.attempts ?? 0) + 1 });
      tally.failed++; continue;
    }
    const msg = res.body?.message ?? {};
    const { data: comm } = await admin.from('communications').upsert({
      workspace_id: m.workspace_id, buyer_id: m.buyer_id, channel: 'sms', direction: 'outbound', occurred_at: new Date().toISOString(),
      to_phone: r.phone, body: smsBody, status: msg.status || 'queued', source: 'talkr', source_id: 'msg:' + msg.id,
    }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
    await admin.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: String(msg.id ?? ''), p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: res.body?.conversation_id ?? null });
    r.talkr_conversation_id = r.talkr_conversation_id ?? res.body?.conversation_id ?? null;
    tally.sent++;
  }

  // Best effort: a Talkr outage never fails the tick.
  const byWs = new Map<number, (OutreachItem | null)[]>();
  for (const o of outreach) { const l = byWs.get(o.ws) ?? []; l.push(o.item); byWs.set(o.ws, l); }
  for (const [ws, items] of byWs) {
    const res = await postOutreach(admin, ws, items, tokenFor).catch(() => []);
    const bad = res.filter((x) => !x.ok);
    if (bad.length) console.warn(`talkr outreach: ${bad.length} of ${res.length} not recorded`, bad[0]?.note);
  }

  // Replies and delivery receipts from Talkr threads.
  await checkThreads(admin, tokenFor, talkrBase, tally, started, async (ws, token) => {
    const binding = await talkrBinding(ws);
    if (!binding) return false;
    return gateTalkrWrite({ binding, observedOrgId: await observedOrg(ws, token) }).ok;
  });
  return json({ ok: true, ...tally });
});

async function checkThreads(
  admin: SupabaseClient, tokenFor: (u: string | null) => Promise<string | null>, talkrBase: (ws: number) => Promise<string>,
  tally: { replies: number }, started: number,
  talkrReady: (ws: number, token: string) => Promise<boolean>,
) {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: rs } = await admin.from('dispo_campaign_recipients')
    .select('id, workspace_id, buyer_id, phone, talkr_conversation_id, campaign_id, checked_at, dispo_campaigns(created_by)')
    .in('status', ['active', 'replied']).not('talkr_conversation_id', 'is', null)
    .gte('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
    .or(`checked_at.is.null,checked_at.lt.${cutoff}`).order('checked_at', { ascending: true, nullsFirst: true }).limit(40);
  for (const r of (rs ?? []) as Any[]) {
    if (Date.now() - started > 130_000) return;
    const token = await tokenFor(r.dispo_campaigns?.created_by ?? null);
    if (!token) return;
    await admin.from('dispo_campaign_recipients').update({ checked_at: new Date().toISOString() }).eq('id', r.id);
    if (!(await talkrReady(r.workspace_id, token))) continue;
    const base = await talkrBase(r.workspace_id);
    const res = await talkr(base, token, `/v1/conversations/${encodeURIComponent(r.talkr_conversation_id)}/messages`);
    if (!res.ok) continue;
    const msgs = (res.body?.messages ?? []) as Any[];
    const rows = msgs.map((x) => ({
      workspace_id: r.workspace_id, buyer_id: r.buyer_id, channel: 'sms', direction: x.direction,
      occurred_at: x.sent_at ?? x.created_at, from_phone: x.direction === 'inbound' ? r.phone : null, to_phone: x.direction === 'inbound' ? null : r.phone,
      body: x.body, status: x.status || (x.direction === 'inbound' ? 'received' : 'sent'), source: 'talkr', source_id: 'msg:' + x.id,
    }));
    if (!rows.length) continue;
    // Outbound rows already exist (status moves in place); inbound ones are new and fire the reply trigger.
    const { data: existing } = await admin.from('communications').select('source_id').eq('workspace_id', r.workspace_id).eq('source', 'talkr').in('source_id', rows.map((x) => x.source_id));
    const have = new Set(((existing ?? []) as Any[]).map((e) => e.source_id));
    const fresh = rows.filter((x) => x.direction === 'inbound' && !have.has(x.source_id));
    if (fresh.length) { await admin.from('communications').insert(fresh); tally.replies += fresh.length; }
    for (const x of msgs.filter((y) => y.direction === 'outbound' && y.status === 'delivered')) {
      await admin.from('communications').update({ status: 'delivered' }).eq('workspace_id', r.workspace_id).eq('source', 'talkr').eq('source_id', 'msg:' + x.id);
      await admin.from('dispo_campaign_messages').update({ status: 'delivered' }).eq('recipient_id', r.id).eq('provider_id', String(x.id)).eq('status', 'sent');
    }
  }
}
