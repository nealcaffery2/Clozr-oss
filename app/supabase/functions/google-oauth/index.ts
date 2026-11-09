/**
 * The Connect Google button, both ends of it.
 *
 * POST /google-oauth            (signed in)
 *   { workspace_id, action: 'status' }      → { configured, account, redirect_uri, team }
 *   { workspace_id, action: 'start', gmail_read?, calendar?, shared?, add_calendar? } → { url }
 *        calendar: false asks for Gmail alone (no calendar scope). shared: true
 *        links another mailbox for the workspace (deals@, migration 441):
 *        gmail.readonly, plus the calendar when calendar is true, never send.
 *        add_calendar: an account id of the caller's, asks for the calendar
 *        scope alone and include_granted_scopes keeps the Gmail grant.
 *   { workspace_id, action: 'disconnect', account_id? } → { ok }
 *        account_id: a linked mailbox; its linker, an owner or an admin.
 *
 * GET  /google-oauth/callback?code=&state=  — where Google sends the browser back
 *
 * verify_jwt is off because that last one is a plain browser redirect from
 * Google, which carries no Authorization header. Every other action checks the
 * caller's JWT and workspace membership itself, first thing.
 *
 * Nothing here ever hands a token to the browser. The consent URL is public by
 * design (it is Google's own page), the code is exchanged server-side, and the
 * refresh token goes straight into google_tokens sealed.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { appLink, appPath } from '../_shared/app-paths.ts';
import { SCOPE, authUrl, configured, exchange, redirectUri, revoke, storeTokens, unseal, whoami } from '../_shared/google.ts';
import { settingsFor } from '../_shared/mailguard.ts';
import { connectScopes } from '../_shared/google-scope.ts';

type Any = any;

const SELECT = 'id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync, gmail_send, gmail_read, status, sync_token, last_calendar_sync_at, last_gmail_sync_at, last_error, connected_at, shared';

/**
 * Where the browser goes after Google.
 *
 * Not a page of our own: Supabase serves every edge function response as
 * text/plain under `CSP: default-src 'none'; sandbox` — an anti-phishing rule
 * on the shared supabase.co domain — so HTML from this host is shown as source
 * and offered as a download. The result rides back to CLOZR in the query
 * string instead, and the app says how it went in its own UI, where it can be
 * styled, dismissed, and read on a phone.
 *
 * The origin is the one the browser sent when the consent was started, so it
 * is wherever the signed-in member actually was — not somewhere a stranger can
 * point this.
 */
function back(ok: boolean, origin: string | null, detail: string): Response {
  const base = String(origin || Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com').replace(/\/$/, '');
  const q = new URLSearchParams({ google: ok ? 'ok' : 'error', m: detail.slice(0, 300) });
  return new Response(null, { status: 302, headers: { ...HARDENING, Location: `${appLink(base, appPath.base)}?${q}` } });
}

type Pending = { workspace_id: number; user_id: string; scopes: string | null; shared?: boolean | null; account_id?: number | null };

/**
 * Which google_accounts row a finished consent writes: an existing id, a new
 * row (id null), or a refusal to show. Before migration 441 `shared` and
 * `account_id` are absent on the state row, and this is the old one-row-per-
 * member behaviour.
 */
async function accountForCallback(admin: SupabaseClient, pending: Pending, email: string): Promise<{ id: number | null } | { refuse: string }> {
  const ws = pending.workspace_id;
  const lower = email.toLowerCase();
  if (pending.account_id) {
    const { data: row } = await admin.from('google_accounts').select('id, email, user_id').eq('id', pending.account_id).eq('workspace_id', ws).maybeSingle();
    if (!row || row.user_id !== pending.user_id) return { refuse: 'That connection is gone. Start again from Settings.' };
    if (String(row.email).toLowerCase() !== lower) return { refuse: `This has to be approved from ${row.email}. Pick that account on Google's screen.` };
    return { id: Number(row.id) };
  }
  const { data: rows } = await admin.from('google_accounts').select('id, email, user_id, shared').eq('workspace_id', ws);
  const all = (rows ?? []) as { id: number; email: string; user_id: string; shared: boolean | null }[];
  const same = all.filter((a) => String(a.email).toLowerCase() === lower);
  if (pending.shared) {
    if (same.some((a) => !a.shared)) return { refuse: `${email} is already a teammate's own connection, so it already syncs. Pick the shared mailbox on Google's screen.` };
    return { id: same.find((a) => a.shared)?.id ?? null };
  }
  if (same.some((a) => a.shared)) return { refuse: `${email} is linked as a shared mailbox. Disconnect it there first, or pick your own account on Google's screen.` };
  return { id: all.find((a) => !a.shared && a.user_id === pending.user_id)?.id ?? null };
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  const url = new URL(req.url);
  const projectUrl = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(projectUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // ------------------------------------------------------------- callback
  if (url.pathname.endsWith('/callback')) {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const denied = url.searchParams.get('error');
    if (!/^[A-Za-z0-9_-]{20,120}$/.test(state)) return back(false, null, 'That sign-in link is not one of ours. Start again from Settings.');

    const { data: pending } = await admin.from('google_oauth_states').select('*').eq('state', state).maybeSingle();
    await admin.from('google_oauth_states').delete().eq('state', state);
    const opener = (pending?.origin as string | undefined) ?? null;
    if (!pending) return back(false, opener, 'That approval has already been used, or it expired. Start again from Settings.');
    if (new Date(pending.created_at as string).getTime() < Date.now() - 15 * 60_000) return back(false, opener, 'That approval took too long and expired. Start again from Settings.');
    if (denied || !code) return back(false, opener, denied === 'access_denied' ? 'You declined the permissions, so nothing was connected.' : 'Google did not send a code back.');

    try {
      const t = await exchange(code);
      const scopes = (t.scope ?? '').split(' ').filter(Boolean);
      const me = await whoami(t.access_token);
      if (!t.refresh_token) {
        // Without one, we could only act for the next hour. Ask Google to
        // forget the old grant so the next attempt shows consent again.
        await revoke(t.access_token);
        return back(false, opener, 'Google did not return a long-lived permission. Remove CLOZR at myaccount.google.com/permissions, then connect again.');
      }
      // "Connect Postmaster" must not quietly swap the sending mailbox for
      // whichever Google account was picked on the consent screen.
      if ([SCOPE.postmaster, SCOPE.driveRead, SCOPE.gmailCompose].some((s) => String(pending.scopes ?? '').includes(s))) {
        const { data: current } = await admin.from('google_accounts').select('email').eq('workspace_id', pending.workspace_id).eq('user_id', pending.user_id).eq('shared', false).maybeSingle();
        if (current && String(current.email).toLowerCase() !== String(me.email ?? '').toLowerCase()) {
          await revoke(t.access_token);
          return back(false, opener, `This has to be added from ${current.email}, the account you connected. Pick that account on Google's screen.`);
        }
      }
      const email = String(me.email ?? 'unknown');
      const now = new Date().toISOString();
      const target = await accountForCallback(admin, pending, email);
      if ('refuse' in target) {
        await revoke(t.access_token);
        return back(false, opener, target.refuse);
      }
      // include_granted_scopes: what Google sends back is the whole grant, so
      // it replaces the row's list rather than adding to it.
      const base = { scopes, status: 'active', last_error: null, gmail_read: scopes.includes(SCOPE.gmailRead), connected_at: now,
        // No calendar grant: sync stays off. "Add Calendar" turns it on. Otherwise the member's own switch stands.
        ...(!scopes.includes(SCOPE.calendar) ? { calendar_sync: false } : pending.account_id || !target.id ? { calendar_sync: true } : {}) };
      let account: { id: number } | null = null;
      let error: unknown = null;
      if (target.id) {
        ({ data: account, error } = await admin.from('google_accounts').update({ ...base, ...(pending.shared ? { user_id: pending.user_id } : {}) }).eq('id', target.id).select('id').single());
      } else {
        ({ data: account, error } = await admin.from('google_accounts').insert({
          workspace_id: pending.workspace_id, user_id: pending.user_id, email, ...base,
          // A linked mailbox reads mail for the workspace and never joins the sending pool.
          ...(pending.shared ? { shared: true, gmail_send: false } : {}),
        }).select('id').single());
      }
      if (error || !account) throw error ?? new Error('no account row');
      await storeTokens(admin, account.id, t, false);
      if (!pending.shared) await settingsFor(admin, { id: account.id, workspace_id: pending.workspace_id });
      // Their Google photo becomes their CLOZR photo, unless they already uploaded one. Not a shared inbox's logo.
      if (me.picture && !pending.shared) {
        await admin.from('profiles').update({ avatar_url: me.picture }).eq('id', pending.user_id).or('avatar_url.is.null,avatar_url.eq.');
      }
      const what = scopes.includes(SCOPE.calendar) ? 'Gmail and Calendar' : 'Gmail';
      return back(true, opener, `${me.email ?? 'Your Google account'} is connected for ${what}.`);
    } catch (err) {
      console.error('google callback failed', err instanceof Error ? { message: err.message } : err);
      return back(false, opener, 'Google would not complete the connection. Try again in a moment.');
    }
  }

  // -------------------------------------------------------------- the app
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const asCaller = createClient(projectUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
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

  const rl = await rateLimit(admin, `google-oauth:${who.user.id}:${clientIp(req)}`, 30, 300);
  if (!rl.allowed) return tooMany(cors, rl);

  const mine = async () => (await admin.from('google_accounts').select(SELECT).eq('workspace_id', ws).eq('user_id', who.user!.id).eq('shared', false).maybeSingle()).data;

  try {
    switch (b.action) {
      case 'status': {
        const { data: team } = await asCaller.from('google_accounts')
          .select('id, user_id, email, scopes, calendar_sync, gmail_send, gmail_read, status, last_calendar_sync_at, last_gmail_sync_at, last_error, connected_at, shared')
          .eq('workspace_id', ws);
        return json({ configured: configured(), redirect_uri: redirectUri(), account: await mine(), team: team ?? [] });
      }

      case 'start': {
        if (!configured()) return json({ error: 'Google is not set up on this project yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the Supabase project secrets.' }, 503);
        // The origin comes from the browser's own header, never the body: it is
        // where the popup will post its result, so it has to be something the
        // caller actually is.
        const origin = req.headers.get('origin');
        // Postmaster is an add-on to an existing connection: ask for just that
        // scope and let include_granted_scopes keep everything already granted,
        // so the member sees one new permission rather than the whole list.
        const existing = await mine();
        if (b.postmaster === true && !existing) return json({ error: 'Connect Google first, then add Postmaster.' }, 409);
        if (b.drive === true && !existing) return json({ error: 'Connect Google first, then add Drive.' }, 409);
        if (b.compose === true && !existing) return json({ error: 'Connect Google first, then allow drafts.' }, 409);
        // Add Calendar to a connection that has only Gmail: the one scope, on that account.
        let addTo: { id: number; email: string } | null = null;
        if (b.add_calendar != null) {
          const { data: row } = await admin.from('google_accounts').select('id, email, user_id').eq('id', Number(b.add_calendar)).eq('workspace_id', ws).maybeSingle();
          if (!row || row.user_id !== who.user.id) return json({ error: 'Only the teammate who connected that account can add Calendar to it.' }, 403);
          addTo = { id: Number(row.id), email: String(row.email) };
        }
        const shared = b.shared === true && !addTo;
        const withCalendar = b.calendar !== false;
        const scopes = addTo ? connectScopes('add_calendar')
          : shared ? connectScopes('shared', { calendar: withCalendar })
          : b.postmaster === true ? [...SCOPE.id, SCOPE.postmaster, SCOPE.postmasterDomains, SCOPE.siteVerification]
          : b.drive === true ? [...SCOPE.id, SCOPE.driveRead]
          : b.compose === true ? [...SCOPE.id, SCOPE.gmailCompose]
          : connectScopes('own', { calendar: withCalendar, read: b.gmail_read !== false });
        const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        await admin.from('google_oauth_states').delete().lt('created_at', new Date(Date.now() - 30 * 60_000).toISOString());
        const { error } = await admin.from('google_oauth_states').insert({
          state, workspace_id: ws, user_id: who.user.id, origin, scopes: scopes.join(' '),
          ...(shared ? { shared: true } : {}), ...(addTo ? { account_id: addTo.id } : {}),
        });
        if (error) throw error;
        // A fresh connect may be any mailbox (the Compr workspace connects
        // @underwriting.example.com), so only an add-on pins Google to the connected account.
        const hint = addTo ? addTo.email : b.postmaster === true || b.drive === true || b.compose === true ? existing?.email ?? null : null;
        return json({ url: authUrl(state, scopes, hint) });
      }

      case 'disconnect': {
        let account: { id: number } | null = null;
        if (b.account_id != null) {
          // A linked mailbox: whoever linked it, or an owner or admin, may remove it.
          const { data: row } = await admin.from('google_accounts').select('id, user_id, shared').eq('id', Number(b.account_id)).eq('workspace_id', ws).maybeSingle();
          if (!row) return json({ ok: true });
          const admins = member.role === 'owner' || member.role === 'admin';
          if (row.user_id !== who.user.id && !(row.shared && admins)) return json({ error: 'Only the teammate who connected it, or an owner or admin for a shared mailbox, can disconnect it.' }, 403);
          account = { id: Number(row.id) };
        } else account = await mine();
        if (!account) return json({ ok: true });
        const { data: row } = await admin.from('google_tokens').select('refresh_token').eq('account_id', account.id).maybeSingle();
        if (row?.refresh_token) {
          const token = await unseal(row.refresh_token).catch(() => null);
          if (token) await revoke(token);
        }
        await admin.from('google_accounts').delete().eq('id', account.id);
        return json({ ok: true });
      }

      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (err) {
    return serverError(cors, 'google-oauth', err);
  }
});
