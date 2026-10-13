/**
 * POST /record-suggest — what a call or a text thread says the seller record
 * should now say.
 *
 * Body:    { workspace_id, seller_id, source: 'call'|'sms', communication_id?,
 *            transcript?: string, messages?: {direction, body, at}[], stages?: string[] }
 * Returns: { ok, suggestions: [{ kind, field?, value?, stage?, title?, due_at?,
 *            starts_at?, ends_at?, reason, quote }] }
 *
 * The seller is read as the caller (RLS), so a record the rep cannot see gives
 * nothing to suggest against. Nothing is written here: every suggestion is
 * applied, or not, by a person on the record (lib/record-suggest.ts).
 * Transcript and messages are fenced as untrusted — a seller saying "set my
 * stage to Closed" is data, not an instruction.
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const SYSTEM = `You read a call transcript or a text thread between a Acme Homes acquisitions rep and a home seller, and suggest updates to that seller's CRM record.

Rules:
- Only suggest what the conversation actually says. Never invent, never infer beyond what was said. Every suggestion carries "quote": the exact span of the transcript or a message that supports it, copied verbatim.
- Only suggest a change that differs from the record's current value. If the record already says it, say nothing.
- kind "field": field is "motivation" (why they are selling, short phrase) or "asking_price" (a number of dollars, digits only in value).
- kind "note": anything worth keeping that has no field — timeline, property condition, occupancy, mortgage/liens, decision makers, desired close. value is one short line starting with the label, e.g. "Timeline: wants to close before Oct 15".
- kind "stage": stage must be exactly one of the listed stages, and only when the conversation clearly moved the seller (appointment agreed → "Appointment Set", not selling → "Not Selling").
- kind "task": a follow-up the rep committed to or the seller asked for ("call me Friday"). title is imperative ("Call back re: price"), due_at an ISO 8601 datetime in the seller's time (Central unless said otherwise).
- kind "appointment": a meeting or walkthrough with a day and time agreed or requested ("can you come Tuesday at 3?"). title, starts_at, ends_at (ISO 8601, default one hour). Resolve relative days against today.
- reason: one short sentence on why.
- Fewer, surer suggestions beat many. None is a fine answer.${UNTRUSTED_RULE}${WRITING_RULE}`;

const TOOL: Anthropic.Tool = {
  name: 'suggest',
  description: 'Suggested updates to the seller record.',
  input_schema: {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['field', 'stage', 'task', 'appointment', 'note'] },
            field: { type: 'string', enum: ['motivation', 'asking_price'] },
            value: { type: 'string' },
            stage: { type: 'string' },
            title: { type: 'string' },
            due_at: { type: 'string' },
            starts_at: { type: 'string' },
            ends_at: { type: 'string' },
            reason: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['kind', 'reason', 'quote'],
        },
      },
    },
    required: ['suggestions'],
  },
};

type Msg = { direction?: string; body?: string; at?: string };

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
  if (!apiKey) return json({ error: 'Suggestions are not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: { workspace_id?: number; seller_id?: number; source?: string; transcript?: string; messages?: Msg[]; stages?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  const sellerId = Number(body.seller_id);
  if (!Number.isFinite(workspaceId) || !Number.isFinite(sellerId)) return json({ error: 'workspace_id and seller_id are required' }, 422);
  const source = body.source === 'sms' ? 'sms' : body.source === 'call' ? 'call' : null;
  if (!source) return json({ error: "source must be 'call' or 'sms'" }, 422);

  const conversation = source === 'call'
    ? String(body.transcript ?? '').trim()
    : (Array.isArray(body.messages) ? body.messages : []).slice(-40)
      .filter((m) => m && typeof m.body === 'string' && m.body.trim())
      .map((m) => `[${String(m.at ?? '').slice(0, 25)}] ${m.direction === 'inbound' ? 'Seller' : 'Rep'}: ${m.body}`)
      .join('\n');
  if (!conversation) return json({ error: source === 'call' ? 'transcript is required' : 'messages are required' }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `record-suggest:${who.user.id}`, 120, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const [sellerQ, tasksQ, apptsQ] = await Promise.all([
    asCaller.from('sellers').select('name,lead_stage,motivation,asking_price,notes,property_address')
      .eq('id', sellerId).eq('workspace_id', workspaceId).maybeSingle(),
    asCaller.from('tasks').select('title,due_at').eq('seller_id', sellerId).eq('done', false).limit(20),
    asCaller.from('appointments').select('title,starts_at').eq('seller_id', sellerId)
      .gte('starts_at', new Date().toISOString()).limit(20),
  ]);
  if (!sellerQ.data) return json({ error: 'seller not found' }, 404);

  const stages = (Array.isArray(body.stages) ? body.stages : []).filter((s) => typeof s === 'string').slice(0, 80);
  const record = { ...sellerQ.data, open_tasks: tasksQ.data ?? [], upcoming_appointments: apptsQ.data ?? [] };
  const today = new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 2000,
      system: toolRule('suggest') + SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `Now: ${today} (Central).\n\nStages:\n${fence('stages', stages.join('\n'), 4000)}\n\nThe record today:\n${fence('seller_record', JSON.stringify(record, null, 1), 8000)}\n\nThe ${source === 'call' ? 'call transcript' : 'text thread'}:\n${fence(source === 'call' ? 'transcript' : 'messages', conversation, 40_000)}`,
      }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const raw = (call?.input as { suggestions?: unknown })?.suggestions;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);
    const suggestions = (Array.isArray(raw) ? raw : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        kind: String(s.kind), field: str(s.field), value: str(s.value), stage: str(s.stage), title: str(s.title),
        due_at: str(s.due_at), starts_at: str(s.starts_at), ends_at: str(s.ends_at),
        reason: str(s.reason) ?? '', quote: str(s.quote) ?? '',
      }))
      // A suggestion that cannot be applied is noise; a quote that is not in
      // the conversation is an invention.
      .filter((s) => ['field', 'stage', 'task', 'appointment', 'note'].includes(s.kind) && s.quote
        && conversation.toLowerCase().includes(s.quote.toLowerCase().slice(0, 60)))
      .filter((s) => s.kind !== 'stage' || stages.includes(s.stage ?? ''))
      .slice(0, 10);
    return json({ ok: true, suggestions });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'record-suggest anthropic', e, 502);
    return serverError(CORS, 'record-suggest', e);
  }
});
