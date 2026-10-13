/**
 * POST /compr-underwrite — the underwriting provider hook.
 *
 * The hosted product connects this function to a private valuation engine
 * (ARV, rehab, offer and comps). That engine is not part of the open-source
 * release, so this build answers every action with "no provider configured"
 * and the app shows its underwriting controls as unavailable.
 *
 * To plug in your own engine, replace this handler. The app calls it with
 * `supabase.functions.invoke('compr-underwrite', { body })`; the request and
 * response shapes it expects are in app/lib/compr.ts (runCompr, pullCompr,
 * comprReportLink, sendComprReport), app/lib/deal-files.ts (deal_photos) and
 * app/lib/places.ts (suggest).
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsFor, jsonWith } from '../_shared/security.ts';

const NOT_CONFIGURED = 'No underwriting provider is configured for this install.';

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { action?: string; place_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  // Address autocomplete falls back to the browser's own input when empty.
  if (body.action === 'suggest') return json(body.place_id ? { ok: false } : { ok: false, items: [] });
  return json({ ok: false, error: NOT_CONFIGURED }, 503);
});
