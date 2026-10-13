// The builder's side of the draft-action-plan edge function.
//
// Two conversations with the model: "write me a plan" (goal) and "change
// this plan" (edit). Both come back as an AiPlan the builder loads for
// review; nothing is saved by either. lib/team.ts draftPlan is the older
// wrapper the seller record still uses for the per-lead mode.

import { supabase } from './supabase';
import type { AiPlan } from './plans';

export type AiResult = { ok: true; plan: AiPlan; changes: string[] } | { ok: false; message: string };

export type GoalRequest = {
  mode: 'goal';
  goal: string;
  tone?: string;
  trigger?: string;
  stepCount?: number | null;
  channels?: string[];
};
export type EditRequest = {
  mode: 'edit';
  plan: AiPlan;
  instruction: string;
  tone?: string;
};

export async function askPlanAi(workspaceId: number, req: GoalRequest | EditRequest): Promise<AiResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const body = req.mode === 'goal'
    ? { mode: 'goal', workspace_id: workspaceId, goal: req.goal, tone: req.tone, trigger: req.trigger, step_count: req.stepCount ?? undefined, channels: req.channels }
    : { mode: 'edit', workspace_id: workspaceId, plan: req.plan, instruction: req.instruction, tone: req.tone };
  const { data, error } = await supabase.functions.invoke('draft-action-plan', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; plan?: AiPlan; changes?: string[]; error?: string };
  if (!r?.ok || !r.plan) return { ok: false, message: r?.error ?? 'No plan came back.' };
  return { ok: true, plan: r.plan, changes: Array.isArray(r.changes) ? r.changes : [] };
}
