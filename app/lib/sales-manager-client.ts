// The browser's side of the AI Sales Manager: the sales-manager function's
// actions, and the two reads RLS already allows (roleplay history, the
// weekly-email settings).

import { supabase } from './supabase';
import type { FlagId, CoachingInsight, CallFlag } from './sales-framework';
import type { RepScorecard } from './sales-scorecard';
import type { RoleplayFeedback, RoleplayLine } from './roleplay';
import type { CallCoachingReview } from './call-coaching';
import { checkUpload, uploadPath } from './call-upload';

type Fail = { ok: false; error: string };

async function call<T>(action: string, workspaceId: number, body: Record<string, unknown> = {}): Promise<(T & { ok: true }) | Fail> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('sales-manager', { body: { action, workspace_id: workspaceId, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, error: message };
  }
  const r = data as { ok?: boolean; error?: string } & T;
  if (r?.ok) return r as T & { ok: true };
  return { ok: false, error: r?.error ?? 'Something went wrong.' };
}

export type TeamTotals = {
  reps: number; calls: number; conversations: number; reviewedCalls: number; flaggedCalls: number;
  appointmentsSet: number; contracts: number; roleplaySessions: number; avgCallScore: number | null; frameworkHitRate: number | null;
};

export type ScorecardsResult = { period: string; range: { start: string | null; end: string }; cards: RepScorecard[]; team: TeamTotals | null; notes: string[]; admin: boolean };

export type FlaggedCall = {
  id: number; occurred_at: string; duration_s: number | null; direction: string | null;
  rep_id: string | null; rep_name: string | null; seller_id: number | null; seller_name: string | null; address: string | null;
  overall: number | null; hit_rate: number | null; flags: CallFlag[]; insights: CoachingInsight[]; verdict: string | null; has_recording: boolean;
};

export type RoleplayStart = {
  session_id: number; mode: 'voice' | 'text'; voice_error: string | null; seller_name: string; opener: string;
  voice?: { signed_url: string; agent_id: string; dynamic_variables: Record<string, string>; first_message: string };
};

export const salesManagerApi = (workspaceId: number) => ({
  scorecards: (period: string) => call<ScorecardsResult>('scorecards', workspaceId, { period }),
  flagged: (opts: { repId?: string | null; flag?: FlagId | null; days?: number }) =>
    call<{ calls: FlaggedCall[] }>('flagged', workspaceId, { rep_id: opts.repId ?? undefined, flag: opts.flag ?? undefined, days: opts.days ?? 30 }),
  reviewBacklog: () => call<{ considered: number; graded: number; errors: string[] }>('review_backlog', workspaceId),
  weeklyTest: () => call<{ to: string }>('weekly_test', workspaceId),
  start: (opts: { persona: string; difficulty: string; objection: string | null; mode: 'voice' | 'text' }) => call<RoleplayStart>('roleplay_start', workspaceId, opts),
  say: (sessionId: number, text: string) => call<{ reply: string }>('roleplay_say', workspaceId, { session_id: sessionId, text }),
  finish: (sessionId: number, opts: { lines?: RoleplayLine[]; conversationId?: string | null; durationS?: number }) =>
    call<{ feedback: RoleplayFeedback; score: number }>('roleplay_finish', workspaceId, {
      session_id: sessionId, lines: opts.lines, conversation_id: opts.conversationId ?? undefined, duration_s: opts.durationS,
    }),
  abandon: (sessionId: number) => call<object>('roleplay_abandon', workspaceId, { session_id: sessionId }),
  arm: (opts: { persona: string; difficulty: string; objection: string | null }) =>
    call<{ session_id: number; phone: string; armed_until: string; seller_name: string }>('roleplay_arm', workspaceId, opts),
  setupPhone: (phone: string) => call<{ agent_id: string; phone: string | null }>('roleplay_phone', workspaceId, { phone }),
  submitReview: (opts: { callType: string; repId?: string | null; title?: string | null; text?: string; filePath?: string }) =>
    call<{ submission_id: number }>('submit_review', workspaceId, {
      call_type: opts.callType, rep_id: opts.repId ?? undefined, title: opts.title ?? undefined, text: opts.text, file_path: opts.filePath,
    }),
});

/** Put a recording in the workspace's uploads folder (migration 149's insert policy). Returns the storage path. */
export async function uploadRecording(workspaceId: number, userId: string, file: File): Promise<{ ok: true; path: string } | Fail> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const c = checkUpload(file.name, file.size);
  if (!c.ok) return c;
  if (c.kind !== 'audio') return { ok: false, error: 'That is not a recording.' };
  const path = uploadPath(workspaceId, userId, c.ext);
  const { error } = await supabase.storage.from('call-recordings').upload(path, file, { contentType: c.contentType, upsert: false });
  return error ? { ok: false, error: error.message } : { ok: true, path };
}

export type SubmissionRow = {
  id: number; user_id: string; rep_id: string | null; call_type: string; title: string | null; source: string; status: string; error: string | null;
  score: number | null; duration_s: number | null; created_at: string; review: CallCoachingReview | null; file_path: string | null;
};

export async function listSubmissions(workspaceId: number): Promise<SubmissionRow[] | Fail> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.from('call_review_submissions')
    .select('id, user_id, rep_id, call_type, title, source, status, error, score, duration_s, created_at, review, file_path')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100);
  if (error) return { ok: false, error: /call_review_submissions/.test(error.message) ? 'Call review needs migration 149.' : error.message };
  return (data ?? []) as unknown as SubmissionRow[];
}

export type RoleplaySessionRow = {
  id: number; user_id: string; persona: string; difficulty: string; objection: string | null; mode: string; status: string;
  score: number | null; stage_hit_rate: number | null; duration_s: number | null; started_at: string; feedback: unknown;
};

/** Practice history: your own, or (owners and admins, by RLS) the team's. */
export async function roleplayHistory(workspaceId: number, opts: { userId?: string | null; days?: number } = {}): Promise<RoleplaySessionRow[] | Fail> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const since = new Date(Date.now() - (opts.days ?? 90) * 86_400_000).toISOString();
  let q = supabase.from('roleplay_sessions')
    .select('id, user_id, persona, difficulty, objection, mode, status, score, stage_hit_rate, duration_s, started_at, feedback')
    .eq('workspace_id', workspaceId).gte('started_at', since).neq('status', 'active').order('started_at', { ascending: false }).limit(300);
  if (opts.userId) q = q.eq('user_id', opts.userId);
  const { data, error } = await q;
  if (error) return { ok: false, error: /roleplay_sessions/.test(error.message) ? 'Roleplay history needs migration 149.' : error.message };
  return (data ?? []) as RoleplaySessionRow[];
}

export type CoachSettings = { roleplay_phone?: string | null; weekly_email: boolean; weekly_recipients: string[]; weekly_at: string; weekly_tz: string; last_weekly_at: string | null; last_weekly_error: string | null; next_weekly_at: string | null };

export async function loadCoachSettings(workspaceId: number): Promise<CoachSettings | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('sales_coach_settings')
    .select('roleplay_phone, weekly_email, weekly_recipients, weekly_at, weekly_tz, last_weekly_at, last_weekly_error, next_weekly_at').eq('workspace_id', workspaceId).maybeSingle();
  return (data as CoachSettings | null) ?? null;
}

export async function saveCoachSettings(workspaceId: number, patch: Partial<Pick<CoachSettings, 'weekly_email' | 'weekly_recipients'>>): Promise<string | null> {
  if (!supabase) return 'Supabase is not configured.';
  const { error } = await supabase.from('sales_coach_settings')
    .upsert({ workspace_id: workspaceId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
  return error ? error.message : null;
}

