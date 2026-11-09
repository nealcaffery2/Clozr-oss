/**
 * POST /cal-webhook[?ws=<workspace id>] — Cal.com booking webhooks (migration 369).
 *
 * Subscribe the Compr onboarding call's Cal.com webhook to BOOKING_CREATED,
 * BOOKING_RESCHEDULED, BOOKING_CANCELLED, BOOKING_NO_SHOW_UPDATED and
 * AFTER_GUESTS_CAL_VIDEO_NO_SHOW, with the secret stored as
 * CAL_WEBHOOK_SECRET. Cal.com signs the raw body (X-Cal-Signature-256, hex
 * HMAC-SHA256); anything unsigned or mis-signed is refused. Without ?ws= the
 * booking files in the workspace whose buyer_profile is compr.
 *
 * Idempotent per booking uid: Cal.com retries land on the same row, and every
 * reminder is claimed before it is sent. The work is handleCalEvent in
 * _shared/cal-booking-run.ts.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { jsonWith } from '../_shared/security.ts';
import { parseCalEvent, verifyCalSignature } from '../_shared/cal-booking.ts';
import { comprWorkspace, handleCalEvent } from '../_shared/cal-booking-run.ts';

const json = jsonWith({});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = (Deno.env.get('CAL_WEBHOOK_SECRET') ?? '').trim();
  if (!secret) return json({ error: 'CAL_WEBHOOK_SECRET is not set' }, 500);
  const raw = await req.text();
  if (!(await verifyCalSignature(raw, req.headers.get('x-cal-signature-256'), secret))) return json({ error: 'bad signature' }, 401);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: 'not JSON' }, 400); }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  const ws = await comprWorkspace(admin, Number(new URL(req.url).searchParams.get('ws')) || null);
  if (!ws) return json({ error: 'no Compr workspace' }, 404);
  try {
    return json(await handleCalEvent(admin, ws, parseCalEvent(body), body));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('cal-webhook', message);
    // 500 so Cal.com retries; every write on this path is safe to repeat.
    return json({ error: message }, 500);
  }
});
