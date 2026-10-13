// Ask the call-coach function for a scorecard and, when we know the call, store it.
import { supabase } from './supabase';
import { isCoachingReview, type CallCoachingReview, type CoachingSource } from './call-coaching';

export type CoachRequest = {
  transcript?: string;
  repName?: string;
  prospectName?: string;
  workspaceId?: number | null;
  communicationId?: number | null;
  talkrCallId?: string | null;
  source?: CoachingSource;
  force?: boolean;
};

export async function requestCallCoaching(
  input: CoachRequest,
): Promise<{ ok: true; review: CallCoachingReview; persisted: boolean } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('call-coach', {
    body: {
      transcript: input.transcript,
      rep_name: input.repName,
      prospect_name: input.prospectName,
      workspace_id: input.workspaceId ?? undefined,
      communication_id: input.communicationId ?? undefined,
      talkr_call_id: input.talkrCallId ?? undefined,
      source: input.source ?? 'ondemand',
      force: input.force ?? false,
    },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; review?: unknown; persisted?: boolean; error?: string };
  if (r?.ok && isCoachingReview(r.review)) return { ok: true, review: r.review, persisted: !!r.persisted };
  return { ok: false, message: r?.error ?? 'No coaching came back.' };
}
