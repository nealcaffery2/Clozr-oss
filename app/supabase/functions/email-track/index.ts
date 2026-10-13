/**
 * GET /email-track/o/<token>.gif      an open: counts it, returns a 1×1 GIF
 * GET /email-track/c/<token>/<n>      a click: counts it, redirects to the n-th link
 *
 * Public (verify_jwt = false in config.toml): the recipient's mail client has
 * no CLOZR login. The 48-hex token from migration 82's email_tracking is the
 * only credential, and all it can do is count. A click's destination comes
 * from email_tracking_links as stored at send time, never from the request,
 * so this is not an open redirect. An unknown token still gets the pixel (or
 * a plain 404 for a click) and learns nothing.
 *
 * The first open of a send notifies the rep who sent it (notifications,
 * category 'Email'), the way Mailtrack's desktop alert does.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, rateLimit } from '../_shared/security.ts';
import { countsAsOpen, parsePath } from '../_shared/email-track.ts';

type Any = any;

// The smallest transparent GIF.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const pixel = () => new Response(GIF, {
  headers: { ...HARDENING, 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' },
});

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('GET only', { status: 405, headers: HARDENING });
  const hit = parsePath(new URL(req.url).pathname);
  if (!hit) return new Response('not found', { status: 404, headers: HARDENING });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ua = req.headers.get('user-agent') ?? '';

  try {
    const { data: t } = await admin.from('email_tracking').select('token, sent_at').eq('token', hit.token).maybeSingle();

    if (hit.kind === 'click') {
      const { data: link } = t ? await admin.from('email_tracking_links').select('url').eq('token', hit.token).eq('idx', hit.idx).maybeSingle() : { data: null };
      const url = String(link?.url ?? '');
      if (!/^https?:\/\//i.test(url)) return new Response('not found', { status: 404, headers: HARDENING });
      // Counting never stands between a reader and their link.
      const rl = await rateLimit(admin, `email-track:${hit.token}:${clientIp(req)}`, 30, 3600).catch(() => ({ allowed: true }));
      if (rl.allowed) await admin.rpc('email_track_hit', { p_token: hit.token, p_kind: 'click', p_url: url, p_ua: ua }).then(() => null, () => null);
      return new Response(null, { status: 302, headers: { ...HARDENING, Location: url } });
    }

    // HEAD is a scanner checking the link, not a person opening the mail.
    if (t && req.method === 'GET' && countsAsOpen(t.sent_at as string)) {
      const rl = await rateLimit(admin, `email-track:${hit.token}:${clientIp(req)}`, 30, 3600).catch(() => ({ allowed: true }));
      if (rl.allowed) {
        const { data } = await admin.rpc('email_track_hit', { p_token: hit.token, p_kind: 'open', p_url: null, p_ua: ua });
        const row = ((data ?? []) as Any[])[0];
        if (row?.first_open && row.user_id) {
          const who = String(row.recipients ?? '').split(',')[0].trim() || 'Your recipient';
          const subject = String(row.subject ?? '').trim() || '(no subject)';
          await admin.from('notifications').insert({
            workspace_id: row.workspace_id, user_id: row.user_id, category: 'Email',
            title: `${who} opened “${subject.length > 80 ? subject.slice(0, 77) + '…' : subject}”`,
            body: `First opened ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })}.`,
          }).then(() => null, () => null);
        }
      }
    }
  } catch (err) {
    console.error('email-track failed', String(err));
  }
  return pixel();
});
