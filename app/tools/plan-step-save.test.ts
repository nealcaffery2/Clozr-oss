// Saving a plan's steps (migration 436). Run: npx tsx tools/plan-step-save.test.ts
import { replacePlanSteps, replaceStepsMissing, type StepPayload } from '../lib/plan-step-save';
import { blankStep, draftStepRows } from '../lib/plans';
import { inputStepRows } from '../lib/crm-write';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// The payload carries no position, plan or workspace: the RPC places step i at position i in the plan's workspace.
const text = { ...blankStep('sms'), delay: 0, unit: 'days' as const, title: ' Intro ', body: ' Hi {{first_name}} ' };
const email = { ...blankStep('email'), delay: 2, unit: 'days' as const, subject: ' Your offer ', body: 'Body', priority: 'high' as const };
const tag = { ...blankStep('tag'), delay: 90, unit: 'minutes' as const, tag: 'warm' };
eq('draft rows', draftStepRows([text, email, tag]), [
  { channel: 'sms', delay_minutes: 0, delay_hours: 0, title: 'Intro', body: 'Hi {{first_name}}', subject: null, config: { priority: 'normal' } },
  { channel: 'email', delay_minutes: 2880, delay_hours: 48, title: null, body: 'Body', subject: 'Your offer', config: { priority: 'high' } },
  { channel: 'tag', delay_minutes: 90, delay_hours: 50, title: null, body: null, subject: null, config: { tag: 'warm' } },
]);
eq('no rows for no steps', draftStepRows([]), []);
eq('row keys', Object.keys(draftStepRows([text])[0]).sort(), ['body', 'channel', 'config', 'delay_hours', 'delay_minutes', 'subject', 'title']);

eq('builder rows', inputStepRows([
  { channel: 'sms', delay: 'Immediately', title: 'Intro', content: 'Hi' },
  { channel: 'call', delay: '2 hours', title: '', content: '' },
  { channel: 'email', delay: 'Day 3', title: 'Check in', content: 'Body' },
]), [
  { channel: 'sms', delay_hours: 0, delay_minutes: 0, title: 'Intro', body: 'Hi', subject: null, config: {} },
  { channel: 'call', delay_hours: 2, delay_minutes: 120, title: null, body: null, subject: null, config: {} },
  { channel: 'email', delay_hours: 48, delay_minutes: 2760, title: 'Check in', body: 'Body', subject: null, config: {} },
]);

eq('PGRST202 is a missing RPC', replaceStepsMissing({ code: 'PGRST202', message: 'Could not find the function public.plan_replace_steps(p_plan, p_steps) in the schema cache' }), true);
eq('42883 is a missing RPC', replaceStepsMissing({ code: '42883', message: 'function public.plan_replace_steps(bigint, jsonb) does not exist' }), true);
eq('a policy refusal is not', replaceStepsMissing({ code: '42501', message: 'new row violates row-level security policy for table "action_plan_steps"' }), false);
eq('a check failure is not', replaceStepsMissing({ code: '23514', message: 'new row for relation "action_plan_steps" violates check constraint' }), false);
eq('no error is not', replaceStepsMissing(null), false);

// A stand-in client that records what was asked of it.
type Err = { code?: string; message: string } | null;
function fakeClient(rpcError: Err, delError: Err = null, insError: Err = null) {
  const calls: string[] = [];
  const inserted: unknown[] = [];
  const sb = {
    rpc: async (fn: string, args: { p_plan: number; p_steps: StepPayload[] }) => { calls.push(`rpc ${fn} ${args.p_plan} ${args.p_steps.length}`); return { data: null, error: rpcError }; },
    from: (table: string) => ({
      delete: () => ({ eq: async (col: string, v: number) => { calls.push(`delete ${table} ${col}=${v}`); return { error: delError }; } }),
      insert: async (rows: unknown[]) => { calls.push(`insert ${table} ${rows.length}`); inserted.push(...rows); return { error: insError }; },
    }),
  };
  return { sb: sb as never, calls, inserted };
}

const rows = draftStepRows([text, email]);
const missing = { code: 'PGRST202', message: 'Could not find the function public.plan_replace_steps' };

await (async () => {
  const ok = fakeClient(null);
  eq('with 436: one RPC call', [await replacePlanSteps(9, 41, rows, ok.sb), ok.calls], [{ error: null }, ['rpc plan_replace_steps 41 2']]);

  const refused = fakeClient({ code: '23514', message: 'check constraint' });
  eq('an RPC error is returned and nothing is deleted', [await replacePlanSteps(9, 41, rows, refused.sb), refused.calls],
    [{ error: { code: '23514', message: 'check constraint' } }, ['rpc plan_replace_steps 41 2']]);

  const old = fakeClient(missing);
  eq('before 436: delete then insert', [await replacePlanSteps(9, 41, rows, old.sb), old.calls],
    [{ error: null }, ['rpc plan_replace_steps 41 2', 'delete action_plan_steps plan_id=41', 'insert action_plan_steps 2']]);
  eq('before 436: rows carry workspace, plan and position', old.inserted.map((r) => {
    const { workspace_id, plan_id, position, channel } = r as Record<string, unknown>;
    return [workspace_id, plan_id, position, channel];
  }), [[9, 41, 0, 'sms'], [9, 41, 1, 'email']]);

  const oldEmpty = fakeClient(missing);
  eq('before 436: an emptied plan deletes and inserts nothing', [await replacePlanSteps(9, 41, [], oldEmpty.sb), oldEmpty.calls],
    [{ error: null }, ['rpc plan_replace_steps 41 0', 'delete action_plan_steps plan_id=41']]);

  const delFails = fakeClient(missing, { message: 'permission denied' });
  eq('before 436: a failed delete stops before the insert', [await replacePlanSteps(9, 41, rows, delFails.sb), delFails.calls],
    [{ error: { message: 'permission denied' } }, ['rpc plan_replace_steps 41 2', 'delete action_plan_steps plan_id=41']]);
})();

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
