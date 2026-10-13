/**
 * POST /cold-pool — Settings → Outbound OS → cold email pool.
 *
 * Body: { workspace_id, action, ... }
 *   overview, health                         any member
 *   save_blocked { extra }                   owner/admin
 *   save_warmup  { provider, api_base, key, instantly_tag } owner/admin.
 *                The key is sealed. provider 'instantly' turns the gate on: a
 *                warming mailbox sends no cold mail until it has warmed 14 days
 *                with an Instantly score of 90 (_shared/cold-warmup.ts).
 *                instantly_tag is Instantly's warmup filter tag; the worker
 *                ignores that mail.
 *   sync_warmup                              owner/admin. Reads Instantly now,
 *                                            stores the reading, promotes and
 *                                            pauses. The cron does the same daily.
 *   import_inboxkit { inboxkit_workspace_id? } owner/admin. Lists that InboxKit
 *                                            workspace (its own InboxKit key, else INBOXKIT_API_KEY), seals
 *                                            each app password, adds the new
 *                                            Google mailboxes as warming. With no
 *                                            id, the key's only workspace (or the
 *                                            only one with domains) is used; the
 *                                            id is remembered either way.
 *   add_domain, check_domain, save_domain, remove_domain
 *   import_csv { csv }                       SMTP/IMAP rows. An email and an app
 *                                            password are enough; blank hosts use
 *                                            smtp.gmail.com and imap.gmail.com.
 *                                            Passwords are sealed and never returned.
 *   google_start, microsoft_start            { url } to the consent screen
 *   pause_mailbox, resume_mailbox, save_mailbox
 *   save_deliverability { physical_address, deliverability } owner/admin
 *   save_campaign, launch, pause_campaign, resume_campaign
 *
 * GET /cold-pool/callback     Google sends the browser here (no JWT).
 * GET /cold-pool/microsoft    Microsoft sends the browser here (no JWT).
 *
 * verify_jwt is off because those redirects have no session. Every other
 * action checks the caller's JWT and workspace membership.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { domainOf, isDomain } from '../_shared/deliverability-rules.ts';
import { checkDomain } from '../deliverability/dns.ts';
import { ENTITY_LABELS, entityKind } from '../../../lib/market-geo.ts';
import {
  DEFAULT_BLOCKED_SENDING_DOMAINS, GOOGLE_WORKSPACE_IMAP, GOOGLE_WORKSPACE_SMTP, WARMUP_GATE_MIN_SCORE, WARMUP_SPAM_PAUSE_PCT,
  blockedSendingDomains, buyerInAudience, coldDeliverability, healthRates, importRefusal, isCatchAllStatus, isRoleAddress, normalizeMailboxPassword, parseMailboxCsv,
  sendingDomainBlocked, stateOf, warmupGate, warmupGateOn, type AudienceBuyer, type AudienceSpec,
} from '../_shared/cold-campaign.ts';
import { instantlyClient } from '../_shared/instantly.ts';
import { inboxkitClient, listInboxkitWorkspaces, pickInboxkitWorkspace } from '../_shared/inboxkit.ts';
import { readWarmupReadings, syncWarmup, warmupKey, type WarmupReading } from '../_shared/cold-warmup.ts';
import { inboxkitKey } from '../_shared/workspace-email.ts';
import {
  exchangeGoogle, exchangeMicrosoft, googleConfigured, googleConsentUrl, microsoftConfigured, microsoftConsentUrl,
  microsoftProfile, poolGoogleRedirect, poolMicrosoftRedirect, sealSecrets, whoami,
} from '../_shared/cold-transport.ts';

type Any = any;

const APP = () => String(Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com').replace(/\/$/, '');

function back(ok: boolean, origin: string | null, detail: string): Response {
  const base = String(origin || APP()).replace(/\/$/, '');
  const q = new URLSearchParams({ cold: ok ? 'ok' : 'error', m: detail.slice(0, 300) });
  return new Response(null, { status: 302, headers: { ...HARDENING, Location: `${base}/app/?${q}` } });
}

function cleanDomain(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^.*@/, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

function zoneOk(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

Deno.serve(async (req) => {
  const cors = corsFor(req, { methods: 'GET, POST, OPTIONS' });
  const json = jsonWith(cors);
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  if (req.method === 'GET' && (url.pathname.endsWith('/callback') || url.pathname.endsWith('/microsoft'))) {
    const provider = url.pathname.endsWith('/microsoft') ? 'microsoft_oauth' : 'google_oauth';
    return oauthCallback(admin, url, provider);
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const isAdmin = member.role === 'owner' || member.role === 'admin';
  const adminOnly = () => json({ error: 'Only an owner or admin can change this.' }, 403);
  const rl = await rateLimit(admin, `cold-pool:${who.user.id}:${clientIp(req)}`, 60, 300);
  if (!rl.allowed) return tooMany(cors, rl);

  try {
    switch (b.action) {
      case 'overview':
        return json(await overview(admin, asCaller, ws, isAdmin));
      case 'health':
        return json(await health(admin, ws));
      case 'save_blocked': {
        if (!isAdmin) return adminOnly();
        const extra = (Array.isArray(b.extra) ? b.extra : String(b.extra ?? '').split(/[\s,]+/))
          .map(cleanDomain).filter((d: string) => isDomain(d) && !DEFAULT_BLOCKED_SENDING_DOMAINS.includes(d as typeof DEFAULT_BLOCKED_SENDING_DOMAINS[number])).slice(0, 40);
        await ensureSettings(admin, ws);
        const { error } = await admin.from('cold_workspace_settings').update({ blocked_extra: extra }).eq('workspace_id', ws);
        if (error) throw error;
        return json({ ok: true, blocked: blockedSendingDomains(extra), extra });
      }
      case 'save_warmup': {
        if (!isAdmin) return adminOnly();
        const provider = String(b.provider ?? 'stub').trim().toLowerCase().slice(0, 40) || 'stub';
        const apiBase = String(b.api_base ?? '').trim().slice(0, 200) || null;
        const rawTag = String(b.instantly_tag ?? '').trim();
        const instantlyTag = rawTag.length >= 4 && rawTag.length <= 80 ? rawTag : null;
        if (rawTag && !instantlyTag) return json({ error: 'The Instantly warmup tag needs 4 to 80 characters.' }, 422);
        await ensureSettings(admin, ws);
        const current = await readSettings(admin, ws);
        const warmupDaily = b.warmup_daily == null ? current.policy.warmupDaily : clamp(b.warmup_daily, 0, 80, 20);
        const merged = coldDeliverability({ ...(current.deliverability_raw ?? {}), warmup_daily: warmupDaily }, current.physical_address);
        await admin.from('cold_workspace_settings').update({
          warmup_provider: provider, warmup_api_base: apiBase, instantly_warmup_tag: instantlyTag,
          deliverability: deliverabilityJson(merged),
        }).eq('workspace_id', ws);
        if (b.key === null) await admin.from('cold_warmup_secrets').delete().eq('workspace_id', ws);
        else if (typeof b.key === 'string' && b.key.trim()) {
          const sealed = await sealSecrets({ smtp: b.key.trim() });
          await admin.from('cold_warmup_secrets').upsert({ workspace_id: ws, api_key: sealed.smtp_password }, { onConflict: 'workspace_id' });
        }
        const note = warmupGateOn(provider)
          ? `Instantly is read daily. A warming mailbox sends no cold mail until it has warmed ${merged.warmupGateDays} days with a score of ${WARMUP_GATE_MIN_SCORE}. Warmup Spam over ${WARMUP_SPAM_PAUSE_PCT}% pauses it.`
          : 'No warmup vendor is called. Cold plus warmup stays at the combined ceiling. Mail carrying the Instantly warmup ID is not a reply.';
        return json({ ok: true, provider, api_base: apiBase, instantly_tag: instantlyTag, warmup_daily: warmupDaily, gate: warmupGateOn(provider), note });
      }
      case 'sync_warmup': {
        if (!isAdmin) return adminOnly();
        const srl = await rateLimit(admin, `cold-warmup:${ws}`, 6, 300);
        if (!srl.allowed) return tooMany(cors, srl);
        const result = await syncWarmup(admin, ws);
        return json(result, result.ok ? 200 : 422);
      }
      case 'import_inboxkit': {
        if (!isAdmin) return adminOnly();
        const apiKey = (await inboxkitKey(admin, ws)).key ?? '';
        if (!apiKey) return json({ error: 'No InboxKit key: add one under Warm-up and mailbox health, or set INBOXKIT_API_KEY on the project. Nothing was imported.' }, 503);
        const settings = await readSettings(admin, ws);
        const given = String(b.inboxkit_workspace_id ?? '').trim();
        if (given && !/^[A-Za-z0-9-]{8,80}$/.test(given)) return json({ error: 'That InboxKit workspace id does not look right.' }, 422);
        const irl = await rateLimit(admin, `cold-inboxkit:${ws}`, 6, 300);
        if (!irl.allowed) return tooMany(cors, irl);
        let uid = given || settings.inboxkit_workspace_uid;
        if (!uid) {
          // The key alone lists the team's workspaces, so the id is found here instead of
          // being dug out of InboxKit's settings by hand.
          let found;
          try { found = await listInboxkitWorkspaces(apiKey); } catch (err) {
            return json({ error: err instanceof Error ? err.message : 'InboxKit did not answer.' }, 502);
          }
          const pick = pickInboxkitWorkspace(found);
          if (!pick) {
            return json({
              error: found.length ? 'InboxKit has more than one workspace with domains. Send the id of the one to import.' : 'InboxKit lists no workspaces for this key.',
              workspaces: found,
            }, 409);
          }
          uid = pick.uid;
        }
        if (uid !== settings.inboxkit_workspace_uid) {
          const { error } = await admin.from('cold_workspace_settings').update({ inboxkit_workspace_uid: uid }).eq('workspace_id', ws);
          if (error) throw error;
        }
        const client = inboxkitClient(apiKey, uid);
        let listed;
        try { listed = await client.listMailboxes(); } catch (err) {
          return json({ error: err instanceof Error ? err.message : 'InboxKit did not answer.' }, 502);
        }
        const { data: rows } = await admin.from('cold_mailboxes').select('id, email').eq('workspace_id', ws);
        const existing = new Map(((rows ?? []) as Any[]).map((r) => [String(r.email).toLowerCase(), Number(r.id)]));
        const imported: string[] = [];
        const updated: string[] = [];
        const skipped: { email: string; reason: string }[] = [];
        for (const m of listed) {
          const refusal = importRefusal(m.email, settings.blocked);
          if (refusal) { skipped.push({ email: m.email, reason: refusal }); continue; }
          if (m.platform !== 'GOOGLE') { skipped.push({ email: m.email, reason: 'Only Google Workspace mailboxes import this way.' }); continue; }
          if (m.status && m.status !== 'active') { skipped.push({ email: m.email, reason: `InboxKit lists it as ${m.status}.` }); continue; }
          let password: string | null = null;
          try { password = await client.appPassword(m.uid); } catch { password = null; }
          if (!password) { skipped.push({ email: m.email, reason: 'InboxKit returned no app password.' }); continue; }
          const plain = normalizeMailboxPassword(password);
          const sealed = await sealSecrets({ smtp: plain, imap: plain });
          let mailboxId = existing.get(m.email);
          if (mailboxId) updated.push(m.email);
          else {
            const domainId = await ensureDomain(admin, ws, domainOf(m.email));
            const displayName = `${m.firstName} ${m.lastName}`.trim() || null;
            mailboxId = await upsertMailbox(admin, ws, {
              domain_id: domainId, email: m.email, display_name: displayName, provider: 'smtp', status: 'warming',
              smtp_host: GOOGLE_WORKSPACE_SMTP.host, smtp_port: GOOGLE_WORKSPACE_SMTP.port, smtp_username: m.email,
              imap_host: GOOGLE_WORKSPACE_IMAP.host, imap_port: GOOGLE_WORKSPACE_IMAP.port, imap_username: m.email,
            });
            existing.set(m.email, mailboxId);
            imported.push(m.email);
          }
          const { error } = await admin.from('cold_mailbox_secrets').upsert({ mailbox_id: mailboxId, workspace_id: ws, ...sealed }, { onConflict: 'mailbox_id' });
          if (error) throw error;
        }
        return json({ ok: true, listed: listed.length, imported: imported.length, updated: updated.length, skipped, workspace_uid: uid });
      }
      case 'save_deliverability': {
        if (!isAdmin) return adminOnly();
        await ensureSettings(admin, ws);
        const current = await readSettings(admin, ws);
        const address = b.physical_address == null ? current.physical_address : String(b.physical_address).trim().slice(0, 300);
        const merged = b.deliverability && typeof b.deliverability === 'object'
          ? coldDeliverability({ ...(current.deliverability_raw ?? {}), ...(b.deliverability as Record<string, unknown>) }, address)
          : coldDeliverability(current.deliverability_raw, address);
        const { error } = await admin.from('cold_workspace_settings').update({
          physical_address: address || null,
          deliverability: deliverabilityJson(merged),
        }).eq('workspace_id', ws);
        if (error) throw error;
        return json({ ok: true, physical_address: address, deliverability: merged });
      }
      case 'add_domain': {
        if (!isAdmin) return adminOnly();
        const domain = cleanDomain(b.domain);
        if (!isDomain(domain)) return json({ error: 'That is not a domain name.' }, 422);
        const settings = await readSettings(admin, ws);
        if (sendingDomainBlocked(domain, settings.blocked)) return json({ error: `${domain} is on the blocked sending list.` }, 422);
        const cap = clamp(b.daily_cap, 1, 10000, 500);
        const selectors = selectorsOf(b.dkim_selectors);
        const { data, error } = await admin.from('cold_domains').upsert({ workspace_id: ws, domain, daily_cap: cap, dkim_selectors: selectors }, { onConflict: 'workspace_id,domain' }).select('id').single();
        if (error) throw error;
        return json({ ok: true, id: data.id });
      }
      case 'check_domain': {
        const { data: d } = await admin.from('cold_domains').select('id, domain, dkim_selectors, tracking_domain').eq('workspace_id', ws).eq('id', Number(b.id)).maybeSingle();
        if (!d) return json({ error: 'domain not found' }, 404);
        const drl = await rateLimit(admin, `cold-dns:${ws}:${d.id}`, 6, 300);
        if (!drl.allowed) return tooMany(cors, drl);
        const r = await checkDomain(d.domain, { dkim_selectors: d.dkim_selectors ?? [], tracking_domain: d.tracking_domain ?? null, uses_resend: false, google_hint: false });
        await admin.from('cold_domains').update({ score: r.score, blocking: r.blocking, report: { checks: r.checks, provider: r.provider }, checked_at: r.checked_at }).eq('id', d.id);
        await admin.from('email_domains').upsert({
          workspace_id: ws, domain: d.domain, dkim_selectors: d.dkim_selectors ?? [],
          score: r.score, blocking: r.blocking, report: { checks: r.checks, provider: r.provider }, checked_at: r.checked_at,
        }, { onConflict: 'workspace_id,domain' });
        return json({ ok: true, ...r });
      }
      case 'save_domain': {
        if (!isAdmin) return adminOnly();
        const patch: Any = {};
        if (b.daily_cap != null) patch.daily_cap = clamp(b.daily_cap, 1, 10000, 500);
        if (b.tracking_domain != null) {
          const host = String(b.tracking_domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          if (host && !isDomain(host)) return json({ error: 'That tracking domain is not a hostname.' }, 422);
          patch.tracking_domain = host || null;
        }
        if (typeof b.paused === 'boolean') {
          patch.paused = b.paused;
          patch.paused_auto = false;
          patch.paused_reason = b.paused ? String(b.reason ?? 'Paused by an admin.').slice(0, 200) : null;
          patch.paused_at = b.paused ? new Date().toISOString() : null;
        }
        const { error } = await admin.from('cold_domains').update(patch).eq('workspace_id', ws).eq('id', Number(b.id));
        if (error) return json({ error: 'Those domain settings are out of range.' }, 422);
        return json({ ok: true });
      }
      case 'remove_domain': {
        if (!isAdmin) return adminOnly();
        await admin.from('cold_domains').delete().eq('workspace_id', ws).eq('id', Number(b.id));
        return json({ ok: true });
      }
      case 'import_csv': {
        if (!isAdmin) return adminOnly();
        const parsed = parseMailboxCsv(String(b.csv ?? ''));
        if (!parsed.ok) return json({ error: parsed.error }, 422);
        const settings = await readSettings(admin, ws);
        const imported: string[] = [];
        const skipped: { email: string; reason: string }[] = parsed.skipped.map((s) => ({ email: s.email || `row ${s.line}`, reason: s.reason }));
        for (const row of parsed.rows) {
          const domain = domainOf(row.email);
          const refusal = importRefusal(row.email, settings.blocked) ?? (isDomain(domain) ? null : 'Not a domain name.');
          if (refusal) { skipped.push({ email: row.email, reason: refusal }); continue; }
          if (!row.smtpPassword) { skipped.push({ email: row.email, reason: 'App password is required.' }); continue; }
          const domainId = await ensureDomain(admin, ws, domain);
          const mailboxId = await upsertMailbox(admin, ws, {
            domain_id: domainId, email: row.email, display_name: row.displayName || null, provider: 'smtp', status: 'warming',
            smtp_host: row.smtpHost, smtp_port: row.smtpPort, smtp_username: row.smtpUsername,
            imap_host: row.imapHost || null, imap_port: row.imapPort, imap_username: row.imapUsername,
          });
          const sealed = await sealSecrets({ smtp: row.smtpPassword, imap: row.imapPassword || row.smtpPassword });
          await admin.from('cold_mailbox_secrets').upsert({ mailbox_id: mailboxId, workspace_id: ws, ...sealed }, { onConflict: 'mailbox_id' });
          imported.push(row.email);
        }
        return json({ ok: true, imported: imported.length, skipped });
      }
      case 'google_start':
      case 'microsoft_start': {
        if (!isAdmin) return adminOnly();
        const provider = b.action === 'google_start' ? 'google_oauth' : 'microsoft_oauth';
        if (provider === 'google_oauth' && !googleConfigured()) return json({ error: 'Google is not set up on this project yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and the cold-pool callback, to the OAuth client.' }, 503);
        if (provider === 'microsoft_oauth' && !microsoftConfigured()) return json({ error: 'Microsoft is not set up yet. Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.' }, 503);
        const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        await admin.from('cold_oauth_states').delete().lt('created_at', new Date(Date.now() - 30 * 60_000).toISOString());
        const { error } = await admin.from('cold_oauth_states').insert({
          state, workspace_id: ws, user_id: who.user.id, provider, origin: req.headers.get('origin'),
        });
        if (error) throw error;
        const consent = provider === 'google_oauth' ? googleConsentUrl(state) : microsoftConsentUrl(state);
        return json({
          url: consent,
          redirect_uri: provider === 'google_oauth' ? poolGoogleRedirect() : poolMicrosoftRedirect(),
        });
      }
      case 'pause_mailbox':
      case 'resume_mailbox': {
        if (!isAdmin) return adminOnly();
        const pause = b.action === 'pause_mailbox';
        // Resume goes back behind the gate when the vendor has not vouched yet.
        const { data: box } = await admin.from('cold_mailboxes').select('warmup_started_at, warmup_score').eq('workspace_id', ws).eq('id', Number(b.id)).maybeSingle();
        const settings = await readSettings(admin, ws);
        const gated = warmupGateOn(settings.warmup_provider) && !warmupGate({ startedAt: box?.warmup_started_at ?? null, score: box?.warmup_score ?? null, now: new Date(), minDays: settings.policy.warmupGateDays }).ready;
        const { error } = await admin.from('cold_mailboxes').update({
          paused: pause, paused_auto: false, paused_reason: pause ? String(b.reason ?? 'Paused by an admin.').slice(0, 200) : null,
          paused_at: pause ? new Date().toISOString() : null, status: pause ? 'paused' : gated ? 'warming' : 'active',
        }).eq('workspace_id', ws).eq('id', Number(b.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case 'save_mailbox': {
        if (!isAdmin) return adminOnly();
        const patch: Any = {};
        if (b.daily_cap != null) patch.daily_cap = clamp(b.daily_cap, 1, 2000, 20);
        if (b.hourly_cap != null) patch.hourly_cap = clamp(b.hourly_cap, 1, 500, 6);
        if (b.min_gap_seconds != null) patch.min_gap_seconds = clamp(b.min_gap_seconds, 0, 3600, 240);
        if (b.signature != null) patch.signature = String(b.signature).trim().slice(0, 2000) || null;
        if (b.display_name != null) patch.display_name = String(b.display_name).trim().slice(0, 120) || null;
        if (b.timezone) {
          const tz = String(b.timezone);
          if (!zoneOk(tz)) return json({ error: 'Unknown time zone.' }, 422);
          patch.timezone = tz;
        }
        const { error } = await admin.from('cold_mailboxes').update(patch).eq('workspace_id', ws).eq('id', Number(b.id));
        if (error) return json({ error: 'Those mailbox settings are out of range.' }, 422);
        return json({ ok: true });
      }
      case 'save_campaign': {
        if (!isAdmin) return adminOnly();
        return answered(json, await saveCampaign(admin, ws, who.user.id, b));
      }
      case 'launch': {
        if (!isAdmin) return adminOnly();
        return answered(json, await launch(admin, ws, Number(b.id)));
      }
      case 'pause_campaign':
      case 'resume_campaign': {
        if (!isAdmin) return adminOnly();
        const status = b.action === 'pause_campaign' ? 'paused' : 'active';
        const { error } = await admin.from('cold_campaigns').update({ status }).eq('workspace_id', ws).eq('id', Number(b.id)).in('status', b.action === 'pause_campaign' ? ['active'] : ['paused']);
        if (error) throw error;
        return json({ ok: true, status });
      }
      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (err) {
    return serverError(cors, 'cold-pool', err);
  }
});

async function oauthCallback(admin: SupabaseClient, url: URL, provider: 'google_oauth' | 'microsoft_oauth'): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const denied = url.searchParams.get('error');
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(state)) return back(false, null, 'That sign-in link is not one of ours. Start again from Outbound OS.');
  const { data: pending } = await admin.from('cold_oauth_states').select('*').eq('state', state).maybeSingle();
  await admin.from('cold_oauth_states').delete().eq('state', state);
  const opener = (pending?.origin as string | undefined) ?? null;
  if (!pending || pending.provider !== provider) return back(false, opener, 'That approval has already been used, or it expired. Start again from Outbound OS.');
  if (new Date(pending.created_at as string).getTime() < Date.now() - 15 * 60_000) return back(false, opener, 'That approval took too long and expired. Start again from Outbound OS.');
  if (denied || !code) return back(false, opener, denied === 'access_denied' ? 'You declined the permissions, so nothing was connected.' : 'The provider did not send a code back.');
  const ws = Number(pending.workspace_id);
  try {
    const tokens = provider === 'google_oauth' ? await exchangeGoogle(code) : await exchangeMicrosoft(code);
    if (!tokens.refresh_token) return back(false, opener, 'No long-lived permission came back. Remove the app from the account and connect again.');
    const profile = provider === 'google_oauth' ? await whoami(tokens.access_token) : await microsoftProfile(tokens.access_token);
    const email = String(profile.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return back(false, opener, 'The account did not share an email address.');
    const settings = await readSettings(admin, ws);
    if (importRefusal(email, settings.blocked)) return back(false, opener, `${domainOf(email)} cannot be used for cold email.`);
    const domainId = await ensureDomain(admin, ws, domainOf(email));
    const mailboxId = await upsertMailbox(admin, ws, {
      domain_id: domainId, email, display_name: profile.name ?? null, provider, status: 'warming',
    });
    const sealed = await sealSecrets({
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
    });
    await admin.from('cold_mailbox_secrets').upsert({ mailbox_id: mailboxId, workspace_id: ws, ...sealed }, { onConflict: 'mailbox_id' });
    return back(true, opener, `${email} is in the cold pool.`);
  } catch (err) {
    console.error('cold oauth failed', err instanceof Error ? err.message : err);
    return back(false, opener, 'The connection did not finish. Try again in a moment.');
  }
}

async function overview(admin: SupabaseClient, asCaller: SupabaseClient, ws: number, isAdmin: boolean) {
  const settings = await readSettings(admin, ws);
  const { data: domains } = await admin.from('cold_domains').select('id, domain, daily_cap, tracking_domain, dkim_selectors, score, blocking, checked_at, paused, paused_reason, paused_auto').eq('workspace_id', ws).order('domain');
  const { data: mailboxes } = await admin.from('cold_mailboxes').select('id, domain_id, email, display_name, signature, provider, status, daily_cap, hourly_cap, min_gap_seconds, timezone, ramp_enabled, ramp_start, ramp_increase_pct, ramp_target, ramp_started_on, paused, paused_reason, paused_auto, smtp_host, smtp_port, imap_host, imap_port, last_polled_at, last_error, connected_at, warmup_started_at, warmup_score, warmup_checked_at, warmup_sent_14d, warmup_spam_14d').eq('workspace_id', ws).order('email');
  const { data: campaigns } = await admin.from('cold_campaigns').select('id, name, status, audience_kind, audience_tag, saved_view_id, window_start, window_end, window_days, fallback_timezone').eq('workspace_id', ws).order('id');
  const ids = ((campaigns ?? []) as Any[]).map((c) => c.id);
  const { data: steps } = ids.length ? await admin.from('cold_steps').select('id, campaign_id, position, delay_business_days, subject, body, variants').eq('workspace_id', ws).in('campaign_id', ids).order('position') : { data: [] };
  const { data: views } = await asCaller.from('saved_views').select('id, name, shared').eq('workspace_id', ws).eq('screen', 'buyers').order('name');
  const key = await admin.from('cold_warmup_secrets').select('workspace_id').eq('workspace_id', ws).maybeSingle();
  // INSTANTLY_API_KEY on the project covers every workspace that has not saved its own.
  const projectKey = !!(Deno.env.get('INSTANTLY_API_KEY') ?? '').trim();
  const keySet = !!key.data || projectKey;
  const counts = await enrollmentCounts(admin, ws);
  const gateOn = warmupGateOn(settings.warmup_provider);
  const now = new Date();
  return {
    admin: isAdmin,
    locked_domains: [...DEFAULT_BLOCKED_SENDING_DOMAINS],
    blocked: settings.blocked,
    blocked_extra: settings.extra,
    fallback_timezone: settings.fallback_timezone,
    warmup: {
      provider: settings.warmup_provider, api_base: settings.warmup_api_base, instantly_tag: settings.instantly_warmup_tag,
      key_set: keySet, key_from_project: !key.data && projectKey, calls_vendor: gateOn && keySet, placement: gateOn ? 'instantly' : 'stub',
      daily: settings.policy.warmupDaily, combined_ceiling: settings.policy.combinedDailyCeiling,
      gate: { on: gateOn, min_days: settings.policy.warmupGateDays, min_score: WARMUP_GATE_MIN_SCORE, spam_pause_pct: WARMUP_SPAM_PAUSE_PCT },
      synced_at: settings.warmup_synced_at, sync_error: settings.warmup_sync_error,
    },
    inboxkit: { configured: !!(await inboxkitKey(admin, ws)).key, workspace_uid: settings.inboxkit_workspace_uid },
    physical_address: settings.physical_address,
    deliverability: settings.policy,
    google: { configured: googleConfigured(), redirect_uri: poolGoogleRedirect() },
    microsoft: { configured: microsoftConfigured(), redirect_uri: poolMicrosoftRedirect() },
    domains: domains ?? [],
    mailboxes: ((mailboxes ?? []) as Any[]).map((m) => ({
      ...m,
      warmup_spam_pct: m.warmup_sent_14d ? Math.round(1000 * Number(m.warmup_spam_14d ?? 0) / Number(m.warmup_sent_14d)) / 10 : null,
      warmup_gate: gateOn ? warmupGate({ startedAt: m.warmup_started_at, score: m.warmup_score, now, minDays: settings.policy.warmupGateDays }) : null,
    })),
    campaigns: ((campaigns ?? []) as Any[]).map((c) => ({ ...c, steps: ((steps ?? []) as Any[]).filter((s) => s.campaign_id === c.id), enrolled: counts.get(Number(c.id)) ?? 0 })),
    saved_views: views ?? [],
    health: await health(admin, ws),
  };
}

async function health(admin: SupabaseClient, ws: number) {
  const { data: mailboxes } = await admin.from('cold_mailbox_health').select('*').eq('workspace_id', ws);
  const { data: domains } = await admin.from('cold_domain_health').select('*').eq('workspace_id', ws);
  const rate = (row: Any) => healthRates({
    sent: Number(row.sent_7d ?? 0), bounced: Number(row.bounced_7d ?? 0), replied: Number(row.replied_7d ?? 0), complaints: Number(row.complaints_7d ?? 0),
  });
  const live = await liveWarmup(admin, ws, ((mailboxes ?? []) as Any[]).map((m) => String(m.email ?? '')));
  return {
    mailboxes: ((mailboxes ?? []) as Any[]).map((m) => ({ ...m, ...rate(m) })),
    domains: ((domains ?? []) as Any[]).map((d) => ({ ...d, ...rate(d) })),
    calls_vendor: live.called,
    warmup: live.readings,
    ...(live.error ? { warmup_error: live.error } : {}),
  };
}

/**
 * The Instantly reading per mailbox email, read now, when the workspace warms
 * through Instantly and has a key. Nothing is written here; the sync does
 * that. A vendor failure is a string, so the overview still answers 200.
 */
async function liveWarmup(admin: SupabaseClient, ws: number, emails: string[]): Promise<{ called: boolean; readings: Record<string, WarmupReading>; error: string | null }> {
  const none = { called: false, readings: {} as Record<string, WarmupReading>, error: null };
  try {
    const settings = await readSettings(admin, ws);
    if (!warmupGateOn(settings.warmup_provider) || !emails.length) return none;
    const key = await warmupKey(admin, ws);
    if (!key) return { ...none, error: 'No Instantly key is saved. Add it under Warmup.' };
    const read = await readWarmupReadings(instantlyClient(key), emails, new Date());
    return { called: read.called, readings: Object.fromEntries(read.readings), error: read.error };
  } catch (err) {
    return { ...none, called: true, error: err instanceof Error ? err.message.slice(0, 200) : 'Instantly did not answer.' };
  }
}

async function saveCampaign(admin: SupabaseClient, ws: number, userId: string, b: Any) {
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) return { error: 'Name the campaign.' };
  const kind = b.audience_kind === 'saved_view' ? 'saved_view' : 'tag';
  const tag = String(b.audience_tag ?? '').trim().slice(0, 80);
  const viewId = Number(b.saved_view_id);
  if (kind === 'tag' && !tag) return { error: 'Name the buyer tag for this audience.' };
  if (kind === 'saved_view') {
    const { data: view } = await admin.from('saved_views').select('id').eq('workspace_id', ws).eq('screen', 'buyers').eq('id', viewId).maybeSingle();
    if (!view) return { error: 'That saved view is not a Buyers view in this workspace.' };
  }
  const tz = String(b.fallback_timezone ?? 'America/Chicago');
  if (!zoneOk(tz)) return { error: 'Unknown time zone.' };
  const start = clamp(b.window_start, 0, 23, 9);
  const end = clamp(b.window_end, 1, 24, 17);
  if (end <= start) return { error: 'The window has to end after it starts.' };
  const days = (Array.isArray(b.window_days) ? b.window_days : [1, 2, 3, 4, 5]).map(Number).filter((d: number) => d >= 0 && d <= 6);
  if (!days.length) return { error: 'Pick at least one day.' };
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!steps.length || steps.length > 20) return { error: 'A sequence needs 1 to 20 steps.' };
  const stepRows = steps.map((s: Any, i: number) => ({
    position: i + 1,
    delay_business_days: clamp(s.delay_business_days, 0, 60, i === 0 ? 0 : 2),
    subject: String(s.subject ?? '').slice(0, 200),
    body: String(s.body ?? '').slice(0, 20_000),
    variants: variantsOf(s.variants),
  }));
  if (stepRows.some((r) => !r.subject || !r.body)) return { error: 'Every step needs a subject and a body.' };
  const id = Number(b.id);
  let campaignId = id;
  if (Number.isFinite(id) && id > 0) {
    const { data: existing } = await admin.from('cold_campaigns').select('id, status').eq('workspace_id', ws).eq('id', id).maybeSingle();
    if (!existing) return { error: 'Campaign not found.' };
    if (existing.status !== 'draft') return { error: 'Steps can be edited while the campaign is a draft. Pause it to stop sending; start a new draft to change the sequence.' };
    const { error } = await admin.from('cold_campaigns').update({
      name, audience_kind: kind, audience_tag: kind === 'tag' ? tag : null, saved_view_id: kind === 'saved_view' ? viewId : null,
      window_start: start, window_end: end, window_days: days, fallback_timezone: tz,
    }).eq('id', id);
    if (error) throw error;
    await admin.from('cold_steps').delete().eq('campaign_id', id).eq('workspace_id', ws);
  } else {
    const { data, error } = await admin.from('cold_campaigns').insert({
      workspace_id: ws, name, status: 'draft', audience_kind: kind, audience_tag: kind === 'tag' ? tag : null,
      saved_view_id: kind === 'saved_view' ? viewId : null, window_start: start, window_end: end, window_days: days,
      fallback_timezone: tz, created_by: userId,
    }).select('id').single();
    if (error) throw error;
    campaignId = data.id;
  }
  const rows = stepRows.map((r) => ({ workspace_id: ws, campaign_id: campaignId, ...r }));
  const { error } = await admin.from('cold_steps').insert(rows);
  if (error) throw error;
  return { ok: true, id: campaignId };
}

async function launch(admin: SupabaseClient, ws: number, id: number) {
  const { data: campaign } = await admin.from('cold_campaigns').select('*').eq('workspace_id', ws).eq('id', id).maybeSingle();
  if (!campaign) return { error: 'Campaign not found.' };
  if (campaign.status === 'done') return { error: 'That campaign is finished.' };
  const { count } = await admin.from('cold_steps').select('id', { count: 'exact', head: true }).eq('campaign_id', id);
  if (!count) return { error: 'Add a step before launching.' };
  const audience = await audienceOf(admin, ws, campaign);
  if ('error' in audience) return audience;
  const names = await ownerNames(admin, ws);
  const policy = (await readSettings(admin, ws)).policy;
  let scanned = 0;
  let enrolled = 0;
  let suppressed = 0;
  const page = 500;
  // A tag audience reads only its tagged buyers, so a big workspace does not hide them past the scan cap.
  const tag = audience.kind === 'tag' ? audience.tag.trim() : '';
  const cap = tag ? 20_000 : 2000;
  for (let from = 0; scanned < cap; from += page) {
    let q = admin.from('buyers')
      .select('id, name, company, email, markets, tags, status, buyer_type, entity_type, archived_at, blacklisted_at, phone, assigned_to, email_status')
      .eq('workspace_id', ws).is('archived_at', null).not('email', 'is', null);
    if (tag) q = q.contains('tags', [tag]);
    const { data, error } = await q.order('id').range(from, from + page - 1);
    if (error) throw error;
    const buyers = (data ?? []) as Any[];
    if (!buyers.length) break;
    scanned += buyers.length;
    const matches = buyers.filter((b) => buyerInAudience(asBuyer(b, names), audience));
    if (matches.length) {
      const emails = [...new Set(matches.map((b) => String(b.email).trim().toLowerCase()))];
      const { data: sup } = await admin.from('email_suppressions').select('email').eq('workspace_id', ws).in('email', emails);
      const blocked = new Set(((sup ?? []) as Any[]).map((s) => String(s.email)));
      const { data: busy } = await admin.from('cold_enrollments').select('email, campaign_id').eq('workspace_id', ws).eq('status', 'active').in('email', emails);
      const taken = new Set(((busy ?? []) as Any[]).filter((r) => Number(r.campaign_id) !== id).map((r) => String(r.email)));
      const rows = matches.map((b) => {
        const email = String(b.email).trim().toLowerCase();
        const role = policy.suppressRoles && isRoleAddress(email);
        const catchAll = policy.suppressCatchAll && isCatchAllStatus(b.email_status);
        const elsewhere = taken.has(email);
        const stopped = blocked.has(email) || role || catchAll || elsewhere;
        const reason = blocked.has(email)
          ? 'On the suppression list.'
          : elsewhere
            ? 'Already in an active sequence.'
            : role
              ? 'Role addresses such as info@ and admin@ are suppressed.'
              : catchAll
                ? 'Catch-all addresses are suppressed.'
                : null;
        return {
          workspace_id: ws, campaign_id: id, buyer_id: b.id, email, state: stateOf(null, b.markets ?? []),
          status: stopped ? 'suppressed' : 'active', stop_reason: reason,
          step_position: 1, next_send_at: new Date().toISOString(),
        };
      });
      const { error: ins } = await admin.from('cold_enrollments').upsert(rows, { onConflict: 'campaign_id,email', ignoreDuplicates: true });
      if (ins) throw ins;
      enrolled += rows.filter((r) => r.status === 'active').length;
      suppressed += rows.filter((r) => r.status === 'suppressed').length;
    }
    if (buyers.length < page) break;
  }
  await admin.from('cold_campaigns').update({ status: 'active' }).eq('id', id);
  return { ok: true, enrolled, suppressed, scanned: Math.min(scanned, cap) };
}

function asBuyer(b: Any, names: Map<string, string>): AudienceBuyer {
  const kind = entityKind(b.name, b.company, b.entity_type);
  const assigned = b.assigned_to ? names.get(String(b.assigned_to)) ?? '' : '';
  return {
    email: b.email, status: b.status, tags: b.tags ?? [], markets: b.markets ?? [],
    buyerType: b.buyer_type, entityType: ENTITY_LABELS[kind], archivedAt: b.archived_at,
    blacklistedAt: b.blacklisted_at, phone: b.phone, ownerName: assigned,
  };
}

async function audienceOf(admin: SupabaseClient, ws: number, campaign: Any): Promise<AudienceSpec | { error: string }> {
  if (campaign.audience_kind === 'tag') return { kind: 'tag', tag: String(campaign.audience_tag ?? '') };
  const { data: view } = await admin.from('saved_views').select('config').eq('workspace_id', ws).eq('id', campaign.saved_view_id).maybeSingle();
  if (!view) return { error: 'The saved view for this campaign is gone.' };
  const config = (view.config ?? {}) as { filters?: Record<string, string>; geniusOnly?: boolean };
  return { kind: 'saved_view', config };
}

async function ownerNames(admin: SupabaseClient, ws: number): Promise<Map<string, string>> {
  const { data: members } = await admin.from('workspace_members').select('user_id').eq('workspace_id', ws);
  const ids = ((members ?? []) as Any[]).map((m) => m.user_id).filter(Boolean);
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const { data: profiles } = await admin.from('profiles').select('id, full_name').in('id', ids);
  for (const p of (profiles ?? []) as Any[]) map.set(String(p.id), String(p.full_name ?? '').trim());
  return map;
}

async function enrollmentCounts(admin: SupabaseClient, ws: number): Promise<Map<number, number>> {
  const { data } = await admin.from('cold_enrollments').select('campaign_id, status').eq('workspace_id', ws).limit(5000);
  const map = new Map<number, number>();
  for (const row of (data ?? []) as Any[]) {
    if (row.status === 'suppressed') continue;
    map.set(Number(row.campaign_id), (map.get(Number(row.campaign_id)) ?? 0) + 1);
  }
  return map;
}

async function ensureDomain(admin: SupabaseClient, ws: number, domain: string): Promise<number> {
  const { data } = await admin.from('cold_domains').select('id').eq('workspace_id', ws).eq('domain', domain).maybeSingle();
  if (data) return Number(data.id);
  const ins = await admin.from('cold_domains').insert({ workspace_id: ws, domain }).select('id').single();
  if (ins.error) {
    const again = await admin.from('cold_domains').select('id').eq('workspace_id', ws).eq('domain', domain).maybeSingle();
    if (again.data) return Number(again.data.id);
    throw ins.error;
  }
  return Number(ins.data.id);
}

async function upsertMailbox(admin: SupabaseClient, ws: number, row: Any): Promise<number> {
  const { data: existing } = await admin.from('cold_mailboxes').select('id').eq('workspace_id', ws).eq('email', row.email).maybeSingle();
  if (existing) {
    const { error } = await admin.from('cold_mailboxes').update({
      ...row, last_error: null, connected_at: new Date().toISOString(), paused: false, paused_auto: false, paused_reason: null, paused_at: null,
    }).eq('id', existing.id);
    if (error) throw error;
    return Number(existing.id);
  }
  const { data, error } = await admin.from('cold_mailboxes').insert({
    workspace_id: ws, ...row, ramp_started_on: new Date().toISOString().slice(0, 10), connected_at: new Date().toISOString(),
    warmup_started_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw error;
  return Number(data.id);
}

async function ensureSettings(admin: SupabaseClient, ws: number): Promise<void> {
  await admin.from('cold_workspace_settings').upsert({ workspace_id: ws }, { onConflict: 'workspace_id', ignoreDuplicates: true });
}

async function readSettings(admin: SupabaseClient, ws: number): Promise<{ blocked: string[]; extra: string[]; fallback_timezone: string; warmup_provider: string; warmup_api_base: string | null; instantly_warmup_tag: string | null; physical_address: string; policy: ReturnType<typeof coldDeliverability>; deliverability_raw: Record<string, unknown> | null; inboxkit_workspace_uid: string | null; warmup_synced_at: string | null; warmup_sync_error: string | null }> {
  await ensureSettings(admin, ws);
  const row = (await admin.from('cold_workspace_settings').select('blocked_extra, fallback_timezone, warmup_provider, warmup_api_base, instantly_warmup_tag, physical_address, deliverability, inboxkit_workspace_uid, warmup_synced_at, warmup_sync_error').eq('workspace_id', ws).maybeSingle()).data as Any;
  const { data: wsRow } = await admin.from('workspaces').select('settings').eq('id', ws).maybeSingle();
  const tag = String(row?.instantly_warmup_tag ?? '').trim();
  const raw = row?.deliverability && typeof row.deliverability === 'object' ? row.deliverability as Record<string, unknown> : null;
  return {
    blocked: blockedSendingDomains(row?.blocked_extra ?? []),
    extra: (row?.blocked_extra ?? []) as string[],
    fallback_timezone: row?.fallback_timezone || (wsRow?.settings as Any)?.timezone || 'America/Chicago',
    warmup_provider: row?.warmup_provider ?? 'stub',
    warmup_api_base: row?.warmup_api_base ?? null,
    instantly_warmup_tag: tag.length >= 4 ? tag : null,
    physical_address: String(row?.physical_address ?? '').trim(),
    policy: coldDeliverability(raw, row?.physical_address),
    deliverability_raw: raw,
    inboxkit_workspace_uid: String(row?.inboxkit_workspace_uid ?? '').trim() || null,
    warmup_synced_at: row?.warmup_synced_at ?? null,
    warmup_sync_error: row?.warmup_sync_error ?? null,
  };
}

function deliverabilityJson(policy: ReturnType<typeof coldDeliverability>): Record<string, unknown> {
  return {
    plain_text_first: policy.plainTextFirst,
    open_tracking: policy.openTracking,
    click_tracking: policy.clickTracking,
    step1_links: policy.step1Links,
    max_links_after_step1: policy.maxLinksAfterStep1,
    spam_lint_block: policy.spamLintBlock,
    spam_score_limit: policy.spamScoreLimit,
    gap_min_seconds: policy.gapMinSeconds,
    gap_max_seconds: policy.gapMaxSeconds,
    daily_ceiling: policy.dailyCeiling,
    jitter_pct: policy.jitterPct,
    ramp_days: policy.rampDays,
    skip_weekends: policy.skipWeekends,
    rest_days: policy.restDays,
    bounce_pause_rate: policy.bouncePauseRate,
    bounce_min_sample: policy.bounceMinSample,
    any_complaint_pauses: policy.anyComplaintPauses,
    complaint_pause_rate: policy.complaintPauseRate,
    recipient_domain_daily_cap: policy.recipientDomainDailyCap,
    warmup_daily: policy.warmupDaily,
    combined_daily_ceiling: policy.combinedDailyCeiling,
    low_reply_rate: policy.lowReplyRate,
    low_reply_sample: policy.lowReplySample,
    primary_rate_floor: policy.primaryRateFloor,
    body_repeat_limit: policy.bodyRepeatLimit,
    body_repeat_window_minutes: policy.bodyRepeatWindowMinutes,
    provider_share: policy.providerShare,
    suppress_roles: policy.suppressRoles,
    suppress_catch_all: policy.suppressCatchAll,
    require_physical_address: policy.requirePhysicalAddress,
    ooo_hold_business_days: policy.oooHoldBusinessDays,
    warmup_gate_days: policy.warmupGateDays,
  };
}

function selectorsOf(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9._-]{1,63}$/.test(s)).slice(0, 10);
}

function variantsOf(raw: unknown): { key: string; subject: string; body: string; weight: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 4).map((v: Any, i: number) => ({
    key: String(v?.key ?? (i === 0 ? 'A' : 'B')).slice(0, 8),
    subject: String(v?.subject ?? '').slice(0, 200),
    body: String(v?.body ?? '').slice(0, 20_000),
    weight: clamp(v?.weight, 1, 100, 1),
  })).filter((v) => v.subject && v.body);
}

function answered(json: (body: unknown, status?: number) => Response, result: Any): Response {
  return json(result, result && result.error && !result.ok ? 422 : 200);
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
