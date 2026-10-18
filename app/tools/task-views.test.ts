// Tasks screen views. Run: npx tsx tools/task-views.test.ts
import { TASK_VIEWS, dueLabel, inTaskView, nextTaskMayMove, overdueFirst, taskLook, taskVisible } from '../lib/task-views';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const late = { id: 'a', bucket: 'overdue', assigned: 'me' };
const due = { id: 'b', bucket: 'today', assigned: 'sam' };
const later = { id: 'c', bucket: 'upcoming', assigned: 'me' };
const all = [due, later, late];
const shown = (view: string, done: Record<string, boolean> = {}) => all.filter((t) => inTaskView(view, t, !!done[t.id], 'me')).map((t) => t.id);
const count = (view: string, done: Record<string, boolean>) => all.filter((t) => inTaskView(view, t, !!done[t.id], 'me')).length;

eq('a rep sees their own task', taskVisible({ bucket: 'today', assigned: 'me' }, 'me', false, 'sam'), true);
eq('a rep does not see a teammate\'s task', taskVisible({ bucket: 'today', assigned: 'sam' }, 'me', false, 'me'), false);
eq('a rep sees an unassigned task on their own seller', taskVisible({ bucket: 'today', assigned: null }, 'me', false, 'me'), true);
eq('a rep does not see the workspace\'s unassigned tasks', taskVisible({ bucket: 'today', assigned: null }, 'me', false, null), false);
eq('a manager sees every task', taskVisible({ bucket: 'today', assigned: null }, 'me', true, null), true);
eq('Today takes in the overdue tasks', shown('Today'), ['b', 'a']);
eq('Overdue is only the late ones', shown('Overdue'), ['a']);
eq('Upcoming', shown('Upcoming'), ['c']);
eq('My Tasks', shown('My Tasks'), ['c', 'a']);
eq('an unknown view reads as Today', shown('Whatever'), ['b', 'a']);
eq('a done task leaves Today', shown('Today', { a: true }), ['b']);
eq('a done task leaves Team', shown('Team', { c: true }), ['b', 'a']);
eq('Completed is only the done ones', shown('Completed', { c: true }), ['c']);
eq('counts are of open tasks, as the list is', TASK_VIEWS.map((v) => count(v, { a: true })), [1, 0, 1, 1, 1, 2]);
eq('overdue first, the rest in order', overdueFirst(all).map((t) => t.id), ['a', 'b', 'c']);
eq('a day-late task says it is late', dueLabel('Yesterday', 'overdue'), 'Overdue · Yesterday');
eq('already says overdue', dueLabel('Overdue · Sep 3', 'overdue'), 'Overdue · Sep 3');
eq('on time is left alone', dueLabel('Today 1:30 PM', 'today'), 'Today 1:30 PM');

// A row draws itself from its own tick, the way the view-model drew it.
eq('an open late task says so in red', taskLook(false, 'Yesterday', 'overdue'), { due: 'Overdue · Yesterday', dueColor: '#dc2626', deco: 'none', textColor: '#18181b' });
eq('ticked, it keeps its plain date, struck through', taskLook(true, 'Yesterday', 'overdue'), { due: 'Yesterday', dueColor: '#71717a', deco: 'line-through', textColor: '#a1a1aa' });
eq('due today reads dark', taskLook(false, 'Today', 'today').dueColor, '#18181b');
eq('a later one reads muted', taskLook(false, 'Oct 30', 'upcoming').dueColor, '#71717a');

// The seller is read again only when the closed task could be the one their row names.
const call = 'Call seller back';
eq('closing the task the row names re-reads', nextTaskMayMove('Call seller back · Yesterday', call, true), true);
eq('the day label may be older than the task one', nextTaskMayMove('Call seller back · Today', call, true), true);
eq('closing another task does not', nextTaskMayMove('Send contract · Oct 30', call, true), false);
eq('closing on a row with no task does not', nextTaskMayMove('No task scheduled', call, true), false);
eq('opening a task again re-reads', nextTaskMayMove('Send contract · Oct 30', call, false), true);
eq('a seller not loaded re-reads', nextTaskMayMove(undefined, call, true), true);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('ok');
