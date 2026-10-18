// Today's "My tasks" and "My deals" band. Run: npx tsx tools/today-band.test.ts
import { daysInStageLabel, dealIsOver, dealKeyNumber, myBandDeals, myBandTasks, myUpcomingTasks } from '../lib/today-band';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const tasks = [
  { id: 'due-mine', bucket: 'today', assigned: 'me', seller: 'sam' },
  { id: 'late-mine', bucket: 'overdue', assigned: 'me', seller: 'sam' },
  { id: 'later-mine', bucket: 'upcoming', assigned: 'me', seller: 'me' },
  { id: 'due-theirs', bucket: 'today', assigned: 'sam', seller: 'me' },
  { id: 'due-nobody-my-seller', bucket: 'today', assigned: null, seller: 'me' },
  { id: 'due-nobody-no-seller', bucket: 'today', assigned: null, seller: null },
  { id: 'late-done', bucket: 'overdue', assigned: 'me', seller: 'me' },
];
const done = new Set(['late-done']);
const band = myBandTasks(tasks, 'me', (t) => done.has(t.id), (t) => t.seller).map((t) => t.id);
eq('late first, then due today, only mine, open only', band, ['late-mine', 'due-mine', 'due-nobody-my-seller']);
eq('nothing due leaves the band empty', myBandTasks([tasks[2]!], 'me', () => false, () => 'me'), []);

const upcoming = [
  { id: 'u-late-time', bucket: 'upcoming', assigned: 'me', seller: 'me', dueAt: '2026-10-20T09:00:00Z' },
  { id: 'u-no-time', bucket: 'upcoming', assigned: 'me', seller: 'me', dueAt: null },
  { id: 'u-soon', bucket: 'upcoming', assigned: 'me', seller: 'me', dueAt: '2026-10-15T09:00:00Z' },
  { id: 'u-theirs', bucket: 'upcoming', assigned: 'sam', seller: 'sam', dueAt: '2026-10-15T08:00:00Z' },
  { id: 'u-done', bucket: 'upcoming', assigned: 'me', seller: 'me', dueAt: '2026-10-15T07:00:00Z' },
  { id: 'today', bucket: 'today', assigned: 'me', seller: 'me', dueAt: '2026-10-14T07:00:00Z' },
];
const nextUp = (limit: number) => myUpcomingTasks(upcoming, 'me', (t) => t.id === 'u-done', (t) => t.seller, limit).map((t) => t.id);
eq('upcoming: mine, open, soonest first, no time last', nextUp(5), ['u-soon', 'u-late-time', 'u-no-time']);
eq('upcoming: capped', nextUp(1), ['u-soon']);

const deals = [
  { id: 'a', owner: 'me', stage: 'Under Contract Seller', daysInStage: 4 },
  { id: 'b', owner: 'me', stage: 'In Escrow', daysInStage: 2 },
  { id: 'c', owner: 'me', stage: 'Under Contract Seller', daysInStage: 12 },
  { id: 'd', owner: 'sam', stage: 'In Escrow', daysInStage: 9 },
  { id: 'e', owner: 'me', stage: 'Closed', daysInStage: 1 },
  { id: 'f', owner: 'me', stage: 'Terminated', daysInStage: 1 },
  { id: 'g', owner: 'me', stage: 'Prospect', daysInStage: 1 },
  { id: 'h', owner: 'me', stage: 'In Escrow', daysInStage: 1, archived: true },
  { id: 'i', owner: 'me', stage: 'Dead', daysInStage: 1 },
  { id: 'j', owner: 'me', stage: 'Negotiation', daysInStage: 30 },
];
eq('my moving deals, furthest along first, then longest in stage', myBandDeals(deals, 'me').map((d) => d.id), ['b', 'c', 'a', 'j']);
eq('closed is over', dealIsOver('Closed'), true);
eq('realtor referral is over', dealIsOver('Realtor Referral'), true);
eq('in escrow is not over', dealIsOver('In Escrow'), false);
eq('contract wins over MAO', dealKeyNumber(186000, 160000), { label: 'Contract', value: 186000 });
eq('MAO when no contract', dealKeyNumber(null, 160000), { label: 'MAO', value: 160000 });
eq('nothing when neither', dealKeyNumber(null, undefined), null);
eq('one day', daysInStageLabel(1), '1 day in stage');
eq('many days', daysInStageLabel(12), '12 days in stage');
eq('zero days', daysInStageLabel(0), 'New today');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
