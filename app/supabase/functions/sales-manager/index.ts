/**
 * POST /sales-manager: the AI Sales Manager (docs/ai-sales-manager.md).
 *
 * Body { action, workspace_id, ... }. A signed-in member of the workspace.
 * Owners and admins see the whole team; everyone else sees only their own
 * scorecard, flagged calls and roleplays.
 *
 *   scorecards       { period? }                     per-rep KPIs, framework hit rates, flags, roleplay
 *   flagged          { rep_id?, flag?, days? }        graded calls with missed-deal flags, newest first
 *   review_backlog   { limit? }                      admins: grade recent long calls the framework has not read yet
 *   weekly_test      {}                              admins: the weekly scorecard email, to the caller now
 *   roleplay_start   { persona, difficulty, objection?, mode: 'voice'|'text' }
 *   roleplay_say     { session_id, text }            text mode: the rep's line, the seller's answer
 *   roleplay_finish  { session_id, lines?, conversation_id?, duration_s? }  grade it
 *   roleplay_abandon { session_id }
 *   roleplay_arm     { persona, difficulty, objection? }   arm the phone line: the rep's next call to it is this scenario
 *   roleplay_phone   { phone? }                     admins: the roleplay line's number, and wire the agent to voice-agent's webhooks
 *   submit_review    { call_type, rep_id?, title?, text? | file_path? }  grade a call from outside CLOZR
 *
 * Grading and the text seller use ANTHROPIC_API_KEY and the model call-coach
 * uses (_shared/models.ts). Voice roleplay needs ELEVENLABS_API_KEY: one
 * agent per workspace (sales_coach_settings.roleplay_agent_id, created on the
 * first voice session) plays every persona through dynamic variables. Without
 * the key, roleplay_start answers { voice: false } and the screen falls back
 * to text. The phone line is graded from voice-agent's post-call webhook
 * (_shared/roleplay-run.ts). An uploaded recording is transcribed by Deepgram
 * (DEEPGRAM_API_KEY, the key the live transcript uses) and graded in the
 * background; the screen reads call_review_submissions for the result.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, fence, jsonWith, rateLimit, serverError, tooMany, UNTRUSTED_RULE } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { coachTranscript } from '../_shared/coach-run.ts';
import { loadScorecards, mailWeekly } from '../_shared/sales-manager.ts';
import { ElevenError, SECRET_HEADER, elJson, getSignedUrl, webhookUrls, type ElConfig } from '../_shared/voice-agent-admin.ts';
import { scoreSession } from '../_shared/roleplay-run.ts';
import { PERIOD_IDS } from '../_shared/leaderboard.ts';
import { firstName, isConversation, measureTalkSplit } from '../../../lib/call-coaching.ts';
import { parseSegments, segmentsForPrompt } from '../../../lib/call-media.ts';
import { FLAG_IDS, FLAG_MIN_SECONDS, callTypeById } from '../../../lib/sales-framework.ts';
import {
  DIFFICULTIES, OBJECTIONS, difficultyById, linesFromElevenLabs, objectionById, parseLines, personaById, roleplayAgentBody, sellerPrompt,
  type RoleplayLine, type RoleplayWiring,
} from '../../../lib/roleplay.ts';
import { cleanUploadedText, guessRepSpeaker, labelledTranscript, parseDeepgram, segmentsFromUtterances } from '../../../lib/call-upload.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// deno-lint-ignore no-explicit-any
type Any = any;
type Body = Record<string, unknown> & { action?: string; workspace_id?: number | string };

const ACTIONS = ['scorecards', 'flagged', 'review_backlog', 'weekly_test', 'roleplay_start', 'roleplay_say', 'roleplay_finish', 'roleplay_abandon', 'roleplay_arm', 'roleplay_phone', 'submit_review'];
const ADMIN_ONLY = ['review_backlog', 'weekly_test', 'roleplay_phone'];
const MAX_TEXT_TURNS = 40;
const BACKLOG_MAX = 8;

function anthropic(apiKey: string): Anthropic {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const action = String(body.action ?? '');
  if (!ACTIONS.includes(action)) return json({ error: `action must be one of ${ACTIONS.join(', ')}` }, 400);
  const ws = Number(body.workspace_id);
  if (!Number.isInteger(ws) || ws <= 0) return json({ error: 'workspace_id is required' }, 422);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const me = who.user.id;
  const { data: member } = await admin.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', me).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  const isAdmin = ['owner', 'admin'].includes(String(member.role));
  if (ADMIN_ONLY.includes(action) && !isAdmin) return json({ error: 'owners and admins only' }, 403);

  const rl = await rateLimit(admin, `sales-manager:${me}`, 400, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

  try {
    switch (action) {
      // ---- Scorecards ----------------------------------------------------------
      case 'scorecards': {
        const period = (PERIOD_IDS as string[]).includes(String(body.period)) ? String(body.period) : 'this-week';
        const b = await loadScorecards(admin, ws, period);
        const cards = isAdmin ? b.cards : b.cards.filter((c) => c.id === me);
        return json({ ok: true, period, range: b.range, cards, team: isAdmin ? b.team : null, notes: b.notes, admin: isAdmin });
      }

      // ---- Flagged calls -------------------------------------------------------
      case 'flagged': {
        const days = Math.max(1, Math.min(90, Number(body.days) || 30));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const flag = typeof body.flag === 'string' && (FLAG_IDS as string[]).includes(body.flag) ? body.flag : null;
        const rep = isAdmin ? (typeof body.rep_id === 'string' && body.rep_id ? body.rep_id : null) : me;
        let q = admin.from('communications')
          .select('id, occurred_at, duration_s, direction, rep_id, seller_id, buyer_id, score_overall, recording_url, coaching_review')
          .eq('workspace_id', ws).eq('channel', 'call').gte('occurred_at', since)
          .filter('coaching_review->flag_ids', 'neq', '[]')
          .order('occurred_at', { ascending: false }).limit(200);
        if (flag) q = q.contains('coaching_review', { flag_ids: [flag] });
        if (rep) q = q.eq('rep_id', rep);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Any[];
        const sellerIds = [...new Set(rows.map((r) => r.seller_id).filter((x) => x != null))];
        const repIds = [...new Set(rows.map((r) => r.rep_id).filter(Boolean))];
        const [sellers, reps] = await Promise.all([
          sellerIds.length ? admin.from('sellers').select('id, name, property_address').in('id', sellerIds) : Promise.resolve({ data: [] }),
          repIds.length ? admin.from('profiles').select('id, full_name').in('id', repIds) : Promise.resolve({ data: [] }),
        ]);
        const sName = new Map(((sellers.data ?? []) as Any[]).map((s) => [s.id, { name: s.name, address: s.property_address }]));
        const rName = new Map(((reps.data ?? []) as Any[]).map((p) => [p.id, p.full_name]));
        return json({
          ok: true,
          calls: rows.map((r) => {
            const cr = r.coaching_review ?? {};
            return {
              id: r.id, occurred_at: r.occurred_at, duration_s: r.duration_s, direction: r.direction,
              rep_id: r.rep_id, rep_name: rName.get(r.rep_id) ?? null,
              seller_id: r.seller_id, seller_name: sName.get(r.seller_id)?.name ?? null, address: sName.get(r.seller_id)?.address ?? null,
              overall: typeof cr.overall === 'number' ? cr.overall : r.score_overall ?? null,
              hit_rate: cr.framework?.hit_rate ?? null,
              flags: Array.isArray(cr.flags) ? cr.flags : [],
              insights: Array.isArray(cr.insights) ? cr.insights : [],
              verdict: typeof cr.verdict === 'string' ? cr.verdict : null,
              has_recording: !!r.recording_url,
            };
          }),
        });
      }

      // ---- Grade the backlog ---------------------------------------------------
      case 'review_backlog': {
        if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set on the Supabase project.' }, 503);
        const bl = await rateLimit(admin, `sales-manager-backlog:${ws}`, 6, 3600);
        if (!bl.allowed) return tooMany(CORS, bl);
        const limit = Math.max(1, Math.min(BACKLOG_MAX, Number(body.limit) || BACKLOG_MAX));
        const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
        // Long recorded calls with a transcript: never graded, or graded before the framework existed.
        const { data } = await admin.from('communications')
          .select('id, transcript, transcript_segments, duration_s, seller_id, buyer_id, rep_id, coaching_review')
          .eq('workspace_id', ws).eq('channel', 'call').eq('transcript_status', 'completed').gte('duration_s', FLAG_MIN_SECONDS)
          .gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(200);
        const todo = ((data ?? []) as Any[]).filter((r) => {
          const cr = r.coaching_review;
          if (!cr) return true;
          return cr.status === 'completed' && !cr.framework;
        }).slice(0, limit);
        let graded = 0;
        const errors: string[] = [];
        for (const r of todo) {
          const transcript = String(r.transcript ?? '').trim();
          const names = await callNames(admin, r);
          if (transcript.length < 40 || !isConversation(transcript, { repName: names.rep, prospectName: names.prospect, durationS: r.duration_s })) continue;
          try {
            const segs = parseSegments(r.transcript_segments);
            const review = await coachTranscript({
              apiKey, transcript, repName: names.rep, prospectName: names.prospect, source: 'recording',
              talk: measureTalkSplit(transcript, names.rep, names.prospect),
              timeline: segs?.length ? segmentsForPrompt(segs, 24_000) : null,
              durationS: r.duration_s, sellerCall: r.buyer_id == null,
            });
            await admin.from('communications').update({ coaching_review: review, score_overall: review.overall }).eq('id', r.id);
            graded++;
          } catch (e) {
            errors.push(e instanceof Error ? e.message.slice(0, 160) : String(e));
          }
        }
        return json({ ok: true, considered: todo.length, graded, errors });
      }

      case 'weekly_test': {
        const email = who.user.email;
        if (!email) return json({ error: 'Your account has no email address.' }, 422);
        const r = await mailWeekly(admin, ws, [email]);
        return r.error && !r.sent ? json({ ok: false, error: r.error }) : json({ ok: true, to: email });
      }

      // ---- Roleplay ------------------------------------------------------------
      case 'roleplay_start': {
        const persona = personaById(String(body.persona ?? ''));
        if (!persona) return json({ error: 'Pick a seller persona.' }, 422);
        const difficulty = difficultyById(String(body.difficulty ?? 'medium'))?.id ?? 'medium';
        const objection = objectionById(String(body.objection ?? ''))?.id ?? null;
        const wantVoice = body.mode === 'voice';
        const sl = await rateLimit(admin, `roleplay-start:${me}`, 30, 3600);
        if (!sl.allowed) return tooMany(CORS, sl);
        const { data: w } = await admin.from('workspaces').select('name').eq('id', ws).maybeSingle();
        const company = (w as Any)?.name ?? null;

        let voice: { signed_url: string; agent_id: string; dynamic_variables: Record<string, string>; first_message: string } | null = null;
        let voiceError: string | null = null;
        const elKey = Deno.env.get('ELEVENLABS_API_KEY') ?? '';
        if (wantVoice) {
          if (!elKey) voiceError = 'Voice roleplay needs ELEVENLABS_API_KEY on the Supabase project. Practising by text instead.';
          else {
            try {
              const cfg: ElConfig = { apiKey: elKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || undefined };
              const agentId = await roleplayAgent(admin, cfg, ws, company);
              voice = {
                signed_url: await getSignedUrl(cfg, agentId), agent_id: agentId, first_message: persona.opener,
                dynamic_variables: { persona_prompt: sellerPrompt({ persona, difficulty, objection, company, voice: true }), first_message: persona.opener },
              };
            } catch (e) {
              console.error('roleplay voice', e instanceof Error ? e.message : e);
              voiceError = e instanceof ElevenError ? `ElevenLabs refused the roleplay agent (${e.status}). Practising by text instead.` : 'Voice roleplay could not start. Practising by text instead.';
            }
          }
        }
        if (!voice && !apiKey) return json({ error: voiceError ?? 'Roleplay needs ANTHROPIC_API_KEY (text) or ELEVENLABS_API_KEY (voice) on the Supabase project.' }, 503);
        const opener: RoleplayLine = { role: 'seller', text: persona.opener, at_s: 0 };
        const { data: row, error } = await admin.from('roleplay_sessions').insert({
          workspace_id: ws, user_id: me, persona: persona.id, difficulty, objection, mode: voice ? 'voice' : 'text',
          status: 'active', transcript: voice ? [] : [opener],
        }).select('id').single();
        if (error) {
          if (/roleplay_sessions/.test(error.message)) return json({ error: 'Roleplay is not set up: apply migration 149.' }, 503);
          throw new Error(error.message);
        }
        return json({
          ok: true, session_id: row.id, mode: voice ? 'voice' : 'text', voice_error: voiceError,
          seller_name: persona.name, opener: persona.opener, ...(voice ? { voice } : {}),
        });
      }

      case 'roleplay_say': {
        if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set on the Supabase project.' }, 503);
        const s = await mySession(admin, ws, me, body.session_id);
        if (!s) return json({ error: 'Session not found.' }, 404);
        if (s.status !== 'active' || s.mode !== 'text') return json({ error: 'This session is over.' }, 409);
        const text = String(body.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
        if (!text) return json({ error: 'Say something first.' }, 422);
        const lines = parseLines(s.transcript);
        if (lines.filter((l) => l.role === 'rep').length >= MAX_TEXT_TURNS) return json({ error: 'That is the turn limit for one session. Finish it to get your feedback.' }, 409);
        const sl = await rateLimit(admin, `roleplay-say:${me}`, 300, 3600);
        if (!sl.allowed) return tooMany(CORS, sl);
        const persona = personaById(s.persona)!;
        const elapsed = Math.round((Date.now() - Date.parse(s.started_at)) / 1000);
        lines.push({ role: 'rep', text, at_s: elapsed });
        const { data: w } = await admin.from('workspaces').select('name').eq('id', ws).maybeSingle();
        // The model is the seller (assistant); the rep is the user. A first user turn stands for the phone ringing.
        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: '(The phone rings. You pick up.)' }];
        for (const l of lines) {
          const role = l.role === 'seller' ? 'assistant' : 'user';
          const last = messages[messages.length - 1];
          if (last.role === role) last.content = `${last.content}\n${l.text}`;
          else messages.push({ role, content: l.text });
        }
        const res = await anthropic(apiKey).messages.create({
          model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: 300,
          system: sellerPrompt({ persona, difficulty: s.difficulty, objection: s.objection, company: (w as Any)?.name ?? null }),
          messages,
        });
        const reply = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ')
          .replace(/^\s*(?:\w+:\s*)/, '').replace(/\s+/g, ' ').trim().slice(0, 1200) || '...';
        lines.push({ role: 'seller', text: reply, at_s: elapsed + 1 });
        await admin.from('roleplay_sessions').update({ transcript: lines, updated_at: new Date().toISOString() }).eq('id', s.id);
        return json({ ok: true, reply });
      }

      case 'roleplay_finish': {
        const s = await mySession(admin, ws, me, body.session_id);
        if (!s) return json({ error: 'Session not found.' }, 404);
        if (s.status === 'scored') return json({ ok: true, feedback: s.feedback, score: s.score, cached: true });
        if (s.mode === 'phone') return json({ ok: false, error: 'A phone roleplay is scored automatically a minute after you hang up.' });
        let lines = parseLines(s.transcript);
        const convId = typeof body.conversation_id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(body.conversation_id) ? body.conversation_id : null;
        if (s.mode === 'voice') {
          // ElevenLabs' own transcript is the record when it is there; the browser's lines otherwise.
          const elKey = Deno.env.get('ELEVENLABS_API_KEY') ?? '';
          if (convId && elKey) {
            try {
              const conv = await elJson(
                { apiKey: elKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || undefined }, 'GET', `/v1/convai/conversations/${encodeURIComponent(convId)}`,
              );
              const fromEl = linesFromElevenLabs(conv);
              if (fromEl.length) lines = fromEl;
            } catch { /* the browser's copy below */ }
          }
          if (!lines.length) lines = parseLines(body.lines);
        }
        const duration = Number(body.duration_s);
        const durationS = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : Math.round((Date.now() - Date.parse(s.started_at)) / 1000);
        const r = await scoreSession(admin, s, lines, { conversation_id: convId ?? s.conversation_id, duration_s: durationS });
        if (!r.ok) return json({ ok: false, error: r.error });
        return json({ ok: true, feedback: r.feedback, score: r.feedback.overall });
      }

      case 'roleplay_abandon': {
        const s = await mySession(admin, ws, me, body.session_id);
        if (!s) return json({ error: 'Session not found.' }, 404);
        if (s.status === 'active' || s.status === 'armed') await admin.from('roleplay_sessions').update({ status: 'abandoned', ended_at: new Date().toISOString() }).eq('id', s.id);
        return json({ ok: true });
      }

      // ---- Roleplay by phone ---------------------------------------------------
      case 'roleplay_arm': {
        const persona = personaById(String(body.persona ?? ''));
        if (!persona) return json({ error: 'Pick a seller persona.' }, 422);
        const difficulty = difficultyById(String(body.difficulty ?? 'medium'))?.id ?? 'medium';
        const objection = objectionById(String(body.objection ?? ''))?.id ?? null;
        const [line, { data: prof }] = await Promise.all([
          roleplayLine(admin, ws),
          admin.from('profiles').select('phone').eq('id', me).maybeSingle(),
        ]);
        if (!line) return json({ error: 'There is no roleplay phone line yet. An owner sets one up once under Coaching, Overview, Manager tools, and it serves every workspace.' }, 409);
        if (String((prof as Any)?.phone ?? '').replace(/\D/g, '').length < 10) return json({ error: 'Add your cell phone to your profile (Account) first: the line knows you by the number you call from.' }, 422);
        // One armed scenario at a time: a new one replaces the old.
        await admin.from('roleplay_sessions').update({ status: 'abandoned', ended_at: new Date().toISOString() }).eq('workspace_id', ws).eq('user_id', me).eq('status', 'armed');
        const { data: row, error } = await admin.from('roleplay_sessions').insert({
          workspace_id: ws, user_id: me, persona: persona.id, difficulty, objection, mode: 'phone', status: 'armed', transcript: [],
        }).select('id, started_at').single();
        if (error) throw new Error(error.message);
        return json({ ok: true, session_id: row.id, phone: line, armed_until: new Date(Date.parse(row.started_at) + 30 * 60_000).toISOString(), seller_name: persona.name });
      }

      case 'roleplay_phone': {
        const wanted = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
        const elKey = Deno.env.get('ELEVENLABS_API_KEY') ?? '';
        if (!elKey) return json({ error: 'ELEVENLABS_API_KEY is not set on the Supabase project.' }, 503);
        const cfg: ElConfig = { apiKey: elKey, baseUrl: Deno.env.get('ELEVENLABS_API_BASE') || undefined };
        const wiring = await roleplayWiring(admin, ws);
        if (!wiring) return json({ error: 'Connect the AI Agent first (Settings, AI Agent, Publish): the roleplay line uses its webhooks.' }, 409);
        const { data: w } = await admin.from('workspaces').select('name').eq('id', ws).maybeSingle();
        const agentId = await roleplayAgent(admin, cfg, ws, (w as Any)?.name ?? null, wiring);
        const picked = await assignRoleplayNumber(admin, cfg, agentId, wanted);
        if (!picked.ok) return json({ error: picked.error }, 409);
        await admin.from('sales_coach_settings').upsert({ workspace_id: ws, roleplay_phone: picked.phone, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
        return json({ ok: true, agent_id: agentId, phone: picked.phone });
      }

      // ---- Submit a call for review -------------------------------------------
      case 'submit_review': {
        if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set on the Supabase project.' }, 503);
        const type = callTypeById(body.call_type);
        if (!type) return json({ error: 'Pick a call scoring type.' }, 422);
        const sl = await rateLimit(admin, `sales-manager-submit:${me}`, 20, 3600);
        if (!sl.allowed) return tooMany(CORS, sl);
        let repId = me;
        if (isAdmin && typeof body.rep_id === 'string' && body.rep_id) {
          const { data: m } = await admin.from('workspace_members').select('user_id').eq('workspace_id', ws).eq('user_id', body.rep_id).maybeSingle();
          if (!m) return json({ error: 'That rep is not in this workspace.' }, 422);
          repId = body.rep_id;
        }
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) || null : null;
        const text = typeof body.text === 'string' ? cleanUploadedText(body.text) : '';
        const path = typeof body.file_path === 'string' ? body.file_path : '';
        if (!text && !path) return json({ error: 'Attach a transcript or a recording.' }, 422);
        if (path && (!path.startsWith(`${ws}/uploads/`) || path.includes('..'))) return json({ error: 'That upload is not in this workspace.' }, 403);
        if (text && text.length < 200) return json({ error: 'That transcript is too short to review.' }, 422);
        if (path && !Deno.env.get('DEEPGRAM_API_KEY')) return json({ error: 'Transcribing a recording needs DEEPGRAM_API_KEY on the Supabase project. Upload a .txt transcript instead.' }, 503);
        const { data: row, error } = await admin.from('call_review_submissions').insert({
          workspace_id: ws, user_id: me, rep_id: repId, call_type: type.id, title, source: path ? 'audio' : 'text',
          file_path: path || null, transcript: text || null, status: 'processing',
        }).select('id').single();
        if (error) {
          if (/call_review_submissions/.test(error.message)) return json({ error: 'Call review is not set up: apply migration 149.' }, 503);
          throw new Error(error.message);
        }
        EdgeRuntime.waitUntil(reviewSubmission(admin, Number(row.id), repId, type.id, text, path, apiKey)
          .catch(async (e) => {
            console.error('submit_review', e instanceof Error ? e.message : e);
            await admin.from('call_review_submissions').update({ status: 'failed', error: 'The review failed. Try again.', updated_at: new Date().toISOString() }).eq('id', row.id);
          }));
        return json({ ok: true, submission_id: row.id });
      }
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    return serverError(CORS, `sales-manager ${action}`, e);
  }
});

type SessionRow = {
  id: number; workspace_id: number; user_id: string; persona: string; difficulty: 'easy' | 'medium' | 'hard'; objection: (typeof OBJECTIONS)[number]['id'] | null;
  mode: 'voice' | 'text' | 'phone'; status: string; transcript: unknown; feedback: unknown; score: number | null; started_at: string; conversation_id: string | null;
};

async function mySession(admin: SupabaseClient, ws: number, me: string, id: unknown): Promise<SessionRow | null> {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const { data } = await admin.from('roleplay_sessions').select('*').eq('id', n).eq('workspace_id', ws).eq('user_id', me).maybeSingle();
  const s = data as SessionRow | null;
  if (!s || !personaById(s.persona) || !DIFFICULTIES.some((d) => d.id === s.difficulty)) return null;
  return s;
}

/** voice-agent's webhooks, as the AI Agent console wired them (voice_agent_secrets, migration 111). Null before it is connected. */
async function roleplayWiring(admin: SupabaseClient, ws: number): Promise<RoleplayWiring | null> {
  const { data, error } = await admin.from('voice_agent_secrets').select('personalize_secret, webhook_id').eq('workspace_id', ws).maybeSingle();
  const r = data as Any;
  if (error || !r?.personalize_secret) return null;
  return { personalizeUrl: webhookUrls(Deno.env.get('SUPABASE_URL')!).personalize, secretHeader: SECRET_HEADER, personalizeSecret: r.personalize_secret, webhookId: r.webhook_id ?? null };
}

/**
 * The workspace's ElevenLabs roleplay agent, created on first use (wired to
 * voice-agent's webhooks when the AI Agent is connected). With `wiring`
 * (setting up the phone line) an existing agent is updated so phone calls
 * reach voice-agent's /personalize and /post-call.
 */
async function roleplayAgent(admin: SupabaseClient, cfg: ElConfig, ws: number, company: string | null, wiring: RoleplayWiring | null = null): Promise<string> {
  const { data } = await admin.from('sales_coach_settings').select('roleplay_agent_id').eq('workspace_id', ws).maybeSingle();
  const have = (data as Any)?.roleplay_agent_id as string | null;
  if (have && !wiring) return have;
  const body = roleplayAgentBody({ company, voiceId: Deno.env.get('ROLEPLAY_VOICE_ID') || null, wiring: wiring ?? await roleplayWiring(admin, ws) });
  if (have) {
    try {
      await elJson(cfg, 'PATCH', `/v1/convai/agents/${encodeURIComponent(have)}`, body);
      return have;
    } catch (e) {
      if (!(e instanceof ElevenError && e.status === 404)) throw e;
    }
  }
  const created = await elJson<{ agent_id?: string }>(cfg, 'POST', '/v1/convai/agents/create', body);
  if (!created.agent_id) throw new Error('ElevenLabs did not return an agent id');
  await admin.from('sales_coach_settings').upsert({ workspace_id: ws, roleplay_agent_id: created.agent_id, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
  return created.agent_id;
}

/**
 * The number a rep calls to practise: this workspace's line, else any
 * workspace's. One line serves everyone because the call is matched to the
 * caller's armed session wherever they armed it (roleplay-run.ts).
 */
async function roleplayLine(admin: SupabaseClient, ws: number): Promise<string | null> {
  const { data } = await admin.from('sales_coach_settings').select('workspace_id, roleplay_phone')
    .not('roleplay_phone', 'is', null).not('roleplay_agent_id', 'is', null);
  const rows = (data ?? []) as { workspace_id: number; roleplay_phone: string }[];
  return (rows.find((r) => Number(r.workspace_id) === ws) ?? rows[0])?.roleplay_phone ?? null;
}

type ElNumber = { phone_number_id: string; phone_number: string; assigned_agent?: { agent_id?: string } | null };

/**
 * Point an ElevenLabs number at the roleplay agent. `wanted` picks one by its
 * digits; blank takes the first number no agent is using. The AI Agent's own
 * numbers (voice_agent_numbers) are never taken.
 */
async function assignRoleplayNumber(admin: SupabaseClient, cfg: ElConfig, agentId: string, wanted: string): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
  const listed = await elJson<ElNumber[] | { phone_numbers?: ElNumber[] }>(cfg, 'GET', '/v1/convai/phone-numbers');
  const all = Array.isArray(listed) ? listed : listed.phone_numbers ?? [];
  const { data: taken } = await admin.from('voice_agent_numbers').select('el_phone_number_id');
  const reserved = new Set(((taken ?? []) as { el_phone_number_id: string | null }[]).map((r) => r.el_phone_number_id).filter(Boolean));
  let pick: ElNumber | undefined;
  if (wanted) {
    pick = all.find((n) => digits(n.phone_number) === digits(wanted));
    if (!pick) return { ok: false, error: `${wanted} is not a number in ElevenLabs. Import or buy it there (Phone numbers) first, or leave the box blank to use a spare one.` };
    if (reserved.has(pick.phone_number_id)) return { ok: false, error: `${wanted} belongs to the AI Agent. Pick a different number.` };
  } else {
    pick = all.find((n) => n.assigned_agent?.agent_id === agentId)
      ?? all.find((n) => !n.assigned_agent?.agent_id && !reserved.has(n.phone_number_id));
    if (!pick) return { ok: false, error: 'Every ElevenLabs number is already in use. Import or buy one more in ElevenLabs (Phone numbers), then set the line up again.' };
  }
  if (pick.assigned_agent?.agent_id !== agentId) {
    await elJson(cfg, 'PATCH', `/v1/convai/phone-numbers/${encodeURIComponent(pick.phone_number_id)}`, { agent_id: agentId });
  }
  return { ok: true, phone: pick.phone_number };
}

/** Transcribe (a recording) and grade one submitted call, then store the review on its row. */
async function reviewSubmission(admin: SupabaseClient, id: number, repId: string, typeId: string, text: string, path: string, apiKey: string): Promise<void> {
  const type = callTypeById(typeId)!;
  const rep = firstName(((await admin.from('profiles').select('full_name').eq('id', repId).maybeSingle()).data as Any)?.full_name, 'Rep') || 'Rep';
  const prospect = type.seller ? 'Seller' : 'Buyer';
  const fail = (error: string) => admin.from('call_review_submissions').update({ status: 'failed', error, updated_at: new Date().toISOString() }).eq('id', id);
  let transcript = text;
  let timeline: string | null = null;
  let durationS: number | null = null;
  let segments: unknown = null;
  if (path) {
    const signed = await admin.storage.from('call-recordings').createSignedUrl(path, 900);
    if (signed.error || !signed.data?.signedUrl) { await fail('Could not read the uploaded recording.'); return; }
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&diarize=true&utterances=true', {
      method: 'POST',
      headers: { Authorization: `Token ${Deno.env.get('DEEPGRAM_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: signed.data.signedUrl }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) { await fail(`Deepgram could not transcribe it (${res.status}).`); return; }
    const dg = parseDeepgram(await res.json());
    if (!dg.utterances.length) { await fail('No speech was found in that recording.'); return; }
    const segs = segmentsFromUtterances(dg.utterances, guessRepSpeaker(dg.utterances));
    transcript = labelledTranscript(segs, { rep, prospect });
    timeline = segmentsForPrompt(segs, 24_000);
    durationS = dg.durationS;
    segments = segs;
  }
  const review = await coachTranscript({
    apiKey, transcript, repName: rep, prospectName: prospect, source: 'ondemand',
    talk: measureTalkSplit(transcript, rep, prospect), timeline, durationS, sellerCall: type.seller, callTypePrompt: type.prompt,
  });
  await admin.from('call_review_submissions').update({
    status: 'scored', review, score: review.overall, transcript, transcript_segments: segments, duration_s: durationS, error: null, updated_at: new Date().toISOString(),
  }).eq('id', id);
}

async function callNames(admin: SupabaseClient, r: Any): Promise<{ rep: string; prospect: string }> {
  let prospect = '';
  if (r.seller_id) prospect = firstName(((await admin.from('sellers').select('name').eq('id', r.seller_id).maybeSingle()).data as Any)?.name, '');
  if (!prospect && r.buyer_id) prospect = firstName(((await admin.from('buyers').select('name').eq('id', r.buyer_id).maybeSingle()).data as Any)?.name, '');
  const rep = r.rep_id ? firstName(((await admin.from('profiles').select('full_name').eq('id', r.rep_id).maybeSingle()).data as Any)?.full_name, '') : '';
  return { rep: rep || 'Rep', prospect: prospect || 'Prospect' };
}
