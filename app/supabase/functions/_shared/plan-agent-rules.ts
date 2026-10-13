// The pure parts of the plan-agent function (migration 142): what the model
// may choose at an action plan's decide-once AI step, how its answer is
// cleaned, and how a smart route's pick is checked. Pure, so
// tools/plan-agent.test.ts pins them; plan-agent does the IO.

export const CAPABILITIES = ['send_sms', 'create_task', 'update_lead_status'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABEL: Record<Capability, string> = {
  send_sms: 'send one text',
  create_task: 'create one task',
  update_lead_status: 'change the lead status',
};

/** A text a step may send: one or two segments, as the builder warns past 320. */
export const SMS_MAX = 320;
export const TASK_TYPES = ['call', 'text', 'email', 'todo'] as const;

export const cleanAllowed = (v: unknown): Capability[] =>
  (Array.isArray(v) ? v : []).filter((x): x is Capability => (CAPABILITIES as readonly string[]).includes(String(x)))
    .filter((x, i, a) => a.indexOf(x) === i);

export type Decision = {
  reason: string;
  send_sms: { body: string } | null;
  create_task: { title: string; type: (typeof TASK_TYPES)[number]; due_in_hours: number } | null;
  update_lead_status: { stage: string } | null;
};

/** The decide tool, offering only what the step allows. */
export function decideTool(allowed: Capability[]) {
  const properties: Record<string, unknown> = {
    reason: { type: 'string', description: 'One or two sentences: why this, or why nothing, from the history.' },
  };
  if (allowed.includes('send_sms')) {
    properties.send_sms = {
      type: ['object', 'null'],
      description: `One text to the seller, or null for none. Under ${SMS_MAX} characters, plain, no links you were not given.`,
      properties: { body: { type: 'string' } }, required: ['body'],
    };
  }
  if (allowed.includes('create_task')) {
    properties.create_task = {
      type: ['object', 'null'],
      description: 'One task for the rep who owns the lead, or null for none.',
      properties: {
        title: { type: 'string', description: 'What the rep should do, short.' },
        type: { type: 'string', enum: [...TASK_TYPES] },
        due_in_hours: { type: 'number', description: '0 for now, up to 336 (two weeks).' },
      },
      required: ['title', 'type', 'due_in_hours'],
    };
  }
  if (allowed.includes('update_lead_status')) {
    properties.update_lead_status = {
      type: ['object', 'null'],
      description: 'Move the lead to another stage, or null to leave it. Only a stage from the list given.',
      properties: { stage: { type: 'string' } }, required: ['stage'],
    };
  }
  return {
    name: 'decide',
    description: 'What to do at this step. At most one of each action; null for any you would not do. Call once.',
    input_schema: { type: 'object' as const, properties, required: ['reason', ...allowed] },
  };
}

/**
 * The model's answer, held to the step: only allowed actions, each at most
 * once, a text within SMS_MAX, a task with a title and a sane due time, a
 * stage from the list and different from the current one. Anything else is
 * dropped and said in `dropped`, so the run records why.
 */
export function parseDecision(input: unknown, allowed: Capability[], stages: readonly string[], currentStage: string | null): { decision: Decision; dropped: string[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const dropped: string[] = [];
  const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  const decision: Decision = { reason, send_sms: null, create_task: null, update_lead_status: null };

  const sms = o.send_sms as { body?: unknown } | null | undefined;
  if (sms && typeof sms === 'object') {
    const body = typeof sms.body === 'string' ? sms.body.replace(/[ \t]+/g, ' ').trim() : '';
    if (!allowed.includes('send_sms')) dropped.push('a text (not allowed at this step)');
    else if (!body) dropped.push('an empty text');
    else if (body.length > SMS_MAX) dropped.push(`a text of ${body.length} characters (over ${SMS_MAX})`);
    else decision.send_sms = { body };
  }

  const task = o.create_task as { title?: unknown; type?: unknown; due_in_hours?: unknown } | null | undefined;
  if (task && typeof task === 'object') {
    const title = typeof task.title === 'string' ? task.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!allowed.includes('create_task')) dropped.push('a task (not allowed at this step)');
    else if (!title) dropped.push('a task with no title');
    else {
      const type = (TASK_TYPES as readonly string[]).includes(String(task.type)) ? task.type as (typeof TASK_TYPES)[number] : 'todo';
      const h = Number(task.due_in_hours);
      decision.create_task = { title, type, due_in_hours: Number.isFinite(h) ? Math.min(336, Math.max(0, Math.round(h))) : 0 };
    }
  }

  const st = o.update_lead_status as { stage?: unknown } | null | undefined;
  if (st && typeof st === 'object') {
    const typed = String(st.stage ?? '').trim();
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const stage = stages.find((x) => x === typed) ?? stages.find((x) => norm(x) === norm(typed)) ?? null;
    if (!allowed.includes('update_lead_status')) dropped.push('a stage change (not allowed at this step)');
    else if (!stage) dropped.push(`the stage "${typed.slice(0, 60)}" (not a lead stage)`);
    else if (stage === currentStage) dropped.push(`moving to ${stage} (already there)`);
    else decision.update_lead_status = { stage };
  }
  return { decision, dropped };
}

export type ActionResult = { kind: Capability; ok: boolean; detail: string };

/** One line for the task notes and the timeline. */
export function runSummary(actions: ActionResult[]): string {
  if (!actions.length) return 'AI step: did nothing.';
  return 'AI step: ' + actions.map((a) => {
    const what = a.kind === 'send_sms' ? 'text' : a.kind === 'create_task' ? 'task' : 'stage';
    return a.ok ? `${what} ✓ ${a.detail}` : `${what} not done (${a.detail})`;
  }).join('; ') + '.';
}

/** A smart route's pick, checked: a candidate's id or null ("none fits"). Anything else is not usable. */
export function parseRoute(input: unknown, candidateIds: number[]): { planId: number | null; reason: string } | null {
  const o = (input && typeof input === 'object' ? input : {}) as { plan_id?: unknown; reason?: unknown };
  const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (o.plan_id === null || o.plan_id === undefined || o.plan_id === '' || o.plan_id === 0) return { planId: null, reason };
  const id = Number(o.plan_id);
  return Number.isInteger(id) && candidateIds.includes(id) ? { planId: id, reason } : null;
}
