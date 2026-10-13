/**
 * POST /call-sections. Chapters and AI search for one recorded call.
 *
 * Body: { communication_id, action: 'sections' | 'search', query?, force? }
 *
 * sections: the call's chapters (intro, motivation, property, price,
 *   timeline, objections, next steps) with the segment each starts on.
 *   Computed once and stored on communications.call_sections (migration 106);
 *   later reads return the stored copy until the transcript grows (the
 *   recording transcript replacing the live one).
 * search: "where did they mention the roof?" answered as the segments that
 *   answer it, best first. Not stored.
 *
 * Segments come from communications.transcript_segments, else the flat
 * transcript with estimated times (lib/call-media.ts). A signed-in member of
 * the call's workspace. ANTHROPIC_API_KEY, same secret call-coach uses; the
 * browser falls back to keyword sections and plain text search without it.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor, fence, jsonWith, rateLimit, serverError, tooMany, UNTRUSTED_RULE } from '../_shared/security.ts';
import {
  SECTION_KINDS, normalizeMatches, normalizeSections, parseSegments, sectionsFresh, segmentsForPrompt, segmentsFromText,
  type CallSegment, type StoredSections,
} from '../../../lib/call-media.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

const MODEL = CLAUDE_MODEL;

const SECTIONS_TOOL = {
  name: 'sections',
  description: 'The chapters of the call, in order.',
  input_schema: {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...SECTION_KINDS] },
            title: { type: 'string', description: 'Two to five words, sentence case, specific to this call (e.g. "Roof and foundation").' },
            start_index: { type: 'integer', description: 'The [n] of the first line of this chapter.' },
            summary: { type: 'string', description: 'One short sentence: what was said in this chapter.' },
          },
          required: ['kind', 'title', 'start_index', 'summary'],
        },
      },
    },
    required: ['sections'],
  },
} as const;

const SEARCH_TOOL = {
  name: 'matches',
  description: 'The transcript lines that answer the question, best first.',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The [n] of the line.' },
            why: { type: 'string', description: 'Under twelve words on why this line answers it.' },
          },
          required: ['index', 'why'],
        },
      },
    },
    required: ['matches'],
  },
} as const;

const SECTIONS_SYSTEM = 'You split a real-estate acquisitions or dispositions phone call into chapters for a playback timeline. '
  + 'Use between 3 and 8 chapters, in time order, each starting on a transcript line. The first chapter starts at line 0. '
  + 'Pick the kind that fits: intro (greeting, rapport), motivation (why they would sell or buy), property (condition, repairs, features), '
  + 'price (asking price, offers, numbers, mortgage), timeline (when), objections (pushback, hesitation, competing offers), '
  + 'next_steps (what happens next), other. Titles are specific to this call and never use em dashes.';

const SEARCH_SYSTEM = 'You find the lines in a phone call transcript that answer a question about the call. '
  + 'Return up to five line numbers, best first. Match meaning, not only words: "the roof" matches "shingles are leaking". '
  + 'Return an empty list when nothing in the call answers it. Never use em dashes.';

type Body = { communication_id?: number; action?: string; query?: string; force?: boolean };

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

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const id = Number(body.communication_id);
  if (!Number.isFinite(id)) return json({ error: 'communication_id required' }, 400);
  const action = body.action === 'search' ? 'search' : 'sections';

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  // select('*') so a project without migration 106 still answers (no stored sections).
  const { data: row, error } = await admin.from('communications').select('*').eq('id', id).maybeSingle();
  if (error) return json({ error: 'Could not read that call.' }, 500);
  if (!row) return json({ error: 'Call not found.' }, 404);
  const { data: member } = await admin.from('workspace_members').select('role')
    .eq('workspace_id', row.workspace_id).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const segments: CallSegment[] = parseSegments(row.transcript_segments)
    ?? segmentsFromText(String(row.transcript ?? (row.source === 'talkr' ? '' : row.body ?? '')), row.duration_s);
  if (segments.length < 2) return json({ error: 'This call has no transcript to work from yet.' }, 422);

  if (action === 'sections' && !body.force && sectionsFresh(row.call_sections, segments.length)) {
    return json({ ok: true, sections: (row.call_sections as StoredSections).sections, source: 'ai', cached: true });
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'AI sections and search are off: set the ANTHROPIC_API_KEY secret on the Supabase project.', code: 'not_configured' }, 503);

  const rl = await rateLimit(admin, `call-sections:${who.user.id}`, action === 'search' ? 120 : 60, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  const client = new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
  const transcript = fence('transcript', segmentsForPrompt(segments), 32_000);

  try {
    if (action === 'search') {
      const query = String(body.query ?? '').trim().slice(0, 200);
      if (!query) return json({ error: 'Type what to look for.' }, 400);
      const res = await client.messages.create({
        model: MODEL, thinking: CLAUDE_THINKING,
        max_tokens: 600,
        system: toolRule('matches') + SEARCH_SYSTEM + UNTRUSTED_RULE,
        tools: [SEARCH_TOOL as unknown as Anthropic.Tool],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: `Question: ${fence('question', query, 400)}\n\nTranscript:\n${transcript}` }],
      });
      const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      return json({ ok: true, matches: normalizeMatches(call?.input, segments.length), source: 'ai' });
    }

    const res = await client.messages.create({
      model: MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 1200,
      system: toolRule('sections') + SECTIONS_SYSTEM + UNTRUSTED_RULE,
      tools: [SECTIONS_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `Transcript (${segments.length} lines):\n${transcript}` }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const sections = normalizeSections(call?.input, segments);
    if (!sections) return json({ error: 'The model returned no usable sections.' }, 502);
    const stored: StoredSections = { sections, source: 'ai', model: MODEL, at: new Date().toISOString(), segments: segments.length };
    // Best effort: without migration 106 the column is missing and the card is simply not cached.
    const { error: saveErr } = await admin.from('communications').update({ call_sections: stored }).eq('id', id);
    if (saveErr) console.error('call-sections persist', saveErr.message);
    return json({ ok: true, sections, source: 'ai', cached: false, persisted: !saveErr });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid', code: 'not_configured' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'call-sections anthropic', e, 502);
    return serverError(CORS, 'call-sections', e);
  }
});
