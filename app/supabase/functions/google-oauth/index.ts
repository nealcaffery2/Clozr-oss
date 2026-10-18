/**
 * The Connect Google button, both ends of it.
 *
 * POST /google-oauth            (signed in)
 *   { workspace_id, action: 'status' }      → { configured, account, redirect_uri }
 *   { workspace_id, action: 'start', gmail_read? } → { url }  — open it, approve, done
 *   { workspace_id, action: 'disconnect' }  → { ok }
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
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { DEFAULT_SCOPES, SCOPE, authUrl, configured, exchange, redirectUri, revoke, storeTokens, unseal, whoami } from '../_shared/google.ts';
import { settingsFor } from '../_shared/mailguard.ts';

type Any = any;

const SELECT = 'id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync, gmail_send, gmail_read, status, sync_token, last_calendar_sync_at, last_gmail_sync_at, last_error, connected_at';

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
  return new Response(null, { status: 302, headers: { ...HARDENING, Location: `${base}/app/?${q}` } });
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
      if (String(pending.scopes ?? '').includes(SCOPE.postmaster) || String(pending.scopes ?? '').includes(SCOPE.driveRead)) {
        const { data: current } = await admin.from('google_accounts').select('email').eq('workspace_id', pending.workspace_id).eq('user_id', pending.user_id).maybeSingle();
        if (current && String(current.email).toLowerCase() !== String(me.email ?? '').toLowerCase()) {
          await revoke(t.access_token);
          return back(false, opener, `This has to be added from ${current.email}, the account you connected. Pick that account on Google's screen.`);
        }
      }
      const { data: account, error } = await admin.from('google_accounts').upsert({
        workspace_id: pending.workspace_id,
        user_id: pending.user_id,
        email: me.email ?? 'unknown',
        scopes,
        status: 'active',
        last_error: null,
        gmail_read: scopes.includes(SCOPE.gmailRead),
        connected_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,user_id' }).select('id').single();
      if (error || !account) throw error ?? new Error('no account row');
      await storeTokens(admin, account.id, t, false);
      await settingsFor(admin, { id: account.id, workspace_id: pending.workspace_id });
      // Their Google photo becomes their CLOZR photo, unless they already uploaded one.
      if (me.picture) {
        await admin.from('profiles').update({ avatar_url: me.picture }).eq('id', pending.user_id).or('avatar_url.is.null,avatar_url.eq.');
      }
      return back(true, opener, `${me.email ?? 'Your Google account'} is connected.`);
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

  const mine = async () => (await admin.from('google_accounts').select(SELECT).eq('workspace_id', ws).eq('user_id', who.user!.id).maybeSingle()).data;

  try {
    switch (b.action) {
      case 'status': {
        const { data: team } = await asCaller.from('google_accounts')
          .select('id, user_id, email, scopes, calendar_sync, gmail_send, gmail_read, status, last_calendar_sync_at, last_gmail_sync_at, last_error, connected_at')
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
        const scopes = b.postmaster === true ? [...SCOPE.id, SCOPE.postmaster, SCOPE.postmasterDomains, SCOPE.siteVerification]
          : b.drive === true ? [...SCOPE.id, SCOPE.driveRead]
          : b.gmail_read === false ? DEFAULT_SCOPES.filter((s) => s !== SCOPE.gmailRead) : DEFAULT_SCOPES;
        const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        await admin.from('google_oauth_states').delete().lt('created_at', new Date(Date.now() - 30 * 60_000).toISOString());
        const { error } = await admin.from('google_oauth_states').insert({ state, workspace_id: ws, user_id: who.user.id, origin, scopes: scopes.join(' ') });
        if (error) throw error;
        // A fresh connect may be any mailbox (the Compr workspace connects
        // @yourcompany.com), so only an add-on pins Google to the connected account.
        const hint = b.postmaster === true || b.drive === true ? existing?.email ?? null : null;
        return json({ url: authUrl(state, scopes, hint) });
      }

      case 'disconnect': {
        const account = await mine();
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
