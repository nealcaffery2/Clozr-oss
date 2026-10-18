/**
 * POST /draft-action-plan — Claude writes or rewrites a follow-up sequence.
 *
 * Three modes:
 *   { mode: "goal", workspace_id, goal, tone?, trigger?, step_count?, channels? }
 *       Draft a plan from a description: "5-touch sequence for a cold
 *       direct-mail lead who has not answered", in the tone asked for.
 *   { mode: "edit", workspace_id, plan, instruction, tone? }
 *       Take the plan as it stands in the builder (the same shape this
 *       function returns) and an instruction — "make the texts shorter",
 *       "add a call on day 5", "drop the email" — and return the revised
 *       plan plus a list of what changed, in words.
 *   { mode: "lead", workspace_id, seller_id }
 *       Draft a plan for one seller from their actual history — every call,
 *       text, email and note on the record, talk time, how long since the
 *       last touch, the stage and what they said they wanted. This is the
 *       "AI action plan" for someone who does not want to hand-build one.
 *
 * Returns { ok, plan: { name, trigger, description, settings, steps: [{ channel,
 * delay, title, content, subject, stage, tag, priority }] }, changes: string[] }.
 * Delays are relative to enrolment ("Immediately", "2 hours", "Day 3");
 * channel is one of sms, email, call, task, wait, stage, tag, assign, compr_report, rvm, ai_agent. Nothing
 * is saved here: the draft goes back to the builder, where the person can
 * change it before it exists.
 *
 * Needs the ANTHROPIC_API_KEY secret (supabase secrets set ANTHROPIC_API_KEY=…);
 * answers 503 with a plain message until it is set.
 */
import { WRITING_RULE, slopFindings, slopReport } from '../_shared/no-ai-slop.ts';
import { seatBrief } from '../_shared/seat-brief.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { UNTRUSTED_RULE, corsFor, fence, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { leadBriefs } from '../_shared/lead-brief.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';

/**
 * An organization-level Anthropic key (one not created inside a workspace)
 * must name the workspace on every request. ANTHROPIC_WORKSPACE_ID is the
 * optional secret that does that; a workspace-scoped key needs nothing.
 */
function anthropicHeaders(): { defaultHeaders?: Record<string, string> } {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {};
}
const WORKSPACE_HINT =
  'The Anthropic key is an organization key, so Anthropic needs a workspace: either create the key inside a workspace '
  + '(console.anthropic.com → API keys → choose a workspace) or add the ANTHROPIC_WORKSPACE_ID secret with that workspace\'s id.';

const PLAN_TOOL: Anthropic.Tool = {
  name: 'submit_plan',
  description: 'Return the follow-up sequence as structured steps, and a list of what changed when revising one.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'trigger', 'description', 'settings', 'steps', 'changes'],
    properties: {
      name: { type: 'string' },
      trigger: { type: 'string', description: 'When the plan starts: "Manual enrollment", "New lead", "Stage → Offer Sent", "Tag \"cold\" added", "Form submitted".' },
      description: { type: 'string', description: 'One or two sentences on who the plan is for and what it is trying to get.' },
      settings: {
        type: 'object',
        additionalProperties: false,
        required: ['stop_on_reply', 'stop_on_call', 'stop_on_stage', 'tone'],
        properties: {
          stop_on_reply: { type: 'boolean', description: 'Stop the sequence when the seller replies by text or email. Almost always true.' },
          stop_on_call: { type: 'boolean', description: 'Stop when a call with the seller connects.' },
          stop_on_stage: { type: 'boolean', description: 'Stop when the seller moves to another stage.' },
          tone: { type: 'string', description: 'The tone the messages were written in, in a few words.' },
        },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['channel', 'delay', 'title', 'content', 'subject', 'stage', 'tag', 'priority'],
          properties: {
            channel: { type: 'string', enum: ['sms', 'email', 'call', 'task', 'wait', 'stage', 'tag', 'assign', 'compr_report', 'rvm', 'ai_agent'] },
            delay: { type: 'string', description: 'Relative to enrolment, never decreasing down the list: "Immediately", "2 hours", "Day 2", "1 week".' },
            title: { type: 'string', description: 'A short label for the step, e.g. "Intro text", "Check-in call". Empty for wait.' },
            content: { type: 'string', description: 'The text to send, the email body, the talking points for a call, or what the task is. Use {{first_name}} and {{address}} as merge fields. Empty for wait / stage / tag / assign.' },
            subject: { type: 'string', description: 'Email subject line. Empty unless channel is email.' },
            stage: { type: 'string', description: 'The stage to move the seller to. Empty unless channel is stage.' },
            tag: { type: 'string', description: 'The tag to add. Empty unless channel is tag.' },
            priority: { type: 'string', enum: ['low', 'normal', 'high'] },
            audience: { type: 'string', enum: ['seller', 'buyer'], description: 'compr_report only: the Compr Seller report (to the seller) or the Compr Buyer report (to the deal\'s buyer).' },
            via: { type: 'string', enum: ['sms', 'email'], description: 'compr_report only: how the report link goes out.' },
          },
        },
      },
      changes: {
        type: 'array',
        items: { type: 'string' },
        description: 'When revising a plan: one line per change, e.g. "Step 2: shortened the text", "Added a call on day 5". Empty for a new plan.',
      },
    },
  },
};

const SYSTEM =
  'You write follow-up sequences for a real-estate wholesaling acquisitions team (Acme Homes, Texas). '
  + 'A sequence is usually 4 to 9 steps across sms, call, email and task, spaced over days to weeks, each with a delay relative to enrolment that never decreases down the list. '
  + 'Other step kinds exist and are used sparingly: wait (a pause with nothing to do), stage (move the seller to a named stage), tag (add a tag), assign (hand the seller to the lead owner), compr_report (send the Compr Seller or Compr Buyer underwriting report link by sms or email; set audience and via, and put {{report_link}} in content where the link goes), rvm (leave a ringless voicemail; content is the script, short, one reason to call back), ai_agent (switch the AI agent on for the record; content is its goal in one or two sentences, and it texts and emails on its own until a rep switches it off, so it is usually the last step). '
  + 'Texts are short, human and specific — one question, no hype, no emojis, and they always give the seller an easy out. '
  + 'Calls are talking points, not scripts. Tasks are for the rep. Emails only where a seller has an email, and every email has a subject. '
  + 'Every message uses {{first_name}} and, where it helps, {{address}}. Never invent facts about the seller; use only what is in the history. '
  + 'Respect quiet hours: nothing is scheduled to send before 8am or after 8pm. '
  + 'Match the tone the person asked for exactly; if none is given, be warm, plain and direct. '
  + 'Set settings.stop_on_reply true unless told otherwise — a seller who answers should hear from a person, not the next step. '
  + 'Reply only by calling submit_plan.'
  + UNTRUSTED_RULE + WRITING_RULE;

type AiStep = { channel?: string; delay?: string; title?: string; content?: string; subject?: string; stage?: string; tag?: string; priority?: string; audience?: string; via?: string };
type AiPlan = {
  name?: string; trigger?: string; description?: string; steps?: AiStep[];
  settings?: { stop_on_reply?: boolean; stop_on_call?: boolean; stop_on_stage?: boolean; tone?: string };
};

/** The plan the builder holds, rendered as text the model can revise. Every free-text field is fenced. */
function describePlan(p: AiPlan): string {
  const lines = [
    `Name: ${fence('name', p.name ?? '', 200)}`,
    `Trigger: ${fence('trigger', p.trigger ?? '', 200)}`,
    `Description: ${fence('description', p.description ?? '', 1000)}`,
    `Settings: stop_on_reply=${p.settings?.stop_on_reply ?? true}, stop_on_call=${p.settings?.stop_on_call ?? false}, stop_on_stage=${p.settings?.stop_on_stage ?? false}, tone=${fence('tone', p.settings?.tone ?? '', 200)}`,
    'Steps:',
  ];
  (p.steps ?? []).slice(0, 40).forEach((s, i) => {
    lines.push(`${i + 1}. [${s.channel ?? 'task'}] at ${fence('delay', s.delay ?? 'Immediately', 40)} — title ${fence('title', s.title ?? '', 200)}`
      + (s.subject ? `; subject ${fence('subject', s.subject, 200)}` : '')
      + (s.stage ? `; stage ${fence('stage', s.stage, 100)}` : '')
      + (s.tag ? `; tag ${fence('tag', s.tag, 100)}` : '')
      + (s.priority && s.priority !== 'normal' ? `; priority ${s.priority}` : '')
      + (s.channel === 'compr_report' ? `; audience ${s.audience === 'buyer' ? 'buyer' : 'seller'}; via ${s.via === 'email' ? 'email' : 'sms'}` : ''));
    if (s.content) lines.push(`   content: ${fence('content', s.content, 3000)}`);
  });
  return lines.join('\n');
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'AI drafting is not configured: set the ANTHROPIC_API_KEY secret on the Supabase project.' }, 503);

  let body: {
    mode?: string; workspace_id?: number; goal?: string; trigger?: string; seller_id?: number;
    tone?: string; step_count?: number; channels?: string[]; plan?: AiPlan; instruction?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);

  // Membership check with the caller's own token: RLS answers, not the body.
  const { data: member } = await asCaller.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);

  // Each call spends money: a per-user hourly ceiling.
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rl = await rateLimit(admin, `draft-action-plan:${who.user.id}`, 30, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  let prompt: string;
  if (body.mode === 'lead') {
    const sellerId = Number(body.seller_id);
    if (!Number.isFinite(sellerId)) return json({ error: 'seller_id is required' }, 422);
    // Read as the caller so RLS scopes it; acquisitions can read their sellers.
    const [{ data: seller }, { data: comms }, { data: deals }, { data: tasks }, briefs] = await Promise.all([
      asCaller.from('sellers').select('name, phone, email, property_address, asking_price, motivation, lead_stage, source, notes, created_at, tags').eq('id', sellerId).maybeSingle(),
      asCaller.from('communications').select('channel, direction, occurred_at, body, summary, duration_s').eq('seller_id', sellerId).order('occurred_at', { ascending: false }).limit(60),
      asCaller.from('deals').select('stage, offer_amount, arv, rehab, contract_date, close_date').eq('seller_id', sellerId).limit(1),
      asCaller.from('tasks').select('title, task_type, due_at, done').eq('seller_id', sellerId).order('due_at').limit(20),
      leadBriefs(asCaller, workspaceId, 'seller', [sellerId]),
    ]);
    if (!seller) return json({ error: 'seller not found' }, 404);

    const talkSeconds = (comms ?? []).filter((c) => c.channel === 'call').reduce((a, c) => a + (c.duration_s ?? 0), 0);
    const last = comms?.[0]?.occurred_at ?? null;
    // Everything a seller said, or another system wrote, is fenced as data.
    const history = (comms ?? []).slice().reverse().map((c) =>
      `${c.occurred_at.slice(0, 16)} ${c.channel} ${c.direction ?? ''}${c.duration_s ? ` ${Math.round(c.duration_s / 60)}m` : ''}: ${(c.summary || c.body || '').slice(0, 400)}`).join('\n');

    prompt = [
      'Draft a follow-up plan for THIS seller from their history. Name the plan after them and the situation.',
      '',
      `Seller: ${fence('seller_name', seller.name, 200)}. Stage: ${seller.lead_stage}. Source: ${fence('source', seller.source ?? '—', 100)}. Created ${seller.created_at.slice(0, 10)}.`,
      `Property: ${fence('address', seller.property_address ?? '—', 300)}. Asking: ${seller.asking_price ?? '—'}. Motivation: ${fence('motivation', seller.motivation ?? '—', 500)}.`,
      `Has email: ${seller.email ? 'yes' : 'no'}. Tags: ${fence('tags', (seller.tags ?? []).join(', ') || '—', 300)}. Notes: ${fence('notes', seller.notes ?? '—', 3000)}.`,
      deals?.[0] ? `Deal: stage ${deals[0].stage}, offer ${deals[0].offer_amount ?? '—'}, ARV ${deals[0].arv ?? '—'}, rehab ${deals[0].rehab ?? '—'}.` : 'No deal yet.',
      `Communications: ${(comms ?? []).length} (${(comms ?? []).filter((c) => c.channel === 'call').length} calls, ${Math.round(talkSeconds / 60)} min talk time). Last touch: ${last ?? 'never'}.`,
      `Open tasks: ${fence('tasks', (tasks ?? []).filter((t) => !t.done).map((t) => t.title).join('; ') || 'none', 1000)}.`,
      ...(briefs.get(sellerId) ? ['', 'What the team already knows (the lead memory reps and the phone agent read; keep every message consistent with it and never raise a do-not-mention topic):', fence('lead_memory', briefs.get(sellerId), 1600)] : []),
      '',
      'History, oldest first:',
      fence('history', history || '(no communications yet)', 20_000),
    ].join('\n');
  } else if (body.mode === 'edit') {
    const instruction = (body.instruction ?? '').trim();
    if (!instruction) return json({ error: 'instruction is required' }, 422);
    if (!body.plan || typeof body.plan !== 'object') return json({ error: 'plan is required' }, 422);
    prompt = [
      'Revise the plan below. Keep everything the instruction does not touch exactly as it is — same steps, same order, same wording — and change only what is asked. '
      + 'Return the whole revised plan, and list each change in `changes` as one short line.',
      '',
      `Instruction: ${fence('instruction', instruction, 2000)}`,
      body.tone ? `Tone to write in: ${fence('tone', body.tone, 200)}` : '',
      '',
      'The plan as it stands:',
      describePlan(body.plan),
    ].filter((l) => l !== '').join('\n');
  } else {
    const goal = (body.goal ?? '').trim();
    if (!goal) return json({ error: 'goal is required' }, 422);
    const n = Number(body.step_count);
    const channels = Array.isArray(body.channels) ? body.channels.filter((c) => typeof c === 'string').slice(0, 8) : [];
    prompt = [
      `Draft a plan for this goal: ${fence('goal', goal, 2000)}`,
      body.trigger ? `It starts when: ${fence('trigger', body.trigger, 300)}` : '',
      body.tone ? `Tone: ${fence('tone', body.tone, 200)}` : '',
      Number.isFinite(n) && n > 0 ? `Aim for about ${Math.min(20, Math.round(n))} steps.` : '',
      channels.length ? `Use only these step kinds: ${fence('channels', channels.join(', '), 200)}.` : '',
      'Leave `changes` empty.',
    ].filter((l) => l !== '').join('\n');
  }

  try {
    const client = new Anthropic({ apiKey, ...anthropicHeaders() });
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING,
      max_tokens: 16000,
      system: toolRule('submit_plan') + SYSTEM + '\n\nThe sequence is for the person drafting it. ' + seatBrief(member.role) + ' Rep tasks and calls in it are that seat\'s work.',
      tools: [PLAN_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: prompt }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) return json({ error: 'the model returned no plan' }, 502);
    const out = call.input as AiPlan & { changes?: string[] };
    const { changes, ...plan } = out;
    // Texts and emails to a person pass the slop check before anyone can save them.
    const slop = (plan.steps ?? []).flatMap((st, i) => {
      if (st.channel !== 'sms' && st.channel !== 'email') return [];
      const f = slopFindings(`${st.subject ?? ''}\n${st.content ?? ''}`);
      return f.length ? [`Step ${i + 1}: ${slopReport(f)}`] : [];
    });
    return json({ ok: true, plan, changes: Array.isArray(changes) ? changes : [], slop, usage: res.usage });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'the ANTHROPIC_API_KEY secret is invalid' }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited — try again in a moment' }, 429);
    if (e instanceof Anthropic.APIError && /anthropic-workspace-id/.test(e.message)) return json({ error: WORKSPACE_HINT }, 503);
    if (e instanceof Anthropic.APIError) return serverError(CORS, 'draft-action-plan anthropic', e, 502);
    return serverError(CORS, 'draft-action-plan', e);
  }
});
