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

/** A rep's views: every list is already theirs, so My Tasks and Team would only repeat it. */
export const REP_TASK_VIEWS = ['Today', 'Overdue', 'Upcoming', 'Completed'] as const;

/**
 * Whose tasks a seat sees. An owner or admin sees the workspace's. Anyone else
 * sees what is assigned to them, plus a task nobody owns on a record that is
 * theirs: their seller, buyer or deal (the rule Today uses for sellers).
 * Every rep used to open on the whole workspace's list, a thousand
 * unassigned imports included.
 */
export function taskVisible(t: TaskViewTask, me: string, manager: boolean, recordOwner: string | null | undefined): boolean {
  if (manager) return true;
  if (t.assigned === me) return true;
  return t.assigned === null && !!recordOwner && recordOwner === me;
}

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

/**
 * How a row on the Tasks screen draws its due date and title, open or done.
 * The row works this out from its own tick, so a click shows at once while
 * the rest of the workspace catches up (screens/Tasks.tsx).
 */
export function taskLook(done: boolean, due: string, bucket: string): { due: string; dueColor: string; deco: string; textColor: string } {
  return {
    due: done ? due : dueLabel(due, bucket),
    dueColor: !done && bucket === 'overdue' ? '#dc2626' : /Overdue/.test(due) ? '#dc2626' : /Now|Today/.test(due) ? '#18181b' : '#71717a',
    deco: done ? 'line-through' : 'none',
    textColor: done ? '#a1a1aa' : '#18181b',
  };
}

/**
 * Whether ticking a task done (or open again) can change the next task its
 * seller's row shows, which lib/crm writes as "title · day" from the soonest
 * open task. Closing a task with another title leaves it as it is, so the
 * seller need not be read again. The day is not compared: the two labels may
 * have been written on different days. Opening one, or a seller whose row is
 * not loaded, may change it.
 */
export function nextTaskMayMove(shown: string | null | undefined, title: string, done: boolean): boolean {
  return !done || shown == null || shown.startsWith(title + ' · ');
}

/** The open tasks a list shows, by id: what the screen's "Complete all shown" ticks. */
export function openShownIds(rows: { id: string; done: boolean }[]): string[] {
  return rows.filter((r) => !r.done).map((r) => r.id);
}

/**
 * The tick overrides once a bulk write is back: each task that did not save
 * goes back the way the database has it, as one tick's failed write does
 * (useClozr persistTask). The loaded row says so unless an earlier tick this
 * session changed it, which only the override remembers. Every other tick stays.
 */
export function revertFailed(
  over: Record<string, boolean>, failed: string[], done: boolean, loadedDone: (id: string) => boolean | undefined,
): Record<string, boolean> {
  if (!failed.length) return over;
  const next = { ...over };
  for (const id of failed) {
    if (loadedDone(id) === !done) delete next[id];
    else next[id] = !done;
  }
  return next;
}
