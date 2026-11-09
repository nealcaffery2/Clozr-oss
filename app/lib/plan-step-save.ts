// Write a plan's steps (savePlanDraft in lib/plans.ts, savePlan in
// lib/crm-write.ts). plan_replace_steps (migration 436) does it in one
// transaction and updates the step at each position in place, so a queued
// task or RVM drop keeps the step it points at and a failed save leaves the
// old steps. Before 436 is applied, the old delete-then-insert runs instead.
import type { Json } from './database.types';
import { supabase } from './supabase';

/** One step as plan_replace_steps takes it; its position is its index. */
export type StepPayload = {
  channel: string;
  delay_minutes: number;
  delay_hours: number;
  title: string | null;
  body: string | null;
  subject: string | null;
  config: Json;
};

type DbError = { message: string; code?: string };

/** The RPC is not there yet (migration 436 not applied): PostgREST PGRST202, or Postgres 42883. */
export const replaceStepsMissing = (e: DbError | null): boolean =>
  !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|function .*plan_replace_steps.* does not exist/i.test(e.message));

/** `sb` is the app's client; tools/plan-step-save.test.ts passes a stand-in. */
export async function replacePlanSteps(
  workspaceId: number, planId: number, steps: StepPayload[], sb = supabase,
): Promise<{ error: DbError | null }> {
  if (!sb) return { error: { message: 'Supabase is not configured.' } };
  // The RPC is newer than the generated types.
  const { error } = await sb.rpc('plan_replace_steps' as never, { p_plan: planId, p_steps: steps } as never);
  if (!replaceStepsMissing(error)) return { error };
  const del = await sb.from('action_plan_steps').delete().eq('plan_id', planId);
  if (del.error) return { error: del.error };
  if (!steps.length) return { error: null };
  const ins = await sb.from('action_plan_steps')
    .insert(steps.map((st, i) => ({ workspace_id: workspaceId, plan_id: planId, position: i, ...st })));
  return { error: ins.error };
}
