/**
 * POST /draft-template — "Write this template" in the template editor.
 *
 * Body:    { workspace_id, channel: 'sms'|'email', audience: 'seller'|'buyer'|'tc'|'general', goal, tone }
 * Returns: { ok, name, subject, blocks, body_text }
 *            email: subject + blocks (heading, paragraph, button, image,
 *                   divider, spacer, signature, property) — the editor's own
 *                   shapes, so the result drops straight into it
 *            sms:   body_text, one or two short sentences
 *          Merge fields are {{first_name}}-style and only from the list the
 *          editor offers; the template stays generic, nothing is filled in.
 *
 * Same shape as lane/: caller JWT, membership check, per-user rate limit, the
 * rep's free text fenced as data, one forced tool call. Needs ANTHROPIC_API_KEY.
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

const FIELDS = ['first_name', 'name', 'address', 'city', 'state', 'zip', 'asking_price', 'offer', 'close_date', 'title_company', 'beds', 'baths', 'photo_url', 'rep_name', 'rep_phone', 'rep_email', 'company'];

const SYSTEM = `You write message templates for Acme Homes, a real estate investment company (wholesaling, novation, double closes) working inside CLOZR, its CRM. Audiences: motivated home sellers, cash investor buyers, title companies and transaction coordinators, or anyone.

Write like a sharp, warm human acquisitions or dispositions rep: plain words, specific, short sentences, one clear ask. No hype, no exclamation-mark spam, no "I hope this email finds you well". Sellers: respectful and low-pressure. Buyers: numbers first, urgency that is real. Title/TC: professional, lead with the property address and exactly what is needed.

Templates are reused for many people, so personalise only through merge fields written as {{field}}, and only these: ${FIELDS.join(', ')}. Never invent a name, price, date or address.

SMS: under 300 characters, no links unless the goal needs one, end with a question when it fits, identify the rep by {{rep_name}} on a first touch.
Email: a subject under 70 characters; blocks in reading order. Usually a heading or not, one to four short paragraphs (the first starts "Hi {{first_name}},"), at most one button with a real https URL only if the goal provides one (otherwise none), a property block when the email is about a specific house, and a signature block last. Image blocks only with {{photo_url}}.${UNTRUSTED_RULE}${WRITING_RULE}`;

const TOOL: Anthropic.Tool = {
  name: 'template',
  description: 'The drafted template.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short name for the template library, e.g. "Seller · first follow-up".' },
      subject: { type: ['string', 'null'], description: 'Email subject; null for SMS.' },
      body_text: { type: 'string', description: 'The SMS body. For email, an empty string.' },
      blocks: {
        type: 'array',
        description: 'Email only (empty for SMS).',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['heading', 'paragraph', 'button', 'image', 'divider', 'spacer', 'signature', 'property'] },
            text: { type: 'string', description: 'heading / paragraph text; paragraphs may contain line breaks' },
            label: { type: 'string', description: 'button label' },
            url: { type: 'string', description: 'button or image URL' },
            alt: { type: 'string', description: 'image alt text' },
            size: { type: 'number', description: 'spacer height in px' },
          },
          required: ['type'],
        },
      },
    },
    required: ['name', 'subject', 'body_text', 'blocks'],
  },
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
  if (!apiKey) return json({ error: 'AI drafting is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: { workspace_id?: number; channel?: string; audience?: string; goal?: string; tone?: string };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  const channel = body.channel === 'sms' ? 'sms' : 'email';
  const audience = ['seller', 'buyer', 'tc', 'general'].includes(String(body.audience)) ? String(body.audience) : 'general';
  const goal = String(body.goal ?? '').trim();
  if (!goal) return json({ error: 'Say what the template is for first.' }, 422);
  if (goal.length > 2000) return json({ error: 'goal is too long' }, 422);
  const tone = String(body.tone ?? '').trim().slice(0, 200) || 'friendly, professional';

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `draft-template:${who.user.id}`, 40, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 2500,
      system: toolRule('template') + SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `Write a ${channel === 'sms' ? 'text message' : 'email'} template for this audience: ${audience}.\n\nWhat it is for:\n${fence('goal', goal, 2000)}\n\nTone:\n${fence('tone', tone, 200)}`,
      }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) return json({ error: 'the draft came back empty' }, 502);
    const out = call.input as { name?: unknown; subject?: unknown; body_text?: unknown; blocks?: unknown };
    return json({
      ok: true,
      name: String(out.name ?? '').slice(0, 120),
      subject: channel === 'email' && typeof out.subject === 'string' ? out.subject.slice(0, 300) : null,
      body_text: channel === 'sms' ? String(out.body_text ?? '').slice(0, 1600) : '',
      blocks: channel === 'email' && Array.isArray(out.blocks) ? out.blocks.slice(0, 30) : [],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'draft-template anthropic', e, 502);
    return serverError(CORS, 'draft-template', e);
  }
});
