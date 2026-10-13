// Which tasks each view on the Tasks screen lists, and the count beside it.
//
// Today used to be only what is due today, so the screen opened on a list
// that left out everything already late: the work that most needed doing
// was one click away under Overdue. Today now leads with the overdue tasks,
// then today's. And every count but Completed counts open tasks only, the
// same ones the list shows: a ticked task used to stay in the sidebar count
// after it had left the list.

/** The fields a view reads off a task (lib/clozr-types Task). */
export type TaskViewTask = { bucket: string; assigned: string | null };

export const TASK_VIEWS = ['Today', 'Overdue', 'Upcoming', 'Completed', 'My Tasks', 'Team'] as const;

/** Whether a task shows in `view`. An unknown view reads as Today, the default. */
export function inTaskView(view: string, t: TaskViewTask, done: boolean, me: string): boolean {
  if (view === 'Completed') return done;
  if (done) return false;
  switch (view) {
    case 'Overdue': return t.bucket === 'overdue';
    case 'Upcoming': return t.bucket === 'upcoming';
    case 'My Tasks': return t.assigned === me;
    case 'Team': return true;
    default: return t.bucket === 'overdue' || t.bucket === 'today';
  }
}

/** Overdue tasks first, everything else after in the order it came. */
export function overdueFirst<T extends { bucket: string }>(list: T[]): T[] {
  return [...list.filter((t) => t.bucket === 'overdue'), ...list.filter((t) => t.bucket !== 'overdue')];
}

/**
 * The due label with the lateness said out loud. A day-late task is labelled
 * "Yesterday" (lib/crm dayLabel), which in a Today list reads as a slip of
 * the calendar rather than a task that is late.
 */
export function dueLabel(due: string, bucket: string): string {
  return bucket === 'overdue' && !/overdue/i.test(due) ? 'Overdue · ' + due : due;
}
