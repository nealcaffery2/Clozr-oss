/**
 * POST /plan-agent — action plans' AI work (migration 142). Service role only:
 * ai_agent_kick (pg_cron, every 2 minutes) posts { action: 'tick' } when a
 * decide-once AI step is due or a smart route is waiting.
 *
 * Decide-once AI step. A plan step of channel ai_agent whose config carries
 * `allowed` ⊆ { send_sms, create_task, update_lead_status } and a `goal`.
 * plan_agent_claim() hands over its due task; this reads the lead's history
 * (texts, calls, notes, activity, prior plans, open tasks), asks the model
 * for at most one of each allowed action or nothing, and carries them out:
 *   send_sms            through _shared/docs-flow.ts textRecipient, the same
 *                       Talkr send the AI agent and contracts use (opt-out:
 *                       a first text carries "Reply STOP to opt out", Talkr's
 *                       suppression list and quiet hours apply; over 320
 *                       characters is refused). Outside 9am–8pm in the lead's
 *                       zone the step waits and is decided again later.
 *   create_task         a task for the lead's owner.
 *   update_lead_status  the seller's stage, from the real stage list.
 * The decision, its reason and what happened go on plan_agent_runs and the
 * seller's timeline; the step's task is closed so the plan moves on. No key,
 * a buyer enrolment or a do-not-engage seller closes the step with the reason.
 *
 * Smart route. An enrolment that ended with on_complete.mode 'smart' waits in
 * route_state 'pending'; this shows the model the lead's history and the
 * candidate plans it has not run (plan_route_candidates) and applies its pick
 * with plan_route_apply, which checks it again. No key: the lead leaves the
 * plan, and the reason says why.
 *
 * Needs ANTHROPIC_API_KEY, and TALKR_PARTNER_JWT_SECRET for texts.
 */
import { WRITING_RULE } from '../_shared/no-ai-slop.ts';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { bearerOf, corsFor, fence, isServiceCaller, jsonWith, serverError, UNTRUSTED_RULE } from '../_shared/security.ts';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from '../_shared/models.ts';
import { gatherHistory } from '../_shared/lead-memory.ts';
import { textRecipient } from '../_shared/docs-flow.ts';
import { phoneE164 } from '../_shared/docs-people.ts';
import { withOptOut } from '../_shared/sms-compliance.ts';
import { CAPABILITY_LABEL, cleanAllowed, decideTool, parseDecision, parseRoute, runSummary, type ActionResult, type Decision } from '../_shared/plan-agent-rules.ts';
import { historyText } from '../../../lib/lead-memory.ts';
import { BLACKLIST_UNREAD, isDoNotEngage } from '../../../lib/blacklist.ts';
import { SELLER_STAGE_LABELS } from '../../../lib/stages.ts';
import { callWindow, zoneForNumber } from '../../../lib/talkr-web/time.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

function anthropic(): Anthropic | null {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return null;
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return new Anthropic({ apiKey: key, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
}

const DECIDE_SYSTEM = `You are the AI step inside an action plan in CLOZR, the CRM a real estate investment company runs its wholesaling business on. A seller lead has reached this step of a follow-up plan. You are given the step's goal, what you are allowed to do, and everything on file for the lead: their record, texts, calls, notes, timeline, prior action plans and open tasks.

Decide what moves the lead toward the goal right now. You may do at most one of each allowed action, and doing nothing is often right: if they replied recently and a rep is on it, if a call or appointment is already set, if they asked not to be contacted, or if another touch now would be pushy. Never text someone who asked to stop.

A text is from the rep who owns the lead, first person, plain and short (under 320 characters, one question at most, no emojis, no links you were not given, no promises about price). Do not sign with a name you were not given. A task is for that rep: concrete ("Call Kara about the roof quote"), with when. A stage change only when the history clearly shows the lead is at that stage, using a stage from the list exactly.

Give the reason in one or two sentences, from the history.${UNTRUSTED_RULE}${WRITING_RULE}`;

const ROUTE_SYSTEM = `You route a seller lead to its next follow-up plan in CLOZR, the CRM Acme Homes runs its wholesaling business on. The lead just finished (or was stopped in) one action plan. You are given the lead's history and the candidate plans it has not run. Pick the one that fits where this lead is now, or none when none fits (they sold, they are dead, they asked to stop, a rep is actively working them). Give the reason in one sentence from the history.${UNTRUSTED_RULE}${WRITING_RULE}`;

const ROUTE_TOOL: Anthropic.Tool = {
  name: 'route',
  description: 'The next plan for this lead, or null for none. Call once.',
  input_schema: {
    type: 'object',
    properties: {
      plan_id: { type: ['integer', 'null'], description: 'A candidate plan id exactly as given, or null.' },
      reason: { type: 'string', description: 'One sentence, from the history.' },
    },
    required: ['plan_id', 'reason'],
  },
};

type Run = { id: number; workspace_id: number; enrollment_id: number | null; task_id: number | null; plan_step_id: number | null; seller_id: number | null; goal: string; allowed: string[] };

/** Prior plans and open tasks, which gatherHistory does not carry. */
async function planContext(admin: SupabaseClient, ws: number, sellerId: number, skipTask: number | null): Promise<string> {
  const [plans, tasks] = await Promise.all([
    admin.from('enrollments').select('status, stopped_reason, enrolled_at, completed_at, routed_reason, action_plans!enrollments_plan_id_fkey(name)')
      .eq('workspace_id', ws).eq('seller_id', sellerId).order('enrolled_at', { ascending: false }).limit(12),
    admin.from('tasks').select('id, title, task_type, due_at').eq('workspace_id', ws).eq('seller_id', sellerId).eq('done', false)
      .order('due_at', { ascending: true }).limit(12),
  ]);
  const p = ((plans.data ?? []) as Any[]).map((e) => `- ${e.action_plans?.name ?? 'a plan'}: ${e.status}${e.stopped_reason ? ` (stopped: ${e.stopped_reason})` : ''}, enrolled ${String(e.enrolled_at).slice(0, 10)}${e.routed_reason ? `; ${e.routed_reason}` : ''}`);
  const t = ((tasks.data ?? []) as Any[]).filter((x) => x.id !== skipTask).map((x) => `- ${x.title} (${x.task_type}, due ${String(x.due_at ?? '').slice(0, 16).replace('T', ' ')})`);
  return [`Action plans this lead has been on, newest first:\n${p.join('\n') || '- none'}`, `Open tasks:\n${t.join('\n') || '- none'}`].join('\n\n');
}

async function finish(admin: SupabaseClient, run: Run, status: 'done' | 'skipped' | 'failed', fields: { decision?: Decision | null; reason: string; actions?: ActionResult[] }, planName: string) {
  const actions = fields.actions ?? [];
  await admin.from('plan_agent_runs').update({
    status, decision: fields.decision ?? {}, reason: fields.reason.slice(0, 1000), actions, finished_at: new Date().toISOString(),
  }).eq('id', run.id);
  const summary = status === 'done' ? runSummary(actions) : `AI step not run: ${fields.reason}`;
  if (run.task_id) {
    const { data: t } = await admin.from('tasks').select('notes').eq('id', run.task_id).maybeSingle();
    await admin.from('tasks').update({
      done: true, completed_at: new Date().toISOString(),
      notes: [t?.notes || null, summary, status === 'done' && fields.reason ? `Why: ${fields.reason}` : null].filter(Boolean).join('\n').slice(0, 4000),
    }).eq('id', run.task_id).eq('done', false);
  }
  if (run.seller_id) {
    await admin.from('activity').insert({
      workspace_id: run.workspace_id, entity_type: 'seller', entity_id: run.seller_id, kind: 'plan',
      title: `${summary.slice(0, 180)}`, body: [`Plan: ${planName}.`, fields.reason ? `Why: ${fields.reason}` : null].filter(Boolean).join('\n'),
    });
  }
}

/** One decide-once step. Returns what happened, for the tick's log. */
async function decide(admin: SupabaseClient, client: Anthropic | null, run: Run): Promise<string> {
  const allowed = cleanAllowed(run.allowed);
  const { data: en } = run.enrollment_id
    ? await admin.from('enrollments').select('id, created_by, status, action_plans!enrollments_plan_id_fkey(name)').eq('id', run.enrollment_id).maybeSingle()
    : { data: null };
  const planName = (en as Any)?.action_plans?.name ?? 'an action plan';
  if (!en || (en as Any).status !== 'active') {
    // A finished run is never claimed again, so a paused plan's step would be
    // stuck when it resumes. Drop the claim instead: plan_agent_claim only
    // picks tasks on an active enrolment, so this cannot loop.
    await admin.from('plan_agent_runs').delete().eq('id', run.id);
    return 'skipped';
  }
  if (!run.seller_id) { await finish(admin, run, 'skipped', { reason: 'decide-once AI steps work seller leads only' }, planName); return 'skipped'; }
  if (!allowed.length) { await finish(admin, run, 'skipped', { reason: 'the step allows nothing' }, planName); return 'skipped'; }
  if (!client) { await finish(admin, run, 'skipped', { reason: 'ANTHROPIC_API_KEY is not set' }, planName); return 'skipped'; }

  const { data: seller } = await admin.from('sellers').select('id, name, phone, tags, lead_stage, assigned_to').eq('id', run.seller_id).eq('workspace_id', run.workspace_id).maybeSingle();
  if (!seller) { await finish(admin, run, 'skipped', { reason: 'the seller is gone' }, planName); return 'skipped'; }
  if (isDoNotEngage(seller as Any)) { await finish(admin, run, 'skipped', { reason: 'the seller is marked do not contact or blacklisted' }, planName); return 'skipped'; }

  // A text cannot go out at night: wait for the lead's morning and decide then.
  const e164 = phoneE164((seller as Any).phone);
  const zone = e164 ? zoneForNumber(e164) : null;
  if (allowed.includes('send_sms') && (seller as Any).phone && !callWindow(zone ?? 'America/Chicago').safe) {
    // Left running: plan_agent_claim takes it again after ten minutes.
    await admin.from('plan_agent_runs').update({ reason: 'Waiting for 9am–8pm in the lead\'s time zone before deciding.' }).eq('id', run.id);
    return 'waiting';
  }

  const history = await gatherHistory(admin, run.workspace_id, 'seller', run.seller_id);
  const context = await planContext(admin, run.workspace_id, run.seller_id, run.task_id);
  const { count: textedBefore } = await admin.from('communications').select('id', { count: 'exact', head: true })
    .eq('workspace_id', run.workspace_id).eq('seller_id', run.seller_id).eq('channel', 'sms').eq('direction', 'outbound');
  const tool = decideTool(allowed);
  const now = new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  const user = [
    `It is ${now} (Central). Plan: "${planName}".`,
    `Goal for this step: ${run.goal ? fence('goal', run.goal, 2000) : 'none given — decide from the history what would move this lead forward.'}`,
    `You may: ${allowed.map((a) => CAPABILITY_LABEL[a]).join(', ')}. At most one of each, or nothing.`,
    allowed.includes('update_lead_status') ? `Lead stages: ${SELLER_STAGE_LABELS.join(' | ')}` : null,
    (seller as Any).phone ? null : 'The lead has no phone number: a text cannot be sent.',
    fence('lead', history ? historyText(history, 80) : `Record: ${JSON.stringify({ name: (seller as Any).name, lead_stage: (seller as Any).lead_stage })}`, 40_000),
    fence('plans_and_tasks', context, 4000),
  ].filter(Boolean).join('\n\n');

  let decision: Decision;
  let dropped: string[] = [];
  try {
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: 2000,
      system: toolRule('decide') + DECIDE_SYSTEM,
      tools: [tool as unknown as Anthropic.Tool], tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: user }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'decide');
    if (!call) { await finish(admin, run, 'failed', { reason: 'the model returned no decision' }, planName); return 'failed'; }
    ({ decision, dropped } = parseDecision(call.input, allowed, SELLER_STAGE_LABELS, (seller as Any).lead_stage ?? null));
  } catch (e) {
    console.error('plan-agent decide', run.id, e instanceof Error ? e.message : e);
    // A model outage is not the lead's fault: leave the run to be claimed again.
    await admin.from('plan_agent_runs').update({ reason: 'The AI call failed; it will be tried again.' }).eq('id', run.id);
    return 'retry';
  }
  if (!(seller as Any).phone && decision.send_sms) { dropped.push('a text (no phone number)'); decision.send_sms = null; }

  const owner: string | null = (seller as Any).assigned_to ?? (en as Any).created_by ?? null;
  const actions: ActionResult[] = [];
  if (decision.send_sms) {
    const body = textedBefore ? decision.send_sms.body : withOptOut(decision.send_sms.body);
    const sent = await textRecipient(admin, { workspace_id: run.workspace_id, created_by: owner }, { phone: (seller as Any).phone, seller_id: run.seller_id }, body, owner, { contractsLine: false });
    if (!sent.ok && sent.reason === BLACKLIST_UNREAD) {
      // Nothing went out and nothing else was done yet: leave the run to be claimed again, like a model outage.
      await admin.from('plan_agent_runs').update({ reason: 'Could not check the blacklist; it will be tried again.' }).eq('id', run.id);
      return 'retry';
    }
    actions.push(sent.ok ? { kind: 'send_sms', ok: true, detail: `"${body}"` } : { kind: 'send_sms', ok: false, detail: sent.reason });
  }
  if (decision.create_task) {
    const t = decision.create_task;
    const { data, error } = await admin.from('tasks').insert({
      workspace_id: run.workspace_id, seller_id: run.seller_id, title: t.title, task_type: t.type, priority: 'normal',
      due_at: new Date(Date.now() + t.due_in_hours * 3_600_000).toISOString(), assigned_to: owner, created_by: owner,
      notes: `From the AI step in "${planName}". ${decision.reason}`.slice(0, 2000),
    }).select('id').single();
    actions.push(error ? { kind: 'create_task', ok: false, detail: error.message } : { kind: 'create_task', ok: true, detail: `"${t.title}" (task ${data.id})` });
  }
  // The stage last: a plan that stops on a stage change deletes its open
  // tasks, this step's included, and the run row keeps the record either way.
  if (decision.update_lead_status) {
    const to = decision.update_lead_status.stage;
    const { error } = await admin.from('sellers').update({ lead_stage: to }).eq('id', run.seller_id).eq('workspace_id', run.workspace_id);
    actions.push(error ? { kind: 'update_lead_status', ok: false, detail: error.message } : { kind: 'update_lead_status', ok: true, detail: `${(seller as Any).lead_stage} → ${to}` });
    if (!error) {
      await admin.from('activity').insert({ workspace_id: run.workspace_id, entity_type: 'seller', entity_id: run.seller_id, kind: 'stage', title: 'Stage → ' + to, body: `Set by the AI step in "${planName}".` });
    }
  }
  const reason = [decision.reason, dropped.length ? `Left out: ${dropped.join('; ')}.` : null].filter(Boolean).join(' ');
  await finish(admin, run, actions.some((a) => !a.ok) && !actions.some((a) => a.ok) ? 'failed' : 'done', { decision, reason, actions }, planName);
  return 'done';
}

/** One pending smart route. */
async function route(admin: SupabaseClient, client: Anthropic | null, e: Any): Promise<string> {
  const { data: cands } = await admin.rpc('plan_route_candidates', { p_enr: e.id });
  const list = (cands ?? []) as { id: number; name: string; description: string }[];
  if (!client) {
    await admin.rpc('plan_route_apply', { p_enr: e.id, p_plan: null, p_reason: 'AI routing is unavailable (ANTHROPIC_API_KEY is not set)' });
    return 'left';
  }
  if (!list.length) {
    await admin.rpc('plan_route_apply', { p_enr: e.id, p_plan: null, p_reason: 'no candidate plan left that this lead has not run' });
    return 'left';
  }
  const history = await gatherHistory(admin, e.workspace_id, 'seller', e.seller_id);
  const context = await planContext(admin, e.workspace_id, e.seller_id, null);
  const user = [
    `The lead ${e.stopped_reason ? `was stopped in (${e.stopped_reason})` : 'finished'} the plan "${e.action_plans?.name ?? 'a plan'}".`,
    `Candidate plans (JSON):\n${JSON.stringify(list.map((p) => ({ id: p.id, name: p.name, description: p.description.slice(0, 300) })))}`,
    fence('lead', history ? historyText(history, 60) : 'No history.', 30_000),
    fence('plans_and_tasks', context, 4000),
  ].join('\n\n');
  try {
    const res = await client.messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: 1000,
      system: toolRule('route') + ROUTE_SYSTEM, tools: [ROUTE_TOOL], tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: user }],
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'route');
    const pick = call ? parseRoute(call.input, list.map((p) => p.id)) : null;
    if (!pick) {
      await admin.rpc('plan_route_apply', { p_enr: e.id, p_plan: null, p_reason: 'the AI answer was not one of the candidates' });
      return 'left';
    }
    const { data } = await admin.rpc('plan_route_apply', { p_enr: e.id, p_plan: pick.planId, p_reason: pick.reason });
    return (data as Any)?.routed ? 'routed' : 'left';
  } catch (err) {
    // Left pending: the next tick asks again.
    console.error('plan-agent route', e.id, err instanceof Error ? err.message : err);
    return 'retry';
  }
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });
  if (!(await isServiceCaller(admin, bearerOf(req)))) return json({ error: 'service only' }, 403);

  let body: { action?: string };
  try { body = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  if (body.action !== 'tick') return json({ error: 'unknown action' }, 400);

  const client = anthropic();
  const tally: Record<string, number> = {};
  const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  try {
    const { data: runs, error } = await admin.rpc('plan_agent_claim', { p_limit: 8 });
    if (error) throw error;
    for (const run of (runs ?? []) as Run[]) {
      try { count(await decide(admin, client, run)); } catch (e) {
        console.error('plan-agent step', run.id, e);
        count('error');
      }
    }
    const { data: pending } = await admin.from('enrollments')
      .select('id, workspace_id, seller_id, plan_id, stopped_reason, action_plans!enrollments_plan_id_fkey(name)')
      .eq('route_state', 'pending').order('id', { ascending: true }).limit(10);
    for (const e of (pending ?? []) as Any[]) {
      try { count(await route(admin, client, e)); } catch (err) {
        console.error('plan-agent route', e.id, err);
        count('error');
      }
    }
    console.log('plan-agent tick', tally);
    return json({ ok: true, ...tally });
  } catch (e) {
    return serverError(CORS, 'plan-agent', e);
  }
});
