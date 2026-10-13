// The "AI agent" action-plan step. Run: npx tsx tools/plan-ai-agent-step.test.ts
import { NO_ROUTE, STEP_TYPES, aiFromDraft, blankPlan, blankStep, cleanOnComplete, draftFromAi, parseOnComplete, routeSummary, stepFromRow, stepMeta, stepSummary, type PlanStepDraft } from '../lib/plans';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const row = (channel: string, config: unknown) => ({
  id: 7, position: 1, channel, delay_hours: 48, delay_minutes: 2880, title: 'Hand to AI', body: null, subject: null, config: config as never,
});

eq('ai_agent is a step type', STEP_TYPES.some((t) => t.v === 'ai_agent'), true);
eq('its label', stepMeta('ai_agent').label, 'AI agent');

const parsed = stepFromRow(row('ai_agent', { goal: 'Book a walkthrough this week' }));
eq('row parses as ai_agent', parsed.type, 'ai_agent');
eq('goal read from config', parsed.goal, 'Book a walkthrough this week');
eq('delay kept', [parsed.delay, parsed.unit], [2, 'days']);
eq('missing goal parses as blank', stepFromRow(row('ai_agent', {})).goal, '');
eq('non-string goal parses as blank', stepFromRow(row('ai_agent', { goal: 5 })).goal, '');
eq('other steps carry no goal', 'goal' in stepFromRow(row('sms', { goal: 'x' })), false);

// The 136 hand-off: an ai_agent step with no `allowed`.
const handoff = (): PlanStepDraft => { const st = blankStep('ai_agent'); delete st.allowed; return st; };
eq('summary shows the goal', stepSummary({ ...handoff(), goal: '  Book a\n walkthrough ' }), 'AI agent: Book a walkthrough');
eq('summary with no goal', stepSummary(handoff()), 'AI agent: decides from the record history');
eq('summary clips a long goal', stepSummary({ ...handoff(), goal: 'x'.repeat(100) }), 'AI agent: ' + 'x'.repeat(60));

// Migration 142: the step decides once, with what it may do.
eq('a new AI step decides once and may do all three', blankStep('ai_agent').allowed, ['send_sms', 'create_task', 'update_lead_status']);
eq('decide-once summary', stepSummary({ ...blankStep('ai_agent'), goal: 'Get a walkthrough booked' }), 'AI decides: Get a walkthrough booked');
eq('allowed read from config, cleaned', stepFromRow(row('ai_agent', { goal: 'g', allowed: ['create_task', 'call', 'create_task'] })).allowed, ['create_task']);
eq('no allowed in config is the hand-off', 'allowed' in stepFromRow(row('ai_agent', { goal: 'g' })), false);

// Where a lead goes when the plan ends.
eq('route: a 34-era next plan reads as fixed', parseOnComplete({}, 12), { mode: 'fixed', plan_id: 12, candidate_ids: [], also_when_stopped: false });
eq('route: nothing set', parseOnComplete(null), NO_ROUTE);
eq('route: smart, ids cleaned', parseOnComplete({ mode: 'smart', candidate_ids: [3, '4', 'x', 3], also_when_stopped: true }),
  { mode: 'smart', plan_id: null, candidate_ids: [3, 4], also_when_stopped: true });
eq('route: never into itself', cleanOnComplete({ mode: 'fixed', plan_id: 5, candidate_ids: [9], also_when_stopped: false }, 5),
  { mode: 'fixed', plan_id: null, candidate_ids: [], also_when_stopped: false });
eq('route: smart drops itself from the candidates', cleanOnComplete({ mode: 'smart', plan_id: 2, candidate_ids: [5, 6], also_when_stopped: true }, 5).candidate_ids, [6]);
eq('route: summaries', [
  routeSummary({ mode: 'fixed', plan_id: 2, candidate_ids: [], also_when_stopped: false }, [{ id: 2, name: 'Nurture' }]),
  routeSummary({ mode: 'smart', plan_id: null, candidate_ids: [2, 3], also_when_stopped: true }, []),
  routeSummary(NO_ROUTE, []),
], ['then “Nurture”', 'then AI picks from 2 plans, also when stopped', '']);

// The AI round trip carries the goal as content.
const plan = { ...blankPlan(), steps: [{ ...blankStep('ai_agent'), goal: 'Qualify and book' }] };
const ai = aiFromDraft(plan);
eq('to the model: content is the goal', [ai.steps[0].channel, ai.steps[0].content], ['ai_agent', 'Qualify and book']);
const back = draftFromAi(ai, plan).steps[0];
eq('from the model: goal back, body empty', [back.type, back.goal, back.body], ['ai_agent', 'Qualify and book', '']);
eq('from the model: an AI step decides once', back.allowed, ['send_sms', 'create_task', 'update_lead_status']);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
