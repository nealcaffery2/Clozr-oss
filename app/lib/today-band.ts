// The band on Today that holds the rep's own work beside the call list: their
// tasks due today or already late, and the deals they own that are still
// moving. A short or empty call list used to leave Today with nothing on it,
// though the rep had tasks waiting and deals in escrow.

import { inTaskView, overdueFirst, taskVisible, type TaskViewTask } from './task-views';
import { DEAL_STAGES } from './stages';

/**
 * The rep's tasks for the band: open, due today or late, and theirs by the
 * rule a rep's Tasks screen uses (taskVisible as a rep, even for an owner, so
 * an owner's band is their own work and not the workspace's imports). Late
 * ones first, the rest in the order they came.
 */
export function myBandTasks<T extends TaskViewTask>(
  tasks: readonly T[],
  me: string,
  isDone: (t: T) => boolean,
  sellerOwner: (t: T) => string | null | undefined,
): T[] {
  return overdueFirst(tasks.filter((t) => inTaskView('Today', t, isDone(t), me) && taskVisible(t, me, false, sellerOwner(t))));
}

/**
 * What comes next once today's are done: the rep's open upcoming tasks,
 * soonest first where a due time is known, `limit` of them. Today shows these
 * only when the band is the page, so an empty call list still says what is next.
 */
export function myUpcomingTasks<T extends TaskViewTask & { dueAt?: string | null }>(
  tasks: readonly T[],
  me: string,
  isDone: (t: T) => boolean,
  sellerOwner: (t: T) => string | null | undefined,
  limit: number,
): T[] {
  const at = (t: T) => (t.dueAt ? Date.parse(t.dueAt) : Number.POSITIVE_INFINITY);
  return tasks
    .filter((t) => inTaskView('Upcoming', t, isDone(t), me) && taskVisible(t, me, false, sellerOwner(t)))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => at(a.t) - at(b.t) || a.i - b.i)
    .slice(0, limit)
    .map(({ t }) => t);
}

/** The fields a deal needs to be sorted into the band. */
export type BandDeal = { owner: string | null | undefined; archived?: boolean; stage: string; daysInStage: number };

/** A stage the work on a deal is over in: closed, terminated, referred out or dead. */
export function dealIsOver(stage: string): boolean {
  return /^(closed|terminated|realtor referral|dead|lost|not interested|archived)\b/i.test(stage.trim());
}

/**
 * The deals the rep owns that are still moving: not archived, not a lead's
 * underwriting holder (Prospect), not over. Furthest along first (In Escrow
 * before Under Contract Seller), then the longest in its stage.
 */
export function myBandDeals<D extends BandDeal>(deals: readonly D[], me: string): D[] {
  const order = (stage: string) => (DEAL_STAGES as readonly string[]).indexOf(stage);
  return deals
    .filter((d) => d.owner === me && !d.archived && d.stage !== 'Prospect' && !!d.stage && !dealIsOver(d.stage))
    .sort((a, b) => order(b.stage) - order(a.stage) || b.daysInStage - a.daysInStage);
}

/** The one number a deal row shows: the contract price, else COMPR's MAO, else nothing yet. */
export function dealKeyNumber(contract: number | null | undefined, mao: number | null | undefined): { label: string; value: number } | null {
  if (contract) return { label: 'Contract', value: contract };
  if (mao) return { label: 'MAO', value: mao };
  return null;
}

/** "3 days in stage", "1 day in stage", "New today". */
export function daysInStageLabel(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return 'New today';
  return days === 1 ? '1 day in stage' : `${days} days in stage`;
}
