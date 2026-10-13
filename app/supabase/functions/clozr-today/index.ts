/**
 * POST /clozr-today — Claude ranks the rep's Today list.
 *
 * Focus:   { workspace_id, action: 'focus', name? }
 *          → { ok, source: 'ai' | 'rules', note?, greeting, total,
 *              items: [{ id, kind, record: { kind: seller|deal, id }, title, detail, tag, tone, why }] }
 *            "Clozr for today": the 3 to 6 things to do first, read here as the
 *            caller (_shared/focus.ts) from overdue and today tasks, today's
 *            appointments, unassigned new leads, closings within 7 days, leads
 *            going cold and deals 14+ days with no buyer. With ANTHROPIC_API_KEY
 *            one model call (a single tool call, so the output is structured
 *            JSON) picks and orders them and rewrites each line; ids, names and
 *            numbers are checked against the rows (lib/focus.ts applyFocusRank)
 *            and anything that does not match falls back to the rules' text.
 *            Without the key, or when the call fails, the rules' order stands
 *            and `source` says so.
 *
 * Rank:
 * Body:    { workspace_id, name?, items: [{ id, kind, label, due, stage, value, detail }] }
 *            items are the rows lib/today.ts buildToday() already picked; this
 *            function never reads the database for them, it only orders them.
 * Returns: { ok, source: 'ai', greeting, items: [{ id, why }] }
 *            ids are only ever ones the caller sent, most important first.
 *
 * The client keeps the rules' order until this answers, and keeps it for good
 * when it fails, so every error here is just "no ranking today".
 *
 * Needs the ANTHROPIC_API_KEY secret; answers 503 until it is set. Model is
 * CLOZR_TODAY_MODEL, else the shared CLAUDE_MODEL.
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { loadFocus } from '../_shared/focus.ts';
import { seatBrief } from '../_shared/seat-brief.ts';
import { FOCUS_MAX, FOCUS_MIN, applyFocusRank, rulesFocus, type FocusItem } from '../../../lib/focus.ts';

const MAX_ITEMS = 60;
const MAX_FIELD = 300;

const SYSTEM = `You are the daily planner inside CLOZR, the CRM a real estate investment company runs its wholesaling business on. A rep is starting their day. You are given the candidates the rules already put on their Today list, all of them their own: new leads nobody has called (kind "now"), tasks due or overdue (kind "due"), and offers out with no next step (kind "offers").

Order them by what should happen first. Speed to lead wins: a fresh lead goes cold in minutes. Then overdue promises, then money on the table (the biggest offer or the smallest gap to asking), then the rest. Return every candidate you think is worth doing today, most important first; leave out only true noise.

For each, write "why": under 90 characters, plain, specific, using only the facts given. Never invent a name, number, time or date. The greeting is one short sentence about what today holds (no salutation, no name, no exclamation marks: the page already says good morning).${UNTRUSTED_RULE}${WRITING_RULE}`;

const RANK_TOOL: Anthropic.Tool = {
  name: 'rank',
  description: 'The ranked Today list. Call once.',
  input_schema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', description: 'One short sentence, no salutation.' },
      items: {
        type: 'array',
        description: 'Most important first.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The candidate id, unchanged.' },
            why: { type: 'string', description: 'Under 90 characters.' },
          },
          required: ['id', 'why'],
        },
      },
    },
    required: ['greeting', 'items'],
  },
};

const FOCUS_SYSTEM = `You are Clozr, the assistant inside CLOZR — the CRM a real estate investment company runs its wholesaling business on. A rep is opening their day. You are given the candidates the rules found for them: overdue tasks, today's appointments, unassigned new leads nobody has called, tasks due today, deals closing within a week, their leads going cold (no touch in 3+ days, with the seller's stated motivation), and deals sitting 14+ days under contract with no buyer.

Pick the ${FOCUS_MIN} to ${FOCUS_MAX} that matter most right now and order them: what costs money or trust if it slips today goes first. A fresh lead goes cold in minutes; a closing this week with an open question is next; an overdue promise to a seller beats a routine follow-up; a motivated seller going quiet beats a lukewarm one.

For each pick, write "why": one plain line under 110 characters saying what to do and why now. Use only the facts given. Copy names and numbers exactly as they appear in the candidate; never add a number, date, time or dollar amount that is not in it. The greeting is one short sentence about what the day holds (no salutation, no name, no exclamation marks).${UNTRUSTED_RULE}${WRITING_RULE}`;

const FOCUS_TOOL: Anthropic.Tool = {
  name: 'focus',
  description: 'The rep\'s focus list for today. Call once.',
  input_schema: {
    type: 'object',
    properties: {
      greeting: { type: 'string', description: 'One short sentence, no salutation.' },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: FOCUS_MAX,
        description: 'Most important first.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The candidate id, unchanged.' },
            why: { type: 'string', description: 'Under 110 characters. Names and numbers exactly as given.' },
          },
          required: ['id', 'why'],
        },
      },
    },
    required: ['greeting', 'items'],
  },
};

type Item = { id?: unknown; kind?: unknown; label?: unknown; due?: unknown; stage?: unknown; value?: unknown; detail?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_FIELD) : v == null ? '' : String(v).slice(0, MAX_FIELD));

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

  let body: { workspace_id?: number; name?: string; items?: Item[]; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);

  if (body.action === 'focus') return focus(asCaller, workspaceId, who.user.id, str(body.name).slice(0, 40), apiKey, CORS);

  if (!apiKey) return json({ error: 'Clozr AI is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);
  if (!Array.isArray(body.items) || !body.items.length) return json({ error: 'items is required' }, 422);
  if (body.items.length > MAX_ITEMS) return json({ error: `at most ${MAX_ITEMS} items` }, 422);
  const items = body.items
    .map((it) => ({ id: str(it?.id).slice(0, 64), kind: str(it?.kind).slice(0, 16), label: str(it?.label), due: str(it?.due), stage: str(it?.stage), value: str(it?.value), detail: str(it?.detail) }))
    .filter((it) => it.id);
  if (!items.length) return json({ error: 'items need ids' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `clozr-today:${who.user.id}`, 30, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const now = new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  try {
    const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
    const client = new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
    const res = await client.messages.create({
      model: Deno.env.get('CLOZR_TODAY_MODEL')?.trim() || CLAUDE_MODEL,
      thinking: CLAUDE_THINKING,
      max_tokens: 3000,
      system: toolRule('rank') + SYSTEM + '\n\n' + seatBrief(member.role),
      tools: [RANK_TOOL],
      // Forced tool_choice is rejected; the system prompt asks for the call.
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `It is ${now} (Central). Rep: ${str(body.name).slice(0, 40) || 'the rep'}.\n\nCandidates (JSON):\n${fence('candidates', JSON.stringify(items), 40_000)}`,
      }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'rank');
    if (!call) return json({ error: 'Clozr AI returned no ranking' }, 502);
    const out = call.input as { greeting?: unknown; items?: unknown };
    // Only ids we were sent, each once: the model cannot add a row.
    const known = new Set(items.map((i) => i.id));
    const seen = new Set<string>();
    const ranked = (Array.isArray(out.items) ? out.items : [])
      .map((x) => ({ id: str((x as Item)?.id), why: str((x as { why?: unknown })?.why).trim().slice(0, 140) }))
      .filter((x) => known.has(x.id) && !seen.has(x.id) && seen.add(x.id));
    if (!ranked.length) return json({ error: 'Clozr AI returned no ranking' }, 502);
    return json({ ok: true, source: 'ai', greeting: str(out.greeting).trim().slice(0, 200), items: ranked });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'clozr-today anthropic', e, 502);
    return serverError(CORS, 'clozr-today', e);
  }
});

// ---- focus -------------------------------------------------------------------------

async function focus(db: SupabaseClient, ws: number, userId: string, name: string, apiKey: string | undefined, CORS: Record<string, string>): Promise<Response> {
  const json = jsonWith(CORS);
  const { data: member } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  let candidates: FocusItem[];
  try {
    candidates = await loadFocus(db, ws, userId, undefined, undefined, member.role ?? null);
  } catch (e) {
    return serverError(CORS, 'clozr-today focus', e);
  }
  const rules = (note: string | null) => json({ ok: true, ...rulesFocus(candidates), ...(note ? { note } : {}) });
  // Nothing to choose between: the rules' list is the answer.
  if (candidates.length <= FOCUS_MIN) return rules(null);
  if (!apiKey) return rules('Ranked by the rules: ANTHROPIC_API_KEY is not set.');

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `clozr-today-focus:${userId}`, 40, 3600);
  if (!rl.allowed) return rules('Ranked by the rules: the hourly AI limit is used up.');

  // The model sees the rules' first 30, plenty to choose six from.
  const shown = candidates.slice(0, 30).map((c) => ({ id: c.id, kind: c.kind, name: c.title, detail: c.detail, tag: c.tag }));
  const now = new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  try {
    const ws_ = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
    const client = new Anthropic({ apiKey, ...(ws_ ? { defaultHeaders: { 'anthropic-workspace-id': ws_ } } : {}) });
    const res = await client.messages.create({
      model: Deno.env.get('CLOZR_TODAY_MODEL')?.trim() || CLAUDE_MODEL,
      thinking: CLAUDE_THINKING,
      max_tokens: 2000,
      system: toolRule('focus') + FOCUS_SYSTEM + '\n\n' + seatBrief(member.role),
      tools: [FOCUS_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `It is ${now} (Central). Rep: ${name || 'the rep'}.\n\nCandidates in the rules' order (JSON):\n${fence('candidates', JSON.stringify(shown), 30_000)}`,
      }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'focus');
    const ranked = call ? applyFocusRank(candidates, call.input as { greeting?: unknown; items?: unknown }) : null;
    if (!ranked) return rules('Ranked by the rules: the AI answer was not usable.');
    return json({ ok: true, ...ranked });
  } catch (e) {
    console.error('clozr-today focus anthropic', e instanceof Error ? e.message : e);
    return rules('Ranked by the rules: the AI call failed.');
  }
}
