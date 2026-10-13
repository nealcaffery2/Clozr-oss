// The rules behind the People smart lists that hold aged leads, in one place so
// the list a rep opens and the leads AI Autopilot reactivates every night are
// the same people (useClozr's 'Dead Leads' and 'Reactivation' lists, and
// _shared/ai-autopilot.ts with migration 146's candidates query, which mirrors
// these in SQL).
//
//   dead_leads    the stage is in a dead or refund group
//   reactivation  we did talk to them, it has gone quiet, and the stage is not
//                 dead, refund or closed
//   no_contact    nobody ever reached them (no call, text or email on file)
//
// lastCommMinutes is minutes since the last call, text or email either way
// (null: never). Pure, no imports beyond the stage list, so the edge
// functions import it too.
import { sellerStageGroup, type SellerStageGroup } from './stages.ts';

export const REACTIVATION_LISTS = ['reactivation', 'dead_leads', 'no_contact'] as const;
export type ReactivationList = (typeof REACTIVATION_LISTS)[number];

export const LIST_LABEL: Record<ReactivationList, string> = {
  reactivation: 'Reactivation (went quiet)', dead_leads: 'Dead Leads', no_contact: 'No Contact',
};

/** How quiet a lead must be for the Reactivation smart list (minutes, about three days). */
export const SMART_LIST_QUIET_MIN = 4000;

export const isDeadGroup = (g: SellerStageGroup | string | null | undefined) => g === 'dead' || g === 'refund';

/** The Dead Leads smart list. */
export const isDeadLeadStage = (stage: string) => isDeadGroup(sellerStageGroup(stage));

/** The Reactivation smart list: talked to, quiet for `quietMin`, not dead, refunded or closed. */
export function isReactivationLead(stage: string, lastCommMinutes: number | null | undefined, quietMin = SMART_LIST_QUIET_MIN): boolean {
  const g = sellerStageGroup(stage);
  return (lastCommMinutes ?? 0) > quietMin && !isDeadGroup(g) && g !== 'closed';
}

/**
 * Groups AI outreach never touches whatever list a lead is on: a contract or
 * a close is a person's job, and 'other' holds wholesalers and buyers.
 */
export const NEVER_REACTIVATE: ReadonlySet<string> = new Set(['contract', 'closed', 'other']);

/** Which of the lists this lead is on, with the quiet period the owner set (minutes). */
export function reactivationListsOf(stage: string, lastCommMinutes: number | null | undefined, quietMin: number): ReactivationList[] {
  const g = sellerStageGroup(stage);
  const out: ReactivationList[] = [];
  if (isReactivationLead(stage, lastCommMinutes, quietMin)) out.push('reactivation');
  if (isDeadGroup(g) && (lastCommMinutes == null || lastCommMinutes > quietMin)) out.push('dead_leads');
  if (lastCommMinutes == null && !isDeadGroup(g) && g !== 'closed') out.push('no_contact');
  return out;
}
