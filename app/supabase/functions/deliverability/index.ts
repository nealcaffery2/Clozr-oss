/**
 * POST /deliverability Ã¢â‚¬â€ Settings Ã¢â€ â€™ Email deliverability.
 *
 * Body: { workspace_id, action, ... }
 *   overview                          everything the section shows: domains (and the
 *                                     ones detected from connected Google accounts),
 *                                     each mailbox's settings, today's count, ramp day,
 *                                     7-day bounce rate, suppressions
 *   check_domain   { id }             DNS check Ã¢â€ â€™ score, launch-blocking failures, fixes
 *   add_domain     { domain, dkim_selectors?, tracking_domain?, uses_resend? }   owner/admin
 *   remove_domain  { id }                                                        owner/admin
 *   save_mailbox   { account_id, settings }                                      owner/admin
 *   pause_mailbox / resume_mailbox { account_id, reason? }                       owner/admin
 *   suppress       { email, reason?, note? }                                     any member
 *   unsuppress     { email }                                                     owner/admin
 *   postmaster     { verify? }        Gmail Postmaster Tools for the caller's connection, plus
 *                                     Site Verification for every workspace domain Postmaster
 *                                     does not list yet (token, TXT at InboxKit or Vercel DNS,
 *                                     verify; pending rows retry on the next load), then adds
 *                                     each one to Postmaster (domains.create) and verifies it
 *                                     there. No cap on domains: BATCH at a time inside a time
 *                                     budget; `remaining` counts the ones left for the next load.
 *                                     verify: true retries now.
 *   warmup                            Instantly warm-up (score, inbox vs spam, 14 days) and
 *                                     InboxKit mailbox health for this workspace's mailboxes
 *   warmup_keys    { instantly_key?, inboxkit_key? }   store / clear (null) a key   owner/admin
 *   resend_key     { key?, webhook_secret? }           this workspace's Resend key   owner/admin
 *   blast_sender   { from | null }    "Acme Homes <deals@deals.yourcompany.com>"            owner/admin
 *
 * GET|POST /deliverability/unsubscribe?t=<token>   (no sign-in Ã¢â‚¬â€ the signed token is the credential)
 *   POST  RFC 8058 one-click (Gmail's unsubscribe button) or the app's
 *         /unsubscribe page Ã¢â€ â€™ the address is suppressed
 *   GET   redirects to the app's /unsubscribe page, which asks before
 *         POSTing, so a link scanner opening the URL unsubscribes nobody
 *
 * POST /deliverability/resend   Resend (Svix) webhook Ã¢â‚¬â€ bounce / complaint /
 *   delivery events. Verified with RESEND_WEBHOOK_SECRET. No JWT.
 *
 *   resend_status                     Resend sender + domain records for this workspace
 *   resend_ensure_domain              add/verify the blast domain at Resend, then DNS-check it
 *   save_sender / pause_sender / resume_sender   owner/admin Ã‚Â· same caps as a mailbox
 *   verify_emails  { buyer_ids?, seller_ids? }  any member. Power-mode Reoon
 *                                     check; writes email_status,
 *                                     email_safe_to_send, email_verified_at
 *                                     and email_verify_provider on every row
 *                                     with that address. No REOON_API_KEY:
 *                                     nothing is written.
 *
 * verify_jwt is off for the webhook and unsubscribe routes; every other
 * action checks the caller's JWT and workspace membership itself, like
 * google-oauth.
 *
 * Each workspace sends blasts with its own Resend key and sender when it has
 * set them (workspace-email.ts); the project secrets below are the fallback.
 *
 * Secrets: RESEND_API_KEY, MAIL_FROM / MAIL_FROM_BLASTS, optional
 * RESEND_WEBHOOK_SECRET. Optional UNSUBSCRIBE_SECRET (else the service role
 * key signs unsubscribe tokens), APP_URL for the unsubscribe redirect.
 * INSTANTLY_API_KEY / INBOXKIT_API_KEY when a workspace has not saved its
 * own. VERCEL_TOKEN (DNS write) and optional VERCEL_TEAM_ID so domain
 * verification can write the TXT for domains on Vercel DNS.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { type Account, SCOPE, accessFor, has, seal } from '../_shared/google.ts';
import { FREE_MAIL, POSTMASTER_V2_METRICS, dailyAllowance, dayStartUtc, domainOf, isDomain, localParts, postmasterDaysV2, rampDay } from '../_shared/deliverability-rules.ts';
import { SETTINGS_COLUMNS, SENDER_COLUMNS, type SenderRow, checkAutoPauseSender, ensureBlastSender, ensureRepBlastSenders, readUnsubscribeToken, senderById, settingsFor } from '../_shared/mailguard.ts';
import { recordDocsDelivery } from '../_shared/parity/delivery.ts';
import { type EnvLike, blastFrom, classifyResendEvent, ensureResendDomain, parseFrom, resendConnectPayload, resendKeyProblem, suggestBlastFrom, verifyResendWebhook } from '../_shared/resend.ts';
import { verifyRecords } from '../_shared/reoon.ts';
import { inboxkitKey, inboxkitWorkspaceUids, resendEnvFor, resendWebhookSecrets, setWorkspaceSecret, workspaceSecret } from '../_shared/workspace-email.ts';
import { warmupKey } from '../_shared/cold-warmup.ts';
import { InstantlyError, instantlyClient } from '../_shared/instantly.ts';
import { inboxkitClient, listInboxkitWorkspaces } from '../_shared/inboxkit.ts';
import { type DnsWriter, autoVerifyDomain, inboxkitDns, siteVerificationClient, vercelDns } from '../_shared/site-verification.ts';
import { type PmDomain, type RegisterOutcome, mapLimit, pmReadable, postmasterClient, registerDomain } from '../_shared/postmaster.ts';
import { checkDomain } from './dns.ts';

type Any = any;

const APP = () => String(Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com').replace(/\/$/, '');
const ACCOUNT_COLUMNS = 'id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync, gmail_send, gmail_read, status, sync_token, last_calendar_sync_at, last_gmail_sync_at, connected_at';

// ------------------------------------------------------------ unsubscribe
async function unsubscribe(req: Request, admin: SupabaseClient, token: string, cors: Record<string, string>): Promise<Response> {
  const rl = await rateLimit(admin, `unsubscribe:${clientIp(req)}`, 60, 300);
  if (!rl.allowed) return tooMany(cors, rl);
  const claim = await readUnsubscribeToken(token);
  if (!claim) return jsonWith(cors)({ error: 'That unsubscribe link is not valid.' }, 400);
  const { error } = await admin.from('email_suppressions').upsert(
    { workspace_id: claim.w, email: claim.e.toLowerCase(), reason: 'unsubscribe', note: 'One-click unsubscribe', account_id: Number.isFinite(claim.a) && (claim.a ?? 0) > 0 ? claim.a : null },
    { onConflict: 'workspace_id,email', ignoreDuplicates: true },
  );
  if (error) return serverError(cors, 'unsubscribe', error);
  const { data: ws } = await admin.from('workspaces').select('name, settings').eq('id', claim.w).maybeSingle();
  const company = String((ws?.settings as Any)?.company?.name || ws?.name || 'us');
  return jsonWith(cors)({ ok: true, email: claim.e, company });
}

// ---------------------------------------------------------- Resend webhooks
async function resendWebhook(req: Request, admin: SupabaseClient, cors: Record<string, string>): Promise<Response> {
  const json = jsonWith(cors);
  // The project's secret, then each workspace's own Resend account's.
  const secrets = await resendWebhookSecrets(admin);
  if (!secrets.length) return json({ error: 'No Resend webhook secret is set (RESEND_WEBHOOK_SECRET or a workspace secret).' }, 503);
  const raw = await req.text();
  const sig = {
    id: req.headers.get('svix-id') ?? '',
    timestamp: req.headers.get('svix-timestamp') ?? '',
    signature: req.headers.get('svix-signature') ?? '',
  };
  let ok = false;
  for (const secret of secrets) if (await verifyResendWebhook(raw, sig, secret)) { ok = true; break; }
  if (!ok) return json({ error: 'invalid signature' }, 401);
  let body: Any;
  try { body = JSON.parse(raw); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  // Document emails (contracts) also get per-recipient delivered / opened / bounced.
  try { await recordDocsDelivery(admin, body); } catch (e) { console.error('docs delivery', (e as Error).message); }
  const kind = classifyResendEvent(String(body?.type ?? ''), body?.data?.bounce?.type ?? body?.data?.failed?.type ?? null);
  const emailId = String(body?.data?.email_id ?? '').trim();
  const to = (Array.isArray(body?.data?.to) ? body.data.to : [body?.data?.to]).map((x: unknown) => String(x ?? '').trim().toLowerCase()).filter((e: string) => e.includes('@'));
  const at = typeof body?.created_at === 'string' ? body.created_at : new Date().toISOString();
  if (kind === 'ignored' || (!emailId && !to.length)) return json({ ok: true, ignored: true });

  let send: Any = null;
  if (emailId) {
    send = (await admin.from('email_send_log').select('id, workspace_id, sender_id, recipient, bounced_at').eq('provider_id', emailId).maybeSingle()).data;
    if (!send) {
      const comm = (await admin.from('communications').select('workspace_id, to_email').eq('source', 'resend').eq('source_id', emailId).maybeSingle()).data;
      if (comm) send = { id: null, workspace_id: comm.workspace_id, sender_id: null, recipient: String(comm.to_email ?? '').toLowerCase(), bounced_at: null };
    }
  }
  if (!send && to[0]) {
    send = (await admin.from('email_send_log').select('id, workspace_id, sender_id, recipient, bounced_at').eq('recipient', to[0]).not('sender_id', 'is', null).order('sent_at', { ascending: false }).limit(1).maybeSingle()).data;
  }
  if (!send?.workspace_id) return json({ ok: true, unmatched: true });
  const email = (send.recipient || to[0] || '').toLowerCase();
  if (!email) return json({ ok: true, unmatched: true });

  if (kind === 'delivered') {
    if (emailId) await admin.from('communications').update({ status: 'delivered' }).eq('source', 'resend').eq('source_id', emailId).or('status.is.null,status.neq.delivered');
    return json({ ok: true, delivered: true });
  }

  const reason = kind === 'complaint' ? 'complaint' : 'hard_bounce';
  if (send.id && !send.bounced_at && kind === 'hard_bounce') {
    await admin.from('email_send_log').update({ bounced_at: at, bounce_status: 'hard' }).eq('id', send.id);
  }
  await admin.from('email_suppressions').upsert({
    workspace_id: send.workspace_id, email, reason,
    note: kind === 'complaint' ? 'Resend: recipient reported spam' : `Resend hard bounce${emailId ? ` (${emailId})` : ''}`,
  }, { onConflict: 'workspace_id,email', ignoreDuplicates: true });
  const bad = kind === 'complaint' ? 'failed' : 'bounced';
  if (emailId) await admin.from('communications').update({ status: bad }).eq('source', 'resend').eq('source_id', emailId).or(`status.is.null,status.neq.${bad}`);
  let paused: string | null = null;
  if (send.sender_id) paused = await checkAutoPauseSender(admin, { id: send.sender_id, workspace_id: send.workspace_id });
  return json({ ok: true, reason, paused });
}

function senderView(sender: SenderRow) {
  return {
    id: sender.id, from_email: sender.from_email, from_name: sender.from_name, reply_to: sender.reply_to, user_id: sender.user_id, domain: sender.domain, active: sender.active,
    settings: sender, sent_today: 0, allowance: 0, ramp_day: 0, sent_7d: 0, bounced_7d: 0,
  };
}

async function resendOverview(admin: SupabaseClient, ws: number) {
  const wsResend = await resendEnvFor(admin, ws);
  const senders = (await ensureRepBlastSenders(admin, ws, wsResend.env)).map(senderView);
  const from = blastFrom(wsResend.env);
  const primary = senders.find((s) => s.from_email === from?.email) ?? senders[0] ?? null;
  const webhook = `${Deno.env.get('SUPABASE_URL')}/functions/v1/deliverability/resend`;
  const ownHook = !!(await workspaceSecret(admin, ws, 'resend_webhook_secret'));
  const projectHook = !!(Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '').trim();
  const projectKey = !!(Deno.env.get('RESEND_API_KEY') ?? '').trim();
  let suggested: string | null = null;
  if (!from) {
    const { data: acc } = await admin.from('google_accounts').select('email').eq('workspace_id', ws).order('id').limit(5);
    const company = ((acc ?? []) as Any[]).map((a) => domainOf(String(a.email))).find((d) => isDomain(d) && !FREE_MAIL.has(d)) ?? null;
    suggested = suggestBlastFrom(wsResend.company, company);
  }
  return {
    configured: !!from, from: from?.from ?? null, email: from?.email ?? null, domain: from?.domain ?? primary?.domain ?? null,
    own_key: wsResend.ownKey, own_from: wsResend.ownFrom, key_source: wsResend.ownKey ? 'workspace' : projectKey ? 'project' : null,
    suggested_from: suggested,
    webhook_url: webhook, webhook_secret_set: wsResend.ownKey ? ownHook : ownHook || projectHook, own_webhook_secret: ownHook,
    sender: primary,
    senders,
    env: wsResend.env,
  };
}

/** The overview's Resend block without the env (it never leaves the server). */
const resendView = ({ env: _env, ...rest }: Awaited<ReturnType<typeof resendOverview>>) => rest;

/** A pool address in this workspace, or the primary blast sender when no id is given. */
async function senderInWorkspace(admin: SupabaseClient, ws: number, id: unknown): Promise<SenderRow | null> {
  const wanted = Number(id);
  if (Number.isFinite(wanted) && wanted > 0) {
    const row = await senderById(admin, wanted);
    return row && row.workspace_id === ws ? row : null;
  }
  return ensureBlastSender(admin, ws);
}

/** Every domain this workspace sends from: its active domains, its cold domains, and its blast domain. Never another workspace's. */
async function workspaceDomains(admin: SupabaseClient, ws: number, env?: EnvLike): Promise<string[]> {
  const [{ data: doms }, { data: cold }] = await Promise.all([
    admin.from('email_domains').select('domain').eq('workspace_id', ws).eq('active', true),
    admin.from('cold_domains').select('domain').eq('workspace_id', ws),
  ]);
  const blast = blastFrom(env ?? (await resendEnvFor(admin, ws)).env)?.domain ?? null;
  const all = [...((doms ?? []) as Any[]), ...((cold ?? []) as Any[])].map((d) => String(d.domain).toLowerCase());
  if (blast) all.push(blast);
  return [...new Set(all.filter((d) => isDomain(d) && !FREE_MAIL.has(d)))].sort();
}

// -------------------------------------------------------------- postmaster
/**
 * Postmaster Tools v2, last 30 days, for every one of this workspace's
 * domains the connected account sees there: domains.list (all pages), then
 * domainStats:query (DAILY, BATCH at a time) for spam rate,
 * SPF / DKIM / DMARC pass rates and the delivery-error rate. Google retired
 * v1 (trafficStats), and v2 has no domain reputation, so `reputation` is
 * always null. v2 needs postmaster.domain and postmaster.traffic.readonly;
 * an account that only granted v1's postmaster.readonly reads as not
 * granted, so the panel offers Connect Postmaster again.
 *
 * A workspace domain Postmaster does not list (or lists unverified) goes
 * through Site Verification, then registerDomain adds it to Postmaster and
 * verifies it there (_shared/postmaster.ts). Each verification row says
 * whether that worked (`postmaster`: ready, added, manual, error).
 */
async function postmaster(admin: SupabaseClient, ws: number, account: Account, known: string[], force: boolean) {
  const siteOk = has(account, SCOPE.siteVerification);
  if (!has(account, SCOPE.postmaster) || !has(account, SCOPE.postmasterDomains)) return { granted: false, site_verification: siteOk, domains: [], unverified: known, verification: await verificationRows(admin, ws, known) };
  const token = await accessFor(admin, account);
  if (!token) return { granted: true, site_verification: siteOk, error: 'Google needs this connection approved again.', domains: [], unverified: known, verification: await verificationRows(admin, ws, known) };
  const deadline = Date.now() + BUDGET_MS;
  const pm = postmasterClient(token);
  const listed = new Map<string, PmDomain>();
  let listOk = false;
  let error: string | undefined;
  try {
    for (const d of await pm.listDomains()) listed.set(d.domain, d);
    listOk = true;
  } catch (err) {
    const status = Number((err as Any).status ?? 0);
    const said = err instanceof Error ? err.message.slice(0, 200) : '';
    console.error('postmaster domains.list', status, said);
    error = status === 403
      ? `Postmaster Tools refused this account (${said || '403'}). Check the Gmail Postmaster Tools API is enabled on the Google Cloud project, then press Connect Postmaster again.`
      : status === 401
        ? 'Google needs this connection approved again. Press Connect Postmaster.'
        : `Postmaster Tools did not answer${said ? `: ${said}` : ''}. Try again shortly.`;
  }
  // Only this workspace's domains, even when the Google account sees more.
  const notReadable = known.filter((k) => !pmReadable(listed.get(k)));
  const writers = lazyWriters(admin, ws);
  const site = siteOk
    ? await runVerification(admin, ws, account, token, notReadable, force, deadline, writers)
    : { rows: await verificationRows(admin, ws, notReadable), remaining: 0 };
  // Add each missing domain to Postmaster and verify it there, after Site Verification had its go.
  const added = new Map<string, RegisterOutcome>();
  if (listOk && notReadable.length) {
    const blocked = { reason: null as string | null };
    const dns = await writers();
    const outs = await mapLimit(notReadable, BATCH, (d) => registerDomain(d, { pm, writers: dns, listed: listed.get(d), blocked }), deadline);
    notReadable.forEach((d, i) => { const o = outs[i]; if (o) added.set(d, o); });
  }
  const readable = known.filter((k) => pmReadable(listed.get(k)) || added.get(k)?.postmaster === 'ready');
  const end = new Date(Date.now() - 86_400_000);
  const start = new Date(Date.now() - 30 * 86_400_000);
  const date = (x: Date) => ({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() });
  const stats = await mapLimit(readable, BATCH, (name) => pm.queryStats(name, {
    metricDefinitions: POSTMASTER_V2_METRICS,
    timeQuery: { dateRanges: { dateRanges: [{ start: date(start), end: date(end) }] } },
    aggregationGranularity: 'DAILY',
    pageSize: 200,
  }).catch((err) => { console.error('postmaster domainStats', name, (err as Any).status, err instanceof Error ? err.message : err); return { domainStats: [] }; }));
  const domains = readable.map((name, i) => ({ domain: name, days: postmasterDaysV2(((stats[i] as Any)?.domainStats ?? []) as unknown[]) }));
  const unverified = known.filter((k) => !readable.includes(k));
  const verification = site.rows.filter((v) => unverified.includes(v.domain)).map((v) => ({
    ...v, postmaster: added.get(v.domain)?.postmaster ?? null, postmaster_detail: added.get(v.domain)?.detail ?? null,
  }));
  return { granted: true, site_verification: siteOk, error, domains, unverified, verification, remaining: site.remaining };
}

// ------------------------------------------------------ domain verification
const VERIFY_COLUMNS = 'domain, account_id, status, dns_host, token, detail, attempts, checked_at, verified_at';
/** Retry a pending domain after 2 minutes, an error or no-DNS one after 30. */
const RETRY_MS: Record<string, number> = { pending: 120_000, error: 1_800_000, needs_dns: 1_800_000 };
/** Domains worked on at once (Google, InboxKit and Vercel calls), and how long one load may spend on them. */
const BATCH = 4;
const BUDGET_MS = 70_000;

async function verificationRows(admin: SupabaseClient, ws: number, domains: string[]) {
  if (!domains.length) return [];
  const { data } = await admin.from('email_domain_verifications').select(VERIFY_COLUMNS).eq('workspace_id', ws).in('domain', domains);
  const by = new Map(((data ?? []) as Any[]).map((r) => [r.domain as string, r]));
  return domains.map((domain) => {
    const r = by.get(domain);
    return { domain, status: r?.status ?? 'unchecked', dns_host: r?.dns_host ?? null, txt: r?.status === 'verified' ? null : r?.token ?? null, detail: r?.detail ?? null, checked_at: r?.checked_at ?? null, attempts: r?.attempts ?? 0 };
  });
}

/** Where CLOZR can write a TXT for this workspace: InboxKit (cold domains) first, then Vercel DNS. */
async function dnsWriters(admin: SupabaseClient, ws: number): Promise<DnsWriter[]> {
  const out: DnsWriter[] = [];
  const kit = await inboxkitKey(admin, ws);
  if (kit.key) {
    const uids = await inboxkitWorkspaceUids(admin, ws, kit.key).catch(() => [] as string[]);
    if (uids.length) out.push(inboxkitDns(uids.slice(0, 5).map((uid) => inboxkitClient(kit.key!, uid))));
  }
  const vercel = (Deno.env.get('VERCEL_TOKEN') ?? '').trim();
  if (vercel) out.push(vercelDns(vercel, (Deno.env.get('VERCEL_TEAM_ID') ?? '').trim() || null));
  return out;
}

/** dnsWriters once per request, only when something needs it. */
function lazyWriters(admin: SupabaseClient, ws: number): () => Promise<DnsWriter[]> {
  let p: Promise<DnsWriter[]> | null = null;
  return () => (p ??= dnsWriters(admin, ws).catch((err) => { console.error('dns writers', err instanceof Error ? err.message : err); return []; }));
}

/**
 * Site Verification for every due domain, BATCH at a time. Domains not
 * started before `deadline` keep their row and stay due, so the next load
 * (the card re-checks while any are left) picks them up.
 */
async function runVerification(admin: SupabaseClient, ws: number, account: Account, token: string, domains: string[], force: boolean, deadline: number, writers: () => Promise<DnsWriter[]>) {
  if (!domains.length) return { rows: [], remaining: 0 };
  const { data } = await admin.from('email_domain_verifications').select(VERIFY_COLUMNS).eq('workspace_id', ws).in('domain', domains);
  const by = new Map(((data ?? []) as Any[]).map((r) => [r.domain as string, r]));
  const now = Date.now();
  // A reconnect (new scopes, an API switched on since) makes every older row due, whatever its status said.
  const reconnected = Date.parse(String((account as Any).connected_at ?? '')) || 0;
  const due = domains.filter((domain) => {
    const r = by.get(domain);
    if (!r) return true;
    if (r.status === 'verified' && r.account_id === account.id) return false;
    if (force || r.account_id !== account.id) return true;
    if (!r.checked_at || Date.parse(r.checked_at) < reconnected) return true;
    return now - Date.parse(r.checked_at) > (RETRY_MS[r.status] ?? 0);
  });
  let remaining = 0;
  if (due.length) {
    const google = siteVerificationClient(token);
    let verified = new Set<string>();
    let listError: string | null = null;
    try { verified = await google.verifiedDomains(); } catch (err) {
      const said = err instanceof Error ? err.message.slice(0, 160) : 'unknown error';
      listError = (err as Any).status === 403
        ? `Google refused Site Verification (${said}). Reconnect Postmaster and allow domain verification, and check the Site Verification API is enabled on the Google Cloud project.`
        : `Site Verification did not answer: ${said}.`;
    }
    const dns = listError ? [] : await writers();
    const at = new Date().toISOString();
    const done = await mapLimit(due, BATCH, async (domain) => {
      const prev = by.get(domain);
      const sameAccount = prev?.account_id === account.id;
      const outcome = listError
        ? { status: 'error' as const, dns_host: null, token: sameAccount ? prev?.token ?? null : null, detail: listError }
        : await autoVerifyDomain(domain, { google, verified, writers: dns, knownToken: sameAccount ? prev?.token ?? null : null });
      const row = {
        workspace_id: ws, domain, account_id: account.id, status: outcome.status, dns_host: outcome.dns_host ?? prev?.dns_host ?? null,
        token: outcome.token, detail: outcome.detail, attempts: (sameAccount ? Number(prev?.attempts ?? 0) : 0) + 1, checked_at: at,
        verified_at: outcome.status === 'verified' ? at : null,
      };
      const { error } = await admin.from('email_domain_verifications').upsert(row, { onConflict: 'workspace_id,domain' });
      if (error) console.error('domain verification store', domain, error.message);
      return true;
    }, deadline);
    remaining = done.filter((x) => !x).length;
  }
  return { rows: await verificationRows(admin, ws, domains), remaining };
}

// ----------------------------------------------------------------- warm-up
/**
 * Instantly runs warm-up for the cold inboxes; InboxKit hosts them. This
 * reads both for the workspace's own mailboxes:
 *
 *   Instantly  GET /accounts (warming, stat_warmup_score) and POST
 *              /accounts/warmup-analytics (14 days sent, inbox, spam)
 *   InboxKit   POST /mailboxes/list (status) and GET
 *              /email-insights/workspace/mailboxes-health (7-day health)
 *
 * With the workspace's own key every mailbox on that account is shown. With
 * the project key (INSTANTLY_API_KEY / INBOXKIT_API_KEY, shared across
 * workspaces) only mailboxes on this workspace's domains are, so one
 * workspace never sees another's inboxes.
 */
type WarmRow = {
  email: string;
  instantly: boolean; warming: boolean | null; score: number | null; sent14: number; inbox14: number; spam14: number; inbox_pct: number | null; spam_pct: number | null;
  inboxkit: boolean; inboxkit_status: string | null; health: string | null; sent7: number | null; bounce_pct: number | null; last_event_at: string | null;
};

async function warmup(admin: SupabaseClient, ws: number) {
  const { data: own } = await admin.from('cold_warmup_secrets').select('api_key').eq('workspace_id', ws).maybeSingle();
  const instKey = await warmupKey(admin, ws);
  const kit = await inboxkitKey(admin, ws);
  const instOwn = !!(own as Any)?.api_key;
  const domains = new Set(await workspaceDomains(admin, ws));
  const mine = (email: string, ownKey: boolean) => ownKey || domains.has(domainOf(email));
  const rows = new Map<string, WarmRow>();
  const rowFor = (email: string): WarmRow => {
    const key = email.toLowerCase();
    if (!rows.has(key)) rows.set(key, { email: key, instantly: false, warming: null, score: null, sent14: 0, inbox14: 0, spam14: 0, inbox_pct: null, spam_pct: null, inboxkit: false, inboxkit_status: null, health: null, sent7: null, bounce_pct: null, last_event_at: null });
    return rows.get(key)!;
  };
  const out = {
    instantly: { connected: !!instKey, own: instOwn, error: null as string | null },
    inboxkit: { connected: !!kit.key, own: kit.own, error: null as string | null },
    mailboxes: [] as WarmRow[],
  };
  if (instKey) {
    try {
      const client = instantlyClient(instKey, { maxPages: 10 });
      const accounts = (await client.listAccounts()).filter((a) => mine(a.email, instOwn)).slice(0, 500);
      const stats = await client.warmupAnalytics(accounts.map((a) => a.email));
      for (const a of accounts) {
        const s = stats.get(a.email);
        const r = rowFor(a.email);
        r.instantly = true;
        r.warming = a.warming;
        r.score = s?.score ?? a.warmupScore;
        r.sent14 = s?.sent ?? 0;
        r.inbox14 = s?.inbox ?? 0;
        r.spam14 = s?.spam ?? 0;
        r.inbox_pct = r.sent14 ? r.inbox14 / r.sent14 : null;
        r.spam_pct = r.sent14 ? r.spam14 / r.sent14 : null;
      }
    } catch (err) {
      out.instantly.error = err instanceof InstantlyError && err.status === 401 ? 'Instantly rejected the API key. Paste a new one below.' : `Instantly did not answer: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown error'}.`;
    }
  }
  if (kit.key) {
    try {
      const uids = (await inboxkitWorkspaceUids(admin, ws, kit.key)).slice(0, 5);
      for (const uid of uids) {
        const client = inboxkitClient(kit.key, uid, { maxPages: 10 });
        const boxes = (await client.listMailboxes()).filter((m) => mine(m.email, kit.own));
        const health = new Map((await client.mailboxesHealth().catch(() => [])).map((h) => [h.uid, h]));
        for (const m of boxes) {
          const r = rowFor(m.email);
          const h = health.get(m.uid);
          r.inboxkit = true;
          r.inboxkit_status = m.status || null;
          r.health = h?.status ?? 'inactive';
          r.sent7 = h?.sent7 ?? 0;
          r.bounce_pct = h?.bounceRatePct ?? null;
          r.last_event_at = h?.lastEventAt ?? null;
        }
      }
    } catch (err) {
      out.inboxkit.error = err instanceof Error && /401/.test(err.message) ? 'InboxKit rejected the API key. Paste a new one below.' : `InboxKit did not answer: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown error'}.`;
    }
  }
  out.mailboxes = [...rows.values()].sort((a, b) => a.email.localeCompare(b.email));
  return out;
}

// ----------------------------------------------------------------- overview
async function overview(admin: SupabaseClient, ws: number) {
  const { data: accounts } = await admin.from('google_accounts').select('id, user_id, email, scopes, gmail_send, gmail_read, status, last_gmail_sync_at, connected_at').eq('workspace_id', ws).order('id');
  const accs = (accounts ?? []) as Any[];
  // Every connected account's company domain is a sending domain.
  const detected = [...new Set(accs.map((a) => domainOf(a.email)).filter((d) => isDomain(d) && !FREE_MAIL.has(d)))];
  if (detected.length) await admin.from('email_domains').upsert(detected.map((domain) => ({ workspace_id: ws, domain, source: 'google' })), { onConflict: 'workspace_id,domain', ignoreDuplicates: true });

  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: domains }, { data: sup }, { data: log }, { data: instantlyOwn }, { data: roster }] = await Promise.all([
    admin.from('email_domains').select('id, domain, source, dkim_selectors, tracking_domain, uses_resend, score, blocking, report, checked_at').eq('workspace_id', ws).eq('active', true).order('domain'),
    admin.from('email_suppressions').select('id, email, reason, note, account_id, created_at').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(500),
    admin.from('email_send_log').select('account_id, sender_id, kind, sent_at, bounced_at').eq('workspace_id', ws).gte('sent_at', since30).limit(50_000),
    admin.from('cold_warmup_secrets').select('workspace_id').eq('workspace_id', ws).maybeSingle(),
    admin.from('workspace_roster').select('user_id, full_name, email').eq('workspace_id', ws),
  ]);
  const names = new Map(((roster ?? []) as Any[]).map((r) => [r.user_id, r.full_name || r.email]));
  const rows = (log ?? []) as Any[];
  const now = new Date();
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const mailboxes = [];
  for (const a of accs) {
    const m = await settingsFor(admin, a);
    const mine = rows.filter((r) => r.account_id === a.id);
    const dayStart = dayStartUtc(now, m.timezone).toISOString();
    const week = mine.filter((r) => r.sent_at >= since7);
    const today = localParts(now, m.timezone).date;
    mailboxes.push({
      account_id: a.id, email: a.email, owner: names.get(a.user_id) ?? null, user_id: a.user_id, status: a.status,
      gmail_send: a.gmail_send, gmail_read: a.gmail_read && (a.scopes ?? []).includes(SCOPE.gmailRead), postmaster: (a.scopes ?? []).includes(SCOPE.postmaster) && (a.scopes ?? []).includes(SCOPE.postmasterDomains),
      settings: m,
      sent_today: mine.filter((r) => r.sent_at >= dayStart).length,
      allowance: dailyAllowance(m, today), ramp_day: rampDay(m, today) + 1,
      sent_7d: week.length, bounced_7d: week.filter((r) => r.bounced_at).length,
      bulk_30d: mine.filter((r) => r.kind === 'bulk').length,
    });
  }
  const blast = await resendOverview(admin, ws);
  for (const view of blast.senders) {
    const mine = rows.filter((r) => r.sender_id === view.id);
    const dayStart = dayStartUtc(now, view.settings.timezone).toISOString();
    const week = mine.filter((r) => r.sent_at >= since7);
    const today = localParts(now, view.settings.timezone).date;
    view.sent_today = mine.filter((r) => r.sent_at >= dayStart).length;
    view.allowance = dailyAllowance(view.settings, today);
    view.ramp_day = rampDay(view.settings, today) + 1;
    view.sent_7d = week.length;
    view.bounced_7d = week.filter((r) => r.bounced_at).length;
  }
  const kit = await inboxkitKey(admin, ws);
  const warmupKeys = {
    instantly: !!instantlyOwn || !!(Deno.env.get('INSTANTLY_API_KEY') ?? '').trim(), instantly_own: !!instantlyOwn,
    inboxkit: !!kit.key, inboxkit_own: kit.own,
  };
  return { domains: domains ?? [], mailboxes, suppressions: sup ?? [], warmup: warmupKeys, resend: resendView(blast) };
}

// --------------------------------------------------------------------- serve
const SETTABLE = ['daily_cap', 'hourly_cap', 'min_gap_seconds', 'window_start', 'window_end', 'window_days', 'timezone', 'ramp_enabled', 'ramp_start', 'ramp_increase_pct', 'ramp_target', 'ramp_started_on'] as const;

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'GET, POST, OPTIONS' });
  const json = jsonWith(cors);
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (url.pathname.endsWith('/unsubscribe')) {
    const t = url.searchParams.get('t') ?? '';
    // Gmail's one-click POSTs form-encoded "List-Unsubscribe=One-Click" here; a browser GET goes to the page that asks first.
    if (req.method === 'POST') return unsubscribe(req, admin, t, cors);
    return new Response(null, { status: 302, headers: { ...HARDENING, Location: `${APP()}/unsubscribe/?t=${encodeURIComponent(t)}` } });
  }
  if (url.pathname.endsWith('/resend')) {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    return resendWebhook(req, admin, cors);
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  if (b.action === 'unsubscribe') return unsubscribe(req, admin, String(b.t ?? ''), cors);

  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const isAdmin = member.role === 'owner' || member.role === 'admin';
  const adminOnly = () => json({ error: 'Only an owner or admin can change this.' }, 403);

  const rl = await rateLimit(admin, `deliverability:${who.user.id}:${clientIp(req)}`, 60, 300);
  if (!rl.allowed) return tooMany(cors, rl);

  const accountIn = async (id: unknown) => {
    const { data } = await admin.from('google_accounts').select(ACCOUNT_COLUMNS).eq('workspace_id', ws).eq('id', Number(id)).maybeSingle();
    return data as Account | null;
  };

  try {
    switch (b.action) {
      case 'overview':
        return json({ ...(await overview(admin, ws)), me: { user_id: who.user.id, admin: isAdmin } });

      case 'add_domain': {
        if (!isAdmin) return adminOnly();
        const domain = String(b.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^.*@/, '').replace(/\/.*$/, '');
        if (!isDomain(domain)) return json({ error: 'That is not a domain name.' }, 422);
        const tracking = String(b.tracking_domain ?? '').trim().toLowerCase();
        if (tracking && !isDomain(tracking)) return json({ error: 'The link domain is not a domain name.' }, 422);
        const selectors = (Array.isArray(b.dkim_selectors) ? b.dkim_selectors : String(b.dkim_selectors ?? '').split(','))
          .map((s: unknown) => String(s).trim().toLowerCase()).filter((s: string) => /^[a-z0-9._-]{1,63}$/.test(s)).slice(0, 10);
        const { data, error } = await admin.from('email_domains').upsert({ workspace_id: ws, domain, dkim_selectors: selectors, tracking_domain: tracking || null, uses_resend: b.uses_resend === true, active: true }, { onConflict: 'workspace_id,domain' }).select('id').single();
        if (error) throw error;
        return json({ ok: true, id: data.id });
      }

      case 'remove_domain': {
        if (!isAdmin) return adminOnly();
        // Switched off, not deleted: its checks and history stay, and adding it again turns it back on.
        await admin.from('email_domains').update({ active: false }).eq('workspace_id', ws).eq('id', Number(b.id));
        return json({ ok: true });
      }

      case 'check_domain': {
        const { data: d } = await admin.from('email_domains').select('id, domain, source, dkim_selectors, tracking_domain, uses_resend').eq('workspace_id', ws).eq('id', Number(b.id)).maybeSingle();
        if (!d) return json({ error: 'domain not found' }, 404);
        const drl = await rateLimit(admin, `deliverability-dns:${ws}:${d.id}`, 6, 300);
        if (!drl.allowed) return tooMany(cors, drl);
        const r = await checkDomain(d.domain, { dkim_selectors: d.dkim_selectors ?? [], tracking_domain: d.tracking_domain, uses_resend: d.uses_resend || blastFrom((await resendEnvFor(admin, ws)).env)?.domain === d.domain, google_hint: d.source === 'google' });
        await admin.from('email_domains').update({ score: r.score, blocking: r.blocking, report: { checks: r.checks, provider: r.provider }, checked_at: r.checked_at }).eq('id', d.id);
        return json({ ok: true, ...r });
      }

      case 'save_mailbox': {
        if (!isAdmin) return adminOnly();
        const account = await accountIn(b.account_id);
        if (!account) return json({ error: 'mailbox not found' }, 404);
        await settingsFor(admin, account);
        const patch: Any = {};
        for (const k of SETTABLE) if (b.settings && k in b.settings) patch[k] = b.settings[k];
        if ('timezone' in patch) { try { new Intl.DateTimeFormat('en-US', { timeZone: String(patch.timezone) }); } catch { return json({ error: 'Unknown time zone.' }, 422); } }
        const { data, error } = await admin.from('mailbox_settings').update(patch).eq('account_id', account.id).select(SETTINGS_COLUMNS).single();
        // The table's CHECK constraints are the validation; say which rule, not the SQL.
        if (error) return json({ error: `Those settings are out of range (${error.message.includes('window') ? 'the window must end after it starts' : 'caps 1Ã¢â‚¬â€œ2000, spacing 0Ã¢â‚¬â€œ3600s, increase 0Ã¢â‚¬â€œ100%'}).` }, 422);
        return json({ ok: true, settings: data });
      }

      case 'pause_mailbox':
      case 'resume_mailbox': {
        if (!isAdmin) return adminOnly();
        const account = await accountIn(b.account_id);
        if (!account) return json({ error: 'mailbox not found' }, 404);
        await settingsFor(admin, account);
        const pause = b.action === 'pause_mailbox';
        await admin.from('mailbox_settings').update(pause
          ? { paused: true, paused_auto: false, paused_reason: String(b.reason ?? '').slice(0, 200) || 'Paused by an admin.', paused_at: new Date().toISOString() }
          : { paused: false, paused_auto: false, paused_reason: null, paused_at: null }).eq('account_id', account.id);
        return json({ ok: true });
      }

      case 'suppress': {
        const email = String(b.email ?? '').trim().toLowerCase();
        if (!/^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/.test(email)) return json({ error: 'Enter one email address.' }, 422);
        const reason = ['manual', 'unsubscribe', 'complaint', 'hard_bounce'].includes(b.reason) ? b.reason : 'manual';
        const { error } = await admin.from('email_suppressions').upsert({ workspace_id: ws, email, reason, note: String(b.note ?? '').slice(0, 300) || null, created_by: who.user.id }, { onConflict: 'workspace_id,email' });
        if (error) throw error;
        return json({ ok: true });
      }

      case 'unsuppress': {
        if (!isAdmin) return adminOnly();
        await admin.from('email_suppressions').delete().eq('workspace_id', ws).eq('email', String(b.email ?? '').trim().toLowerCase());
        return json({ ok: true });
      }

      case 'postmaster': {
        const { data: account } = await admin.from('google_accounts').select(ACCOUNT_COLUMNS).eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
        const known = await workspaceDomains(admin, ws);
        if (!account) return json({ connected: false, granted: false, site_verification: false, domains: [], unverified: known, verification: await verificationRows(admin, ws, known) });
        const force = b.verify === true;
        if (force) {
          const vrl = await rateLimit(admin, `deliverability-verify:${ws}`, 6, 300);
          if (!vrl.allowed) return tooMany(cors, vrl);
        }
        return json({ connected: true, ...(await postmaster(admin, ws, account as Account, known, force)) });
      }

      case 'warmup': {
        const wrl = await rateLimit(admin, `deliverability-warmup:${ws}`, 20, 300);
        if (!wrl.allowed) return tooMany(cors, wrl);
        return json(await warmup(admin, ws));
      }

      case 'warmup_keys': {
        if (!isAdmin) return adminOnly();
        const given = (v: unknown) => (v === null ? '' : typeof v === 'string' ? v.trim() : undefined);
        const inst = given(b.instantly_key);
        const kit = given(b.inboxkit_key);
        if (inst) {
          try { await instantlyClient(inst, { maxPages: 1 }).listAccounts(); } catch (err) {
            return json({ error: err instanceof InstantlyError && err.status === 401 ? 'Instantly rejected that API key. Use an API v2 key from Instantly, Settings, Integrations.' : 'Could not reach Instantly to check that key.' }, 422);
          }
        }
        if (kit) {
          try { await listInboxkitWorkspaces(kit); } catch (err) {
            return json({ error: err instanceof Error && /401/.test(err.message) ? 'InboxKit rejected that API key.' : 'Could not reach InboxKit to check that key.' }, 422);
          }
        }
        // The Instantly key is the same one the cold pool's warm-up gate reads (cold_warmup_secrets).
        if (inst === '') await admin.from('cold_warmup_secrets').delete().eq('workspace_id', ws);
        else if (inst) {
          const { error } = await admin.from('cold_warmup_secrets').upsert({ workspace_id: ws, api_key: await seal(inst) }, { onConflict: 'workspace_id' });
          if (error) throw error;
        }
        if (kit !== undefined) await setWorkspaceSecret(admin, ws, 'inboxkit_key', kit || null);
        return json({ ok: true });
      }

      case 'resend_key': {
        if (!isAdmin) return adminOnly();
        if (b.key !== undefined) {
          const key = typeof b.key === 'string' ? b.key.trim() : '';
          if (key) {
            const problem = await resendKeyProblem(key);
            if (problem) return json({ error: problem }, 422);
          }
          await setWorkspaceSecret(admin, ws, 'resend_key', key || null);
        }
        if (b.webhook_secret !== undefined) {
          const secret = typeof b.webhook_secret === 'string' ? b.webhook_secret.trim() : '';
          if (secret && !/^whsec_[A-Za-z0-9+/=]{16,}$/.test(secret)) return json({ error: 'That does not look like a Resend signing secret (it starts with whsec_).' }, 422);
          await setWorkspaceSecret(admin, ws, 'resend_webhook_secret', secret || null);
        }
        return json({ ok: true, resend: resendView(await resendOverview(admin, ws)) });
      }

      case 'blast_sender': {
        if (!isAdmin) return adminOnly();
        const raw = typeof b.from === 'string' ? b.from.trim() : '';
        const from = raw ? parseFrom(raw) : null;
        if (raw && !from) return json({ error: 'Enter a sender like Acme Homes <deals@deals.yourcompany.com> on your own domain (not Gmail or Outlook).' }, 422);
        const { data: wsRow } = await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle();
        const settings = { ...((wsRow?.settings ?? {}) as Any) };
        if (from) settings.blast_from = from.from;
        else delete settings.blast_from;
        const { error } = await admin.from('workspaces').update({ settings }).eq('id', ws);
        if (error) throw error;
        const wsResend = await resendEnvFor(admin, ws);
        const now = blastFrom(wsResend.env);
        // Addresses on a domain this workspace no longer blasts from stop rotating (kept, not deleted).
        const keep = new Set([now?.domain, ...(Array.isArray(settings.blast_domains) ? settings.blast_domains : [])].map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean));
        const { data: active } = await admin.from('email_senders').select('id, domain').eq('workspace_id', ws).eq('provider', 'resend').eq('active', true);
        const stale = ((active ?? []) as Any[]).filter((s) => !keep.has(String(s.domain).toLowerCase())).map((s) => s.id);
        if (stale.length) await admin.from('email_senders').update({ active: false }).in('id', stale);
        if (now) {
          await admin.from('email_domains').upsert({ workspace_id: ws, domain: now.domain, source: 'manual', uses_resend: true, active: true }, { onConflict: 'workspace_id,domain' });
          await ensureRepBlastSenders(admin, ws, wsResend.env);
        }
        return json({ ok: true, retired: stale.length, resend: resendView(await resendOverview(admin, ws)) });
      }

      case 'resend_status': {
        const blast = await resendOverview(admin, ws);
        let records: Any[] = [];
        let status: string | null = null;
        let region: string | null = null;
        let error: string | null = null;
        if (blast.domain) {
          const added = await ensureResendDomain(blast.domain, blast.env);
          if (!('error' in added)) {
            const view = resendConnectPayload(added, blast.domain);
            records = view.records;
            status = view.status;
            region = view.region;
          } else error = added.error;
        }
        return json({ ...resendView(blast), records, status, region, error });
      }

      case 'resend_ensure_domain': {
        if (!isAdmin) return adminOnly();
        const blast = await resendOverview(admin, ws);
        const name = String(b.domain ?? blast.domain ?? '').trim().toLowerCase();
        if (!name) return json({ error: 'Set the blast sender first, for example deals@deals.yourdomain.com.' }, 422);
        if (!isDomain(name)) return json({ error: 'That is not a domain name.' }, 422);
        const added = await ensureResendDomain(name, blast.env);
        if ('error' in added) return json({ error: added.error }, 422);
        const view = resendConnectPayload(added, name);
        const { data: row } = await admin.from('email_domains').upsert(
          { workspace_id: ws, domain: name, source: 'manual', uses_resend: true, active: true },
          { onConflict: 'workspace_id,domain' },
        ).select('id, domain, source, dkim_selectors, tracking_domain, uses_resend').single();
        if (row) {
          const r = await checkDomain(row.domain, { dkim_selectors: row.dkim_selectors ?? [], tracking_domain: row.tracking_domain, uses_resend: true, google_hint: false });
          await admin.from('email_domains').update({ score: r.score, blocking: r.blocking, report: { checks: r.checks, provider: r.provider }, checked_at: r.checked_at }).eq('id', row.id);
        }
        return json({ ok: true, domain: view.domain, status: view.status, region: view.region, records: view.records });
      }

      case 'save_sender': {
        if (!isAdmin) return adminOnly();
        const sender = await senderInWorkspace(admin, ws, b.sender_id);
        if (!sender) return json({ error: 'Resend is not set up for this workspace. Add its Resend key and blast sender under Buyer blasts.' }, 422);
        const patch: Any = {};
        for (const k of SETTABLE) if (b.settings && k in b.settings) patch[k] = b.settings[k];
        if ('timezone' in patch) { try { new Intl.DateTimeFormat('en-US', { timeZone: String(patch.timezone) }); } catch { return json({ error: 'Unknown time zone.' }, 422); } }
        const { data, error } = await admin.from('email_senders').update(patch).eq('id', sender.id).select(SENDER_COLUMNS).single();
        if (error) return json({ error: `Those settings are out of range (${error.message.includes('window') ? 'the window must end after it starts' : 'caps 1Ã¢â‚¬â€œ2000, spacing 0Ã¢â‚¬â€œ3600s, increase 0Ã¢â‚¬â€œ100%'}).` }, 422);
        return json({ ok: true, settings: data });
      }

      case 'verify_emails': {
        const rlVerify = await rateLimit(admin, `verify-email:${ws}:${who.user.id}`, 20, 600);
        if (!rlVerify.allowed) return tooMany(cors, rlVerify);
        const out = await verifyRecords(admin, ws, { buyer_ids: b.buyer_ids, seller_ids: b.seller_ids });
        if (!out.ok) return json({ error: out.error, pending: out.pending ?? false, task_id: out.task_id ?? null }, out.missingKey ? 503 : 422);
        return json({ ok: true, verified: out.verified, updated: out.updated, missing: out.missing, results: out.results });
      }

      case 'pause_sender':
      case 'resume_sender': {
        if (!isAdmin) return adminOnly();
        const sender = await senderInWorkspace(admin, ws, b.sender_id);
        if (!sender) return json({ error: 'Resend is not set up for this workspace. Add its Resend key and blast sender under Buyer blasts.' }, 422);
        const pause = b.action === 'pause_sender';
        await admin.from('email_senders').update(pause
          ? { paused: true, paused_auto: false, paused_reason: String(b.reason ?? '').slice(0, 200) || 'Paused by an admin.', paused_at: new Date().toISOString() }
          : { paused: false, paused_auto: false, paused_reason: null, paused_at: null }).eq('id', sender.id);
        return json({ ok: true });
      }

      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (err) {
    return serverError(cors, 'deliverability', err);
  }
});
