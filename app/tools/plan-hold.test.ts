// Play and pause rules for action plans.
// Run: npx tsx tools/plan-hold.test.ts
import { applyPlanPlayback, remainingStepSchedule } from '../lib/plan-hold';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const steps = [
  { id: 1, channel: 'sms', delay_minutes: 0 },
  { id: 2, channel: 'wait', delay_minutes: 1440 },
  { id: 3, channel: 'email', delay_minutes: 60 },
  { id: 4, channel: 'call', delay_minutes: 0 },
];

eq('a fresh plan queues every step, waits included after the first', remainingStepSchedule(steps, new Set()), [
  { id: 1, offsetMinutes: 0 },
  { id: 3, offsetMinutes: 1500 },
  { id: 4, offsetMinutes: 1500 },
]);
eq('finished steps and the waits before the next one are skipped', remainingStepSchedule(steps, new Set([1])), [
  { id: 3, offsetMinutes: 60 },
  { id: 4, offsetMinutes: 60 },
]);
eq('a done middle step is not queued again', remainingStepSchedule(steps, new Set([1, 3])), [
  { id: 4, offsetMinutes: 0 },
]);
eq('nothing left to queue', remainingStepSchedule(steps, new Set([1, 3, 4])), []);

const people = [
  { id: 1, status: 'active', stopped_reason: null },
  { id: 2, status: 'paused', stopped_reason: 'manual' },
  { id: 3, status: 'done', stopped_reason: 'reply' },
];
const held = applyPlanPlayback(people, false);
eq('pause holds only the people who are running', held.held, 1);
eq('a hand pause stays a hand pause', held.rows[1], people[1]);
eq('the running person is marked plan_paused', held.rows[0].stopped_reason, 'plan_paused');
const played = applyPlanPlayback(held.rows, true);
eq('play picks up only the plan pause', played.held, 1);
eq('hand-paused stays paused', played.rows[1].status, 'paused');
eq('the held person is running again', played.rows[0], { id: 1, status: 'active', stopped_reason: null });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('plan-hold ok');
