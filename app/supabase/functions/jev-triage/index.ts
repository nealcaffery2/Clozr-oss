/**
 * POST /jev-triage — evaluate a lead-triage state with TypeSafe Jev.
 *
 * Playground-only. Nothing is written: no seller, no stage, no task. The
 * browser sends the same `state` object lib/jev-triage.ts builds; this function
 * forwards it to TypeSafe and returns the answers. Ingest is not on this path.
 *
 * Body:    { state: object }
 * Returns: { ok, model, answers, usage }
 *
 * Needs TYPESAFE_API_KEY on the Supabase project:
 *   supabase secrets set TYPESAFE_API_KEY=…
 * Until it is set, the function answers 503 and the playground stays on the stub.
 *
 * JWT is on (config.toml default). Unsigned visitors cannot spend the key.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, isTeammate, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { JEV_MODEL, TRIAGE_QUESTIONS, TYPESAFE_URL } from '../_shared/jev-triage.ts';

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
    auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  if (!(await isTeammate(asCaller, who.user.id))) return json({ error: 'not a member of a workspace' }, 403);

  const apiKey = Deno.env.get('TYPESAFE_API_KEY');
  if (!apiKey) {
    return json({
      error: 'Jev is not configured: set the TYPESAFE_API_KEY secret on the Supabase project. The playground stub still works without it.',
    }, 503);
  }

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `jev-triage:${who.user.id}`, 60, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  let body: { state?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
    return json({ error: 'state (object) is required' }, 422);
  }

  let upstream: Response;
  try {
    upstream = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: body.state,
        questions: TRIAGE_QUESTIONS,
      }),
    });
  } catch (e) {
    return serverError(CORS, 'jev-triage fetch', e);
  }

  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return serverError(CORS, `jev-triage non-json ${upstream.status}`, text.slice(0, 300));
  }

  if (!upstream.ok) {
    const detail = (parsed as { detail?: { message?: string; error_type?: string } }).detail;
    const message = detail?.message
      ?? (parsed as { error?: string }).error
      ?? `TypeSafe returned ${upstream.status}`;
    const status = upstream.status === 401 ? 503
      : upstream.status === 422 ? 422
        : upstream.status === 429 || upstream.status === 529 ? 429
          : 502;
    if (upstream.status === 401) {
      return json({ error: 'the TYPESAFE_API_KEY secret is invalid' }, 503);
    }
    return json({ error: message }, status);
  }

  const res = parsed as { model?: string; answers?: unknown; usage?: unknown };
  if (!res.answers || typeof res.answers !== 'object') {
    return json({ error: 'TypeSafe returned no answers' }, 502);
  }
  return json({ ok: true, model: res.model ?? JEV_MODEL, answers: res.answers, usage: res.usage ?? null });
});
