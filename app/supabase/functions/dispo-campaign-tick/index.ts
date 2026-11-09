/**
 * POST /dispo-campaign-tick — sends what dispo campaigns have due (migration 53).
 *
 * Called every minute by pg_cron through dispo_campaign_kick(), with the
 * service-role key as the bearer; nobody else may call it. Idempotent: a
 * message is claimed (queued → sending) before anything goes out, so two
 * overlapping ticks never send it twice. Due messages go in waves of up to
 * five (pool.ts): claimed, one read of their recipients and the blacklist,
 * then sent at once. A workspace's texts and AI calls stay one at a time.
 *
 * For each due message:
 *   - skipped when the campaign is paused/cancelled, the buyer opted out or was
 *     stopped, or it is a follow-up and the buyer has since replied or offered,
 *     or another campaign for the same deal already sent this buyer a message
 *     of the same kind on the same channel (lib/blast-dupes.ts; one read per
 *     wave, and only when the deal has more than one campaign)
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
 *   - SMS: through Talkr as the rep who launched the campaign, on a line from
 *     plan-tick/lines.ts pickBlastLine: the buyer's line, else the chosen from
 *     number for its first 50 a day, else the rep's other lines and the
 *     office's shared ones (local first, least used, under each line's ramp
 *     cap; a line Talkr holds is skipped for the tick), and MMS media. Talkr
 *     assigns the conversation to the rep, so replies come back to them. Filed with from_phone and rep_id. Talkr trusts this project's tokens, so the
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
 * per tick, each at most every 5 minutes, four at a time) and writes inbound
 * texts to communications with buyer_id; the migration's trigger does the rest.
 *
 * Hot replies (migration 434): a yes or a details ask from a blast recipient
 * is emailed to the rep who sent the blast (hot-alerts.ts).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { jsonWith } from '../_shared/security.ts';
import { type Account, SCOPE, accessFor, has, messageIdOf, sendMail, textToHtml } from '../_shared/google.ts';
import { FREE_MAIL, cycleOrder, domainOf, pickReplyTo, repSenderPool } from '../_shared/deliverability-rules.ts';
import { ensureRepBlastSenders, gmailBulkPool, guardSend, guardSendResend, markSendProvider, release, unsubscribeToken, unsubscribeUrl } from '../_shared/mailguard.ts';
import { type EnvLike, blastFrom, filedEmailBody, sendResend } from '../_shared/resend.ts';
import { resendEnvFor } from '../_shared/workspace-email.ts';
import { sendHotAlerts } from './hot-alerts.ts';
import { alertSendFailure } from '../_shared/send-alert.ts';
import { appPath } from '../_shared/app-paths.ts';
import { intoWindow } from '../_shared/dispo-rules.ts';
import { withOptOut } from '../_shared/sms-compliance.ts';
import { needsOptOutLine, optOutFacts } from '../_shared/opt-out-first-touch.ts';
import { lastLineTo, loadLines, pickBlastLine, type Line } from '../plan-tick/lines.ts';
import { BLACKLIST_MESSAGE, loadBlocked } from '../../../lib/blacklist.ts';
import { waveRepeats } from '../../../lib/blast-dupes.ts';
import { outreachItem, type OutreachItem } from '../../../lib/talkr-outreach.ts';
import { postOutreach, tokenCache } from '../_shared/talkr-outreach.ts';
import { gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from '../_shared/talkr-binding.ts';
import { textingBinding } from '../_shared/talkr-connect.ts';
import { carrierCheck, carrierReport } from '../../../lib/carrier-safe.ts';
import { mapLimit } from '../_shared/postmaster.ts';
import { once, runWaves } from './pool.ts';

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

  // Per-tick caches hold the promise, so sends running side by side read once.
  const recipients = new Map<number, Any>();
  // Message id → why it is a repeat of another campaign's send for the same deal, filled per wave.
  const repeats = new Map<number, string>();
  const resendEnv = once(async (ws: number): Promise<EnvLike> => (await resendEnvFor(admin, ws)).env);
  const PACE = new Set(['daily_cap', 'hourly_cap', 'gap', 'paused', 'window']);
  // Mailboxes the Gmail sync reads: a blast's Reply-To should be one of them,
  // or the reply never reaches the buyer's record or marks them replied.
  const syncedFor = once(async (ws: number) => {
    const { data } = await admin.from('google_accounts').select('email, user_id').eq('workspace_id', ws).eq('status', 'active').eq('gmail_read', true);
    return ((data ?? []) as Any[]).map((a) => ({ email: String(a.email ?? ''), user_id: (a.user_id ?? null) as string | null }));
  });
  // Blast emails Talkr cannot see: told to Talkr so a buyer who calls back rings that rep.
  const outreach: { ws: number; item: OutreachItem | null }[] = [];

  // The read itself, so a failed read holds the message instead of failing it as gone.
  const campaignOf = once(async (id: number) => await admin.from('dispo_campaigns').select('*').eq('id', id).maybeSingle());
  // null when the read failed: texting then waits, as when not connected.
  const settingsOf = once(async (ws: number) => {
    const { data, error } = await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle();
    return error ? null : ((data?.settings ?? {}) as Any);
  });
  const talkrBase = async (ws: number) => String((await settingsOf(ws))?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  // One partner token per rep per tick (_shared/talkr-outreach.ts mints it).
  const tokenFor = once(tokenCache(admin));
  // The launching rep's Talkr lines with today's counts, read once a tick per rep (plan-tick/lines.ts).
  const linesFor = once(async (key: string) => {
    const [ws, rep] = key.split(':');
    return await loadLines(admin, Number(ws), rep, (await settingsOf(Number(ws))) ?? {}, { shared: true }).catch(() => []);
  });
  // Addresses that never send a blast (workspaces.settings.blast_exclude_senders): reps' personal inboxes.
  const noBlastFrom = once(async (ws: number) => new Set(
    ((((await settingsOf(ws)) ?? {}).blast_exclude_senders ?? []) as unknown[]).map((e) => String(e).trim().toLowerCase()).filter(Boolean),
  ));
  // Lines Talkr refused this tick (number_protected): skipped by pickBlastLine until the next tick.
  const heldLines = new Set<string>();
  const talkrBinding = once(async (ws: number) => {
    const s = await settingsOf(ws);
    return s ? await textingBinding(admin, { id: ws, settings: s }) : null;
  });
  const orgCache = new Map<string, Promise<string | null>>();
  const observedOrg = (ws: number, token: string) => {
    const key = ws + ':' + token.slice(0, 24);
    if (!orgCache.has(key)) orgCache.set(key, talkrBase(ws).then((base) => readTalkrOrg((path) => talkr(base, token, path))));
    return orgCache.get(key)!;
  };
  const accountFor = once(async (id: number | null): Promise<{ account: Account | null; access: string | null; unread?: boolean }> => {
    if (!id) return { account: null, access: null };
    const { data, error } = await admin.from('google_accounts').select('id, workspace_id, user_id, email, scopes, calendar_id, status, gmail_send').eq('id', id).maybeSingle();
    const account = data as Account | null;
    return { account, access: account && account.status === 'active' ? await accessFor(admin, account) : null, unread: !!error };
  });
  // Message id → why it failed, told to the owner once the tick is done.
  const failed = new Map<number, string>();
  const mark = (id: number, patch: Record<string, unknown>) => {
    if (patch.status === 'failed') failed.set(id, String(patch.last_error ?? ''));
    return admin.from('dispo_campaign_messages').update(patch).eq('id', id);
  };
  const reschedule = async (m: Any, at: Date, why: string) => {
    tally.rescheduled++;
    await mark(m.id, { status: 'queued', send_at: at.toISOString(), last_error: why, attempts: (m.attempts ?? 0) + 1 });
  };
  // A text Talkr cannot take yet (not bound, no server token, another org) waits 15 minutes and
  // counts an attempt. Put back to queued with its old send_at, it was claimed, read and held again
  // every minute for good: the 30-attempt cut-off only ever saw reschedules.
  const hold = async (m: Any, why: string) => {
    tally.held++;
    await mark(m.id, { status: 'queued', send_at: new Date(Date.now() + 15 * 60_000).toISOString(), last_error: why, attempts: (m.attempts ?? 0) + 1 });
  };
  // VIP head start with nobody in it. The plan holds everyone else back
  // (settings.vipFirst) when a VIP or A-list buyer is on the list, but Talkr's
  // opt-outs are only learned here, at send time. When the one who went first
  // turns out opted out and nothing in the campaign has been sent, the rest
  // waited the full head start for no one: campaign 12 (6121, 2026-11-04) sent
  // nothing for 24 h. Pull every queued message forward so the earliest is now.
  const endEmptyHeadStart = async (c: Any, optedOutId: number, tz: string) => {
    if (!c.settings?.vipFirst?.on) return;
    const { count: sent } = await admin.from('dispo_campaign_messages').select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id).not('sent_at', 'is', null);
    if (sent !== 0) return; // someone got the first look, or the count failed: leave the plan alone
    const { data: queued, error } = await admin.from('dispo_campaign_messages').select('id, recipient_id, send_at')
      .eq('campaign_id', c.id).eq('status', 'queued').neq('recipient_id', optedOutId).order('send_at', { ascending: true });
    if (error || !queued?.length) return;
    const shift = Date.parse(queued[0].send_at) - Date.now();
    if (shift < 3_600_000) return; // nothing is being held back
    // ponytail: one update per message (a few hundred, once per campaign); an RPC if blasts get much bigger.
    for (let i = 0; i < queued.length; i += 50) {
      await Promise.all(queued.slice(i, i + 50).map((q) =>
        admin.from('dispo_campaign_messages').update({ send_at: intoWindow(new Date(Date.parse(q.send_at) - shift), tz).toISOString() })
          .eq('id', q.id).eq('status', 'queued')));
    }
    console.log(JSON.stringify({ fn: 'dispo-campaign-tick', campaign: c.id, head_start_ended: true, moved: queued.length, by_min: Math.round(shift / 60_000) }));
  };
  const resendPool = once(async (ws: number) => ensureRepBlastSenders(admin, ws, await resendEnv(ws)));
  const gmailPool = once((ws: number) => gmailBulkPool(admin, ws));

  const sendOne = async (m: Any, gate: Awaited<ReturnType<typeof loadBlocked>>) => {
    const cq = await campaignOf(m.campaign_id);
    if (cq.error) { await reschedule(m, new Date(Date.now() + 5 * 60_000), `could not read the campaign: ${cq.error.message}`); return; }
    const c = cq.data as Any;
    const r = recipients.get(m.recipient_id);
    if (!c || !r) { await mark(m.id, { status: 'failed', last_error: 'campaign or recipient is gone' }); tally.failed++; return; }
    if (c.status === 'paused') { await mark(m.id, { status: 'queued', send_at: new Date(Date.now() + 15 * 60_000).toISOString(), last_error: 'campaign paused' }); tally.held++; return; }
    if (c.status === 'cancelled') { await mark(m.id, { status: 'cancelled', last_error: 'campaign cancelled' }); tally.skipped++; return; }
    if (['opted_out', 'stopped'].includes(r.status)) { await mark(m.id, { status: 'skipped', last_error: `buyer ${r.status.replace('_', ' ')}` }); tally.skipped++; return; }
    if (m.only_if_no_reply && (r.replied_at || r.offered_at || !['active'].includes(r.status))) {
      await mark(m.id, { status: 'skipped', last_error: r.offered_at ? 'buyer made an offer' : 'buyer replied' }); tally.skipped++; return;
    }
    // A follow-up never goes ahead of the intro or brief it follows up on: when
    // those were held (a line off 10DLC) it waits the campaign's follow-up gap
    // after the last of them. Bea Arden got "checking whether 5323 Sage Hill
    // Road is one you'd look at" with her intro and brief still queued (2026-10-23).
    if (m.kind === 'followup') {
      const { data: ahead, error } = await admin.from('dispo_campaign_messages').select('send_at')
        .eq('recipient_id', m.recipient_id).in('kind', ['intro', 'brief']).eq('status', 'queued').order('send_at', { ascending: false }).limit(1);
      if (error) { await reschedule(m, new Date(Date.now() + 5 * 60_000), `could not check the intro and brief: ${error.message}`); return; }
      if (ahead?.length) {
        const f = c.settings?.followups ?? {};
        // lib/dispo-plan.ts ms(): hours or minutes.
        const gap = (Number(f.after) || 24) * (f.afterUnit === 'minutes' ? 60_000 : 3_600_000);
        await reschedule(m, new Date(Math.max(Date.parse(ahead[0].send_at), Date.now()) + gap), 'waiting for the intro and brief to go first');
        return;
      }
    }
    // The deal text never goes ahead of the intro text: caps and quiet hours
    // reschedule each on its own, so a held intro let the brief out first.
    // Tony Lane got 1091 Sparrow's details on Saturday and "I've got a deal,
    // want more details?" on Monday (2026-10-26). A brief waits 5 minutes past
    // its queued intro; an intro whose brief already went is skipped.
    if (m.channel === 'sms' && (m.kind === 'brief' || m.kind === 'intro')) {
      const other = m.kind === 'brief' ? 'intro' : 'brief';
      let q = admin.from('dispo_campaign_messages').select('send_at').eq('recipient_id', m.recipient_id).eq('channel', 'sms').eq('kind', other);
      q = m.kind === 'brief' ? q.in('status', ['queued', 'sending']) : q.not('sent_at', 'is', null);
      const { data: pair, error } = await q.limit(1);
      if (error) { await reschedule(m, new Date(Date.now() + 5 * 60_000), `could not check the ${other}: ${error.message}`); return; }
      if (pair?.length && m.kind === 'intro') { await mark(m.id, { status: 'skipped', last_error: 'the deal text already went' }); tally.skipped++; return; }
      if (pair?.length) { await reschedule(m, new Date(Math.max(Date.parse(pair[0].send_at), Date.now()) + 5 * 60_000), 'waiting for the intro to go first'); return; }
    }
    const repeat = repeats.get(m.id);
    if (repeat) { await mark(m.id, { status: 'skipped', last_error: repeat }); tally.skipped++; return; }
    // A buyer blacklisted after this was queued: cancelled at send time, on
    // either channel, from the wave's read made after its claims. A failed
    // read holds it, since "could not check" is not "clear".
    if (m.buyer_id != null) {
      if (!gate.ok) { await reschedule(m, new Date(Date.now() + 5 * 60_000), gate.message); return; }
      if (gate.blocked?.buyers.has(m.buyer_id)) {
        await mark(m.id, { status: 'skipped', last_error: BLACKLIST_MESSAGE });
        tally.skipped++; return;
      }
    }
    if ((m.attempts ?? 0) >= 30) { await mark(m.id, { status: 'failed', last_error: 'gave up after 30 attempts' }); tally.failed++; return; }
    const tz = c.timezone || 'America/Chicago';
    const nextMorning = () => intoWindow(new Date(Date.now() + 11 * 3_600_000), tz);

    if (m.channel === 'email') {
      if (!r.email) { await mark(m.id, { status: 'failed', last_error: 'buyer has no email' }); tally.failed++; return; }
      const skipBlocked = async (message: string, why: string) => {
        await mark(m.id, { status: 'skipped', last_error: message });
        await admin.from('dispo_campaign_messages').update({ status: 'cancelled', last_error: why }).eq('recipient_id', r.id).eq('channel', 'email').eq('status', 'queued');
        tally.skipped++;
      };
      const useResend = (c.email_provider ?? 'gmail') === 'resend';
      if (useResend) {
        const env = await resendEnv(m.workspace_id);
        const fromAddr = blastFrom(env);
        const off = await noBlastFrom(m.workspace_id);
        const pool = cycleOrder(repSenderPool((await resendPool(m.workspace_id)).filter((s) => !off.has(String(s.from_email ?? '').toLowerCase())), c.created_by ?? null), m.id);
        if (!pool.length || !fromAddr) { await reschedule(m, new Date(Date.now() + 3_600_000), 'Resend is not configured for this workspace. Set its Resend key and blast sender in Settings, Outbound OS, or RESEND_API_KEY and MAIL_FROM_BLASTS on the project.'); return; }
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
            subject: m.subject, body: filedEmailBody(m.body_html, m.body), from_email: sender.from_email, to_email: r.email, status: 'sent', source: 'resend', source_id: sent.id,
          }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
          await admin.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: sent.id, p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: null });
          outreach.push({ ws: m.workspace_id, item: outreachItem({ phone: r.phone, userId: sender.user_id ?? c.created_by, channel: 'email', at: new Date(), ref: `email:${m.id}` }) });
          tally.sent++;
          sentThis = true;
          break;
        }
        if (!sentThis && held) await reschedule(m, held.at ? new Date(held.at) : new Date(Date.now() + 3_600_000), held.message);
        return;
      }
      const pinned = c.email_account_id as number | null;
      const off = await noBlastFrom(m.workspace_id);
      const pool = cycleOrder(repSenderPool((await gmailPool(m.workspace_id))
        .filter((a) => (!FREE_MAIL.has(domainOf(a.email)) || a.id === pinned) && !off.has(a.email.toLowerCase())), c.created_by ?? null), m.id);
      if (!pool.length) {
        const { account, unread } = await accountFor(pinned);
        if (unread) { await reschedule(m, new Date(Date.now() + 5 * 60_000), 'could not read the sending Gmail account'); return; }
        if (!account) { await mark(m.id, { status: 'failed', last_error: 'the sending Gmail account is gone' }); tally.failed++; return; }
        await reschedule(m, new Date(Date.now() + 6 * 3_600_000), 'Every connected mailbox is paused. An admin can resume one in Settings → Outbound OS.');
        return;
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
          subject: m.subject, body: filedEmailBody(m.body_html, m.body), from_email: account.email.toLowerCase(), to_email: r.email, status: 'sent', source: 'gmail', source_id: messageId,
        }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
        await admin.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: messageId, p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: null });
        outreach.push({ ws: m.workspace_id, item: outreachItem({ phone: r.phone, userId: account.user_id ?? c.created_by, channel: 'email', at: new Date(), ref: `email:${m.id}` }) });
        tally.sent++;
        sentThis = true;
        break;
      }
      if (!sentThis && held) await reschedule(m, held.at ? new Date(held.at) : new Date(Date.now() + 3_600_000), held.message);
      return;
    }

    // Ringless voicemail (migration 192): handed to rvm_drops at its send
    // time, so the RVM tick drops it with the campaign's recording or the
    // script spoken. The drop's own callbacks and results stay on rvm_drops.
    if (m.channel === 'rvm') {
      if (!r.phone) { await mark(m.id, { status: 'failed', last_error: 'buyer has no phone' }); tally.failed++; return; }
      const clip = c.settings?.brief?.rvmRecording ?? null;
      const { data: drop, error } = await admin.from('rvm_drops').insert({
        workspace_id: m.workspace_id, buyer_id: m.buyer_id, phone_e164: r.phone, script: String(m.body ?? '').slice(0, 4500),
        library_id: clip && Number(clip.libraryId) > 0 ? Number(clip.libraryId) : null, variant_group: clip && Number(clip.libraryId) > 0 ? String(clip.variantGroup ?? 'default') : 'default',
        status: 'queued', scheduled_at: new Date().toISOString(), created_by: c.created_by ?? null,
      }).select('id').maybeSingle();
      if (error || !drop) { await reschedule(m, new Date(Date.now() + 600_000), `could not queue the voicemail: ${error?.message ?? 'no row'}`); return; }
      await mark(m.id, { status: 'sent', sent_at: new Date().toISOString(), rvm_drop_id: drop.id, provider_id: `rvm:${drop.id}` });
      tally.sent++; return;
    }

    // An AI call (migration 192): the ai-agent function places it through the
    // workspace's dispo agent with the deal brief as the call goal. Outside
    // the agent's call hours it waits; a buyer the agent must not engage is skipped.
    if (m.channel === 'ai_call') {
      if (!r.phone) { await mark(m.id, { status: 'failed', last_error: 'buyer has no phone' }); tally.failed++; return; }
      let res: Response | null = null;
      try {
        res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-agent`, {
          method: 'POST', headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
          // message_id is the idempotency key: a dial that outlives the 25 s below still rings, and the retry
          // an hour on must get that call back from ai-agent, not a second one.
          body: JSON.stringify({ action: 'deal_call', message_id: m.id, workspace_id: m.workspace_id, buyer_id: m.buyer_id, deal_id: c.deal_id, campaign_id: c.id, rep_id: c.created_by ?? null, call_goal: String(m.body ?? '').slice(0, 2000) }),
          signal: AbortSignal.timeout(25_000),
        });
      } catch { /* unreachable: retried below */ }
      const out = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok || !out?.ok) {
        const why = String(out?.error ?? (res ? `ai-agent answered ${res.status}` : 'ai-agent unreachable'));
        if (out?.stop) { await mark(m.id, { status: 'skipped', last_error: why }); tally.skipped++; return; }
        const hours = Number(out?.retry_hours) || 1;
        if (hours >= 24 && (m.attempts ?? 0) >= 3) { await mark(m.id, { status: 'failed', last_error: why }); tally.failed++; return; }
        await reschedule(m, hours >= 12 ? nextMorning() : new Date(Date.now() + hours * 3_600_000), why);
        return;
      }
      await mark(m.id, { status: 'sent', sent_at: new Date().toISOString(), conversation_id: out.conversation_id ?? null, provider_id: out.conversation_id ? `call:${out.conversation_id}` : null });
      tally.sent++; return;
    }

    // SMS. Email above is workspace-scoped and keeps sending. Talkr texts
    // require this workspace's binding, then a token org that matches it.
    const smsBinding = await talkrBinding(m.workspace_id);
    if (!smsBinding) { await hold(m, TALKR_NOT_CONNECTED); return; }
    const token = await tokenFor(c.created_by);
    if (!token) { await hold(m, 'waiting for a browser send: server texting is not configured (TALKR_PARTNER_JWT_SECRET)'); return; }
    if (!gateTalkrWrite({ binding: smsBinding, observedOrgId: await observedOrg(m.workspace_id, token) }).ok) { await hold(m, TALKR_NOT_CONNECTED); return; }
    if (!r.phone) { await mark(m.id, { status: 'failed', last_error: 'buyer has no phone' }); tally.failed++; return; }
    const base = await talkrBase(m.workspace_id);
    // The opt-out line only on a stranger's first text from us: never to a VIP,
    // a vetted buyer, anyone who has written back, or anyone texted before.
    const firstTouch = m.kind !== 'followup' && needsOptOutLine(await optOutFacts(admin, m.workspace_id, { buyer_id: m.buyer_id }));
    const carrier = carrierCheck(firstTouch ? withOptOut(m.body) : m.body);
    if (carrier.blocked) { await mark(m.id, { status: 'skipped', last_error: `carrier would block it: ${carrierReport(carrier)}` }); tally.skipped++; return; }
    const smsBody = carrier.text;
    // The line (pickBlastLine): the one this buyer already hears from, else the sender's picked number
    // for its first 50 texts of the day, else the sender's other lines and the office's shared ones,
    // local first, each under its ramp cap. A reply on any of them comes back to the sender. A picked
    // number that is not the sender's or shared (a teammate's line) sends alone, as before.
    const lines = await linesFor(`${m.workspace_id}:${c.created_by}`);
    // No lines read (Talkr did not answer this tick): wait, never fall back to the picked number alone.
    // A blast picked on a main line went out from it on those ticks (2026-10-23).
    if (!lines.length) { await reschedule(m, new Date(Date.now() + 5 * 60_000), 'could not read the text lines from Talkr; trying again shortly'); return; }
    const pickedOnly = !!c.from_phone_number_id && !lines.some((l) => l.id === c.from_phone_number_id);
    const lastFrom = await lastLineTo(admin, m.workspace_id, { buyer_id: m.buyer_id ?? null, seller_id: null });
    let line: Line | null = null;
    let res: Awaited<ReturnType<typeof talkr>>;
    // A line Talkr holds (off the 10DLC campaign, or full) is skipped for the tick and the next one is tried.
    for (;;) {
      line = !pickedOnly && lines.length ? pickBlastLine(lines, c.from_phone_number_id ?? null, lastFrom, r.phone, heldLines) : null;
      if (!pickedOnly && lines.length && !line) { await reschedule(m, nextMorning(), 'every text line is at its daily cap or held by Talkr'); return; }
      const fromId = line?.id ?? c.from_phone_number_id ?? null;
      res = await talkr(base, token, '/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          to_number: r.phone, body: smsBody,
          ...(m.media_urls?.length ? { media_urls: m.media_urls } : {}),
          ...(fromId ? { from_phone_number_id: fromId } : {}),
        }),
      });
      if (line && !res.ok && String(res.body?.error ?? '') === 'number_protected') { heldLines.add(line.id); continue; }
      break;
    }
    if (line && res.ok) line.sent++;
    if (!res.ok) {
      const code = String(res.body?.error ?? '');
      if (code === 'suppressed') {
        await mark(m.id, { status: 'skipped', last_error: 'number opted out of texts' });
        await admin.from('dispo_campaign_recipients').update({ status: 'opted_out' }).eq('id', r.id);
        await admin.from('dispo_campaign_messages').update({ status: 'cancelled', last_error: 'number opted out of texts' }).eq('recipient_id', r.id).eq('channel', 'sms').eq('status', 'queued');
        await endEmptyHeadStart(c, r.id, tz);
        tally.skipped++; return;
      }
      if (code === 'quiet_hours') { await reschedule(m, nextMorning(), 'Talkr quiet hours'); return; }
      // The line hit its daily text cap (or its 10DLC gate): Talkr says 422
      // number_protected. Tomorrow's cap has room, so it waits, with Talkr's reason.
      if (code === 'number_protected') { await reschedule(m, nextMorning(), `Talkr held this line: ${res.body?.message || code}`); return; }
      if (res.status === 429 || /cap|limit/i.test(code)) { await reschedule(m, nextMorning(), `Talkr limit: ${code || res.status}`); return; }
      if (res.status === 401) { await reschedule(m, new Date(Date.now() + 3_600_000), 'Talkr did not accept the server token (check TALKR_PARTNER_JWT_SECRET matches Talkr)'); return; }
      if (res.status === 0 || res.status >= 500) { await reschedule(m, new Date(Date.now() + 600_000), `Talkr unavailable (${res.status})`); return; }
      await mark(m.id, { status: 'failed', last_error: `Talkr refused: ${code || res.status}`, attempts: (m.attempts ?? 0) + 1 });
      tally.failed++; return;
    }
    const msg = res.body?.message ?? {};
    const { data: comm } = await admin.from('communications').upsert({
      workspace_id: m.workspace_id, buyer_id: m.buyer_id, channel: 'sms', direction: 'outbound', occurred_at: new Date().toISOString(),
      to_phone: r.phone, body: smsBody, status: msg.status || 'queued', source: 'talkr', source_id: 'msg:' + msg.id,
      // The line and the rep, so the next text stays on this line and reporting credits the rep.
      from_phone: line?.e164 ?? msg.from_number ?? null, rep_id: c.created_by ?? null,
    }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
    await admin.rpc('dispo_message_sent', { p_message_id: m.id, p_provider_id: String(msg.id ?? ''), p_communication_id: comm?.id ?? null, p_status: 'sent', p_conversation_id: res.body?.conversation_id ?? null });
    r.talkr_conversation_id = r.talkr_conversation_id ?? res.body?.conversation_id ?? null;
    tally.sent++;
  };

  await runWaves((due ?? []) as Any[], {
    db: admin,
    late: () => Date.now() - started > 100_000,
    // Both reads come after the wave's claims and live for the wave (the
    // recipients, like before, for the tick).
    prepare: async (won) => {
      const need = [...new Set(won.map((m) => m.recipient_id as number))].filter((id) => !recipients.has(id));
      if (need.length) {
        const { data, error } = await admin.from('dispo_campaign_recipients').select('*').in('id', need);
        if (error) {
          for (const m of won) await reschedule(m, new Date(Date.now() + 5 * 60_000), `could not read the recipients: ${error.message}`);
          return null;
        }
        for (const id of need) recipients.set(id, null);
        for (const r of (data ?? []) as Any[]) recipients.set(r.id, r);
      }
      // Two campaigns for one deal (8 and 9 on 2026-10-21) must not both reach
      // a buyer: the deal's other campaigns' sent rows for this wave's buyers.
      // A deal with one campaign reads nothing more, and a campaign launched
      // with "Send again" switched on (settings.sendRepeats) is not checked.
      // Both reads are on existing indexes (dispo_campaigns_deal_idx, dispo_messages_buyer_idx).
      // ponytail: a twin claimed by an overlapping tick (status sending) is not seen; count sending rows if that ever shows up.
      const dealOf = new Map<number, number>();
      for (const id of new Set(won.map((m) => m.campaign_id as number))) {
        const c = (await campaignOf(id)).data as Any;
        if (c?.deal_id != null && !c.settings?.sendRepeats) dealOf.set(id, Number(c.deal_id));
      }
      const deals = [...new Set(dealOf.values())];
      if (deals.length) {
        const { data: cs, error: ce } = await admin.from('dispo_campaigns').select('id, deal_id').in('deal_id', deals);
        let sent: Any[] = [];
        let error = ce;
        if (!ce && (cs ?? []).length > deals.length) {
          const got = await admin.from('dispo_campaign_messages').select('campaign_id, buyer_id, kind, channel')
            .in('campaign_id', (cs as Any[]).map((c) => c.id)).in('buyer_id', [...new Set(won.map((m) => m.buyer_id))]).in('status', ['sent', 'delivered']);
          error = got.error;
          sent = ((got.data ?? []) as Any[]).map((x) => ({ ...x, deal_id: Number((cs as Any[]).find((c) => c.id === x.campaign_id)?.deal_id) }));
        }
        if (error) {
          for (const m of won) await reschedule(m, new Date(Date.now() + 5 * 60_000), `could not check earlier blasts for this property: ${error.message}`);
          return null;
        }
        const mine = won.filter((m) => dealOf.has(m.campaign_id)).map((m) => ({ ...m, deal_id: dealOf.get(m.campaign_id)! }));
        for (const [id, why] of waveRepeats(mine, sent)) repeats.set(id, why);
      }
      return await loadBlocked(admin as never, { buyerIds: won.map((m) => m.buyer_id) });
    },
    send: sendOne,
  });

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
  await alertFailedBlasts(admin, (due ?? []) as Any[], failed);
  // After the thread read, so a yes it just filed is mailed this tick.
  const hot = await sendHotAlerts(admin).catch((e) => { console.error('hot alerts', String(e)); return 0; });
  return json({ ok: true, ...tally, hot });
});

/**
 * One alert per blast with failed messages. A buyer with no phone or email is
 * their record's gap, not a send that broke, so it rings nothing.
 */
async function alertFailedBlasts(admin: SupabaseClient, due: Any[], failed: Map<number, string>) {
  const byCampaign = new Map<number, { ws: number; n: number; why: Set<string> }>();
  for (const m of due) {
    const why = failed.get(m.id);
    if (why == null || /^buyer has no /.test(why)) continue;
    const c = byCampaign.get(m.campaign_id) ?? { ws: m.workspace_id, n: 0, why: new Set<string>() };
    c.n++;
    c.why.add(why);
    byCampaign.set(m.campaign_id, c);
  }
  for (const [id, c] of byCampaign) {
    await alertSendFailure(admin, {
      ws: c.ws, key: `dispo_campaign:${id}`, title: `${c.n} dispo blast message${c.n === 1 ? '' : 's'} failed`,
      reason: `Why: ${[...c.why].join('; ')}.`, path: appPath.dispo, place: 'Dispo',
    });
  }
}

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
  // Four threads at a time; each recipient's reads and writes are its own.
  // A rep with no token means server texting is not set up: the poll stops, as before.
  let stop = false;
  await mapLimit((rs ?? []) as Any[], 4, async (r) => {
    if (stop) return;
    const token = await tokenFor(r.dispo_campaigns?.created_by ?? null);
    if (!token) { stop = true; return; }
    await admin.from('dispo_campaign_recipients').update({ checked_at: new Date().toISOString() }).eq('id', r.id);
    if (!(await talkrReady(r.workspace_id, token))) return;
    const base = await talkrBase(r.workspace_id);
    const res = await talkr(base, token, `/v1/conversations/${encodeURIComponent(r.talkr_conversation_id)}/messages`);
    if (!res.ok) return;
    const msgs = (res.body?.messages ?? []) as Any[];
    const rows = msgs.map((x) => ({
      workspace_id: r.workspace_id, buyer_id: r.buyer_id, channel: 'sms', direction: x.direction,
      occurred_at: x.sent_at ?? x.created_at, from_phone: x.direction === 'inbound' ? r.phone : null, to_phone: x.direction === 'inbound' ? null : r.phone,
      body: x.body, status: x.status || (x.direction === 'inbound' ? 'received' : 'sent'), source: 'talkr', source_id: 'msg:' + x.id,
    }));
    if (!rows.length) return;
    // Outbound rows already exist (status moves in place); inbound ones are new and fire the reply trigger.
    // A failed read is not "none there": try again on the next poll.
    const { data: existing, error } = await admin.from('communications').select('source_id').eq('workspace_id', r.workspace_id).eq('source', 'talkr').in('source_id', rows.map((x) => x.source_id));
    if (error) return;
    const have = new Set(((existing ?? []) as Any[]).map((e) => e.source_id));
    const fresh = rows.filter((x) => x.direction === 'inbound' && !have.has(x.source_id));
    if (fresh.length) { await admin.from('communications').insert(fresh); tally.replies += fresh.length; }
    // One update per table, and only rows not yet delivered: the poll sees the same delivered texts every 5 minutes.
    const delivered = msgs.filter((y) => y.direction === 'outbound' && y.status === 'delivered').map((x) => String(x.id));
    if (delivered.length) {
      await admin.from('communications').update({ status: 'delivered' }).eq('workspace_id', r.workspace_id).eq('source', 'talkr')
        .in('source_id', delivered.map((id) => 'msg:' + id)).or('status.is.null,status.neq.delivered');
      await admin.from('dispo_campaign_messages').update({ status: 'delivered' }).eq('recipient_id', r.id).in('provider_id', delivered).eq('status', 'sent');
    }
  }, started + 130_000);
}
