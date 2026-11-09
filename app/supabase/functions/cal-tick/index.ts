/**
 * POST /cal-tick — Cal.com booking reminders and no-show follow-up (migration 369).
 *
 * cal_kick() posts here every minute while a booking is upcoming or waiting
 * on its outcome. Service role only. The work is runCalTick in
 * _shared/cal-booking-run.ts: confirmation, 60 and 5 minute reminders by
 * email and text, the host's "did they show?" task, and the Missed demo
 * enrolment for a no-show.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { isServiceCaller, jsonWith } from '../_shared/security.ts';
import { runCalTick } from '../_shared/cal-booking-run.ts';

const json = jsonWith({});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!(await isServiceCaller(admin, bearer))) return json({ error: 'service role only' }, 403);
  const body = await req.json().catch(() => ({})) as { booking_id?: number };
  const out = await runCalTick(admin, { bookingId: Number(body.booking_id) || undefined });
  if (out.errors.length) console.error('cal-tick', out.errors.slice(0, 10));
  return json(out);
});
