/**
 * Mailbox protection, on the send path.
 *
 * Every Gmail send CLOZR makes goes through guardSend() first and release()
 * if Gmail then refuses it:
 *
 *   google-sync  send_email   one_to_one (or bulk when the caller says so)
 *   google-sync  test         transactional (to yourself)
 *   google-sync  mail         transactional (contract signing links)
 *
 * Dispo campaign blasts go through guardSendResend() instead — same
 * suppressions, window, ramp and claim, keyed on email_senders rather than
 * a Google account. AgentMail is not on either path.
 *
 * In order: suppressed recipients are refused (transactional mail skips only
 * hard bounces — a signing link to a seller who unsubscribed from follow-ups
 * is still owed), then an address that email verification has marked unsafe.
 * Unverified addresses (email_safe_to_send null, or no row) still send. A
 * workspace with settings.require_verified_email also refuses those nulls,
 * and only for bulk. Transactional mail (contracts, signing links, a test to
 * yourself) skips the verification check entirely. allowUnverified skips it
 * too. A paused mailbox refuses, bulk is held to the window and to the
 * domain's launch-blocking checks, then email_send_claim() counts and
 * reserves under a lock. Transactional sends always pass the claim but are
 * still counted. A verification lookup that errors (the columns are not
 * applied yet) does not block the send.
 *
 * scanBounces() runs inside the Gmail sync: mailer-daemon notices become a
 * bounced send, a bounced communication, a suppression, and — past the
 * OutboundOS thresholds — a paused mailbox. Resend bounces arrive on
 * /deliverability/resend instead.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  BUYER_SEND_ROLES, FREE_MAIL, PER_ADDRESS_TARGET, WARMUP_START, type MailboxSettings, type Refusal, type SendKind, addressesPerRep, autoPauseReason, blastDomains, blockUnverified, domainOf, emailSafety, limitsFor, parseBounce, preflight, refusal, repBlastAddresses,
} from './deliverability-rules.ts';

export { blockUnverified, emailSafety };
import { type EnvLike, blastFrom } from './resend.ts';
import { resendEnvFor } from './workspace-email.ts';

type Any = any;

export const SETTINGS_COLUMNS = 'account_id, workspace_id, daily_cap, hourly_cap, min_gap_seconds, window_start, window_end, window_days, timezone, ramp_enabled, ramp_start, ramp_increase_pct, ramp_target, ramp_started_on, paused, paused_reason, paused_at, paused_auto';

/** The mailbox's settings, creating the default row the first time. The ramp starts the day the account was connected, so a mailbox that has been sending for months is not throttled back to day one. */
export async function settingsFor(admin: SupabaseClient, account: { id: number; workspace_id: number }): Promise<MailboxSettings & { account_id: number }> {
  const read = async () => (await admin.from('mailbox_settings').select(SETTINGS_COLUMNS).eq('account_id', account.id).maybeSingle()).data as Any;
  let row = await read();
  if (!row) {
    const { data: acc } = await admin.from('google_accounts').select('connected_at').eq('id', account.id).maybeSingle();
    const started = acc?.connected_at ? String(acc.connected_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
    await admin.from('mailbox_settings').upsert({
      account_id: account.id, workspace_id: account.workspace_id, ramp_started_on: started, ramp_enabled: true, ramp_start: WARMUP_START,
    }, { onConflict: 'account_id', ignoreDuplicates: true });
    row = await read();
  }
  return { ...row, ramp_increase_pct: Number(row.ramp_increase_pct), window_days: (row.window_days ?? []).map(Number) };
}

export type Guard = { ok: true; ids: number[] } | { ok: false; code: Refusal['code'] | 'suppressed' | 'domain' | 'unverified_unsafe'; message: string; next_at: string | null; suppressed?: string[]; unsafe?: string[] };

export type GuardOptions = { allowUnverified?: boolean };

const ADDRESS_TABLES = [
  { table: 'buyers', keyed: false },
  { table: 'buyer_contacts', keyed: false },
  { table: 'sellers', keyed: false },
  { table: 'buyer_emails', keyed: true },
] as const;

function addressKey(row: Any): string {
  return String(row.email_key ?? row.email ?? '').trim().toLowerCase();
}

/** Flags per address, or null when a read failed — the send is then allowed. */
async function verificationFlags(admin: SupabaseClient, workspaceId: number, emails: string[]): Promise<Map<string, (boolean | null)[]> | null> {
  const flags = new Map<string, (boolean | null)[]>(emails.map((e) => [e, []]));
  for (const t of ADDRESS_TABLES) {
    let q = admin.from(t.table).select(t.keyed ? 'email, email_key, email_safe_to_send' : 'email, email_safe_to_send').eq('workspace_id', workspaceId);
    q = t.keyed ? q.in('email_key', emails) : q.or(emails.map((e) => `email.ilike.${e}`).join(','));
    const { data, error } = await q;
    if (error) {
      console.error('email verification lookup skipped', t.table, error.message);
      return null;
    }
    for (const row of (data ?? []) as Any[]) {
      const key = addressKey(row);
      const bucket = flags.get(key);
      if (!bucket) continue;
      bucket.push(row.email_safe_to_send ?? null);
    }
  }
  return flags;
}

/** The verification refusal, or null when every recipient may be sent. */
export async function verificationBlock(admin: SupabaseClient, workspaceId: number, recipients: string[], kind: SendKind, opts: GuardOptions = {}): Promise<Extract<Guard, { ok: false }> | null> {
  if (kind === 'transactional' || opts.allowUnverified || (kind !== 'bulk' && kind !== 'one_to_one')) return null;
  const to = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (!to.length) return null;
  let requireVerified = false;
  if (kind === 'bulk') {
    const { data, error } = await admin.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle();
    if (error) console.error('require_verified_email unread', error.message);
    else requireVerified = (data?.settings as Any)?.require_verified_email === true;
  }
  const flags = await verificationFlags(admin, workspaceId, to);
  if (!flags) return null;
  const unsafe: string[] = [];
  const unverified: string[] = [];
  for (const email of to) {
    const safety = emailSafety(flags.get(email) ?? []);
    if (!blockUnverified(safety, kind, { requireVerified })) continue;
    if (safety === 'unsafe') unsafe.push(email);
    else unverified.push(email);
  }
  if (!unsafe.length && !unverified.length) return null;
  const parts = [
    unsafe.length ? `${unsafe.join(', ')} failed email verification and ${unsafe.length === 1 ? 'is' : 'are'} not safe to send` : '',
    unverified.length ? `${unverified.join(', ')} ${unverified.length === 1 ? 'has' : 'have'} not been verified, and this workspace only sends bulk mail to a verified address` : '',
  ].filter(Boolean);
  return { ok: false, code: 'unverified_unsafe', next_at: null, unsafe: [...unsafe, ...unverified], message: `Not sent: ${parts.join('; ')}.` };
}

export async function guardSend(admin: SupabaseClient, account: { id: number; workspace_id: number; email: string }, recipients: string[], kind: SendKind, opts: GuardOptions = {}): Promise<Guard> {
  const ws = account.workspace_id;
  const to = recipients.map((r) => r.trim().toLowerCase());
  const { data: sup } = await admin.from('email_suppressions').select('email, reason').eq('workspace_id', ws).in('email', to);
  const blocked = ((sup ?? []) as Any[]).filter((s) => kind !== 'transactional' || s.reason === 'hard_bounce');
  if (blocked.length) {
    const why: Record<string, string> = { hard_bounce: 'bounced', unsubscribe: 'unsubscribed', complaint: 'reported spam', manual: 'is on the do-not-email list' };
    return { ok: false, code: 'suppressed', next_at: null, suppressed: blocked.map((s) => s.email), message: `Not sent: ${blocked.map((s) => `${s.email} ${why[s.reason] ?? 'is suppressed'}`).join('; ')}. Remove them from the suppression list in Settings only if you are sure.` };
  }
  const unverified = await verificationBlock(admin, ws, to, kind, opts);
  if (unverified) return unverified;

  const m = await settingsFor(admin, account);
  const now = new Date();
  const pre = preflight(m, kind, now);
  if (pre) return { ok: false, ...pre };

  if (kind === 'bulk') {
    const domain = domainOf(account.email);
    if (!FREE_MAIL.has(domain)) {
      const { data: d } = await admin.from('email_domains').select('score, blocking, checked_at').eq('workspace_id', ws).eq('domain', domain).maybeSingle();
      if (!d?.checked_at) return { ok: false, code: 'domain', next_at: null, message: `${domain} has not been checked yet. Run the domain check in Settings → Outbound OS before sending in bulk.` };
      if ((d.blocking ?? []).length) return { ok: false, code: 'domain', next_at: null, message: `Bulk sending is blocked until ${domain} is fixed: ${(d.blocking as string[])[0]}` };
      if (Date.parse(d.checked_at) < Date.now() - 7 * 86_400_000) return { ok: false, code: 'domain', next_at: null, message: `${domain} was last checked over a week ago. Re-run the check before sending in bulk.` };
    }
  }

  const l = limitsFor(m, kind, now);
  const { data, error } = await admin.rpc('email_send_claim', {
    p_workspace: ws, p_account: account.id, p_recipients: to, p_kind: kind,
    p_day_start: l.dayStart.toISOString(), p_daily: l.daily, p_hourly: l.hourly, p_gap_seconds: l.gap,
  });
  if (error) {
    // Fail closed for anything that is not a one-off transactional email:
    // without the count there is no cap.
    console.error('email_send_claim failed', error.message);
    if (kind === 'transactional') return { ok: true, ids: [] };
    return { ok: false, code: 'daily_cap', next_at: null, message: 'Could not check this mailbox’s sending limits, so nothing was sent. Try again in a moment.' };
  }
  const c = data as { ok: boolean; today: number; last_hour: number; hour_oldest: string | null; last_sent_at: string | null; ids: number[] };
  if (c.ok) return { ok: true, ids: c.ids ?? [] };
  return { ok: false, ...refusal(m, kind, c, to.length, now) };
}

export const SENDER_COLUMNS = 'id, workspace_id, from_email, from_name, reply_to, user_id, domain, active, daily_cap, hourly_cap, min_gap_seconds, window_start, window_end, window_days, timezone, ramp_enabled, ramp_start, ramp_increase_pct, ramp_target, ramp_started_on, paused, paused_reason, paused_at, paused_auto';

export type SenderRow = MailboxSettings & {
  id: number; workspace_id: number; from_email: string; from_name: string | null; reply_to: string | null; user_id: string | null; domain: string;
  active: boolean; paused_at: string | null; paused_auto: boolean;
};

function asSender(row: Any): SenderRow {
  return { ...row, ramp_increase_pct: Number(row.ramp_increase_pct), window_days: (row.window_days ?? []).map(Number) };
}

/** The workspace's Resend from-addresses, oldest first. */
export async function listBlastSenders(admin: SupabaseClient, workspaceId: number): Promise<SenderRow[]> {
  const { data } = await admin.from('email_senders').select(SENDER_COLUMNS).eq('workspace_id', workspaceId).eq('provider', 'resend').eq('active', true).order('id');
  return ((data ?? []) as Any[]).map(asSender);
}

/**
 * Upsert the workspace's primary Resend sender: settings.blast_from, else the
 * project's MAIL_FROM_BLASTS / MAIL_FROM. Null when Resend is not wired for
 * this workspace. `env` is the workspace's Resend env when the caller already
 * has it.
 */
export async function ensureBlastSender(admin: SupabaseClient, workspaceId: number, env?: EnvLike): Promise<SenderRow | null> {
  const from = blastFrom(env ?? (await resendEnvFor(admin, workspaceId)).env);
  if (!from) return null;
  const existing = (await admin.from('email_senders').select(SENDER_COLUMNS).eq('workspace_id', workspaceId).eq('from_email', from.email).maybeSingle()).data as Any;
  if (!existing) {
    await admin.from('email_senders').upsert({
      workspace_id: workspaceId, provider: 'resend', from_email: from.email, from_name: from.name, domain: from.domain, active: true,
      ramp_enabled: true, ramp_start: WARMUP_START,
    }, { onConflict: 'workspace_id,from_email', ignoreDuplicates: true });
  } else if (existing.domain !== from.domain || (existing.from_name ?? null) !== from.name) {
    await admin.from('email_senders').update({ from_name: from.name, domain: from.domain }).eq('id', existing.id);
  }
  await admin.from('email_domains').upsert(
    { workspace_id: workspaceId, domain: from.domain, source: 'manual', uses_resend: true },
    { onConflict: 'workspace_id,domain', ignoreDuplicates: true },
  );
  const row = (await admin.from('email_senders').select(SENDER_COLUMNS).eq('workspace_id', workspaceId).eq('from_email', from.email).maybeSingle()).data as Any;
  return row ? asSender(row) : null;
}

/**
 * Ten blast addresses per buyer-facing rep, on the same authenticated domain
 * as the primary sender (`morgan1@` … `morgan10@`). Each row has its own warm-up
 * ramp (start {@link WARMUP_START}, cap {@link PER_ADDRESS_TARGET}) and stores
 * that rep's user id, display name, and real inbox as Reply-To. A campaign
 * Morgan launches rotates only his rows. Nothing here sends mail between the
 * addresses. Existing rows are left alone so a ramp already in progress is
 * not reset.
 */
export async function ensureRepBlastSenders(admin: SupabaseClient, workspaceId: number, env?: EnvLike): Promise<SenderRow[]> {
  const wsEnv = env ?? (await resendEnvFor(admin, workspaceId)).env;
  const from = blastFrom(wsEnv);
  if (!from) return [];
  await ensureBlastSender(admin, workspaceId, wsEnv);
  const { data: members } = await admin.from('workspace_members').select('user_id, role').eq('workspace_id', workspaceId).in('role', [...BUYER_SEND_ROLES]);
  const ids = ((members ?? []) as Any[]).map((m) => m.user_id).filter(Boolean);
  // More capacity: extra verified Resend domains (settings.blast_domains) and
  // more addresses per rep (settings.blast_addresses_per_rep, up to 25).
  const { data: ws } = await admin.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle();
  const wsSettings = (ws?.settings ?? {}) as Any;
  const { data: doms } = await admin.from('email_domains').select('domain, uses_resend, blocking, active').eq('workspace_id', workspaceId);
  const ready = new Set(((doms ?? []) as Any[]).filter((d) => d.uses_resend && d.active !== false && d.blocking !== true).map((d) => String(d.domain).toLowerCase()));
  const extra = (Array.isArray(wsSettings.blast_domains) ? wsSettings.blast_domains : []).filter((d: unknown) => ready.has(String(d ?? '').trim().toLowerCase()));
  const domains = blastDomains(from.domain, extra);
  const perRep = addressesPerRep(wsSettings.blast_addresses_per_rep);
  if (ids.length) {
    const { data: profiles } = await admin.from('profiles').select('id, full_name, email').in('id', ids);
    const { data: have } = await admin.from('email_senders').select('from_email').eq('workspace_id', workspaceId);
    const haveSet = new Set(((have ?? []) as Any[]).map((r) => String(r.from_email ?? '').toLowerCase()));
    const today = new Date().toISOString().slice(0, 10);
    const rows: Any[] = [];
    for (const p of (profiles ?? []) as Any[]) {
      const email = String(p.email ?? '').trim().toLowerCase();
      const name = String(p.full_name ?? '').trim() || null;
      for (const domain of domains) for (const addr of repBlastAddresses(email, domain, perRep)) {
        if (addr === from.email || haveSet.has(addr)) continue;
        rows.push({
          workspace_id: workspaceId, provider: 'resend', from_email: addr, from_name: name, domain, active: true,
          reply_to: email, user_id: p.id, ramp_enabled: true, ramp_start: WARMUP_START, ramp_target: PER_ADDRESS_TARGET, daily_cap: PER_ADDRESS_TARGET, ramp_started_on: today,
        });
      }
    }
    if (rows.length) {
      await admin.from('email_senders').upsert(rows, { onConflict: 'workspace_id,from_email', ignoreDuplicates: true });
    }
  }
  return listBlastSenders(admin, workspaceId);
}

/** Connected mailboxes that can send, with whether the warm-up row has them paused. */
export async function gmailBulkPool(admin: SupabaseClient, workspaceId: number): Promise<{ id: number; email: string; user_id: string; paused: boolean }[]> {
  const { data } = await admin.from('google_accounts').select('id, email, user_id').eq('workspace_id', workspaceId).eq('status', 'active').eq('gmail_send', true).order('id');
  const out: { id: number; email: string; user_id: string; paused: boolean }[] = [];
  for (const a of (data ?? []) as Any[]) {
    const s = await settingsFor(admin, { id: a.id, workspace_id: workspaceId });
    out.push({ id: a.id, email: String(a.email ?? ''), user_id: String(a.user_id ?? ''), paused: !!s.paused });
  }
  return out;
}

export async function senderById(admin: SupabaseClient, id: number): Promise<SenderRow | null> {
  const row = (await admin.from('email_senders').select(SENDER_COLUMNS).eq('id', id).maybeSingle()).data as Any;
  return row ? asSender(row) : null;
}

/** Same guard as Gmail, keyed on an email_senders row. */
export async function guardSendResend(admin: SupabaseClient, sender: SenderRow, recipients: string[], kind: SendKind, opts: GuardOptions = {}): Promise<Guard> {
  const ws = sender.workspace_id;
  const to = recipients.map((r) => r.trim().toLowerCase());
  const { data: sup } = await admin.from('email_suppressions').select('email, reason').eq('workspace_id', ws).in('email', to);
  const blocked = ((sup ?? []) as Any[]).filter((s) => kind !== 'transactional' || s.reason === 'hard_bounce');
  if (blocked.length) {
    const why: Record<string, string> = { hard_bounce: 'bounced', unsubscribe: 'unsubscribed', complaint: 'reported spam', manual: 'is on the do-not-email list' };
    return { ok: false, code: 'suppressed', next_at: null, suppressed: blocked.map((s) => s.email), message: `Not sent: ${blocked.map((s) => `${s.email} ${why[s.reason] ?? 'is suppressed'}`).join('; ')}. Remove them from the suppression list in Settings only if you are sure.` };
  }
  const unverified = await verificationBlock(admin, ws, to, kind, opts);
  if (unverified) return unverified;

  const now = new Date();
  const pre = preflight(sender, kind, now);
  if (pre) return { ok: false, ...pre };

  if (kind === 'bulk') {
    const domain = sender.domain;
    const { data: d } = await admin.from('email_domains').select('score, blocking, checked_at').eq('workspace_id', ws).eq('domain', domain).maybeSingle();
    if (!d?.checked_at) return { ok: false, code: 'domain', next_at: null, message: `${domain} has not been checked yet. Run the domain check in Settings → Outbound OS before sending in bulk.` };
    if ((d.blocking ?? []).length) return { ok: false, code: 'domain', next_at: null, message: `Bulk sending is blocked until ${domain} is fixed: ${(d.blocking as string[])[0]}` };
    if (Date.parse(d.checked_at) < Date.now() - 7 * 86_400_000) return { ok: false, code: 'domain', next_at: null, message: `${domain} was last checked over a week ago. Re-run the check before sending in bulk.` };
  }

  const l = limitsFor(sender, kind, now);
  const { data, error } = await admin.rpc('email_send_claim', {
    p_workspace: ws, p_account: null, p_recipients: to, p_kind: kind,
    p_day_start: l.dayStart.toISOString(), p_daily: l.daily, p_hourly: l.hourly, p_gap_seconds: l.gap, p_sender: sender.id,
  });
  if (error) {
    console.error('email_send_claim failed', error.message);
    if (kind === 'transactional') return { ok: true, ids: [] };
    return { ok: false, code: 'daily_cap', next_at: null, message: 'Could not check this sender’s sending limits, so nothing was sent. Try again in a moment.' };
  }
  const c = data as { ok: boolean; today: number; last_hour: number; hour_oldest: string | null; last_sent_at: string | null; ids: number[] };
  if (c.ok) return { ok: true, ids: c.ids ?? [] };
  return { ok: false, ...refusal(sender, kind, c, to.length, now) };
}

/** Gmail or Resend refused it: give the reservation back. */
export async function release(admin: SupabaseClient, ids: number[]): Promise<void> {
  if (ids.length) await admin.from('email_send_log').delete().in('id', ids);
}

export async function markSendProvider(admin: SupabaseClient, ids: number[], providerId: string): Promise<void> {
  if (ids.length) await admin.from('email_send_log').update({ provider_id: providerId }).in('id', ids);
}

/** Pause a mailbox when it crosses a threshold. Returns the reason, or null. */
export async function checkAutoPause(admin: SupabaseClient, account: { id: number; workspace_id: number }): Promise<string | null> {
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const [{ data: recent }, { data: last50 }, { count: unsub30d }] = await Promise.all([
    admin.from('email_send_log').select('kind, sent_at, bounced_at').eq('account_id', account.id).gte('sent_at', since(30)).limit(10_000),
    admin.from('email_send_log').select('bounce_status').eq('account_id', account.id).order('sent_at', { ascending: false }).limit(50),
    admin.from('email_suppressions').select('id', { count: 'exact', head: true }).eq('account_id', account.id).eq('reason', 'unsubscribe').gte('created_at', since(30)),
  ]);
  const rows = (recent ?? []) as Any[];
  const week = rows.filter((r) => r.sent_at >= since(7));
  const reason = autoPauseReason({
    sent7d: week.length,
    bounced7d: week.filter((r) => r.bounced_at).length,
    hardInLast50: ((last50 ?? []) as Any[]).filter((r) => r.bounce_status === 'hard').length,
    bulk30d: rows.filter((r) => r.kind === 'bulk').length,
    unsub30d: unsub30d ?? 0,
  });
  if (!reason) return null;
  const { data: cur } = await admin.from('mailbox_settings').select('paused').eq('account_id', account.id).maybeSingle();
  if (cur?.paused) return reason;
  await admin.from('mailbox_settings').update({ paused: true, paused_auto: true, paused_reason: `Auto-paused: ${reason}.`, paused_at: new Date().toISOString() }).eq('account_id', account.id);
  console.warn('mailbox auto-paused', { account: account.id, reason });
  return reason;
}

/** Pause a Resend sender when it crosses the same bounce / complaint thresholds. */
export async function checkAutoPauseSender(admin: SupabaseClient, sender: { id: number; workspace_id: number }): Promise<string | null> {
  const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const [{ data: recent }, { data: last50 }, { count: unsub30d }, { count: complaint30d }] = await Promise.all([
    admin.from('email_send_log').select('kind, sent_at, bounced_at').eq('sender_id', sender.id).gte('sent_at', since(30)).limit(10_000),
    admin.from('email_send_log').select('bounce_status').eq('sender_id', sender.id).order('sent_at', { ascending: false }).limit(50),
    admin.from('email_suppressions').select('id', { count: 'exact', head: true }).eq('workspace_id', sender.workspace_id).eq('reason', 'unsubscribe').gte('created_at', since(30)),
    admin.from('email_suppressions').select('id', { count: 'exact', head: true }).eq('workspace_id', sender.workspace_id).eq('reason', 'complaint').gte('created_at', since(30)),
  ]);
  const rows = (recent ?? []) as Any[];
  const week = rows.filter((r) => r.sent_at >= since(7));
  const reason = autoPauseReason({
    sent7d: week.length,
    bounced7d: week.filter((r) => r.bounced_at).length,
    hardInLast50: ((last50 ?? []) as Any[]).filter((r) => r.bounce_status === 'hard').length,
    bulk30d: rows.filter((r) => r.kind === 'bulk').length,
    unsub30d: (unsub30d ?? 0) + (complaint30d ?? 0),
  });
  if (!reason) return null;
  const { data: cur } = await admin.from('email_senders').select('paused').eq('id', sender.id).maybeSingle();
  if (cur?.paused) return reason;
  await admin.from('email_senders').update({ paused: true, paused_auto: true, paused_reason: `Auto-paused: ${reason}.`, paused_at: new Date().toISOString() }).eq('id', sender.id);
  console.warn('resend sender auto-paused', { sender: sender.id, reason });
  return reason;
}

/**
 * Bounce notices in this mailbox since the last Gmail sync (Gmail's own
 * mailer-daemon, plus any remote server's postmaster). Needs gmail.readonly.
 * Idempotent: a send already marked bounced is not marked again, and the
 * suppression is an upsert.
 */
export async function scanBounces(admin: SupabaseClient, account: { id: number; workspace_id: number; email: string; last_gmail_sync_at: string | null }, accessToken: string): Promise<{ bounces: number; paused: string | null }> {
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    return res.ok ? await res.json() as Any : null;
  };
  const days = account.last_gmail_sync_at ? Math.min(30, Math.max(1, Math.ceil((Date.now() - Date.parse(account.last_gmail_sync_at)) / 86_400_000) + 1)) : 14;
  const q = `newer_than:${days}d from:(mailer-daemon OR postmaster) -in:chats`;
  const list = await get(`${GMAIL}/messages?maxResults=50&q=${encodeURIComponent(q)}`);
  const ids = ((list?.messages ?? []) as Any[]).map((m) => String(m.id));
  let bounces = 0;
  for (const id of ids) {
    const m = await get(`${GMAIL}/messages/${id}?format=full`);
    if (!m) continue;
    const headers: Record<string, string> = {};
    for (const h of (m.payload?.headers ?? []) as Any[]) headers[String(h.name).toLowerCase()] = String(h.value ?? '');
    const bounce = parseBounce(headers.from ?? '', headers, textOf(m.payload));
    if (!bounce || !bounce.hard) continue;
    const at = new Date(Number(m.internalDate) || Date.now()).toISOString();
    // The send it answers: the latest to that address from this mailbox before the notice.
    const { data: send } = await admin.from('email_send_log').select('id, bounced_at').eq('account_id', account.id).eq('recipient', bounce.recipient).lte('sent_at', at).order('sent_at', { ascending: false }).limit(1).maybeSingle();
    if (send?.bounced_at) continue;
    if (send) await admin.from('email_send_log').update({ bounced_at: at, bounce_status: 'hard' }).eq('id', send.id);
    await admin.from('email_suppressions').upsert({ workspace_id: account.workspace_id, email: bounce.recipient, reason: 'hard_bounce', note: `Bounced${bounce.status ? ` (${bounce.status})` : ''} — seen in ${account.email}`, account_id: account.id }, { onConflict: 'workspace_id,email', ignoreDuplicates: true });
    const { data: comm } = await admin.from('communications').select('id').eq('workspace_id', account.workspace_id).eq('channel', 'email').eq('direction', 'outbound')
      .eq('from_email', account.email.toLowerCase()).ilike('to_email', `%${bounce.recipient.replace(/[%_]/g, '')}%`).lte('occurred_at', at).order('occurred_at', { ascending: false }).limit(1).maybeSingle();
    if (comm) await admin.from('communications').update({ status: 'bounced' }).eq('id', comm.id);
    bounces++;
  }
  return { bounces, paused: bounces ? await checkAutoPause(admin, account) : null };
}

function textOf(payload: Any): string {
  const out: string[] = [];
  const walk = (p: Any) => {
    if (!p) return;
    if (p.body?.data && /^(text\/|message\/delivery-status|message\/rfc822|text\/rfc822-headers)/i.test(String(p.mimeType))) {
      try { out.push(new TextDecoder().decode(Uint8Array.from(atob(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)))); } catch { /* skip */ }
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out.join('\n').slice(0, 50_000);
}

// ------------------------------------------------------------ unsubscribe
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmac(data: string): Promise<Uint8Array> {
  const secret = Deno.env.get('UNSUBSCRIBE_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const key = await crypto.subtle.importKey('raw', enc.encode(`clozr.unsubscribe.v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export type UnsubClaim = { w: number; e: string; a?: number };

/** A token naming the workspace, recipient and mailbox, signed so it cannot be edited into someone else's address. */
export async function unsubscribeToken(c: UnsubClaim): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(c)));
  return `${body}.${b64url((await hmac(body)).slice(0, 18))}`;
}

export async function readUnsubscribeToken(token: string): Promise<UnsubClaim | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64url((await hmac(body)).slice(0, 18));
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(unb64url(body))) as UnsubClaim;
    return Number.isFinite(c.w) && typeof c.e === 'string' && c.e.includes('@') ? { w: c.w, e: c.e, a: Number.isFinite(c.a) && (c.a ?? 0) > 0 ? c.a : undefined } : null;
  } catch { return null; }
}

export const unsubscribeUrl = (token: string) => `${Deno.env.get('SUPABASE_URL')}/functions/v1/deliverability/unsubscribe?t=${encodeURIComponent(token)}`;
