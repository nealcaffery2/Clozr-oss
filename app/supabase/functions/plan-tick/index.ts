/**
 * POST /plan-tick. Sends due action-plan steps (migration 284).
 *
 * pg_cron calls plan_kick() every minute with the service-role key. The
 * claim (plan_send_claim) hands over due email, text, tag, assign and stage
 * steps on an active enrolment in a Compr workspace, or any plan with
 * settings.auto_send on. Calls and manual tasks stay on the list.
 *
 * Email to a prospect goes out of a warmed cold inbox, under the same caps
 * as a cold campaign, and the reply routes to that inbox's rep. Email to
 * someone who already has a Compr account goes through the workspace's own
 * Resend sender. A text goes through Talkr as the step's assignee. A tag,
 * an assignment and a stage land on the record. Every one of those writes
 * the activity log. A ringless drop and an AI-agent step are started by
 * their own ticks; this one only has to leave a record a person can read
 * when those ticks finish (the migration's triggers).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { isServiceCaller, jsonWith } from '../_shared/security.ts';
import { slopFindings, slopReport } from '../_shared/no-ai-slop.ts';
import { blastFrom, sendResend } from '../_shared/resend.ts';
import { resendEnvFor } from '../_shared/workspace-email.ts';
import { textRecipient } from '../_shared/docs-flow.ts';
import { withOptOut } from '../_shared/sms-compliance.ts';
import { unsubscribeToken, unsubscribeUrl, verificationBlock } from '../_shared/mailguard.ts';
import { localParts } from '../_shared/deliverability-rules.ts';
import { sendPool } from '../_shared/cold-transport.ts';
import {
  blockedSendingDomains, coldDailyAllowance, coldDeliverability, coldMessageId, coldSendRoom, composeColdText,
  mailboxDayStart, mailboxGapSeconds, pickPoolMailbox, plainHtml, recipientProvider, warmupGateOn,
  type ColdDeliverability,
} from '../_shared/cold-campaign.ts';
import {
  autoSendOn, coldHold, emailLane, enrollmentOpen, fillMerge, planBlock, planSender, skipTitle, subjectOf, tagToAdd, windowState,
  type Hours, type PlanPerson,
} from '../_shared/plan-send.ts';
import {
  afterThrow, asSettings, buildPool, closeSent, dropPool, eachClaimed, holdUnhealthy, noteSend, readHealth, sendsSince, sentSteps, serial, withPool,
  type Pool, type Serial,
} from './pool.ts';

type Any = any;
const json = jsonWith({});

type RosterRow = { user_id: string; role: string | null; email: string | null; full_name: string | null };

/** Who works the record: its own assignee, else the workspace owner, else the first member. Only a current member counts. */
function pickRep(i: { assignedTo?: string | null; roster: readonly RosterRow[]; ownerId: string | null }): RosterRow | null {
  const member = (id: string | null | undefined) => (id ? i.roster.find((r) => r.user_id === id) ?? null : null);
  return member(i.assignedTo) ?? member(i.ownerId) ?? i.roster[0] ?? null;
}

/** A markdown CTA line (`[Label](https://...)`) as plain text: "Label: https://...". */
const CTA_LINE = /^\[([^\]\n]{1,60})\]\(((?:https?:\/\/|\{\{)[^)\s]+)\)$/;
const ctaPlain = (text: string) => text.split('\n').map((l) => {
  const m = l.trim().match(CTA_LINE);
  return m ? `${m[1]}: ${m[2]}` : l;
}).join('\n');

type Claim = {
  task_id: number; workspace_id: number; enrollment_id: number; plan_step_id: number;
  seller_id: number | null; buyer_id: number | null; assigned_to: string | null; created_by: string | null;
  notes: string | null; deal_id: number | null; channel: string; subject: string | null; step_title: string | null;
  config: Any; plan_name: string | null; plan_settings: Any;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!(await isServiceCaller(admin, bearer))) return json({ error: 'service role only' }, 403);

  // Every row is claimed here (plan_claim_at, for update skip locked) before
  // anything sends, so an overlapping tick holds none of them. The pool only
  // changes how many of this tick's rows are in flight at once.
  const { data, error } = await admin.rpc('plan_send_claim', { p_limit: 20 });
  if (error) return json({ error: error.message }, 500);
  const rows = (data ?? []) as Claim[];
  const tally = { sent: 0, texted: 0, tagged: 0, waited: 0, skipped: 0, failed: 0 };
  const ctx = new Map<number, Promise<Ws>>();
  await eachClaimed(rows, recordKey, async (row) => {
    try {
      await one(admin, row, await workspace(admin, ctx, Number(row.workspace_id)), tally);
    } catch (err) {
      tally.failed++;
      console.error('plan-tick', row.task_id, err instanceof Error ? err.message : err);
      // A row that already sent is closed or held, never released (afterThrow).
      await afterThrow(row,
        () => release(admin, row, new Date(Date.now() + 15 * 60_000).toISOString(), null),
        () => closeSent(admin, row.task_id, finishPatch(row, null)));
    }
  });
  return json({ ok: true, ...tally, claimed: rows.length });
});

/** Rows on one record run in claim order, one at a time (tags are read, then written). */
const recordKey = (row: Claim) => row.buyer_id ? `b${row.buyer_id}` : row.seller_id ? `s${row.seller_id}` : `t${row.task_id}`;

/**
 * One workspace for one tick. `pool` is the warmed-inbox pool the tick reads
 * once (pool.ts), `lock` keeps its picks and claims one at a time, and
 * `busy` holds the inboxes with a send in flight, so one inbox never has two.
 */
type Ws = {
  compr: boolean; tz: string; requireVerified: boolean;
  roster: RosterRow[]; ownerId: string | null;
  cold: { campaignId: number | null; policy: ColdDeliverability; cursor: number; gate: boolean; blocked: string[] } | null;
  pool: Pool | null; lock: Serial; busy: Set<number>;
};

/** Read once per tick and shared by the rows in flight. A failed read is not kept, so the next row reads again. */
function workspace(admin: SupabaseClient, cache: Map<number, Promise<Ws>>, id: number): Promise<Ws> {
  const hit = cache.get(id);
  if (hit) return hit;
  const load = readWorkspace(admin, id);
  cache.set(id, load);
  load.catch(() => cache.delete(id));
  return load;
}

/** Throws on a failed read: a step must not send on default caps or without require_verified_email. */
async function readWorkspace(admin: SupabaseClient, id: number): Promise<Ws> {
  const [{ data: ws, error: wsError }, { data: roster, error: rosterError }, { data: cold, error: coldError }] = await Promise.all([
    admin.from('workspaces').select('owner_id, settings').eq('id', id).maybeSingle(),
    admin.from('workspace_roster').select('user_id, role, email, full_name').eq('workspace_id', id),
    admin.from('cold_workspace_settings').select('deliverability, physical_address, fallback_timezone, rotation_cursor, warmup_provider, blocked_extra').eq('workspace_id', id).maybeSingle(),
  ]);
  const failed = wsError ?? rosterError ?? coldError;
  if (failed) throw new Error(`workspace ${id} unread: ${failed.message}`);
  const settings = ((ws as Any)?.settings ?? {}) as Any;
  const row = cold as Any;
  const built: Ws = {
    compr: settings.buyer_profile === 'compr',
    tz: settings.timezone || row?.fallback_timezone || 'America/Chicago',
    requireVerified: settings.require_verified_email === true,
    roster: (roster ?? []) as RosterRow[],
    ownerId: (ws as Any)?.owner_id ?? null,
    cold: {
      campaignId: null,
      policy: coldDeliverability(row?.deliverability, row?.physical_address),
      cursor: Number(row?.rotation_cursor ?? 0),
      gate: warmupGateOn(row?.warmup_provider),
      blocked: blockedSendingDomains(row?.blocked_extra ?? []),
    },
    pool: null, lock: serial(), busy: new Set(),
  };
  if (built.compr) {
    const { data: camp, error: campError } = await admin.from('cold_campaigns').select('id, status').eq('workspace_id', id).eq('audience_tag', 'compr-cold').order('id').limit(5);
    if (campError) throw new Error(`cold campaign unread: ${campError.message}`);
    const rows = (camp ?? []) as { id: number; status: string }[];
    built.cold!.campaignId = (rows.find((c) => c.status === 'active') ?? rows[0])?.id ?? null;
  }
  return built;
}

async function one(admin: SupabaseClient, row: Claim, ws: Ws, tally: { sent: number; texted: number; tagged: number; waited: number; skipped: number; failed: number }): Promise<void> {
  const settings = (row.plan_settings ?? {}) as { auto_send?: boolean; business_hours?: Hours; text_without_consent?: boolean };
  if (!autoSendOn(ws.compr, settings)) {
    await release(admin, row, null, null);
    return;
  }
  if (!(await stillRunning(admin, row.enrollment_id))) {
    await release(admin, row, null, null);
    tally.skipped++;
    return;
  }
  const person = await loadPerson(admin, row);
  if (!person) {
    await finish(admin, row, 'the record is gone');
    tally.skipped++;
    return;
  }
  const hours = windowState(new Date(), settings.business_hours, ws.tz);
  if ((row.channel === 'email' || row.channel === 'sms') && !hours.open) {
    await release(admin, row, hours.nextAt, null);
    tally.waited++;
    return;
  }
  if (row.channel === 'tag') return actTag(admin, row, person, tally);
  if (row.channel === 'assign') return actAssign(admin, row, person, ws, tally);
  if (row.channel === 'stage') return actStage(admin, row, person, tally);

  const lane = row.channel === 'email' ? emailLane(person.who, ws.compr) : 'relationship';
  const email = (person.who.email ?? '').trim().toLowerCase();
  const suppressed = row.channel === 'email' ? await isSuppressed(admin, row.workspace_id, email) : false;
  const block = planBlock(person.who, row.channel === 'sms' ? 'sms' : 'email', lane, { suppressed, requireVerified: ws.requireVerified, textWithoutConsent: settings.text_without_consent === true });
  if (block) {
    await finish(admin, row, block);
    await log(admin, row, skipTitle(row.channel), block);
    tally.skipped++;
    return;
  }
  const rep = pickRep({ assignedTo: person.assignedTo, roster: ws.roster, ownerId: ws.ownerId });
  const senderId = planSender({
    stepAssignee: typeof row.config?.assignee === 'string' ? row.config.assignee : null,
    repId: rep?.user_id ?? null, taskAssignee: row.assigned_to, createdBy: row.created_by, compr: ws.compr,
  });
  const sender = ws.roster.find((r) => r.user_id === senderId) ?? (senderId && senderId === rep?.user_id ? rep : null);
  const fields = mergeFields(person, sender?.full_name || rep?.full_name || '');
  if (row.channel === 'sms') {
    if (!(await stillRunning(admin, row.enrollment_id))) {
      await release(admin, row, null, null);
      tally.skipped++;
      return;
    }
    const body = withOptOut(fillMerge(messageOf(row.notes), fields));
    const slop = slopFindings(body);
    if (slop.length) {
      await hold(admin, row, `slop: ${slopReport(slop)}`, tally);
      return;
    }
    const sent = await textRecipient(admin, { workspace_id: row.workspace_id, deal_id: row.deal_id, created_by: row.created_by }, {
      phone: person.who.phone, seller_id: row.seller_id, buyer_id: row.buyer_id,
    }, body, senderId, { contractsLine: false });
    if (sent.ok) {
      sentSteps.add(row);
      await finishSent(admin, row, sent.carrier_fixed ? `Reworded so carriers deliver it: ${sent.carrier_fixed}` : null);
      tally.texted++;
      return;
    }
    if (sent.reason === 'quiet hours') {
      await release(admin, row, hours.open ? new Date(Date.now() + 12 * 3600_000).toISOString() : hours.nextAt, null);
      tally.waited++;
      return;
    }
    if (sent.reason === 'number opted out of texts' || sent.reason === 'blocked: on the blacklist' || sent.reason === 'no mobile number') {
      await finish(admin, row, sent.reason);
      await log(admin, row, 'Text skipped', sent.reason);
      tally.skipped++;
      return;
    }
    await release(admin, row, new Date(Date.now() + 15 * 60_000).toISOString(), sent.reason);
    tally.failed++;
    return;
  }

  const subject = subjectOf(row.subject, row.step_title, fields);
  const body = fillMerge(messageOf(row.notes), fields);
  const slop = slopFindings(`${subject}\n${body}`);
  if (slop.length) {
    await hold(admin, row, `slop: ${slopReport(slop)}`, tally);
    return;
  }
  if (lane === 'cold') {
    // Cold mail stays plain text for deliverability: a [Label](link) line reads as "Label: link".
    await coldEmail(admin, row, person, ws, sender ?? rep, subject, ctaPlain(body), tally);
    return;
  }
  await relationshipEmail(admin, row, person, ws, sender ?? rep, subject, body, tally);
}

async function coldEmail(
  admin: SupabaseClient, row: Claim, person: Loaded, ws: Ws, rep: RosterRow | null,
  subject: string, body: string, tally: { sent: number; waited: number; skipped: number; failed: number },
): Promise<void> {
  const campaignId = ws.cold?.campaignId ?? null;
  if (!campaignId) {
    await release(admin, row, new Date(Date.now() + 6 * 3600_000).toISOString(), 'no cold campaign for prospects');
    await log(admin, row, 'Email waiting', 'No warmed-inbox campaign is set up for prospects yet.');
    tally.waited++;
    return;
  }
  const email = person.who.email!.trim().toLowerCase();
  const { data: existing, error: heldError } = await admin.from('cold_enrollments').select('id, status, mailbox_id, thread_message_id').eq('campaign_id', campaignId).eq('email', email).maybeSingle();
  if (heldError) throw new Error(`warmed sequence unread: ${heldError.message}`);
  const held = existing as { id: number; status: string; mailbox_id: number | null; thread_message_id: string | null } | null;
  const heldReason = coldHold(held?.status);
  if (heldReason) {
    await finish(admin, row, held?.status === 'active' ? 'already on a cold sequence' : `warmed sequence is ${held?.status}`);
    await log(admin, row, 'Email skipped', heldReason);
    tally.skipped++;
    return;
  }
  // A failed read throws: the row is released and tried again (the catch around one()), never skipped.
  const gate = await verificationBlock(admin, row.workspace_id, [email], 'bulk', { requireVerified: ws.requireVerified });
  if (gate) {
    await finish(admin, row, gate.message);
    await log(admin, row, 'Email skipped', gate.message);
    tally.skipped++;
    return;
  }
  let enrollmentId = held?.id ?? null;
  if (!enrollmentId) {
    const { data: made, error } = await admin.from('cold_enrollments').insert({
      workspace_id: row.workspace_id, campaign_id: campaignId, buyer_id: row.buyer_id, email,
      status: 'completed', stop_reason: 'Action plan email', step_position: 1, next_send_at: new Date().toISOString(), stopped_at: new Date().toISOString(),
    }).select('id').maybeSingle();
    if (error || !made) {
      await release(admin, row, new Date(Date.now() + 15 * 60_000).toISOString(), error?.message ?? 'could not keep a place on the warmed list');
      tally.failed++;
      return;
    }
    enrollmentId = (made as { id: number }).id;
  }
  const added = tagToAdd(person.who, 'cold');
  if (added && row.buyer_id) await addTag(admin, 'buyers', row.buyer_id, person.tags, added, row);

  const pinned = held?.mailbox_id ?? null;
  const got = await withPool(ws, () => loadPool(admin, row.workspace_id, ws), async (pool) => {
    const boxes = (pinned ? pool.mailboxes.filter((m) => m.id === pinned) : pool.mailboxes).filter((m) => !ws.busy.has(m.id));
    const picked = pickPoolMailbox(boxes, pool.domains, ws.cold?.blocked ?? [], pinned ? 0 : (ws.cold?.cursor ?? 0), new Date(), ws.cold?.policy);
    if (!picked) return { wait: 'no warmed inbox has room' };
    const mailbox = pool.raw.find((m) => Number(m.id) === picked.mailbox.id);
    const domain = pool.domains.find((d) => d.id === picked.mailbox.domainId);
    if (!mailbox || !domain) return { wait: null };
    const token = await unsubscribeToken({ w: row.workspace_id, e: email });
    const link = unsubscribeUrl(token);
    const address = ws.cold?.policy.physicalAddress?.trim() || '';
    const text = composeColdText(body, { signature: mailbox.signature, physicalAddress: address, unsubscribeUrl: link });
    const messageId = coldMessageId(enrollmentId, Number(row.plan_step_id), crypto.randomUUID(), picked.mailbox.email);
    const now = new Date();
    const dayStart = mailboxDayStart(asSettings(mailbox), now);
    const ramp = coldDailyAllowance(asSettings(mailbox), localParts(now, mailbox.timezone || ws.tz).date, {
      ceiling: ws.cold!.policy.dailyCeiling, rampDays: ws.cold!.policy.rampDays, jitterPct: ws.cold!.policy.jitterPct, mailboxId: Number(mailbox.id),
    });
    const warmupDaily = mailbox.warmup_daily == null ? ws.cold!.policy.warmupDaily : Number(mailbox.warmup_daily);
    const allowance = coldSendRoom(ramp, warmupDaily, ws.cold!.policy.combinedDailyCeiling);
    const gap = mailboxGapSeconds(picked.mailbox, now, ws.cold!.policy);
    const { data: claim, error } = await admin.rpc('cold_send_claim', {
      p_workspace: row.workspace_id, p_mailbox: mailbox.id, p_domain: domain.id, p_campaign: campaignId, p_enrollment: enrollmentId,
      p_step: 1, p_to: email, p_from: picked.mailbox.email, p_subject: subject, p_variant: 'plan',
      p_in_reply_to: held?.thread_message_id ?? null, p_day_start: dayStart.toISOString(),
      p_mailbox_daily: allowance, p_mailbox_hourly: mailbox.hourly_cap, p_domain_daily: domain.dailyCap, p_gap_seconds: gap,
      p_body_hash: null, p_recipient_provider: recipientProvider(email),
      p_recipient_domain_cap: null, p_recipient_day_start: null,
    });
    if (error || !claim?.ok) return 'refused';
    noteSend(pool, picked.mailbox.id, new Date().toISOString());
    ws.busy.add(picked.mailbox.id);
    return { claimId: claim.id, mailbox, picked, link, text, messageId, now };
  });
  if (got === 'refused' || 'wait' in got) {
    await release(admin, row, new Date(Date.now() + 15 * 60_000).toISOString(), got === 'refused' ? null : got.wait ?? null);
    tally.waited++;
    return;
  }
  const { claimId, mailbox, picked, link, text, messageId, now } = got;
  if (!(await stillRunning(admin, row.enrollment_id))) {
    await admin.from('cold_sends').delete().eq('id', claimId);
    await dropPool(ws);
    ws.busy.delete(picked.mailbox.id);
    await release(admin, row, null, null);
    tally.skipped++;
    return;
  }
  try {
    let sent: Awaited<ReturnType<typeof sendPool>>;
    try {
      sent = await sendPool(admin, mailbox, {
        from: picked.mailbox.email, fromName: mailbox.display_name, to: email, subject, text, html: plainHtml(text),
        plainText: true, inReplyTo: held?.thread_message_id ?? null, messageId,
        headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
    } catch (err) {
      await admin.from('cold_sends').delete().eq('id', claimId);
      const why = err instanceof Error ? err.message.slice(0, 240) : 'Send failed';
      await admin.from('cold_mailboxes').update({ last_error: why }).eq('id', mailbox.id);
      // The tick's pool still counts this send, and the inbox may read status 'error' now.
      await dropPool(ws);
      await release(admin, row, new Date(Date.now() + 15 * 60_000).toISOString(), why);
      tally.failed++;
      return;
    }
    // Sent. A throw from here on reaches the tick's catch, which holds the row instead of releasing it.
    sentSteps.add(row);
    const rfc = sent.rfcMessageId ?? messageId;
    await admin.from('cold_sends').update({ status: 'sent', rfc_message_id: rfc, provider_message_id: sent.providerId }).eq('id', claimId);
    await admin.from('cold_enrollments').update({
      mailbox_id: mailbox.id, thread_message_id: held?.thread_message_id ?? rfc, provider_thread_id: sent.threadId ?? null,
      last_sent_at: now.toISOString(), buyer_id: row.buyer_id, status: 'completed', stop_reason: 'Action plan email',
    }).eq('id', enrollmentId);
    await fileEmail(admin, row, {
      subject, body: text, from: picked.mailbox.email, to: email, source: 'cold', sourceId: `plan:${row.task_id}`, repId: mailbox.user_id ?? rep?.user_id ?? null,
    });
    if (row.buyer_id && !person.assignedTo && mailbox.user_id) await giveTo(admin, row, mailbox.user_id, repName(ws, mailbox.user_id, rep));
    await finishSent(admin, row, null);
    tally.sent++;
  } finally {
    ws.busy.delete(picked.mailbox.id);
  }
}

async function relationshipEmail(
  admin: SupabaseClient, row: Claim, person: Loaded, ws: Ws, rep: RosterRow | null,
  subject: string, body: string, tally: { sent: number; waited: number; skipped: number; failed: number },
): Promise<void> {
  const mail = await resendEnvFor(admin, row.workspace_id);
  const from = blastFrom(mail.env);
  if (!from) {
    await release(admin, row, new Date(Date.now() + 3600_000).toISOString(), 'Resend is not set up for this workspace');
    await log(admin, row, 'Email waiting', 'Resend is not set up for this workspace.');
    tally.waited++;
    return;
  }
  if (!(await stillRunning(admin, row.enrollment_id))) {
    await release(admin, row, null, null);
    tally.skipped++;
    return;
  }
  const text = ctaPlain(body);
  const html = plainHtml(text);
  const sent = await sendResend({
    from: from.from, to: person.who.email!.trim(), subject, html, text, replyTo: rep?.email ?? null,
    headers: rep?.email ? { 'List-Unsubscribe': `<mailto:${rep.email}?subject=unsubscribe>` } : undefined,
    tags: { kind: 'action_plan', plan: String(row.plan_name ?? '').slice(0, 40) },
    idempotencyKey: `plan-${row.task_id}`,
  }, mail.env);
  if (!sent) {
    await release(admin, row, new Date(Date.now() + 15 * 60_000).toISOString(), 'Resend refused the send');
    tally.failed++;
    return;
  }
  sentSteps.add(row);
  await fileEmail(admin, row, { subject, body: text, from: from.email, to: person.who.email!.trim(), source: 'resend', sourceId: `plan:${row.task_id}`, repId: rep?.user_id ?? row.assigned_to });
  if (ws.compr && row.buyer_id && !person.assignedTo && rep) await giveTo(admin, row, rep.user_id, rep.full_name || 'the Compr rep');
  await finishSent(admin, row, null);
  tally.sent++;
}

async function actTag(admin: SupabaseClient, row: Claim, person: Loaded, tally: { tagged: number; skipped: number }): Promise<void> {
  const tag = String(row.config?.tag ?? '').trim();
  if (!tag) {
    await finish(admin, row, 'no tag on the step');
    tally.skipped++;
    return;
  }
  const table = row.buyer_id ? 'buyers' : 'sellers';
  const id = row.buyer_id ?? row.seller_id;
  if (!id) { await finish(admin, row, 'the record is gone'); tally.skipped++; return; }
  const added = await addTag(admin, table, id, person.tags, tag, row);
  await finish(admin, row, null);
  if (added) tally.tagged++; else tally.skipped++;
}

async function actAssign(admin: SupabaseClient, row: Claim, person: Loaded, ws: Ws, tally: { tagged: number }): Promise<void> {
  const named = typeof row.config?.assignee === 'string' ? row.config.assignee : null;
  const rep = named
    ? ws.roster.find((r) => r.user_id === named) ?? null
    : pickRep({ assignedTo: person.assignedTo, roster: ws.roster, ownerId: ws.ownerId });
  if (rep && (row.buyer_id || row.seller_id)) {
    const table = row.buyer_id ? 'buyers' : 'sellers';
    await admin.from(table).update({ assigned_to: rep.user_id }).eq('id', (row.buyer_id ?? row.seller_id) as number);
    await log(admin, row, `Assigned to ${rep.full_name || 'a teammate'}`, `The action plan "${row.plan_name ?? ''}" assigned this record.`);
  }
  await finish(admin, row, rep ? null : 'no teammate to assign');
  tally.tagged++;
}

async function actStage(admin: SupabaseClient, row: Claim, _person: Loaded, tally: { tagged: number; skipped: number }): Promise<void> {
  const stage = String(row.config?.stage ?? '').trim();
  if (!stage) { await finish(admin, row, 'no stage on the step'); tally.skipped++; return; }
  if (row.seller_id) await admin.from('sellers').update({ lead_stage: stage }).eq('id', row.seller_id);
  else if (row.buyer_id) await admin.from('buyers').update({ status: stage }).eq('id', row.buyer_id);
  await log(admin, row, `Stage → ${stage}`, `Set by the action plan "${row.plan_name ?? ''}".`);
  await finish(admin, row, null);
  tally.tagged++;
}

type Loaded = { who: PlanPerson; tags: string[]; assignedTo: string | null; name: string };

async function loadPerson(admin: SupabaseClient, row: Claim): Promise<Loaded | null> {
  if (row.buyer_id) {
    const { data, error } = await admin.from('buyers')
      .select('name, email, phone, tags, blacklisted_at, archived_at, opted_in_at, assigned_to, compr_signup, email_safe_to_send, email_status')
      .eq('id', row.buyer_id).maybeSingle();
    if (error) throw new Error(`buyer unread: ${error.message}`);
    const b = data as Any;
    if (!b) return null;
    return {
      name: String(b.name ?? ''),
      assignedTo: b.assigned_to ?? null,
      tags: Array.isArray(b.tags) ? b.tags : [],
      who: {
        kind: 'buyer', tags: b.tags ?? [], email: b.email ?? null, phone: b.phone ?? null,
        archived: !!b.archived_at, blacklisted: !!b.blacklisted_at, optedIn: !!b.opted_in_at,
        hasSignup: b.compr_signup != null, emailSafe: b.email_safe_to_send ?? null, emailStatus: b.email_status ?? null,
      },
    };
  }
  if (!row.seller_id) return null;
  const { data, error } = await admin.from('sellers').select('name, email, phone, tags, archived_at, assigned_to').eq('id', row.seller_id).maybeSingle();
  if (error) throw new Error(`seller unread: ${error.message}`);
  const s = data as Any;
  if (!s) return null;
  return {
    name: String(s.name ?? ''),
    assignedTo: s.assigned_to ?? null,
    tags: Array.isArray(s.tags) ? s.tags : [],
    who: {
      kind: 'seller', tags: s.tags ?? [], email: s.email ?? null, phone: s.phone ?? null,
      archived: !!s.archived_at, blacklisted: false, optedIn: true, hasSignup: false, emailSafe: null, emailStatus: null,
    },
  };
}

function mergeFields(person: Loaded, repNameText: string): Record<string, string> {
  const name = person.name.trim();
  const first = name.split(/\s+/)[0] || name;
  return { first_name: first, name, contact_name: name, rep_name: repNameText, email: person.who.email ?? '', phone: person.who.phone ?? '' };
}

async function isSuppressed(admin: SupabaseClient, ws: number, email: string): Promise<boolean> {
  if (!email) return false;
  const { data, error } = await admin.from('email_suppressions').select('email').eq('workspace_id', ws).eq('email', email).maybeSingle();
  if (error) throw new Error(`suppressions unread: ${error.message}`);
  return !!data;
}

async function addTag(admin: SupabaseClient, table: 'buyers' | 'sellers', id: number, tags: string[], tag: string, row: Claim): Promise<boolean> {
  if (tags.some((t) => t.trim().toLowerCase() === tag.trim().toLowerCase())) return false;
  const next = [...tags, tag];
  const { error } = await admin.from(table).update({ tags: next }).eq('id', id);
  if (error) { console.error('plan tag', error.message); return false; }
  await log(admin, row, `Tagged "${tag}"`, `Added by the action plan "${row.plan_name ?? ''}".`);
  return true;
}

async function giveTo(admin: SupabaseClient, row: Claim, userId: string, name: string): Promise<void> {
  if (!row.buyer_id) return;
  const { data } = await admin.from('buyers').update({ assigned_to: userId }).eq('id', row.buyer_id).is('assigned_to', null).select('id');
  if (data?.length) await log(admin, row, `Assigned to ${name}`, 'The action plan routed this record to them.');
}

function repName(ws: Ws, userId: string, fallback: RosterRow | null): string {
  return ws.roster.find((r) => r.user_id === userId)?.full_name || fallback?.full_name || 'the Compr rep';
}

async function fileEmail(admin: SupabaseClient, row: Claim, mail: { subject: string; body: string; from: string; to: string; source: string; sourceId: string; repId: string | null }): Promise<void> {
  const rec: Record<string, unknown> = {
    workspace_id: row.workspace_id, seller_id: row.seller_id, buyer_id: row.buyer_id, deal_id: row.deal_id,
    channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(),
    subject: mail.subject, body: mail.body.slice(0, 20_000), from_email: mail.from, to_email: mail.to,
    status: 'sent', source: mail.source, source_id: mail.sourceId, rep_id: mail.repId,
  };
  let { error } = await admin.from('communications').upsert(rec, { onConflict: 'workspace_id,source,source_id' });
  if (error && /rep_id|deal_id/.test(error.message)) {
    delete rec.rep_id;
    ({ error } = await admin.from('communications').upsert(rec, { onConflict: 'workspace_id,source,source_id' }));
  }
  if (error) console.error('plan email log', row.task_id, error.message);
}

async function log(admin: SupabaseClient, row: Claim, title: string, body: string): Promise<void> {
  const entity_id = row.buyer_id ?? row.seller_id;
  if (!entity_id) return;
  const { error } = await admin.from('activity').insert({
    workspace_id: row.workspace_id, entity_type: row.buyer_id ? 'buyer' : 'seller', entity_id,
    kind: 'plan', title: title.slice(0, 200), body: body.slice(0, 1000), actor_id: row.assigned_to ?? row.created_by, occurred_at: new Date().toISOString(),
  });
  if (error) console.error('plan activity', row.task_id, error.message);
}

function cleaned(notes: string | null, extra: string | null): string | null {
  const base = (notes ?? '').replace(/\n?Waiting: [\s\S]*$/, '').trim();
  if (!extra) return base || null;
  return `${base}${base ? '\n' : ''}Waiting: ${extra}`.slice(0, 4000);
}

/**
 * The message a plan task carries, without the "Waiting: …" line a hold adds
 * (cleaned above). Before this, a text held once and sent later went out with
 * "Waiting: Talkr not connected to this workspace" on the end.
 */
const messageOf = (notes: string | null | undefined) => cleaned(notes ?? null, null) ?? '';

async function stillRunning(admin: SupabaseClient, enrollmentId: number): Promise<boolean> {
  const { data } = await admin.from('enrollments').select('status').eq('id', enrollmentId).maybeSingle();
  return enrollmentOpen((data as { status?: string } | null)?.status);
}

function finishPatch(row: Claim, reason: string | null) {
  const notes = reason ? `${(row.notes ?? '').replace(/\n?Waiting: [\s\S]*$/, '').trim()}${row.notes ? '\n' : ''}${reason}`.slice(0, 4000) : cleaned(row.notes, null);
  return { done: true, completed_at: new Date().toISOString(), notes, plan_claim_at: null };
}

/** A step that sent nothing: a failed write is claimed again in 10 minutes and decided again. */
async function finish(admin: SupabaseClient, row: Claim, reason: string | null): Promise<void> {
  await admin.from('tasks').update(finishPatch(row, reason)).eq('id', row.task_id);
}

/** A step that sent: the write is retried, and held as sent if it never lands (closeSent), so it never sends twice. */
async function finishSent(admin: SupabaseClient, row: Claim, reason: string | null): Promise<void> {
  await closeSent(admin, row.task_id, finishPatch(row, reason));
}

async function release(admin: SupabaseClient, row: Claim, dueAt: string | null, waiting: string | null): Promise<void> {
  const patch: Record<string, unknown> = { plan_claim_at: null, notes: cleaned(row.notes, waiting) };
  if (dueAt) patch.due_at = dueAt;
  await admin.from('tasks').update(patch).eq('id', row.task_id);
}

async function hold(admin: SupabaseClient, row: Claim, why: string, tally: { waited: number }): Promise<void> {
  await release(admin, row, new Date(Date.now() + 6 * 3600_000).toISOString(), why);
  await log(admin, row, row.channel === 'sms' ? 'Text held' : 'Email held', why);
  tally.waited++;
}

/**
 * The workspace's warmed inboxes and their sends, read once per tick
 * (withPool). Only mailbox_id and sent_at of the rows the counts use: back to
 * the earliest mailbox day start or the longest send gap (sendsSince), on
 * cold_sends_mailbox_idx (mailbox_id, sent_at). A failed read throws, so no
 * step picks an inbox from a half-read pool. The health counts are read
 * alongside and hold off what the health pass would pause (holdUnhealthy).
 */
async function loadPool(admin: SupabaseClient, wsId: number, ws: Ws): Promise<Pool> {
  const now = new Date();
  const [{ data: domains, error: domainError }, { data: boxes, error: boxError }] = await Promise.all([
    admin.from('cold_domains').select('*').eq('workspace_id', wsId),
    admin.from('cold_mailboxes').select('*').eq('workspace_id', wsId).order('id'),
  ]);
  if (domainError || boxError) throw new Error(`cold pool unread: ${(domainError ?? boxError)!.message}`);
  const raw = (boxes ?? []) as Any[];
  if (!raw.length) return buildPool(raw, domains ?? [], [], now, !!ws.cold?.gate);
  const [{ data: sends, error }, health] = await Promise.all([
    admin.from('cold_sends').select('mailbox_id, sent_at')
      .eq('workspace_id', wsId).in('mailbox_id', raw.map((m) => m.id))
      .gte('sent_at', sendsSince(raw, now, ws.cold!.policy.gapMaxSeconds).toISOString()).neq('status', 'failed'),
    readHealth(admin, wsId, now),
  ]);
  if (error) throw new Error(`cold sends unread: ${error.message}`);
  const pool = buildPool(raw, domains ?? [], (sends ?? []) as { mailbox_id: number; sent_at: string }[], now, !!ws.cold?.gate);
  // cold-campaign-tick's health gate, before every claim from this pool. No reading (null) holds nothing back.
  const held = health ? holdUnhealthy(pool, health, ws.cold!.policy) : null;
  if (held && (held.mailboxes.length || held.domains.length)) console.error('plan-tick cold health hold', wsId, JSON.stringify(held));
  return pool;
}
