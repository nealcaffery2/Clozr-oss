/**
 * POST /google-calendar-push: Google Calendar's push notifications.
 *
 * google-sync opens one events.watch channel per calendar feed (watch.ts) with
 * this URL as the address and a random token. Google then posts here, with no
 * body, whenever anything on that calendar changes: the headers carry the
 * channel id, the token we gave it, and the resource state.
 *
 * What happens: the channel id finds the feed, the token must match what we
 * stored (constant time), the account's calendar_push_at is stamped, and
 * google-sync runs { action: 'sync_one', part: 'calendar' } for that account
 * at once with the service key. A move or a new event made in Google Calendar
 * reaches CLOZR in seconds instead of on the next 14-minute pass. If a pass is
 * already running (sync_one's 90s lock), the stamp makes the next cron tick
 * run it regardless of the gate.
 *
 * No Supabase JWT (config.toml: verify_jwt = false): the token is the
 * credential. Always answers 2xx to a known channel quickly; Google retries a
 * slow or failed answer with backoff.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { pushWantsSync, sameToken } from '../_shared/calendar-watch.ts';

const ok = (body: Record<string, unknown> = { ok: true }, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return ok({ error: 'POST only' }, 405);
  const channel = req.headers.get('x-goog-channel-id') ?? '';
  const token = req.headers.get('x-goog-channel-token') ?? '';
  const state = req.headers.get('x-goog-resource-state') ?? '';
  await req.body?.cancel().catch(() => null);
  if (!channel || !token) return ok({ error: 'not a Google channel message' }, 400);

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const { data: feed } = await admin.from('google_calendar_feeds')
    .select('account_id, calendar_id, watch_token')
    .eq('watch_channel_id', channel).maybeSingle();
  // A channel we replaced or closed: answer 200 so Google stops retrying; it lapses on its own.
  if (!feed) return ok({ ok: true, ignored: 'unknown channel' });
  if (!sameToken(token, feed.watch_token as string | null)) return ok({ error: 'bad channel token' }, 401);
  if (!pushWantsSync(state)) return ok({ ok: true, state });

  const accountId = Number(feed.account_id);
  await admin.from('google_accounts').update({ calendar_push_at: new Date().toISOString() }).eq('id', accountId);
  const run = fetch(`${url.replace(/\/$/, '')}/functions/v1/google-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ action: 'sync_one', account_id: accountId, part: 'calendar' }),
  }).then(async (res) => {
    if (!res.ok) console.error('push sync_one failed', { account: accountId, status: res.status });
    await res.body?.cancel();
  }).catch((err) => console.error('push sync_one failed', { account: accountId, err: String(err) }));
  // Answer Google now; the sync finishes in the background.
  (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil(run);
  return ok({ ok: true, account_id: accountId });
});
