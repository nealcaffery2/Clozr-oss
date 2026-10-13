// Today's list against the demo graph, plus the rules the demo cannot show
// (the 72-hour pool, the caps, live ISO times). Run: npx tsx tools/today.test.ts
import assert from 'node:assert/strict';
import { buildToday, dueTaskFor, isNewLead, parseDemoWhen, tasksByPerson, CALL_NOW_CAP, type TodayDone, type TodayInput, type TodayPerson, type TodayTask } from '../lib/today';
import { D } from '../lib/clozr-types';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
};

// Wednesday 23 September 2026, 10:05 on this machine's clock: the demo's labels are local times.
const now = new Date(2026, 8, 23, 10, 5);
const demoTasks: TodayTask[] = D.tasks.map((t) => ({ ...t }));
const demoDeal = (pid: string) => {
  const d = D.deals.find((x) => x.personId === pid);
  return d ? { contract: d.contract, mao: d.mao } : undefined;
};
const demo = (over: Partial<TodayInput> = {}) => buildToday({
  people: D.people, tasks: demoTasks, dealOf: demoDeal, me: 'taylor', now, vocab: 'demo', ...over,
});

test('demo labels parse as local times', () => {
  assert.equal(parseDemoWhen('Today 8:51 AM', now)?.getHours(), 8);
  assert.equal(parseDemoWhen('Today 1:30 PM', now)?.getHours(), 13);
  assert.equal(parseDemoWhen('Tomorrow 10:00 AM', now)?.getDate(), 24);
  assert.equal(parseDemoWhen('Overdue · 2h', now)?.getTime(), now.getTime() - 2 * 3_600_000);
  assert.equal(parseDemoWhen('Now', now)?.getTime(), now.getTime());
  assert.equal(parseDemoWhen('Aug 22', now), null);
  assert.equal(parseDemoWhen('Sat 10:00 AM', now), null);
});

test('the demo list: John, Olivia | Kara | Gary', () => {
  const { rows, more } = demo();
  assert.deepEqual(rows.map((r) => r.pid), ['p3', 'p15', 'p1', 'p7']);
  assert.deepEqual(rows.map((r) => r.group), ['now', 'now', 'due', 'offers']);
  assert.equal(more, 0);
  for (const absent of ['p4', 'p2', 'p11']) assert.ok(!rows.some((r) => r.pid === absent), absent);
});
test('John: unassigned, claimed by calling, his first-call task rides along', () => {
  const john = demo().rows[0]!;
  assert.equal(john.claim, true);
  assert.equal(john.tag, '8:51 AM');
  assert.equal(john.task?.id, 'k3');
  assert.ok(john.why.includes('Facebook PPC') && john.why.includes('Calling claims it for you.'), john.why);
  assert.equal(john.reason, 'New lead, Facebook PPC, unassigned');
  assert.equal(john.address, '4410 Bluebonnet Trail, Fort Worth');
  assert.deepEqual(john.target, { name: 'John Smith', phone: '(817) 555-0117', personId: 'p3' });
});
test('Kara is due at 1:30 PM, Gary’s offer is out with a gap', () => {
  const { rows } = demo();
  const kara = rows.find((r) => r.pid === 'p1')!;
  assert.equal(kara.tag, '1:30 PM');
  assert.equal(kara.tagTone, 'due');
  assert.equal(kara.task?.id, 'k1');
  const gary = rows.find((r) => r.pid === 'p7')!;
  assert.equal(gary.tag, '$188,000');
  assert.equal(gary.tagTone, 'money');
  assert.ok(gary.why.includes('Asking $210,000, a $22,000 gap'), gary.why);
});
test('Derek is out: his next step is tomorrow', () => {
  const { rows } = demo({ tasks: demoTasks.filter((t) => t.id !== 'k6') });
  assert.ok(rows.some((r) => r.pid === 'p4'), 'without k6 Derek is an offer out');
});
test('done rows keep their place in their group and leave the universe', () => {
  const first = demo();
  const olivia = first.rows.find((r) => r.pid === 'p15')!;
  const john = first.rows.find((r) => r.pid === 'p3')!;
  // Olivia's stage moved on after the save; her row keeps its snapshot and its place.
  const people = D.people.map((p) => (p.id === 'p15' ? { ...p, stage: 'Contacted', lastCommTs: 0 } : p));
  const one = demo({ people, done: { p15: { seq: 1, label: 'Voicemail', row: olivia, at: 1 } } });
  assert.deepEqual(one.rows.map((r) => r.pid), ['p3', 'p15', 'p1', 'p7']);
  assert.equal(one.rows[1]!.done?.label, 'Voicemail');
  assert.equal(one.rows.filter((r) => !r.done).length, 3);
  const both = demo({ people, done: { p15: { seq: 1, label: 'Voicemail', row: olivia, at: 1 }, p3: { seq: 2, label: 'No answer', row: john, at: 0 } } });
  assert.deepEqual(both.rows.map((r) => r.pid), ['p3', 'p15', 'p1', 'p7']);
  const unplaced: Record<string, TodayDone> = { p15: { seq: 1, label: 'Voicemail', row: olivia } };
  assert.equal(demo({ people, done: unplaced }).rows[0]!.pid, 'p15', 'no place recorded: the top of the group');
});
test('do-not-call sellers are never on Today', () => {
  const people = D.people.map((p) => (p.id === 'p3' ? { ...p, tags: ['DNC'] } : p));
  assert.ok(!demo({ people }).rows.some((r) => r.pid === 'p3'));
});
test('once claimed, John is mine and no longer a claim', () => {
  const people = D.people.map((p) => (p.id === 'p3' ? { ...p, assigned: 'taylor' } : p));
  const john = demo({ people }).rows.find((r) => r.pid === 'p3')!;
  assert.equal(john.claim, false);
  assert.ok(!john.why.includes('claims'));
});

// ---- live rules ---------------------------------------------------------------
const lead = (id: string, over: Partial<TodayPerson> = {}): TodayPerson => ({
  id, name: 'Lead ' + id, stage: 'Lead', assigned: null, source: 'Website', phone: '(210) 555-0100',
  lastComm: 'No contact yet', lastCommTs: null, created: 'Sep 20', createdAt: null, tags: [], asking: '—', offer: null,
  property: { addr: '1 Main St', city: 'San Antonio', st: 'TX', zip: '78201' }, ...over,
});
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const live = (people: TodayPerson[], tasks: TodayTask[] = []) => buildToday({ people, tasks, dealOf: () => undefined, me: 'u1', now, vocab: 'live' });

test('the unassigned pool is 72 hours deep', () => {
  assert.ok(isNewLead(lead('s1', { createdAt: hoursAgo(71) }), 'u1', now, 'live'));
  assert.ok(!isNewLead(lead('s2', { createdAt: hoursAgo(73) }), 'u1', now, 'live'));
  assert.ok(isNewLead(lead('s3', { createdAt: hoursAgo(24 * 10), assigned: 'u1' }), 'u1', now, 'live'), 'mine at any age');
  assert.ok(!isNewLead(lead('s4', { createdAt: hoursAgo(1), assigned: 'u2' }), 'u1', now, 'live'), 'someone else’s');
  assert.ok(!isNewLead(lead('s5', { createdAt: hoursAgo(1), stage: 'New Submission' }), 'u1', now, 'live'));
  assert.ok(!isNewLead(lead('s6', { createdAt: hoursAgo(1), stage: 'Lead - No Contact' }), 'u1', now, 'live'));
  assert.ok(!isNewLead(lead('s7', { createdAt: hoursAgo(1), lastCommTs: 5 }), 'u1', now, 'live'));
});
test('Call now: oldest first, capped at 25 with the rest counted', () => {
  const people = Array.from({ length: 30 }, (_, i) => lead('s' + i, { createdAt: hoursAgo(i + 1) }));
  const { rows, more } = live(people);
  assert.equal(rows.length, CALL_NOW_CAP);
  assert.equal(more, 5);
  assert.equal(rows[0]!.pid, 's29', 'the longest wait is called first');
});
test('Due today: mine, overdue first, TC and dispo work left out', () => {
  const people = [lead('s1', { stage: 'Contacted - Follow Up Needed', assigned: 'u1', lastCommTs: 60 }), lead('s2', { stage: 'Contacted - Follow Up Needed', assigned: 'u1', lastCommTs: 60 }), lead('s3', { stage: 'Underwriting', assigned: 'u1', lastCommTs: 60 }), lead('s4', { stage: 'Contacted - Follow Up Needed', assigned: 'u2', lastCommTs: 60 })];
  const task = (id: string, personId: string, over: Partial<TodayTask>): TodayTask => ({ id, title: 'Call ' + personId, personId, type: 'Call', due: 'Today', dueAt: null, assigned: 'u1', done: false, bucket: 'today', ...over });
  const tasks = [
    task('k1', 's1', { dueAt: new Date(2026, 8, 23, 15, 0).toISOString() }),
    task('k2', 's2', { bucket: 'overdue', dueAt: new Date(2026, 8, 22, 9, 0).toISOString() }),
    task('k3', 's3', { type: 'TC' }),
    task('k4', 's4', { assigned: null }),
    task('k5', 's1', { dueAt: new Date(2026, 8, 23, 11, 0).toISOString() }),
  ];
  const { rows } = live(people, tasks);
  assert.deepEqual(rows.map((r) => r.pid), ['s2', 's1']);
  assert.equal(rows[0]!.tag, 'Overdue');
  assert.equal(rows[1]!.task?.id, 'k5', 'the earliest task is the one on the row');
  assert.equal(rows[1]!.tag, '11:00 AM');
  assert.equal(dueTaskFor(tasksByPerson(tasks).get('s4'), 'u1', now)?.id, 'k4', 'an unassigned task is still mine to complete');
});
test('Offers out: mine, no next step, stalest first, capped at 15', () => {
  const people = Array.from({ length: 18 }, (_, i) => lead('o' + i, { stage: 'Offer Made', assigned: 'u1', lastCommTs: i * 10, offer: '$150,000' }));
  people.push(lead('x', { stage: 'Offer Made', assigned: 'u2', lastCommTs: 1e6 }));
  const tasks: TodayTask[] = [{ id: 'k9', title: 'Next step', personId: 'o17', type: 'Call', due: 'Fri', dueAt: null, assigned: 'u1', done: false, bucket: 'upcoming' }];
  const { rows } = live(people, tasks);
  assert.equal(rows.length, 15);
  assert.equal(rows[0]!.pid, 'o16', 'o17 has a next step; o16 is the stalest left');
  assert.ok(!rows.some((r) => r.pid === 'x'));
  assert.equal(rows[0]!.tag, '$150,000');
});

test('a dispo rep: no unassigned pool, their own dispo task on a seller under contract, not the TC checklist', () => {
  const people = [
    lead('pool', { createdAt: hoursAgo(2) }),
    lead('uc', { stage: 'Under Contract', assigned: 'u9', lastCommTs: 60 }),
    lead('other', { stage: 'Contacted - Follow Up Needed', assigned: 'u2', lastCommTs: 60 }),
  ];
  const task = (id: string, personId: string, over: Partial<TodayTask>): TodayTask => ({ id, title: 'Send to buyers ' + personId, personId, type: 'Dispo', due: 'Today', dueAt: null, assigned: 'u1', done: false, bucket: 'today', ...over });
  const tasks = [task('d1', 'uc', {}), task('t1', 'uc', { type: 'TC' }), task('o1', 'other', { assigned: 'u2' })];
  const dispo = buildToday({ people, tasks, dealOf: () => undefined, me: 'u1', now, vocab: 'live', role: 'dispositions' });
  assert.deepEqual(dispo.rows.map((r) => r.pid + ':' + r.task?.id), ['uc:d1']);
  const acq = buildToday({ people, tasks, dealOf: () => undefined, me: 'u1', now, vocab: 'live', role: 'acquisitions' });
  assert.deepEqual(acq.rows.map((r) => r.pid), ['pool'], 'acquisitions: the pool, and no dispo task');
});

console.log(`today: ${passed} checks passed`);
