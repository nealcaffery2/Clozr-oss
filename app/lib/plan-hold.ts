// Pure rules for holding and resuming an action plan.
//
// Pausing a plan holds everyone currently running it. Playing it puts those
// people back and leaves anyone paused by hand still paused. Resuming one
// person queues only the steps that do not already have a task, timed from
// the first step that is still open.

export type HoldStep = { id: number; channel: string; delay_minutes: number | null };

export type HoldEnrollment = { status: string; stopped_reason: string | null };

/** Steps still to queue, with minutes from "now" (the first open step). */
export function remainingStepSchedule(
  steps: HoldStep[],
  doneIds: ReadonlySet<number>,
): { id: number; offsetMinutes: number }[] {
  let offset = 0;
  let armed = false;
  const out: { id: number; offsetMinutes: number }[] = [];
  for (const st of steps) {
    const open = st.channel !== 'wait' && !doneIds.has(st.id);
    if (!armed && !open) continue;
    armed = true;
    offset += st.delay_minutes ?? 0;
    if (open) out.push({ id: st.id, offsetMinutes: offset });
  }
  return out;
}

/**
 * Pause holds every active enrollment. Play resumes only the ones this plan
 * pause put on hold (`stopped_reason` plan_paused).
 */
export function applyPlanPlayback<T extends HoldEnrollment>(
  rows: T[],
  playing: boolean,
): { rows: T[]; held: number } {
  if (!playing) {
    let held = 0;
    const next = rows.map((r) => {
      if (r.status !== 'active') return r;
      held += 1;
      return { ...r, status: 'paused', stopped_reason: 'plan_paused' };
    });
    return { rows: next, held };
  }
  let held = 0;
  const next = rows.map((r) => {
    if (r.status !== 'paused' || r.stopped_reason !== 'plan_paused') return r;
    held += 1;
    return { ...r, status: 'active', stopped_reason: null };
  });
  return { rows: next, held };
}
