/**
 * POST /deepgram-token. A 60-second Deepgram credential for the browser's
 * live call transcript (lib/live-transcript.ts).
 *
 * The browser streams both call legs straight to Deepgram, so it needs a
 * credential, and the long-lived DEEPGRAM_API_KEY must never be it. This
 * trades the key for a short-lived access token (POST /v1/auth/grant) that
 * only opens a listen socket and expires in a minute. Used when Talkr's own
 * /v1/transcription/token has no key to give.
 *
 * A signed-in workspace member only; rate limited per user.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, tooMany } from '../_shared/security.ts';

const TTL_SECONDS = 60;

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { count } = await admin.from('workspace_members').select('user_id', { count: 'exact', head: true }).eq('user_id', who.user.id);
  if (!count) return json({ error: 'not a member of any workspace' }, 403);
  // A call is one token, a retry is two or three; a hundred an hour is a runaway loop.
  const rl = await rateLimit(admin, `deepgram-token:${who.user.id}`, 100, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const key = Deno.env.get('DEEPGRAM_API_KEY')?.trim();
  if (!key) {
    return json({ error: 'Live transcription is not configured: set the DEEPGRAM_API_KEY secret on the Supabase project.' }, 503);
  }

  let res: Response;
  try {
    res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: TTL_SECONDS }),
    });
  } catch {
    return json({ error: 'Deepgram did not answer. Try the call again in a moment.' }, 502);
  }
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; err_msg?: string };
  if (res.status === 401 || res.status === 403) {
    return json({ error: 'Deepgram refused DEEPGRAM_API_KEY. It needs Member scope or higher to mint tokens.' }, 503);
  }
  if (!res.ok || !body.access_token) {
    console.error('deepgram grant', res.status, body.err_msg ?? '');
    return json({ error: `Deepgram would not issue a token (HTTP ${res.status}).` }, 502);
  }
  return json({ key: body.access_token, scheme: 'bearer', ttl_seconds: body.expires_in ?? TTL_SECONDS });
});
