/**
 * POST /gif-search { q?: string }. GIPHY trending (no q) or search, rated pg,
 * for the SMS composer's GIF picker (app/components/talkr/GifPicker).
 *
 * The browser never sees GIPHY_API_KEY: it asks here, and gets back only
 * GIPHY CDN URLs with their query strings stripped (_shared/giphy).
 *
 * Every signed-in CLOZR user, no role, plan or admin gate; rate limited per user.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, tooMany } from '../_shared/security.ts';
import { gifsFrom } from '../_shared/giphy.ts';

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
  // Typing a search is a few requests a word; 300 an hour is a stuck loop.
  const rl = await rateLimit(admin, `gif-search:${who.user.id}`, 300, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const key = Deno.env.get('GIPHY_API_KEY')?.trim();
  if (!key) return json({ error: 'GIFs are unavailable: GIPHY_API_KEY is not set on the Supabase project.', unavailable: true }, 503);

  const body = await req.json().catch(() => ({})) as { q?: unknown };
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 50) : '';
  const params = new URLSearchParams({ api_key: key, limit: '18', rating: 'pg' });
  if (q) params.set('q', q);

  let res: Response;
  try {
    res = await fetch(`https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params}`);
  } catch {
    return json({ error: 'GIPHY did not answer. Try again in a moment.' }, 502);
  }
  if (res.status === 401 || res.status === 403) {
    return json({ error: 'GIFs are unavailable: GIPHY refused GIPHY_API_KEY.', unavailable: true }, 503);
  }
  if (!res.ok) return json({ error: `GIPHY search failed (HTTP ${res.status}).` }, 502);
  const giphy = await res.json().catch(() => ({})) as { data?: unknown };
  return json({ gifs: gifsFrom(giphy.data) });
});
