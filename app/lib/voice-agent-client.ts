// The AI Agent console's side of the `voice-agent-admin` edge function (contract
// v2): one typed helper per action, behind an `Api` object so /demo can swap in
// an in-memory stand-in (voice-agent-demo.ts) and the screens have one code
// path. Every call resolves to a Result and never throws, so a screen can draw
// the failure instead of guarding each await.

import { invokeFn } from '@/app/components/phone/ui';
import { supabase } from './supabase';
import {
  cleanQuery, interpretReply, normalizeAgents, normalizeCalls, normalizeDetail, normalizeDiff, normalizeEnabled, normalizePreview, normalizePublish, normalizeScenarios,
  normalizeScore, normalizeSettings, normalizeStats, normalizeSummary, normalizeTemplates, normalizeToolInfo, normalizeVersions, normalizeVoices, savePayload,
  type AgentCall, type AgentDetail, type AgentSettings, type AgentSummary, type DiffResult, type PromptPreview, type PublishResult, type RecordKind,
  type Result, type Scenario, type ScoreResult, type StatsResult, type TemplateInfo, type TestSession, type ToolInfo, type Tuning, type VersionRow, type Voice,
} from './voice-agent';

const FN = 'voice-agent-admin';

async function call<T>(body: Record<string, unknown>, pick: (res: Record<string, unknown>) => T): Promise<Result<T>> {
  const { data, error } = await invokeFn<unknown>(FN, body);
  const r = interpretReply(data, error);
  if (!r.ok) return r;
  try { return { ok: true, data: pick(r.data) }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'The reply could not be read.' }; }
}

export type PreviewAudio = { audio_base64: string; mime: string; model: string | null };
export type PreviewOptions = Partial<Tuning> & { tts_model?: string };
/** `as` on "me": which side the tester plays, so a buyer-side agent hears a test cash buyer, not a seller. */
export type TestTarget = { kind: RecordKind; id: number } | { sample: RecordKind | 'me'; as?: RecordKind };
/** A phone test: the agent rang `to` with this session's brief. */
export type PhoneTest = TestSession & { note: string; conversation_id: string | null };
export type SaveDraftResult = { settings: AgentSettings; warnings: string[]; has_unpublished_changes: boolean };
export type VersionsResult = { live_version: number; versions: VersionRow[] };
export type NewAgentInput = { template?: string; role?: string; name?: string; agent_key?: string };
export type CreatedAgent = { agent: AgentSummary; settings: AgentSettings };
export type DiffRef = number | 'live' | 'draft';
/** A failed publish still carries what ElevenLabs said, so the modal draws the checks and the reason. */
export type PublishOutcome = { ok: true; data: PublishResult } | { ok: false; error: string; data: PublishResult | null };

export type Api = {
  demo: boolean;
  listAgents: () => Promise<Result<{ agents: AgentSummary[]; max_agents: number }>>;
  templates: () => Promise<Result<{ templates: TemplateInfo[]; tools: ToolInfo[] }>>;
  getAgent: (key: string, verify?: boolean) => Promise<Result<AgentDetail>>;
  saveDraft: (key: string, settings: AgentSettings) => Promise<Result<SaveDraftResult>>;
  previewPrompt: (key: string, settings?: AgentSettings) => Promise<Result<PromptPreview>>;
  publish: (key: string, note?: string) => Promise<PublishOutcome>;
  rollback: (key: string, version: number, note?: string) => Promise<PublishOutcome>;
  versions: (key: string) => Promise<Result<VersionsResult>>;
  diff: (key: string, from: DiffRef, to: DiffRef) => Promise<Result<DiffResult>>;
  createAgent: (input: NewAgentInput) => Promise<Result<CreatedAgent>>;
  duplicateAgent: (key: string, name?: string) => Promise<Result<CreatedAgent>>;
  deleteAgent: (key: string) => Promise<Result<{ deleted: string; remote_deleted: boolean }>>;
  /** Owners and admins only. A switched-off live agent answers like a do-not-engage number. */
  setEnabled: (key: string, enabled: boolean) => Promise<Result<{ agent_key: string; enabled: boolean }>>;
  voices: (key: string) => Promise<Result<Voice[]>>;
  previewVoice: (key: string, voiceId: string, text: string, opts?: PreviewOptions) => Promise<Result<PreviewAudio>>;
  startTestSession: (key: string, target: TestTarget) => Promise<Result<TestSession>>;
  /** Owners and admins: the published agent rings `phone` with the target's brief. */
  phoneTest: (key: string, target: TestTarget, phone: string) => Promise<Result<PhoneTest>>;
  scenarios: () => Promise<Result<Scenario[]>>;
  scoreCall: (key: string, conversationId: string, scenarioId: string) => Promise<Result<ScoreResult>>;
  calls: (key: string) => Promise<Result<AgentCall[]>>;
  stats: (key?: string, days?: number) => Promise<Result<StatsResult>>;
};

const created = (r: Record<string, unknown>): CreatedAgent => ({ agent: normalizeSummary(r.agent ?? { agent_key: r.agent_key }), settings: normalizeSettings(r.settings) });

/** A publish keeps its `checks`, `manual` and `errors` on a 502 too. */
async function publishCall(body: Record<string, unknown>): Promise<PublishOutcome> {
  const { data, error } = await invokeFn<unknown>(FN, body);
  const r = interpretReply(data, error);
  const b = (data && typeof data === 'object' ? data : null) as Record<string, unknown> | null;
  if (r.ok) return { ok: true, data: normalizePublish(r.data) };
  return { ok: false, error: r.error, data: b && (b.checks || b.manual || b.errors) ? normalizePublish(b) : null };
}

const testBody = (t: TestTarget) => ('sample' in t ? { record_kind: t.sample, sample: true, ...(t.as ? { me_as: t.as } : {}) } : { record_kind: t.kind, record_id: t.id });
const testSession = (r: Record<string, unknown>, key: string, signed: string): TestSession => ({
  signed_url: signed, agent_id: String(r.agent_id ?? ''), agent_key: String(r.agent_key ?? key), live_version: Number(r.live_version) || 0,
  dynamic_variables: (r.dynamic_variables && typeof r.dynamic_variables === 'object' ? r.dynamic_variables : {}) as TestSession['dynamic_variables'],
  first_message: String(r.first_message ?? ''), resolution: typeof r.resolution === 'string' && r.resolution ? r.resolution : null,
});

export function liveApi(workspaceId: number): Api {
  const at = (action: string, key?: string, more: Record<string, unknown> = {}) => ({ action, workspace_id: workspaceId, ...(key ? { agent_key: key } : {}), ...more });
  return {
    demo: false,
    listAgents: () => call(at('list_agents'), (r) => ({ agents: normalizeAgents(r.agents), max_agents: Number(r.max_agents) || 10 })),
    templates: () => call(at('templates'), (r) => ({ templates: normalizeTemplates(r.templates), tools: normalizeToolInfo(r.tools) })),
    getAgent: (key, verify) => call(at('get', key, verify ? { verify: true } : {}), (r) => normalizeDetail(r)),
    saveDraft: (key, settings) => call(at('save_draft', key, { settings: savePayload(settings) }), (r) => ({
      settings: normalizeSettings(r.settings), warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [],
      has_unpublished_changes: r.has_unpublished_changes === true,
    })),
    previewPrompt: (key, settings) => call(at('preview_prompt', key, settings ? { settings: savePayload(settings) } : {}), (r) => normalizePreview(r)),
    publish: (key, note) => publishCall(at('publish', key, note ? { note } : {})),
    rollback: (key, version, note) => publishCall(at('rollback', key, { version, ...(note ? { note } : {}) })),
    versions: (key) => call(at('versions', key), (r) => normalizeVersions(r)),
    diff: (key, from, to) => call(at('diff', key, { from, to }), (r) => normalizeDiff(r)),
    createAgent: (input) => call(at('create_agent', undefined, { ...input }), created),
    duplicateAgent: (key, name) => call(at('duplicate_agent', key, name ? { name } : {}), created),
    deleteAgent: (key) => call(at('delete_agent', key, { confirm: true }), (r) => ({ deleted: String(r.deleted ?? key), remote_deleted: r.remote_deleted === true })),
    setEnabled: (key, enabled) => call(at('set_enabled', key, { enabled }), (r) => normalizeEnabled(r, key)),
    voices: (key) => call(at('voices', key), (r) => normalizeVoices(r.voices)),
    previewVoice: (key, voiceId, text, opts = {}) => call(at('preview', key, { voice_id: voiceId, text, ...opts }), (r): PreviewAudio => {
      const b64 = typeof r.audio_base64 === 'string' ? r.audio_base64 : '';
      if (!b64) throw new Error('No audio came back.');
      return { audio_base64: b64, mime: typeof r.mime === 'string' && r.mime ? r.mime : 'audio/mpeg', model: typeof r.model === 'string' && r.model ? r.model : null };
    }),
    startTestSession: (key, target) => call(
      at('test_session', key, testBody(target)),
      (r): TestSession => {
        const signed = String(r.signed_url ?? '');
        if (!signed) throw new Error('The function did not return a session link.');
        return testSession(r, key, signed);
      },
    ),
    phoneTest: (key, target, phone) => call(at('test_session', key, { ...testBody(target), phone }), (r): PhoneTest => ({
      ...testSession(r, key, ''), note: String(r.note ?? 'Calling now.'), conversation_id: typeof r.conversation_id === 'string' ? r.conversation_id : null,
    })),
    scenarios: () => call(at('scenarios'), (r) => normalizeScenarios(r.scenarios)),
    scoreCall: (key, conversationId, scenarioId) => call(at('score_call', key, { conversation_id: conversationId, scenario_id: scenarioId }), (r) => normalizeScore(r)),
    calls: (key) => call(at('calls', key), (r) => normalizeCalls(r.calls)),
    stats: (key, days) => call(at('stats', key, days ? { days } : {}), (r) => normalizeStats(r)),
  };
}

/** A browser-playable src for the base64 audio the `preview` action returns. */
export const audioSrc = (p: { audio_base64: string; mime: string }) => `data:${p.mime};base64,${p.audio_base64}`;

// ---- Records for the test call's picker -------------------------------------------------------------

export type RecordHit = { kind: RecordKind; id: number; name: string; sub: string };

/** Sellers and buyers in this workspace whose name matches, for the test call's picker. */
export async function searchRecords(workspaceId: number, q: string): Promise<Result<RecordHit[]>> {
  const term = cleanQuery(q);
  if (term.length < 2) return { ok: true, data: [] };
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const like = `%${term}%`;
  const [s, b] = await Promise.all([
    supabase.from('sellers').select('id, name, property_address').eq('workspace_id', workspaceId).is('archived_at', null).ilike('name', like).order('created_at', { ascending: false }).limit(6),
    supabase.from('buyers').select('id, name, company').eq('workspace_id', workspaceId).ilike('name', like).order('name').limit(6),
  ]);
  if (s.error && b.error) return { ok: false, error: s.error.message };
  const hits: RecordHit[] = [
    ...(s.data ?? []).map((r) => ({ kind: 'seller' as const, id: r.id, name: r.name ?? 'Unnamed seller', sub: r.property_address ?? 'Seller' })),
    ...(b.data ?? []).map((r) => ({ kind: 'buyer' as const, id: r.id, name: r.name ?? 'Unnamed buyer', sub: r.company ? `Buyer · ${r.company}` : 'Buyer' })),
  ];
  return { ok: true, data: hits };
}
