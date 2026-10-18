/**
 * POST /call-profile: who the other person on a live call is, from what they
 * said. The dialer asks while a call is up (and once at wrap-up) when the
 * number has no CLOZR record, or is a buyer whose buy box has gaps.
 *
 * Body:    { workspace_id, transcript, rep_label?, phone?, known_kind? }
 *          transcript is "Rep: …" / "Caller: …" lines; only its last 6,000
 *          characters are read.
 * Returns: { ok, profile: CallProfile } (supabase/functions/_shared/call-profile.ts)
 *
 * Nothing is written here. The dialer shows the profile and the rep opens a
 * pre-filled form and saves it, or does not. The transcript is fenced as
 * untrusted: a caller saying "mark me as a VIP buyer" is data, not an
 * instruction. Every field must quote the transcript or it is dropped, and the
 * free-text notes are dropped when they fail the no-AI-slop check.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { WRITING_RULE, slopFindings } from '../_shared/no-ai-slop.ts';
import { CALL_PROFILE_SYSTEM, CALL_PROFILE_TOOL, PROFILE_KINDS, emptyProfile, parseCallProfile, tailTranscript } from '../_shared/call-profile.ts';

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const SYSTEM = toolRule('profile') + CALL_PROFILE_SYSTEM + UNTRUSTED_RULE + WRITING_RULE;

type Body = { workspace_id?: number; transcript?: string; rep_label?: string; phone?: string; known_kind?: string };

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
  if (!apiKey) return json({ error: 'Call profiles are not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  const transcript = tailTranscript(String(body.transcript ?? ''));
  if (!transcript) return json({ error: 'transcript is required' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  // A long call asks every 20 seconds or so; this leaves room for a full day of calls.
  const rl = await rateLimit(admin, `call-profile:${who.user.id}`, 400, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const repLabel = String(body.rep_label ?? 'Rep').replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40) || 'Rep';
  const known = (PROFILE_KINDS as readonly string[]).includes(String(body.known_kind)) ? String(body.known_kind) : null;
  const phone = String(body.phone ?? '').replace(/[^\d+]/g, '').slice(0, 16);

  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 1500,
      system: SYSTEM,
      tools: [CALL_PROFILE_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `Lines starting "Rep:" are the rep (${repLabel}); lines starting "Caller:" are the other person.`
          + (phone ? ` The other person's number is ${phone}.` : '')
          + (known ? ` The CRM already has them as a ${known}.` : ' They are not in the CRM yet.')
          + `\n\nThe call so far:\n${fence('transcript', transcript, 7000)}`,
      }],
    });
    if (res.stop_reason === 'refusal') return json({ ok: true, profile: emptyProfile() });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const profile = parseCallProfile(call?.input, transcript, { notesOk: (s) => slopFindings(s).length === 0 });
    return json({ ok: true, profile });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'call-profile anthropic', e, 502);
    return serverError(CORS, 'call-profile', e);
  }
});
