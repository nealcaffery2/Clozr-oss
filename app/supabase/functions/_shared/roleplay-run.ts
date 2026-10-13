// Roleplay, server side: grading a session, and the roleplay phone line.
//
// The line: a rep arms a session in CLOZR (sales-manager roleplay_arm), then
// calls the workspace's roleplay number, which is routed in ElevenLabs to the
// roleplay agent (sales_coach_settings.roleplay_agent_id). That agent carries
// the same initiation and post-call webhooks as the AI Agent, so the calls
// land in voice-agent:
//   /personalize  → roleplayInitiation: the caller's number names the rep
//                   (profiles.phone), their armed session names the persona,
//                   and the answer is that persona's prompt and opener.
//   /post-call    → roleplayPostCall: the transcript is graded and stored on
//                   the session. A practice call is never filed as a
//                   communications row, so it never counts as a real call.

import Anthropic from 'npm:@anthropic-ai/sdk';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { CLAUDE_MODEL, CLAUDE_THINKING, toolRule } from './models.ts';
import { fence, UNTRUSTED_RULE } from './security.ts';
import { firstName } from '../../../lib/call-coaching.ts';
import {
  ARM_TTL_MINUTES, ROLEPLAY_SYSTEM, ROLEPLAY_TOOL, buildRoleplayFeedback, gradable, lineNotice, linesFromElevenLabs, personaById, phoneInitiation,
  pickArmedSession, sellerPrompt, transcriptText, type DifficultyId, type ObjectionId, type RoleplayLine,
} from '../../../lib/roleplay.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const phoneKey = (raw: unknown): string | null => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

function anthropic(apiKey: string): Anthropic {
  const ws = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  return new Anthropic({ apiKey, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
}

/** One grading pass (with one retry on a rejected card), the same scorecard a real call gets plus objection handling and a model answer. */
export async function gradeRoleplay(apiKey: string, lines: RoleplayLine[], repName: string, sellerName: string) {
  const transcript = transcriptText(lines, { rep: repName, seller: sellerName }, true);
  const user = `Rep first name: ${repName}\nProspect first name: ${sellerName}\nTalk split is measured from the lines; do not send prospect_talk.\n\nTranscript:\n${fence('transcript', transcript, 24_000)}`;
  let lastError = 'Feedback was empty.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await anthropic(apiKey).messages.create({
      model: CLAUDE_MODEL, thinking: CLAUDE_THINKING, max_tokens: 4200,
      system: toolRule('roleplay_scorecard') + ROLEPLAY_SYSTEM + UNTRUSTED_RULE,
      tools: [ROLEPLAY_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: attempt === 0 ? user : user + `\n\nYour last scorecard was rejected: ${lastError} Send a clean one.` }],
    });
    const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const built = buildRoleplayFeedback(use?.input, { repName, sellerName, lines });
    if (built.ok) return { ok: true as const, feedback: { ...built.feedback, model: CLAUDE_MODEL, source: 'ondemand' as const, scored_at: new Date().toISOString() } };
    lastError = built.error;
  }
  return { ok: false as const, error: lastError };
}

export async function repFirstName(admin: SupabaseClient, id: string): Promise<string> {
  const { data } = await admin.from('profiles').select('full_name').eq('id', id).maybeSingle();
  return firstName((data as Any)?.full_name, 'Rep') || 'Rep';
}

/**
 * Grade a finished session and store the result. Too short to grade is
 * stored as abandoned; no key or a refused card as failed.
 */
export async function scoreSession(admin: SupabaseClient, s: { id: number; user_id: string; persona: string; conversation_id?: string | null }, lines: RoleplayLine[], extra: Record<string, unknown>) {
  const base = { transcript: lines, ended_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra };
  if (!gradable(lines)) {
    await admin.from('roleplay_sessions').update({ ...base, status: 'abandoned' }).eq('id', s.id);
    return { ok: false as const, error: 'Not enough of a conversation to grade. Talk for a few turns, then finish.' };
  }
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!apiKey) {
    await admin.from('roleplay_sessions').update({ ...base, status: 'failed', feedback: { status: 'not_configured', error: 'ANTHROPIC_API_KEY is not set.' } }).eq('id', s.id);
    return { ok: false as const, error: 'ANTHROPIC_API_KEY is not set on the Supabase project.' };
  }
  const persona = personaById(s.persona);
  const graded = await gradeRoleplay(apiKey, lines, await repFirstName(admin, s.user_id), persona?.name ?? 'Seller');
  if (!graded.ok) {
    await admin.from('roleplay_sessions').update({ ...base, status: 'failed', feedback: { status: 'failed', error: graded.error } }).eq('id', s.id);
    return graded;
  }
  await admin.from('roleplay_sessions').update({
    ...base, status: 'scored', feedback: graded.feedback, score: graded.feedback.overall, stage_hit_rate: graded.feedback.framework?.hit_rate ?? null,
  }).eq('id', s.id);
  return graded;
}

/** The workspace whose roleplay agent this is, or null when the agent is not a roleplay agent (or migration 149 is missing). */
export async function roleplayWorkspaceFor(admin: SupabaseClient, agentId: string | null | undefined): Promise<number | null> {
  if (!agentId) return null;
  try {
    const { data, error } = await admin.from('sales_coach_settings').select('workspace_id').eq('roleplay_agent_id', agentId).limit(1);
    if (error || !data?.length) return null;
    return Number((data[0] as Any).workspace_id);
  } catch {
    return null;
  }
}

/**
 * /personalize for the roleplay line. Never throws: a failed webhook can stop the call from connecting.
 * One line serves every workspace, so the caller's armed session is looked up
 * wherever it was armed, not only in the workspace that owns the line.
 */
export async function roleplayInitiation(admin: SupabaseClient, _lineWs: number, callerId: string | null, conversationId: string | null) {
  try {
    const key = phoneKey(callerId);
    if (!key) return lineNotice('unknown_caller');
    const since = new Date(Date.now() - (ARM_TTL_MINUTES + 5) * 60_000).toISOString();
    const { data: armed } = await admin.from('roleplay_sessions').select('id, workspace_id, user_id, status, mode, started_at, persona, difficulty, objection')
      .eq('status', 'armed').eq('mode', 'phone').gte('started_at', since).order('started_at', { ascending: false }).limit(50);
    const rows = (armed ?? []) as Any[];
    const userIds = [...new Set(rows.map((r) => r.user_id as string))];
    const { data: profiles } = userIds.length ? await admin.from('profiles').select('id, phone').in('id', userIds) : { data: [] };
    const callers = new Set(((profiles ?? []) as Any[]).filter((p) => phoneKey(p.phone) === key).map((p) => p.id as string));
    if (!callers.size) {
      const { data: known } = await admin.from('profiles').select('id, phone').not('phone', 'is', null);
      return lineNotice(((known ?? []) as Any[]).some((p) => phoneKey(p.phone) === key) ? 'not_armed' : 'unknown_caller');
    }
    const s = pickArmedSession(rows.filter((r) => callers.has(r.user_id)));
    const persona = s ? personaById(s.persona) : null;
    if (!s || !persona) return lineNotice('not_armed');
    const { data: w } = await admin.from('workspaces').select('name').eq('id', s.workspace_id).maybeSingle();
    await admin.from('roleplay_sessions').update({
      status: 'active', conversation_id: conversationId, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', s.id);
    return phoneInitiation(
      sellerPrompt({ persona, difficulty: s.difficulty as DifficultyId, objection: s.objection as ObjectionId | null, company: (w as Any)?.name ?? null, voice: true }),
      persona.opener,
    );
  } catch (e) {
    console.error('roleplay initiation', String(e));
    return lineNotice('not_armed');
  }
}

/** /post-call for the roleplay line: grade the session the call belongs to. */
export async function roleplayPostCall(admin: SupabaseClient, _lineWs: number, data: unknown): Promise<void> {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, Any>;
  const conv = typeof d.conversation_id === 'string' ? d.conversation_id : '';
  if (!conv) return;
  // The session may belong to any workspace: the line is shared.
  const { data: row } = await admin.from('roleplay_sessions').select('id, user_id, persona, status, mode, conversation_id')
    .eq('conversation_id', conv).maybeSingle();
  const s = row as Any;
  // Browser sessions are graded by their own Finish; only the phone line is graded here.
  if (!s || s.mode !== 'phone' || s.status === 'scored') return;
  const dur = Number(d.metadata?.call_duration_secs);
  await scoreSession(admin, s, linesFromElevenLabs(d), { duration_s: Number.isFinite(dur) ? Math.round(dur) : null });
}
