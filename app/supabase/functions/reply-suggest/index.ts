/**
 * POST /reply-suggest — the inbox templates rail's "Suggested" cards.
 *
 * Body:    { workspace_id, kind: 'seller'|'buyer'|null, stage, name,
 *            messages: {direction, body, at}[] (newest last, at most 20),
 *            templates: {id, name, body}[] (the rail's own, at most 60) }
 * Returns: { ok, suggestions: [{ template_id: string|null, body, why }] }
 *          Up to three replies that fit this thread and the lead's stage: a
 *          saved template when one fits (template_id set, body is its text),
 *          else a reply written for this thread. Nothing is sent here; the rep
 *          clicks one into the composer and edits it.
 *
 * Same shape as draft-template: caller JWT, membership check, per-user rate
 * limit, the thread and the templates fenced as data, one tool call. The
 * Compr workspace (settings.buyer_profile = 'compr') gets Compr's brief, the
 * others the Acme Homes one. Needs ANTHROPIC_API_KEY.
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, cachedSystem, toolRule } from '../_shared/models.ts';
import { recordUsage } from '../_shared/ai-usage.ts';
import { COMPR_TEMPLATE_SYSTEM } from '../_shared/compr-plan-ai.ts';
import { COMPANY_FOOTPRINT } from '../_shared/company-profile.ts';

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const ACME_HOMES = `You help a Acme Homes rep answer a text thread. Acme Homes is a real estate investment company (wholesaling, novation, double closes). ${COMPANY_FOOTPRINT} The other side is a home seller or a cash buyer. Read the thread and the lead's stage and pick what the rep should send next: respectful and low-pressure with sellers, numbers first with buyers, one clear ask.`;

const COMPR = `You help Compr's rep answer a text thread. The other side is a Compr prospect, signup or customer, never a home seller. ${COMPR_TEMPLATE_SYSTEM}`;

const RULES = `
How to choose:
- Up to three suggestions, best first. Fewer is fine; none only when the thread needs no reply (they opted out, or the last message is ours and asked nothing).
- Prefer a saved template when one fits what was just said and the stage: return its id and leave body empty. Never reword a template.
- Otherwise write the reply: under 300 characters, plain, answers what they last asked, one question or one next step. Use their first name only if the thread shows it. Merge fields like {first_name} are fine in a written reply.
- Never promise a price, a date or a fact the thread or the brief does not give you.
- If they asked to stop, return no suggestions.
- why: a few words on why this fits now, e.g. "they asked for the price".`;

const TOOL: Anthropic.Tool = {
  name: 'suggestions',
  description: 'The replies to offer the rep.',
  input_schema: {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array', maxItems: 3,
        items: {
          type: 'object',
          properties: {
            template_id: { type: ['string', 'null'], description: 'The id of the saved template to use, or null for a written reply.' },
            body: { type: 'string', description: 'The written reply; empty when template_id is set.' },
            why: { type: 'string', description: 'A few words on why it fits now.' },
          },
          required: ['template_id', 'body', 'why'],
        },
      },
    },
    required: ['suggestions'],
  },
};

type Msg = { direction?: unknown; body?: unknown; at?: unknown };
type Tpl = { id?: unknown; name?: unknown; body?: unknown };

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
  if (!apiKey) return json({ error: 'AI suggestions are not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: { workspace_id?: number; kind?: string; stage?: string; name?: string; messages?: Msg[]; templates?: Tpl[] };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-20)
    .map((m) => ({ direction: m.direction === 'outbound' ? 'Rep' : 'Them', body: String(m.body ?? '').slice(0, 1000), at: String(m.at ?? '').slice(0, 40) }))
    .filter((m) => m.body.trim());
  if (!messages.length) return json({ ok: true, suggestions: [] });
  const templates = (Array.isArray(body.templates) ? body.templates : []).slice(0, 60)
    .map((t) => ({ id: String(t.id ?? '').slice(0, 80), name: String(t.name ?? '').slice(0, 120), body: String(t.body ?? '').slice(0, 600) }))
    .filter((t) => t.id && t.body);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `reply-suggest:${who.user.id}`, 200, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const { data: ws } = await admin.from('workspaces').select('buyer_profile:settings->>buyer_profile').eq('id', workspaceId).maybeSingle();
  const compr = (ws as { buyer_profile?: unknown } | null)?.buyer_profile === 'compr';

  const thread = messages.map((m) => `${m.at ? m.at + ' ' : ''}${m.direction}: ${m.body}`).join('\n');
  const library = templates.map((t) => `[${t.id}] ${t.name}: ${t.body}`).join('\n') || '(no saved templates)';
  const who2 = `Lead: ${String(body.kind ?? 'unknown').slice(0, 20)}${body.name ? `, ${String(body.name).slice(0, 80)}` : ''}. Stage: ${String(body.stage ?? 'unknown').slice(0, 80) || 'unknown'}.`;

  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL,
      thinking: CLAUDE_THINKING,
      max_tokens: 1200,
      system: cachedSystem(toolRule('suggestions') + (compr ? COMPR : ACME_HOMES) + RULES + UNTRUSTED_RULE + WRITING_RULE),
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `${who2}\n\nThe thread, oldest first:\n${fence('thread', thread, 16_000)}\n\nSaved templates, [id] name: text:\n${fence('templates', library, 30_000)}` }],
    });
    await recordUsage(admin, { ws: workspaceId, feature: 'reply_suggest', model: res.model, usage: res.usage });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const raw = ((call?.input as { suggestions?: unknown } | undefined)?.suggestions ?? []) as { template_id?: unknown; body?: unknown; why?: unknown }[];
    const ids = new Set(templates.map((t) => t.id));
    const suggestions = (Array.isArray(raw) ? raw : []).slice(0, 3).flatMap((s) => {
      const id = typeof s.template_id === 'string' && ids.has(s.template_id) ? s.template_id : null;
      const text = id ? templates.find((t) => t.id === id)!.body : String(s.body ?? '').trim().slice(0, 600);
      return text ? [{ template_id: id, body: text, why: String(s.why ?? '').slice(0, 120) }] : [];
    });
    return json({ ok: true, suggestions });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'reply-suggest anthropic', e, 502);
    return serverError(CORS, 'reply-suggest', e);
  }
});
