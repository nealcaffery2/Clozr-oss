/**
 * POST /call-coach. The coaching scorecard for one call.
 *
 * Body: { transcript?, rep_name?, prospect_name?, workspace_id?, communication_id?,
 *         talkr_call_id?, source?: 'live'|'recording'|'ondemand', force? }
 *
 * A signed-in member. With a communication id, or a workspace plus the Talkr
 * call id, the review is written onto that communications row (and
 * score_overall, so the record's call title shows the grade). A transcript
 * alone still returns the card, for the hang-up before the row exists.
 *
 * ANTHROPIC_API_KEY, same secret the other coaching and summary functions use.
 * Talkr's own /score rubric is left alone.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { coachTranscript } from '../_shared/coach-run.ts';
import {
  firstName, isCoachingReview, measureTalkSplit, shouldRefreshCoaching, type CallCoachingReview, type CoachingSource,
} from '../../../lib/call-coaching.ts';
import { parseSegments, segmentsForPrompt } from '../../../lib/call-media.ts';

type Body = {
  transcript?: string;
  rep_name?: string;
  prospect_name?: string;
  workspace_id?: number;
  communication_id?: number;
  talkr_call_id?: string;
  source?: string;
  force?: boolean;
};

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

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Coaching is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }

  const source: CoachingSource = body.source === 'live' || body.source === 'recording' ? body.source : 'ondemand';
  const force = body.force === true;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `call-coach:${who.user.id}`, 60, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const row = await loadCall(admin, who.user.id, body);
  if (row && 'error' in row) return json({ error: row.error }, row.status);

  const existing = row && 'coaching_review' in row ? row.coaching_review : null;
  if (row && !('error' in row) && isCoachingReview(existing) && !shouldRefreshCoaching(existing, source, force)) {
    return json({ ok: true, review: existing, persisted: true, cached: true });
  }

  const transcript = String(body.transcript ?? (row && 'transcript' in row ? row.transcript : '') ?? '').trim();
  if (transcript.length < 40) return json({ error: 'Need a transcript of the conversation first.' }, 422);

  let rep = firstName(body.rep_name, '');
  let prospect = firstName(body.prospect_name, '');
  if (row && !('error' in row)) {
    if (!prospect && row.seller_id) prospect = await personName(admin, 'sellers', row.seller_id);
    if (!prospect && row.buyer_id) prospect = await personName(admin, 'buyers', row.buyer_id);
    if (!rep && row.rep_id) rep = await repName(admin, row.rep_id);
  }
  rep = rep || 'Rep';
  prospect = prospect || 'Prospect';

  try {
    // The stored timed lines give the insights their m:ss; only when they are the transcript being graded.
    const segs = row && !('error' in row) && !body.transcript ? parseSegments(row.transcript_segments) : null;
    const review = await coachTranscript({
      apiKey, transcript, repName: rep, prospectName: prospect, source, talk: measureTalkSplit(transcript, rep, prospect),
      timeline: segs?.length ? segmentsForPrompt(segs, 24_000) : null,
      durationS: row && !('error' in row) ? row.duration_s : null,
      sellerCall: row && !('error' in row) ? row.buyer_id == null : undefined,
    });
    let persisted = false;
    // The dialer files a finished call on its record while this card is being
    // graded (lib/call-file.ts), so a row that was not there a few seconds ago
    // usually is now. Look once more rather than dropping the scorecard.
    let target = row;
    if (!target && body.talkr_call_id) {
      const again = await loadCall(admin, who.user.id, body);
      target = again && !('error' in again) ? again : null;
    }
    if (target && !('error' in target) && shouldRefreshCoaching(target.coaching_review, source, force)) {
      const { error } = await admin.from('communications').update({
        coaching_review: review,
        score_overall: review.overall,
      }).eq('id', target.id);
      if (error) console.error('call-coach persist', error.message);
      else persisted = true;
    }
    return json({ ok: true, review, persisted });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'call-coach anthropic', e, 502);
    if (e instanceof Error && /score|verdict|fix|keep|line|talk split|em dash|contrast/i.test(e.message)) {
      return json({ error: e.message }, 422);
    }
    return serverError(CORS, 'call-coach', e);
  }
});

type CallRow = {
  id: number;
  workspace_id: number;
  transcript: string | null;
  coaching_review: unknown;
  seller_id: number | null;
  buyer_id: number | null;
  rep_id: string | null;
  duration_s: number | null;
  transcript_segments?: unknown;
};

async function loadCall(admin: SupabaseClient, userId: string, body: Body): Promise<CallRow | { error: string; status: number } | null> {
  const id = Number(body.communication_id);
  const ws = Number(body.workspace_id);
  const talkrId = String(body.talkr_call_id ?? '').trim();
  if (!Number.isFinite(id) && !(Number.isFinite(ws) && talkrId)) return null;

  let q = admin.from('communications').select('id, workspace_id, transcript, coaching_review, seller_id, buyer_id, rep_id, duration_s, transcript_segments');
  if (Number.isFinite(id)) q = q.eq('id', id);
  else q = q.eq('workspace_id', ws).eq('source', 'talkr').eq('source_id', 'call:' + talkrId);
  const { data, error } = await q.maybeSingle();
  if (error) return { error: 'Could not read that call.', status: 500 };
  if (!data) return Number.isFinite(id) ? { error: 'Call not found.', status: 404 } : null;
  const { data: member } = await admin.from('workspace_members').select('role')
    .eq('workspace_id', data.workspace_id).eq('user_id', userId).maybeSingle();
  if (!member) return { error: 'not a member of that workspace', status: 403 };
  return data as CallRow;
}

async function personName(admin: SupabaseClient, table: 'sellers' | 'buyers', id: number): Promise<string> {
  const { data } = await admin.from(table).select('name').eq('id', id).maybeSingle();
  return firstName((data as { name?: string } | null)?.name, '');
}

async function repName(admin: SupabaseClient, id: string): Promise<string> {
  const { data } = await admin.from('profiles').select('full_name').eq('id', id).maybeSingle();
  return firstName((data as { full_name?: string } | null)?.full_name, '');
}
