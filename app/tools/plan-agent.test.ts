// Action plans' decide-once AI step and smart routing: what the model may do, and how its answer is held to the step.
// Run: npx tsx tools/plan-agent.test.ts
import { cleanAllowed, decideTool, parseDecision, parseRoute, runSummary } from '../supabase/functions/_shared/plan-agent-rules';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const stages = ['Lead', 'Qualified', 'Offer Made - Follow Up', 'Dead'];

eq('allowed: known capabilities only, once each', cleanAllowed(['send_sms', 'call', 'send_sms', 'update_lead_status']), ['send_sms', 'update_lead_status']);
eq('allowed: not a list', cleanAllowed('send_sms'), []);
eq('tool: offers only what the step allows', Object.keys(decideTool(['create_task']).input_schema.properties), ['reason', 'create_task']);
eq('tool: every allowed key is required (null for none)', decideTool(['send_sms', 'update_lead_status']).input_schema.required, ['reason', 'send_sms', 'update_lead_status']);

const all = cleanAllowed(['send_sms', 'create_task', 'update_lead_status']);
eq('decision: one of each, cleaned', parseDecision({
  reason: '  Went quiet  after the offer. ',
  send_sms: { body: 'Hi Kara,  still thinking it over?' },
  create_task: { title: 'Call Kara', type: 'call', due_in_hours: 999 },
  update_lead_status: { stage: 'offer made follow up' },
}, all, stages, 'Qualified'), {
  decision: {
    reason: 'Went quiet after the offer.',
    send_sms: { body: 'Hi Kara, still thinking it over?' },
    create_task: { title: 'Call Kara', type: 'call', due_in_hours: 336 },
    update_lead_status: { stage: 'Offer Made - Follow Up' },
  },
  dropped: [],
});
eq('decision: nothing is a decision', parseDecision({ reason: 'Replied yesterday; leave it.', send_sms: null, create_task: null, update_lead_status: null }, all, stages, 'Lead').decision,
  { reason: 'Replied yesterday; leave it.', send_sms: null, create_task: null, update_lead_status: null });
const bad = parseDecision({
  reason: 'x', send_sms: { body: 'y'.repeat(400) }, create_task: { title: 'Do it', type: 'fax', due_in_hours: 'soon' }, update_lead_status: { stage: 'Qualified' },
}, all, stages, 'Qualified');
eq('decision: long text, current stage dropped; odd task type and due fixed', bad, {
  decision: { reason: 'x', send_sms: null, create_task: { title: 'Do it', type: 'todo', due_in_hours: 0 }, update_lead_status: null },
  dropped: ['a text of 400 characters (over 320)', 'moving to Qualified (already there)'],
});
eq('decision: actions the step does not allow are dropped', parseDecision({ reason: 'r', send_sms: { body: 'hi' }, update_lead_status: { stage: 'Dead' } }, ['create_task'], stages, 'Lead'), {
  decision: { reason: 'r', send_sms: null, create_task: null, update_lead_status: null },
  dropped: ['a text (not allowed at this step)', 'a stage change (not allowed at this step)'],
});
eq('decision: a stage not on the list', parseDecision({ reason: 'r', update_lead_status: { stage: 'Super hot' } }, all, stages, 'Lead').dropped, ['the stage "Super hot" (not a lead stage)']);

eq('summary', runSummary([{ kind: 'send_sms', ok: true, detail: '"Hi"' }, { kind: 'update_lead_status', ok: false, detail: 'quiet hours' }]), 'AI step: text ✓ "Hi"; stage not done (quiet hours).');
eq('summary: nothing', runSummary([]), 'AI step: did nothing.');

eq('route: a candidate', parseRoute({ plan_id: 7, reason: ' Asked to talk in spring ' }, [7, 9]), { planId: 7, reason: 'Asked to talk in spring' });
eq('route: none fits', parseRoute({ plan_id: null, reason: 'Sold elsewhere' }, [7]), { planId: null, reason: 'Sold elsewhere' });
eq('route: not a candidate is unusable', parseRoute({ plan_id: 8 }, [7, 9]), null);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
