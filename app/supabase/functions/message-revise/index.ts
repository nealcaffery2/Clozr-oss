/**
 * POST /message-revise — "What do you want to change?" in the campaign
 * builder's edit lightbox.
 *
 * Body:    { workspace_id, channel: 'sms'|'email', instruction,
 *            text, subject?, html?, section? }
 *          `section` is one part of `text` the rep picked; only it is
 *          rewritten and the rest is kept word for word. Without it the whole
 *          message is fair game. A designed email sends `html`; only its words
 *          change, never its tags, styles, links or images.
 * Returns: { ok, text, subject, html, carrier }
 *          `carrier` is the carrier check on the result (lib/carrier-safe):
 *          the reworded text the sender would use, and what it flagged.
 *
 * Same shape as draft-template: caller JWT, membership check, per-user rate
 * limit, the rep's words fenced as data, one forced tool call. Merge fields
 * ({{first_name}}) come back exactly as they went in.
 */
import { MESSAGE_RULES, WRITING_RULE, slopFindings } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { carrierCheck } from '../../../lib/carrier-safe.ts';
import { mergeTokens, reviseProblem } from '../../../lib/message-revise.ts';

function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}

const SYSTEM = `You edit marketing messages for Acme Homes, a real estate investment company, sent from CLOZR to cash investor buyers about a property under contract. A rep tells you what to change; you change exactly that and keep everything else.

Rules:
- Merge fields like {{first_name}}, {{address}}, {{price}}, {{deal_link}} stay exactly as written, character for character. Never fill one in, rename one or add one that was not there.
- Never invent a fact, price, date, number, name or claim. If the rep asks for a fact that is not in the message, use the matching merge field only if it already appears; otherwise leave the fact out.
- When you are given a section, rewrite only that section and return the whole message with every other character unchanged.
- Texts stay under 320 characters unless they started longer, and keep any opt-out line.
- Carrier filters block texts with these, so never write them: shortened links, "free", "cash offer", "guaranteed", "act now", "limited time", "urgent", "risk-free", "no obligation", "winner", "congratulations", ALL-CAPS words, or stacked !!! or $$$.
- For a designed email (HTML), change only the words between tags. Keep every tag, attribute, style, link and image exactly as it was.${UNTRUSTED_RULE}${WRITING_RULE} ${MESSAGE_RULES}`;

const TOOL: Anthropic.Tool = {
  name: 'revised',
  description: 'The revised message.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The whole revised text (SMS body, or the plain-text email body).' },
      subject: { type: ['string', 'null'], description: 'The email subject, changed only if asked; null for SMS.' },
      html: { type: ['string', 'null'], description: 'The whole revised HTML when HTML was given; otherwise null.' },
    },
    required: ['text', 'subject', 'html'],
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
  if (!apiKey) return json({ error: 'AI editing is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: { workspace_id?: number; channel?: string; instruction?: string; text?: string; subject?: string | null; html?: string | null; section?: string | null };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  const channel = body.channel === 'sms' ? 'sms' : 'email';
  const instruction = String(body.instruction ?? '').trim();
  const text = String(body.text ?? '');
  const subject = channel === 'email' ? String(body.subject ?? '') : null;
  const html = channel === 'email' && body.html ? String(body.html) : null;
  const section = body.section ? String(body.section) : null;
  const problem = reviseProblem({ instruction, text, html, section });
  if (problem) return json({ error: problem }, 422);

  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `message-revise:${who.user.id}`, 120, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const parts = [
    `Channel: ${channel === 'sms' ? 'text message' : html ? 'designed HTML email' : 'plain-text email'}.`,
    `What to change:\n${fence('instruction', instruction, 1000)}`,
    subject !== null ? `Subject:\n${fence('subject', subject, 300)}` : '',
    html ? `HTML:\n${fence('html', html, 60000)}` : `Message:\n${fence('message', text, 6000)}`,
    section ? `Rewrite only this section, and keep the rest exactly:\n${fence('section', section, 2000)}` : 'Rewrite the whole message as needed.',
  ].filter(Boolean).join('\n\n');

  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: html ? 16000 : 2000,
      system: toolRule('revised') + SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: parts }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) return json({ error: 'the edit came back empty' }, 502);
    const out = call.input as { text?: unknown; subject?: unknown; html?: unknown };
    const nextText = String(out.text ?? '').slice(0, channel === 'sms' ? 1600 : 20000);
    const nextSubject = subject !== null ? (typeof out.subject === 'string' && out.subject.trim() ? out.subject.slice(0, 300) : subject) : null;
    const nextHtml = html ? (typeof out.html === 'string' && out.html.trim() ? out.html : html) : null;
    // A merge field the model dropped or made up would send wrong: refuse the edit rather than ship it.
    const before = mergeTokens(`${subject ?? ''} ${html ?? text}`);
    const after = mergeTokens(`${nextSubject ?? ''} ${nextHtml ?? nextText}`);
    const made = after.filter((t) => !before.includes(t));
    if (made.length) return json({ error: `The edit added ${made.map((t) => `{{${t}}}`).join(', ')}, which was not in the message. Try again or edit by hand.` }, 422);
    const check = carrierCheck(channel === 'sms' ? nextText : `${nextSubject ?? ''}\n${nextText}`);
    return json({
      ok: true, text: nextText, subject: nextSubject, html: nextHtml,
      carrier: { text: check.text, blocked: check.blocked, findings: check.findings },
      slop: slopFindings(nextText).map((f) => ({ pattern: f.pattern, quote: f.quote, fix: f.fix })),
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited, try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'message-revise anthropic', e, 502);
    return serverError(CORS, 'message-revise', e);
  }
});
