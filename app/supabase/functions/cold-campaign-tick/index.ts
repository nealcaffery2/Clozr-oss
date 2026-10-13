/**
 * POST /cold-campaign-tick — sends due cold-campaign steps and polls pool
 * mailboxes for replies. pg_cron calls cold_campaign_kick() every minute
 * with the service-role key. Nobody else may call it.
 *
 * Each enrollment is planned by _shared/cold-campaign.ts (rotation, caps,
 * ramp, recipient timezone, blocked domains). Before anything is handed to
 * Gmail, Graph, or SMTP, the address goes through mailguard's
 * verificationBlock as bulk mail and the workspace suppression list.
 * A real reply, bounce, unsubscribe, or suppression stops that prospect.
 * An out-of-office reply pauses the next step and resumes later.
 * Instantly warmup mail (the workspace tag, warmup headers, the subject
 * code, or the Warmup / Instantly Warmup folder) is ignored.
 * Copy goes out plain-text first, under the workspace Primary policy.
 *
 * Body {"action":"warmup_sync"} (cold_warmup_kick(), daily) runs the
 * Instantly sync for every workspace warming through Instantly instead of a
 * send tick: _shared/cold-warmup.ts stores the reading, promotes a mailbox
 * past the gate, and pauses one whose warmup mail lands in Spam. It also
 * re-checks every pool domain's DNS so a send never waits on a stale check.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { jsonWith } from '../_shared/security.ts';
import { dayStartUtc, domainOf, localParts } from '../_shared/deliverability-rules.ts';
import { unsubscribeToken, unsubscribeUrl, verificationBlock } from '../_shared/mailguard.ts';
import {
  blockedSendingDomains, coldDailyAllowance, coldDeliverability, coldMessageId, coldSendRoom, composeColdText, countsAsComplaint, createWarmupProvider,
  mailboxDayStart, mailboxGapSeconds, oooResumeAt, placementPausesRamp, plainHtml, planColdSend, poolPauseReason, prospectReply,
  recipientCompanyDomain, recipientProvider, replyOwner, rewriteTrackedLinks, poolAlerts, stateOf, warmupGateOn, WARMUP_GATE_MIN_SCORE, withOpenPixel, zoneForState, type ColdDeliverability, type ColdDomain, type ColdMailbox, type ColdStep,
} from '../_shared/cold-campaign.ts';
import { pollPool, sendPool, textToHtml, type Polled } from '../_shared/cold-transport.ts';
import { syncWarmup } from '../_shared/cold-warmup.ts';
import { sendResend, transactionalFrom } from '../_shared/resend.ts';
import { checkDomain } from '../deliverability/dns.ts';

type Any = any;
const json = jsonWith({});
const MAX_SENDS = 25;
const MAX_POLLS = 5;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  // The cron's key (vault clozr_service_role_key) and this runtime's env key can be
  // different issues of the service key; accept exactly either one (migration 193).
  if (!bearer || (bearer !== serviceKey && (await admin.rpc('is_cron_key', { p_key: bearer })).data !== true)) return json({ error: 'service role only' }, 403);
  const now = new Date();
  let body: Any = null;
  try { body = await req.json(); } catch { body = null; }
  if (body?.action === 'warmup_sync') return json(await warmupSyncAll(admin));
  const tally = { sent: 0, waited: 0, stopped: 0, failed: 0, replies: 0, paused: 0 };

  const { data: due } = await admin.from('cold_enrollments')
    .select('id, workspace_id, campaign_id, buyer_id, email, state, status, step_position, next_send_at, last_sent_at, enrolled_at, thread_message_id, provider_thread_id, mailbox_id')
    .eq('status', 'active').lte('next_send_at', now.toISOString()).order('next_send_at').limit(MAX_SENDS);

  const seenWs = new Set<number>();
  for (const row of (due ?? []) as Any[]) {
    seenWs.add(Number(row.workspace_id));
    try {
      await sendOne(admin, row, now, tally);
    } catch (err) {
      tally.failed++;
      console.error('cold send', row.id, err instanceof Error ? err.message : err);
      await admin.from('cold_enrollments').update({ next_send_at: new Date(now.getTime() + 15 * 60_000).toISOString() }).eq('id', row.id);
    }
  }

  const { data: pollBoxes } = await admin.from('cold_mailboxes')
    .select('id, workspace_id')
    .in('status', ['active', 'warming']).eq('paused', false)
    .or(`last_polled_at.is.null,last_polled_at.lt.${new Date(now.getTime() - 5 * 60_000).toISOString()}`)
    .order('last_polled_at', { ascending: true, nullsFirst: true })
    .limit(MAX_POLLS);
  for (const box of (pollBoxes ?? []) as Any[]) {
    seenWs.add(Number(box.workspace_id));
    try {
      tally.replies += await pollOne(admin, Number(box.id), Number(box.workspace_id));
    } catch (err) {
      console.error('cold poll', box.id, err instanceof Error ? err.message : err);
      await admin.from('cold_mailboxes').update({ last_error: 'Reply check failed. It will be tried again.', last_polled_at: now.toISOString() }).eq('id', box.id);
    }
  }

  for (const ws of seenWs) tally.paused += await pauseUnhealthy(admin, ws);

  return json({ ok: true, ...tally });
});

async function sendOne(admin: SupabaseClient, row: Any, now: Date, tally: { sent: number; waited: number; stopped: number; failed: number }): Promise<void> {
  const ws = Number(row.workspace_id);
  const campaign = (await admin.from('cold_campaigns').select('*').eq('id', row.campaign_id).eq('workspace_id', ws).maybeSingle()).data as Any;
  if (!campaign) return;
  const { data: stepRows } = await admin.from('cold_steps').select('*').eq('campaign_id', campaign.id).eq('workspace_id', ws).order('position');
  const steps: ColdStep[] = ((stepRows ?? []) as Any[]).map(asStep);
  const settings = await workspaceSettings(admin, ws);
  const buyer = row.buyer_id
    ? (await admin.from('buyers').select('id, name, company, email, markets, email_safe_to_send, email_status').eq('id', row.buyer_id).eq('workspace_id', ws).maybeSingle()).data as Any
    : null;
  const email = String(row.email).toLowerCase();
  const { data: sup } = await admin.from('email_suppressions').select('email').eq('workspace_id', ws).eq('email', email).maybeSingle();
  const gate = await verificationBlock(admin, ws, [email], 'bulk');
  // verificationBlock is the mailguard gate (suppressions are checked below
  // as well). An unverified address, when the workspace requires it, stops
  // with that gate's own reason rather than the generic unsafe wording.
  if (gate) {
    await stopEnrollment(admin, row, 'stopped', gate.message);
    tally.stopped++;
    return;
  }
  const pool = await loadPool(admin, ws, now, warmupGateOn(settings.warmup_provider));
  const { data: otherSeq } = await admin.from('cold_enrollments').select('id').eq('workspace_id', ws).eq('email', email).eq('status', 'active').neq('id', row.id).limit(1);
  const company = recipientCompanyDomain(email);
  const recipientDay = dayStartUtc(now, settings.fallback_timezone).toISOString();
  let recipientDomainSentToday = 0;
  if (company) {
    const { count } = await admin.from('cold_sends').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws).gte('sent_at', recipientDay).neq('status', 'failed').like('to_email', `%@${company}`);
    recipientDomainSentToday = count ?? 0;
  }
  const state = row.state || stateOf(null, buyer?.markets ?? []);
  const sinceCopy = new Date(now.getTime() - settings.policy.bodyRepeatWindowMinutes * 60_000).toISOString();
  const { data: recentRows } = await admin.from('cold_sends').select('body_hash, sent_at').eq('workspace_id', ws).gte('sent_at', sinceCopy).not('body_hash', 'is', null).limit(300);
  const plan = planColdSend({
    now,
    enrollment: {
      id: Number(row.id), status: String(row.status), email, state,
      stepPosition: Number(row.step_position), lastSentAt: row.last_sent_at, enrolledAt: row.enrolled_at,
      threadMessageId: row.thread_message_id, suppressed: !!sup,
      safety: 'safe', verificationStatus: buyer?.email_status ?? null,
      pinnedMailboxId: row.mailbox_id == null ? null : Number(row.mailbox_id),
      otherSequence: ((otherSeq ?? []) as Any[]).length > 0,
    },
    steps, campaign: {
      status: campaign.status,
      window: { start: Number(campaign.window_start), end: Number(campaign.window_end), days: (campaign.window_days ?? []).map(Number) },
      fallbackTimezone: campaign.fallback_timezone || settings.fallback_timezone,
    },
    mailboxes: pool.mailboxes, domains: pool.domains,
    blockedDomains: settings.blocked, requireVerified: false, cursor: settings.rotation_cursor,
    fields: fieldsOf(buyer, state, email),
    policy: settings.policy,
    recentBodies: ((recentRows ?? []) as Any[]).map((r) => ({ hash: String(r.body_hash), sentAt: String(r.sent_at) })),
    recipientDomainSentToday,
  });
  if (plan.action === 'stop') {
    await stopEnrollment(admin, row, plan.status, plan.reason);
    tally.stopped++;
    return;
  }
  if (plan.action === 'wait') {
    await admin.from('cold_enrollments').update({ next_send_at: plan.nextAt }).eq('id', row.id);
    tally.waited++;
    return;
  }

  const mailbox = pool.raw.find((m) => Number(m.id) === plan.mailboxId);
  const domain = pool.domains.find((d) => d.id === mailbox?.domain_id);
  if (!mailbox || !domain) {
    await admin.from('cold_enrollments').update({ next_send_at: new Date(now.getTime() + 900_000).toISOString() }).eq('id', row.id);
    tally.waited++;
    return;
  }
  const token = await unsubscribeToken({ w: ws, e: email });
  const link = unsubscribeUrl(token);
  let text = composeColdText(plan.body, { signature: mailbox.signature, physicalAddress: settings.policy.physicalAddress, unsubscribeUrl: link });
  text = rewriteTrackedLinks(text, { enabled: settings.policy.clickTracking, trackingDomain: plan.trackingDomain });
  const html = withOpenPixel(settings.policy.plainTextFirst ? plainHtml(text) : textToHtml(text), settings.policy.openTracking, null);
  const messageId = coldMessageId(Number(row.id), plan.stepPosition, crypto.randomUUID(), plan.from);
  const dayStart = mailboxDayStart(asSettings(mailbox), now);
  const rampAllowance = coldDailyAllowance(asSettings(mailbox), localParts(now, mailbox.timezone || 'America/Chicago').date, {
    ceiling: settings.policy.dailyCeiling, rampDays: settings.policy.rampDays, jitterPct: settings.policy.jitterPct, mailboxId: Number(mailbox.id),
  });
  const warmupDaily = mailbox.warmup_daily == null ? settings.policy.warmupDaily : Number(mailbox.warmup_daily);
  const allowance = coldSendRoom(rampAllowance, warmupDaily, settings.policy.combinedDailyCeiling);
  const plannedBox = pool.mailboxes.find((m) => m.id === plan.mailboxId);
  const gapSeconds = plannedBox ? mailboxGapSeconds(plannedBox, now, settings.policy) : settings.policy.gapMinSeconds;
  const { data: claim, error } = await admin.rpc('cold_send_claim', {
    p_workspace: ws, p_mailbox: mailbox.id, p_domain: domain.id, p_campaign: campaign.id, p_enrollment: row.id,
    p_step: plan.stepPosition, p_to: email, p_from: plan.from, p_subject: plan.subject, p_variant: plan.variant,
    p_in_reply_to: plan.inReplyTo, p_day_start: dayStart.toISOString(),
    p_mailbox_daily: allowance, p_mailbox_hourly: mailbox.hourly_cap, p_domain_daily: domain.dailyCap, p_gap_seconds: gapSeconds,
    p_body_hash: plan.bodyHash, p_recipient_provider: plan.recipientProvider,
    p_recipient_domain_cap: company ? settings.policy.recipientDomainDailyCap : null,
    p_recipient_day_start: company ? recipientDay : null,
  });
  if (error || !claim?.ok) {
    await admin.from('cold_enrollments').update({ next_send_at: new Date(now.getTime() + 900_000).toISOString() }).eq('id', row.id);
    tally.waited++;
    return;
  }
  try {
    const sent = await sendPool(admin, mailbox, {
      from: plan.from, fromName: mailbox.display_name, to: email, subject: plan.subject, text, html,
      plainText: settings.policy.plainTextFirst,
      inReplyTo: plan.inReplyTo, threadId: row.provider_thread_id, messageId,
      headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    const rfc = sent.rfcMessageId ?? messageId;
    await admin.from('cold_sends').update({ status: 'sent', rfc_message_id: rfc, provider_message_id: sent.providerId }).eq('id', claim.id);
    const next = steps.find((s) => s.position === plan.stepPosition + 1);
    await admin.from('cold_enrollments').update({
      last_sent_at: now.toISOString(),
      mailbox_id: row.mailbox_id ?? mailbox.id,
      thread_message_id: row.thread_message_id ?? rfc,
      provider_thread_id: sent.threadId ?? row.provider_thread_id,
      step_position: next ? next.position : plan.stepPosition,
      status: next ? 'active' : 'completed',
      stop_reason: next ? null : 'Sequence finished.',
      stopped_at: next ? null : now.toISOString(),
      next_send_at: next ? new Date(now.getTime() + 60_000).toISOString() : now.toISOString(),
    }).eq('id', row.id);
    if (next) {
      // The planner applies the business-day delay on the next tick from last_sent_at.
      await admin.from('cold_enrollments').update({ step_position: next.position, next_send_at: now.toISOString() }).eq('id', row.id);
    }
    await admin.from('communications').upsert({
      workspace_id: ws, buyer_id: row.buyer_id, channel: 'email', direction: 'outbound', occurred_at: now.toISOString(),
      subject: plan.subject, body: text.slice(0, 20_000), from_email: plan.from, to_email: email, status: 'sent',
      source: 'cold', source_id: `cold-send:${claim.id}`,
    }, { onConflict: 'workspace_id,source,source_id' });
    await admin.from('cold_workspace_settings').update({ rotation_cursor: settings.rotation_cursor + 1 }).eq('workspace_id', ws);
    tally.sent++;
  } catch (err) {
    await admin.from('cold_sends').delete().eq('id', claim.id);
    await admin.from('cold_mailboxes').update({ last_error: err instanceof Error ? err.message.slice(0, 240) : 'Send failed' }).eq('id', mailbox.id);
    await admin.from('cold_enrollments').update({ next_send_at: new Date(now.getTime() + 15 * 60_000).toISOString() }).eq('id', row.id);
    tally.failed++;
  }
}

async function pollOne(admin: SupabaseClient, mailboxId: number, ws: number): Promise<number> {
  const mailbox = (await admin.from('cold_mailboxes').select('*').eq('id', mailboxId).eq('workspace_id', ws).maybeSingle()).data as Any;
  if (!mailbox) return 0;
  const messages = await pollPool(admin, mailbox);
  await admin.from('cold_mailboxes').update({ last_polled_at: new Date().toISOString(), last_error: null }).eq('id', mailboxId);
  const settings = await workspaceSettings(admin, ws);
  const { data: sends } = await admin.from('cold_sends').select('id, to_email, rfc_message_id, enrollment_id, workspace_id').eq('mailbox_id', mailboxId).eq('workspace_id', ws).order('sent_at').limit(500);
  const refs = ((sends ?? []) as Any[]).map((s) => ({ id: Number(s.id), toEmail: String(s.to_email), rfcMessageId: s.rfc_message_id as string | null, enrollmentId: Number(s.enrollment_id) }));
  let n = 0;
  for (const msg of messages) {
    if (await recordReply(admin, mailbox, ws, msg, refs, settings)) n++;
  }
  return n;
}

async function recordReply(admin: SupabaseClient, mailbox: Any, ws: number, msg: Polled, refs: { id: number; toEmail: string; rfcMessageId: string | null; enrollmentId: number }[], settings: WorkspaceCold): Promise<boolean> {
  const decision = prospectReply({
    from: msg.from, inReplyTo: msg.inReplyTo, subject: msg.subject, providerId: msg.providerId, body: msg.body,
    headers: msg.headers, labels: msg.labels, folder: msg.folder,
  }, refs, settings.instantly_warmup_tag);
  if (!decision.stop) return false;
  const hit = decision.send;
  const { data: existing } = await admin.from('cold_replies').select('id').eq('mailbox_id', mailbox.id).eq('provider_message_id', msg.providerId).maybeSingle();
  if (existing) return false;
  const enrollment = (await admin.from('cold_enrollments').select('id, buyer_id, status, email, state').eq('id', hit.enrollmentId).eq('workspace_id', ws).maybeSingle()).data as Any;
  if (!enrollment) return false;
  const classification = decision.classification;
  const complaint = countsAsComplaint({ from: msg.from, subject: msg.subject, body: msg.body });
  const hold = classification === 'out_of_office' && !complaint;
  const status = classification === 'bounce' ? 'bounced' : classification === 'unsubscribe' ? 'unsubscribed' : 'replied';
  const buyerRow = enrollment.buyer_id
    ? (await admin.from('buyers').select('assigned_to, owner_id, name').eq('id', enrollment.buyer_id).eq('workspace_id', ws).maybeSingle()).data as Any
    : null;
  const workspace = (await admin.from('workspaces').select('owner_id').eq('id', ws).maybeSingle()).data as Any;
  const owner = replyOwner({
    buyerAssignedTo: buyerRow?.assigned_to ?? null,
    buyerOwnerId: buyerRow?.owner_id ?? null,
    workspaceOwnerId: workspace?.owner_id ?? null,
  });
  const { data: comm } = await admin.from('communications').upsert({
    workspace_id: ws, buyer_id: enrollment.buyer_id, channel: 'email', direction: 'inbound', occurred_at: msg.receivedAt,
    subject: msg.subject, body: msg.body.slice(0, 20_000), from_email: msg.from, to_email: mailbox.email, status: 'received',
    source: 'cold', source_id: `cold-reply:${mailbox.id}:${msg.providerId}`, rep_id: owner,
  }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
  await admin.from('cold_replies').insert({
    workspace_id: ws, mailbox_id: mailbox.id, enrollment_id: enrollment.id, send_id: hit.id, buyer_id: enrollment.buyer_id,
    provider_message_id: msg.providerId, from_email: msg.from, subject: msg.subject, snippet: msg.body.slice(0, 500),
    classification, complaint, communication_id: comm?.id ?? null, received_at: msg.receivedAt, assigned_to: owner,
  });
  if (owner && classification !== 'bounce') {
    const noted = await admin.from('notifications').insert({
      workspace_id: ws, user_id: owner, category: 'cold_reply', buyer_id: enrollment.buyer_id,
      title: `Cold reply from ${buyerRow?.name || msg.from}`,
      body: String(msg.subject || msg.body || '').slice(0, 200),
    });
    if (noted.error) console.error('cold reply notify', noted.error.message);
  }
  if (hold && enrollment.status === 'active') {
    const zone = zoneForState(enrollment.state, settings.fallback_timezone);
    const resume = oooResumeAt(msg.body, new Date(msg.receivedAt), settings.policy.oooHoldBusinessDays, zone);
    await admin.from('cold_enrollments').update({
      next_send_at: resume.toISOString(), ooo_until: resume.toISOString(),
    }).eq('id', enrollment.id).eq('status', 'active');
  } else if (enrollment.status === 'active') {
    await stopEnrollment(admin, enrollment, status, `Reply classified as ${classification.replaceAll('_', ' ')}.`);
  }
  if (classification === 'bounce') {
    await admin.from('cold_sends').update({ status: 'bounced', bounced_at: msg.receivedAt }).eq('id', hit.id);
    await admin.from('email_suppressions').upsert({ workspace_id: ws, email: enrollment.email, reason: 'hard_bounce', note: `Cold campaign bounce via ${mailbox.email}` }, { onConflict: 'workspace_id,email', ignoreDuplicates: true });
  } else if (!hold) {
    await admin.from('cold_sends').update({ status: 'replied', replied_at: msg.receivedAt, ...(complaint ? { complained_at: msg.receivedAt } : {}) }).eq('id', hit.id);
  }
  if (classification === 'unsubscribe' || complaint) {
    await admin.from('email_suppressions').upsert({
      workspace_id: ws, email: enrollment.email, reason: complaint ? 'complaint' : 'unsubscribe', note: `Cold campaign reply via ${mailbox.email}`,
    }, { onConflict: 'workspace_id,email', ignoreDuplicates: true });
  }
  return true;
}

async function pauseUnhealthy(admin: SupabaseClient, ws: number): Promise<number> {
  const settings = await workspaceSettings(admin, ws);
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: sends } = await admin.from('cold_sends').select('mailbox_id, status, sent_at, bounced_at, replied_at, complained_at').eq('workspace_id', ws).gte('sent_at', since30).limit(5000);
  const { data: unsubRows } = await admin.from('cold_replies').select('mailbox_id').eq('workspace_id', ws).eq('classification', 'unsubscribe').gte('received_at', since30).limit(5000);
  const { data: boxes } = await admin.from('cold_mailboxes').select('id, domain_id, email, paused').eq('workspace_id', ws);
  const rows = (sends ?? []) as Any[];
  const unsubByBox = new Map<number, number>();
  for (const r of (unsubRows ?? []) as Any[]) unsubByBox.set(Number(r.mailbox_id), (unsubByBox.get(Number(r.mailbox_id)) ?? 0) + 1);
  let paused = 0;
  const byBox = new Map<number, Any[]>();
  for (const s of rows) {
    const list = byBox.get(Number(s.mailbox_id)) ?? [];
    list.push(s);
    byBox.set(Number(s.mailbox_id), list);
  }
  for (const box of (boxes ?? []) as Any[]) {
    if (box.paused) continue;
    const mine = byBox.get(Number(box.id)) ?? [];
    const reason = poolPauseReason({ ...counts(mine, since7, unsubByBox.get(Number(box.id)) ?? 0), policy: settings.policy });
    if (!reason) continue;
    await admin.from('cold_mailboxes').update({ paused: true, paused_auto: true, paused_reason: `Auto-paused: ${reason}.`, paused_at: new Date().toISOString() }).eq('id', box.id);
    box.paused = true;
    paused++;
  }
  const { data: domains } = await admin.from('cold_domains').select('id, paused').eq('workspace_id', ws);
  for (const d of (domains ?? []) as Any[]) {
    if (d.paused) continue;
    const ids = new Set(((boxes ?? []) as Any[]).filter((b) => Number(b.domain_id) === Number(d.id)).map((b) => Number(b.id)));
    const mine = rows.filter((s) => ids.has(Number(s.mailbox_id)));
    const unsub = [...ids].reduce((n, id) => n + (unsubByBox.get(id) ?? 0), 0);
    const reason = poolPauseReason({ ...counts(mine, since7, unsub), policy: settings.policy });
    if (!reason) continue;
    await admin.from('cold_domains').update({ paused: true, paused_auto: true, paused_reason: `Auto-paused: ${reason}.`, paused_at: new Date().toISOString() }).eq('id', d.id);
    paused++;
  }
  const vendor = createWarmupProvider({ provider: settings.warmup_provider, apiBase: settings.warmup_api_base });
  for (const box of (boxes ?? []) as Any[]) {
    if (box.paused) continue;
    const place = await vendor.placement({ id: Number(box.id), email: String(box.email ?? 'pool@workspace'), rampDay: 0, allowance: settings.policy.dailyCeiling });
    const why = placementPausesRamp(place, settings.policy.primaryRateFloor);
    if (!why) continue;
    await admin.from('cold_mailboxes').update({ paused: true, paused_auto: true, paused_reason: `Auto-paused: ${why}.`, paused_at: new Date().toISOString() }).eq('id', box.id);
    paused++;
  }
  return paused;
}

function counts(rows: Any[], since7: string, unsub30d: number) {
  const week = rows.filter((r) => r.sent_at >= since7 && r.status !== 'failed');
  const last50 = [...rows].sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 50);
  return {
    sent7d: week.length,
    bounced7d: week.filter((r) => r.status === 'bounced' || r.bounced_at).length,
    hardInLast50: last50.filter((r) => r.status === 'bounced' || r.bounced_at).length,
    bulk30d: rows.filter((r) => r.status !== 'failed').length,
    unsub30d,
    complaints7d: week.filter((r) => r.complained_at).length,
    replied7d: week.filter((r) => r.status === 'replied' || r.replied_at).length,
  };
}

type WorkspaceCold = {
  blocked: string[];
  fallback_timezone: string;
  rotation_cursor: number;
  warmup_provider: string;
  warmup_api_base: string | null;
  instantly_warmup_tag: string | null;
  policy: ColdDeliverability;
};

async function workspaceSettings(admin: SupabaseClient, ws: number): Promise<WorkspaceCold> {
  const cols = 'blocked_extra, fallback_timezone, rotation_cursor, warmup_provider, warmup_api_base, instantly_warmup_tag, physical_address, deliverability';
  let row = (await admin.from('cold_workspace_settings').select(cols).eq('workspace_id', ws).maybeSingle()).data as Any;
  if (!row) {
    await admin.from('cold_workspace_settings').upsert({ workspace_id: ws }, { onConflict: 'workspace_id', ignoreDuplicates: true });
    row = (await admin.from('cold_workspace_settings').select(cols).eq('workspace_id', ws).maybeSingle()).data as Any;
  }
  const { data: wsRow } = await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle();
  const fallback = row?.fallback_timezone || (wsRow?.settings as Any)?.timezone || 'America/Chicago';
  const tag = String(row?.instantly_warmup_tag ?? '').trim();
  return {
    blocked: blockedSendingDomains(row?.blocked_extra ?? []),
    fallback_timezone: fallback,
    rotation_cursor: Number(row?.rotation_cursor ?? 0),
    warmup_provider: row?.warmup_provider ?? 'stub',
    warmup_api_base: row?.warmup_api_base ?? null,
    instantly_warmup_tag: tag.length >= 4 ? tag : null,
    policy: coldDeliverability(row?.deliverability, row?.physical_address),
  };
}

/**
 * Re-run the DNS check on every pool domain, the same write as cold-pool's
 * check_domain. A send needs a check under 7 days old (mailboxSkip), and a
 * person clicking Check DNS once goes stale before warmup ends.
 */
async function recheckDomains(admin: SupabaseClient, ws: number): Promise<number> {
  const { data } = await admin.from('cold_domains').select('id, domain, dkim_selectors, tracking_domain').eq('workspace_id', ws);
  let checked = 0;
  for (const d of (data ?? []) as Any[]) {
    try {
      const r = await checkDomain(d.domain, { dkim_selectors: d.dkim_selectors ?? [], tracking_domain: d.tracking_domain ?? null, uses_resend: false, google_hint: false });
      await admin.from('cold_domains').update({ score: r.score, blocking: r.blocking, report: { checks: r.checks, provider: r.provider }, checked_at: r.checked_at }).eq('id', d.id);
      // The deliverability page reads the per-check report from email_domains, as cold-pool's check_domain writes it.
      await admin.from('email_domains').upsert({
        workspace_id: ws, domain: d.domain, dkim_selectors: d.dkim_selectors ?? [],
        score: r.score, blocking: r.blocking, report: { checks: r.checks, provider: r.provider }, checked_at: r.checked_at,
      }, { onConflict: 'workspace_id,domain' });
      checked++;
    } catch (err) {
      console.error('cold dns', d.domain, err instanceof Error ? err.message : err);
    }
  }
  return checked;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Mail the workspace owner when the pool needs a person (something paused,
 * blocked, listed or failing to sync) or when the sync fixed something by
 * itself. Quiet days send nothing. Returns whether a mail went out.
 */
async function mailPoolAlert(admin: SupabaseClient, ws: number, sync: Awaited<ReturnType<typeof syncWarmup>>): Promise<boolean> {
  const [{ data: boxes }, { data: domains }, { data: row }, { data: wsRow }] = await Promise.all([
    admin.from('cold_mailboxes').select('email, status, paused, paused_reason, warmup_score, warmup_started_at').eq('workspace_id', ws),
    admin.from('cold_domains').select('domain, paused, paused_reason, blocking, checked_at').eq('workspace_id', ws),
    admin.from('cold_workspace_settings').select('deliverability').eq('workspace_id', ws).maybeSingle(),
    admin.from('workspaces').select('name, owner_id').eq('id', ws).maybeSingle(),
  ]);
  const { problems, healed } = poolAlerts({
    sync, mailboxes: (boxes ?? []) as Any[], domains: (domains ?? []) as Any[],
    minDays: coldDeliverability((row as Any)?.deliverability).warmupGateDays, minScore: WARMUP_GATE_MIN_SCORE, now: new Date(),
  });
  if (!problems.length && !healed.length) return false;
  const from = transactionalFrom();
  const { data: owner } = await admin.from('profiles').select('email').eq('id', (wsRow as Any)?.owner_id ?? '').maybeSingle();
  const to = String((owner as Any)?.email ?? '').trim();
  if (!from || !to) return false;
  const name = String((wsRow as Any)?.name ?? `Workspace ${ws}`);
  const list = (title: string, items: string[]) => items.length ? `<p><strong>${esc(title)}</strong></p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
  const subject = problems.length
    ? `${name} cold email: ${problems.length} problem${problems.length === 1 ? '' : 's'} to look at`
    : `${name} cold email: fixed ${healed.length} thing${healed.length === 1 ? '' : 's'} on its own`;
  const sent = await sendResend({
    from: from.from, to, subject,
    html: `${list('Needs you', problems)}${list('Fixed on its own', healed)}<p>Settings, Outbound OS, Email deliverability has the details.</p>`,
    text: [...problems.map((p) => `Needs you: ${p}`), ...healed.map((h) => `Fixed: ${h}`)].join('\n'),
    idempotencyKey: `cold-pool-alert:${ws}:${new Date().toISOString().slice(0, 10)}`,
  });
  return !!sent;
}

/** One sync per workspace that warms through Instantly. Errors stay per workspace. */
async function warmupSyncAll(admin: SupabaseClient): Promise<Record<string, unknown>> {
  const { data } = await admin.from('cold_workspace_settings').select('workspace_id').eq('warmup_provider', 'instantly').limit(200);
  const results: Record<string, unknown> = {};
  for (const row of (data ?? []) as Any[]) {
    const ws = Number(row.workspace_id);
    try {
      const r = await syncWarmup(admin, ws);
      const dns = await recheckDomains(admin, ws);
      const alerted = await mailPoolAlert(admin, ws, r);
      results[String(ws)] = {
        ok: r.ok, checked: r.checked, promoted: r.promoted.length, paused: r.paused.length, unlisted: r.unlisted.length,
        rewarmed: r.rewarmed.length, resumed: r.resumed.length, dns, alerted, error: r.error,
      };
    } catch (err) {
      results[String(ws)] = { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'sync failed' };
    }
  }
  return { ok: true, action: 'warmup_sync', workspaces: results };
}

async function loadPool(admin: SupabaseClient, ws: number, now: Date, gateOn = false): Promise<{ mailboxes: ColdMailbox[]; domains: ColdDomain[]; raw: Any[] }> {
  const { data: domains } = await admin.from('cold_domains').select('*').eq('workspace_id', ws);
  const { data: boxes } = await admin.from('cold_mailboxes').select('*').eq('workspace_id', ws).order('id');
  const dayAgo = new Date(now.getTime() - 26 * 3_600_000).toISOString();
  const { data: sends } = await admin.from('cold_sends').select('mailbox_id, sent_at, status, to_email').eq('workspace_id', ws).gte('sent_at', dayAgo).neq('status', 'failed');
  const sent = (sends ?? []) as Any[];
  const domainSent = new Map<number, number>();
  const raw = (boxes ?? []) as Any[];
  const mailboxes: ColdMailbox[] = raw.map((m) => {
    const start = mailboxDayStart(asSettings(m), now).getTime();
    const hour = now.getTime() - 3_600_000;
    const mine = sent.filter((s) => Number(s.mailbox_id) === Number(m.id));
    const todayRows = mine.filter((s) => Date.parse(s.sent_at) >= start);
    const today = todayRows.length;
    domainSent.set(Number(m.domain_id), (domainSent.get(Number(m.domain_id)) ?? 0) + today);
    const sentByProvider: ColdMailbox['sentByProvider'] = {};
    for (const s of todayRows) {
      const provider = recipientProvider(String(s.to_email ?? ''));
      sentByProvider[provider] = (sentByProvider[provider] ?? 0) + 1;
    }
    return {
      id: Number(m.id), domainId: Number(m.domain_id), domain: domainOf(m.email), email: m.email,
      paused: !!m.paused, status: String(m.status), settings: asSettings(m),
      signature: m.signature ?? null, restWeekday: m.rest_weekday == null ? null : Number(m.rest_weekday),
      warmupDaily: m.warmup_daily == null ? null : Number(m.warmup_daily),
      warmupGated: gateOn && String(m.status) === 'warming',
      sentToday: today, sentLastHour: mine.filter((s) => Date.parse(s.sent_at) >= hour).length,
      lastSentAt: mine.reduce((max: string | null, s) => !max || s.sent_at > max ? s.sent_at : max, null),
      sentByProvider,
    };
  });
  const coldDomains: ColdDomain[] = ((domains ?? []) as Any[]).map((d) => ({
    id: Number(d.id), domain: String(d.domain), dailyCap: Number(d.daily_cap), sentToday: domainSent.get(Number(d.id)) ?? 0,
    paused: !!d.paused, blocking: (d.blocking ?? []) as string[], checkedAt: d.checked_at ?? null,
    trackingDomain: d.tracking_domain ?? null,
  }));
  for (const m of mailboxes) {
    const d = coldDomains.find((x) => x.id === m.domainId);
    if (d) m.domain = d.domain;
  }
  return { mailboxes, domains: coldDomains, raw };
}

function asSettings(m: Any) {
  return {
    daily_cap: Number(m.daily_cap), hourly_cap: Number(m.hourly_cap), min_gap_seconds: Number(m.min_gap_seconds),
    window_start: 0, window_end: 24, window_days: [0, 1, 2, 3, 4, 5, 6], timezone: m.timezone || 'America/Chicago',
    ramp_enabled: !!m.ramp_enabled, ramp_start: Number(m.ramp_start), ramp_increase_pct: Number(m.ramp_increase_pct),
    ramp_target: Number(m.ramp_target), ramp_started_on: String(m.ramp_started_on).slice(0, 10),
    paused: !!m.paused, paused_reason: m.paused_reason ?? null,
  };
}

function asStep(s: Any): ColdStep {
  const variants = Array.isArray(s.variants) ? s.variants : [];
  return {
    position: Number(s.position), delayBusinessDays: Number(s.delay_business_days),
    subject: String(s.subject ?? ''), body: String(s.body ?? ''),
    variants: variants.map((v: Any) => ({ key: String(v.key ?? ''), subject: String(v.subject ?? ''), body: String(v.body ?? ''), weight: Number(v.weight ?? 1) })),
  };
}

function fieldsOf(buyer: Any, state: string | null, email: string): Record<string, string> {
  const name = String(buyer?.name ?? '').trim();
  const [first, ...rest] = name.split(/\s+/);
  const market = String((buyer?.markets ?? [])[0] ?? '');
  return {
    first_name: first ?? '', last_name: rest.join(' '), name, company: String(buyer?.company ?? ''),
    email, city: market.split(',')[0].trim(), state: state ?? '',
  };
}

async function stopEnrollment(admin: SupabaseClient, row: Any, status: string, reason: string): Promise<void> {
  const allowed = ['replied', 'bounced', 'unsubscribed', 'suppressed', 'completed', 'stopped'];
  await admin.from('cold_enrollments').update({
    status: allowed.includes(status) ? status : 'stopped',
    stop_reason: reason.slice(0, 300),
    stopped_at: new Date().toISOString(),
  }).eq('id', row.id).eq('status', 'active');
}
