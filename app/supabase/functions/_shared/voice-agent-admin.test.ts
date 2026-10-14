// voice-agent-admin's ElevenLabs side: request bodies from v2 settings, the
// transfer/voicemail mapping, the Connect/Publish sequence (fetch mocked, no
// network), model fallback, voices, preview, signed URL, and the admin test's
// use of the same initiation builder /personalize uses.
// Run:  npx tsx supabase/functions/_shared/voice-agent-admin.test.ts
//   or: deno run supabase/functions/_shared/voice-agent-admin.test.ts
import {
  ElevenError, FALLBACK_TTS_MODEL, PREVIEW_MAX_CHARS, SAMPLE_CANDIDATE, SAMPLE_MEMORY, agentBody, callOut, checksFromAgent, deleteRemoteAgent, elJson,
  agentToolIds, asrKeywords, builtWriteTools, generateSecret, ignoreTerms, withModelFallback, getSignedUrl, listVoices, previewSpeech, redact, runConnect, toolBody, transferTool, trimVoice, unappliedSettings, webhookCreateBody, webhookUrls,
  type ConnectState, type Wiring,
} from './voice-agent-admin.ts';
import { buildInitiation, DYNAMIC_VARIABLES, resolveCaller } from './voice-agent.ts';
import { e164, initiationFor, loadAgentFor, loadCandidates, loadTransferTarget, repFreeNow } from './voice-agent-db.ts';
import { agentSwitchedOff } from './voice-agent-calls.ts';
import { defaultSettings, normalizeSettings, type AgentSettings } from './voice-agent-settings.ts';
import { TEMPLATES } from './voice-agent-templates.ts';
import { assemblePrompt } from './voice-agent-prompt.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; } else console.log(`PASS  ${name}`);
}
function ok(name: string, cond: boolean, detail?: unknown) { eq(name, cond ? true : { failed: detail ?? null }, true); }

const D = defaultSettings();
const mk = (patch: Record<string, unknown>, base: AgentSettings = D) => {
  const r = normalizeSettings(patch, base);
  if (r.errors.length) throw new Error(r.errors.join('; '));
  return r.settings;
};
const urls = webhookUrls('https://proj.supabase.co/');
const wiring: Wiring = { toolId: 'tool_1', webhookId: 'wh_1', personalizeUrl: urls.personalize, personalizeSecret: 'P'.repeat(64) };
// deno-lint-ignore no-explicit-any
const body = (s: AgentSettings, w = wiring) => agentBody(s, TEMPLATES, w).body as any;
const XFER = { live_transfer: { enabled: true, destinations: [{ id: 'main', label: 'Sales line', number: '(210) 555-0100' }] } };

// ---- urls, secrets ----
eq('webhook urls', urls, {
  personalize: 'https://proj.supabase.co/functions/v1/voice-agent/personalize',
  tool: 'https://proj.supabase.co/functions/v1/voice-agent/tool/lead-context',
  post_call: 'https://proj.supabase.co/functions/v1/voice-agent/post-call',
});
const s1 = generateSecret(); const s2 = generateSecret();
ok('secrets are 64 hex characters', /^[0-9a-f]{64}$/.test(s1), s1);
ok('secrets differ', s1 !== s2);

// ---- the agent body ----
const b = body(mk({ identity: { name: 'Riley', company: 'Acme' }, voice: { voice_id: 'JBFqnCBsd6RMkjVDRZzb' }, call_handling: { max_call_seconds: 300 } }));
eq('placeholders are exactly the documented dynamic variables', Object.keys(b.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders).sort(), [...DYNAMIC_VARIABLES].sort());
eq('boolean variables are booleans', [typeof b.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.caller_known, b.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.do_not_engage], ['boolean', false]);
eq('agent tts: model, default tuning', b.conversation_config.tts, { voice_id: 'JBFqnCBsd6RMkjVDRZzb', model_id: 'eleven_v4_turbo', stability: 0.5, similarity_boost: 0.8, speed: 1 });
eq('expressive and unset: livelier stability', body(mk({ personality: { expressiveness: 'expressive' } })).conversation_config.tts.stability, 0.3);
eq('tuning reaches the agent', body(mk({ voice: { stability: 0.2, similarity: 0.6, speed: 0.9, tts_model: 'eleven_flash_v2_5' } })).conversation_config.tts, { voice_id: D.voice.voice_id, model_id: 'eleven_flash_v2_5', stability: 0.2, similarity_boost: 0.6, speed: 0.9 });
const TURN = { turn_model: 'turn_v3', speculative_turn: true, retranscribe_on_turn_timeout: true, interruption_ignore_terms: ignoreTerms(3), soft_timeout_config: { timeout_seconds: 3, message: 'Mm, okay…', use_llm_generated_message: true } };
eq('call length, turn eagerness and silence timeout', [b.conversation_config.conversation.max_duration_seconds, b.conversation_config.turn], [300, { turn_eagerness: 'normal', silence_end_call_timeout: 30, ...TURN }]);
eq('silence timeout 0 means off (-1)', body(mk({ call_handling: { silence_timeout_s: 0, turn_eagerness: 'patient' } })).conversation_config.turn, { turn_eagerness: 'patient', silence_end_call_timeout: -1, ...TURN });
eq('balanced interruptions ignore only "uh huh" sounds', ignoreTerms(3), ['uh huh', 'uh-huh', 'mm hmm', 'mm-hmm', 'mhm', 'hmm']);
eq('hard to interrupt also ignores "yeah" and "okay"', ['yeah', 'okay'].every((t) => ignoreTerms(2).includes(t)) && !ignoreTerms(2).includes('wait'), true);
eq('easy to interrupt ignores nothing', [ignoreTerms(4), ignoreTerms(5)], [[], []]);
eq('asr: high quality, primed with the company, the agent, the team and the call words', (() => { const a = body(mk({ identity: { name: 'Jordan', company: 'Acme Homes' } })).conversation_config.asr; return [a.quality, ['Acme Homes', 'Jordan', 'title company', 'earnest money'].every((k) => a.keywords.includes(k))]; })(), ['high', true]);
eq('asr keywords add team first names once, case-insensitively, capped at 50', (() => { const k = asrKeywords(mk({ identity: { name: 'Riley', company: 'Acme Homes' } }), ['Casey', 'casey', 'Morgan', '']); return [k.filter((x) => x.toLowerCase() === 'casey').length, k.includes('Morgan'), k.length <= 50]; })(), [1, true, true]);
eq('a real yes always cuts in', [1, 2, 3].some((s) => ignoreTerms(s).includes('yes') || ignoreTerms(s).includes('sure')), false);
eq('the interruption scale reaches the agent', body(mk({ call_handling: { interruption_sensitivity: 1 } })).conversation_config.turn.interruption_ignore_terms, ignoreTerms(1));
eq('no fillers: the soft timeout says the static line', body(mk({ personality: { use_fillers: false } })).conversation_config.turn.soft_timeout_config.use_llm_generated_message, false);
eq('brain: the chosen LLM, light thinking, default backup', (({ llm, reasoning_effort, backup_llm_config }) => ({ llm, reasoning_effort, backup_llm_config }))(b.conversation_config.agent.prompt), { llm: 'gemini-3.8-flash', reasoning_effort: 'low', backup_llm_config: { preference: 'default' } });
eq('deep thinking is medium effort', body(mk({ voice: { llm: 'claude-sonnet-5-5', thinking: 'deep' } })).conversation_config.agent.prompt.reasoning_effort, 'medium');
eq('auto thinking sends no effort', 'reasoning_effort' in body(mk({ voice: { thinking: 'auto' } })).conversation_config.agent.prompt, false);
eq('name, language, first message', [b.name, b.conversation_config.agent.language, b.conversation_config.agent.first_message], ['Acme Riley', 'en', 'Hi, this is {{agent_name}} with {{company}}. Who am I speaking with?']);
eq('the name falls back to the role', body(mk({ identity: { role: 'acquisitions', company: 'Acme' } })).name, 'Acme acquisitions specialist');
eq('the prompt is assemblePrompt', b.conversation_config.agent.prompt.prompt, assemblePrompt(mk({ identity: { name: 'Riley', company: 'Acme' }, voice: { voice_id: 'JBFqnCBsd6RMkjVDRZzb' }, call_handling: { max_call_seconds: 300 } }), TEMPLATES));
eq('initiation webhook url and header', b.platform_settings.workspace_overrides.conversation_initiation_client_data_webhook, { url: urls.personalize, request_headers: { 'X-Voice-Agent-Secret': 'P'.repeat(64) } });
eq('initiation webhook enabled, first message may be overridden', [b.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook, b.platform_settings.overrides.conversation_config_override.agent.first_message], [true, true]);
eq('post-call webhook with transcripts', b.platform_settings.workspace_overrides.webhooks, { post_call_webhook_id: 'wh_1', events: ['transcript'], transcript_format: 'json' });
eq('the tool is attached', b.conversation_config.agent.prompt.tool_ids, ['tool_1']);
eq('signed urls need auth on', b.platform_settings.auth, { enable_auth: true });
const bare = body(D, { ...wiring, toolId: null, webhookId: null });
eq('no tool id, no tool_ids entries; no webhook id, no post-call block', [bare.conversation_config.agent.prompt.tool_ids, 'webhooks' in bare.platform_settings.workspace_overrides], [[], false]);
eq('lead_context switched off: no tool_ids', body(mk({ tools: { lead_context: { enabled: false } } })).conversation_config.agent.prompt.tool_ids, []);
eq('end_call switched off is sent as null so a PATCH removes it', body(mk({ tools: { end_call: { enabled: false } } })).conversation_config.agent.prompt.built_in_tools.end_call, null);
eq('end_call on', b.conversation_config.agent.prompt.built_in_tools.end_call, { type: 'system', name: 'end_call', params: { system_tool_type: 'end_call' } });
eq('unbuilt tools are never sent to ElevenLabs', Object.keys(b.conversation_config.agent.prompt.built_in_tools).sort(), ['end_call', 'transfer_to_number', 'voicemail_detection']);
const allOn = mk({ tools: { request_agreement: { enabled: true } } });
eq('...even when switched on: the agent config is unchanged', JSON.stringify(body(allOn).conversation_config.agent.prompt.built_in_tools) === JSON.stringify(b.conversation_config.agent.prompt.built_in_tools) && !/request_agreement/.test(JSON.stringify(body(allOn))), true);
// ---- the write tools ----
const WRITE_IDS = { book_appointment: 'tool_book', save_qualification: 'tool_qual', mark_do_not_contact: 'tool_dnc' };
eq('the built write tools ride in tool_ids next to lead_context', body(D, { ...wiring, writeToolIds: WRITE_IDS }).conversation_config.agent.prompt.tool_ids, ['tool_1', 'tool_book', 'tool_qual', 'tool_dnc']);
eq('a write tool switched off is not carried', body(mk({ tools: { book_appointment: { enabled: false }, mark_do_not_contact: { enabled: false } } }), { ...wiring, writeToolIds: WRITE_IDS }).conversation_config.agent.prompt.tool_ids, ['tool_1', 'tool_qual']);
eq('a write tool ElevenLabs has no id for is not carried', body(D, { ...wiring, writeToolIds: { save_qualification: 'tool_qual' } }).conversation_config.agent.prompt.tool_ids, ['tool_1', 'tool_qual']);
eq('agentToolIds agrees with the body', agentToolIds(D, { toolId: null, writeToolIds: WRITE_IDS }), ['tool_book', 'tool_qual', 'tool_dnc']);
eq('builtWriteTools follows TOOL_AVAILABLE', builtWriteTools(), ['book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer']);
ok('no secret in the prompt or anywhere but the webhook header', JSON.stringify(b).split('P'.repeat(64)).length === 2);

// ---- voicemail ----
eq('voicemail: leave a message', b.conversation_config.agent.prompt.built_in_tools.voicemail_detection, { type: 'system', name: 'voicemail_detection', params: { system_tool_type: 'voicemail_detection', voicemail_message: D.call_handling.voicemail.message_template } });
eq('voicemail: hang up sends no message', body(mk({ call_handling: { voicemail: { action: 'hang_up' } } })).conversation_config.agent.prompt.built_in_tools.voicemail_detection, { type: 'system', name: 'voicemail_detection', params: { system_tool_type: 'voicemail_detection' } });
eq('voicemail: detection off is null', body(mk({ call_handling: { voicemail: { detect: false } } })).conversation_config.agent.prompt.built_in_tools.voicemail_detection, null);

// ---- transfer mapping ----
eq('transfer off: no tool, nothing unapplied', transferTool(mk({ live_transfer: { enabled: false, destinations: [] } })), { tool: null, unapplied: [] });
eq('by default a positive call goes to the rep working the lead', transferTool(D).tool?.params.transfers.map((t: any) => t.transfer_destination), [{ type: 'phone_dynamic_variable', phone_number: 'rep_phone' }]); // deno-lint-ignore no-explicit-any
eq('transfer off is null in the body', body(mk({ live_transfer: { enabled: false, destinations: [] } })).conversation_config.agent.prompt.built_in_tools.transfer_to_number, null);
const warm = transferTool(mk(XFER)) as { tool: any; unapplied: unknown[]; timezone?: string }; // deno-lint-ignore no-explicit-any
eq('warm transfer to a fixed number', [warm.tool.name, warm.tool.params.system_tool_type, warm.tool.params.transfers[0].transfer_destination, warm.tool.params.transfers[0].transfer_type, warm.tool.params.enable_client_message], ['transfer_to_number', 'transfer_to_number', { type: 'phone', phone_number: '+12105550100' }, 'conference', true]);
ok('the condition names the triggers and the destination', /Transfer when: the caller asks to speak to a person; the conversation is positive.* Send them to Sales line\./.test(warm.tool.params.transfers[0].condition), warm.tool.params.transfers[0].condition);
eq('warm transfer: nothing unapplied', warm.unapplied, []);
const cold = transferTool(mk({ live_transfer: { ...XFER.live_transfer, mode: 'cold' } })) as { tool: any; unapplied: { setting: string }[] }; // deno-lint-ignore no-explicit-any
eq('cold transfer is SIP REFER and says so', [cold.tool.params.transfers[0].transfer_type, cold.unapplied.map((u) => u.setting)], ['sip_refer', ['live_transfer.mode']]);
const rep = transferTool(mk({ live_transfer: { enabled: true, destinations: [{ label: 'Assigned rep', type: 'rep_assigned' }] } })) as { tool: any; unapplied: unknown[] }; // deno-lint-ignore no-explicit-any
eq('rep-assigned uses the rep_phone dynamic variable', [rep.tool.params.transfers[0].transfer_destination, rep.unapplied], [{ type: 'phone_dynamic_variable', phone_number: 'rep_phone' }, []]);
const hours = transferTool(mk({ live_transfer: { enabled: true, destinations: [{ id: 'main', label: 'Sales line', number: '2105550100', ring_timeout_s: 40, hours: { days: ['mon', 'tue'], start: '09:00', end: '17:00', tz: 'America/Chicago' } }] } })) as { tool: any; unapplied: { setting: string }[]; timezone?: string }; // deno-lint-ignore no-explicit-any
eq('destination hours go in the condition and set the prompt timezone', [/Only between 09:00 and 17:00 America\/Chicago on mon, tue/.test(hours.tool.params.transfers[0].condition), hours.timezone], [true, 'America/Chicago']);
eq('...and ring timeout and hours are reported as not enforced by ElevenLabs', hours.unapplied.map((u) => u.setting), ['live_transfer.destinations.main.ring_timeout_s', 'live_transfer.destinations.main.hours']);
eq('the body carries the prompt timezone', body(mk({ live_transfer: { enabled: true, destinations: [{ number: '2105550100', hours: { days: ['mon'], start: '09:00', end: '17:00', tz: 'America/Chicago' } }] } })).conversation_config.agent.prompt.timezone, 'America/Chicago');
eq('no destination hours: the call hours\' timezone, so the agent knows today', body(mk(XFER)).conversation_config.agent.prompt.timezone, D.call_handling.call_hours.tz);
eq('ring group and whisper are reported', transferTool(mk({ live_transfer: { enabled: true, whisper_message_template: 'Seller on the line', destinations: [{ id: 'rg', label: 'Team', number: '2105550100', type: 'ring_group' }] } })).unapplied.map((u) => u.setting), ['live_transfer.whisper_message_template', 'live_transfer.destinations.rg']);
eq('several destinations become several rules', (transferTool(mk({ live_transfer: { enabled: true, destinations: [{ number: '2105550100', label: 'A' }, { number: '2105550101', label: 'B' }] } })).tool as { params: { transfers: unknown[] } }).params.transfers.length, 2);
eq('transfer switched off in tools: null', body(mk({ ...XFER, tools: { transfer: { enabled: false } } })).conversation_config.agent.prompt.built_in_tools.transfer_to_number, null);
eq('the transfer prompt says the tool exists', /transfer_to_number tool/.test(body(mk(XFER)).conversation_config.agent.prompt.prompt), true);

// ---- unapplied settings ----
eq('defaults leave nothing unapplied', unappliedSettings(D), []);
eq('settings ElevenLabs has no field for', unappliedSettings(mk({ call_handling: { first_response_delay_ms: 500, interruption_sensitivity: 5, retry: { max_attempts: 3, gap_hours: 12 } }, identity: { languages: ['en', 'es'] }, channels: { phone_number_id: 'phnum_abc123' } })).map((u) => u.setting), [
  'call_handling.first_response_delay_ms', 'call_handling.retry', 'identity.languages', 'channels.phone_number_id',
]);
eq('agentBody returns them too', agentBody(mk({ call_handling: { first_response_delay_ms: 500 } }), TEMPLATES, wiring).unapplied.map((u) => u.setting), ['call_handling.first_response_delay_ms']);

// ---- tool and webhook bodies ----
const tb = toolBody(urls.tool, 'T'.repeat(64)) as any; // deno-lint-ignore no-explicit-any
eq('tool is a POST webhook named lead_context with the secret header', [tb.tool_config.type, tb.tool_config.name, tb.tool_config.api_schema.method, tb.tool_config.api_schema.request_headers], ['webhook', 'lead_context', 'POST', { 'X-Voice-Agent-Secret': 'T'.repeat(64) }]);
eq('tool body takes the system variables, including the agent id', Object.fromEntries(['caller_id', 'called_number', 'agent_id'].map((k) => [k, tb.tool_config.api_schema.request_body_schema.properties[k].dynamic_variable])), { caller_id: 'system__caller_id', called_number: 'system__called_number', agent_id: 'system__agent_id' });
eq('tool body binds record_kind, record_id and record_token to our dynamic variables, none required', [
  Object.fromEntries(['record_kind', 'record_id', 'record_token'].map((k) => [k, tb.tool_config.api_schema.request_body_schema.properties[k].dynamic_variable])),
  tb.tool_config.api_schema.request_body_schema.required,
], [{ record_kind: 'record_kind', record_id: 'record_id', record_token: 'record_token' }, ['caller_id', 'called_number']]);
eq('every dynamic variable the tool reads has a placeholder', Object.values(tb.tool_config.api_schema.request_body_schema.properties as Record<string, { dynamic_variable?: string }>).map((p) => p.dynamic_variable).filter((v): v is string => !!v && !v.startsWith('system__')).filter((v) => !(v in b.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders)), []);
eq('tool contact_name is LLM-filled', Object.keys(tb.tool_config.api_schema.request_body_schema.properties.contact_name).sort(), ['description', 'type']);
eq('webhook create body', webhookCreateBody(urls.post_call), { settings: { auth_type: 'hmac', name: 'CLOZR post-call', webhook_url: urls.post_call } });

// ---- ElevenLabs calls (fetch mocked) ----
type Call = { method: string; path: string; body: any; key: string | null }; // deno-lint-ignore no-explicit-any
function mock(handler: (c: Call) => { status?: number; json?: unknown; bytes?: Uint8Array }) {
  const calls: Call[] = [];
  const fetchFn = (async (u: string, init: RequestInit) => {
    const call: Call = { method: String(init.method), path: String(u).replace('https://api.elevenlabs.io', ''), body: init.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init.headers).get('xi-api-key') };
    calls.push(call);
    const r = handler(call);
    const status = r.status ?? 200;
    if (r.bytes) return new Response(r.bytes.buffer as ArrayBuffer, { status });
    return new Response(JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, cfg: { apiKey: 'xi_TESTKEY_123456', fetchFn } };
}
const fresh: ConnectState = { agent_id: null, tool_id: null, webhook_id: null, personalize_secret: 'P'.repeat(64), tool_secret: 'T'.repeat(64), webhook_secret: null };
// Each tool POST answers its own id: lead_context is tool_new, a write tool tool_<name>.
const toolIdFor = (c: Call) => (c.body?.tool_config?.name === 'lead_context' ? 'tool_new' : `tool_${c.body?.tool_config?.name}`);
const happy = mock((c) => {
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { json: { id: toolIdFor(c) } };
  if (c.method === 'POST' && c.path === '/v1/workspace/webhooks') return { json: { webhook_id: 'wh_new', webhook_secret: 'wsec_returned' } };
  if (c.method === 'POST' && c.path === '/v1/convai/agents/create') return { json: { agent_id: 'agent_new' } };
  return { json: { status: 'ok' } };
});
const r1 = await runConnect(happy.cfg, fresh, D, TEMPLATES, urls);
eq('fresh publish call order', happy.calls.map((c) => `${c.method} ${c.path}`), ['POST /v1/convai/tools', 'POST /v1/convai/tools', 'POST /v1/convai/tools', 'POST /v1/convai/tools', 'POST /v1/convai/tools', 'POST /v1/workspace/webhooks', 'PATCH /v1/workspace/webhooks/wh_new', 'POST /v1/convai/agents/create']);
eq('the tools created are lead_context and the four write tools', happy.calls.filter((c) => c.path === '/v1/convai/tools').map((c) => c.body.tool_config.name), ['lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer']);
eq('the write tools post to their own routes with the tool secret', happy.calls.slice(1, 4).map((c) => [c.body.tool_config.api_schema.url, c.body.tool_config.api_schema.request_headers['X-Voice-Agent-Secret'] === 'T'.repeat(64)]), [
  ['https://proj.supabase.co/functions/v1/voice-agent/tool/book-appointment', true],
  ['https://proj.supabase.co/functions/v1/voice-agent/tool/save-qualification', true],
  ['https://proj.supabase.co/functions/v1/voice-agent/tool/mark-do-not-contact', true],
]);
eq('the write tools carry the conversation id and the caller', Object.fromEntries(['caller_id', 'called_number', 'agent_id', 'conversation_id'].map((k) => [k, happy.calls[1].body.tool_config.api_schema.request_body_schema.properties[k].dynamic_variable])), { caller_id: 'system__caller_id', called_number: 'system__called_number', agent_id: 'system__agent_id', conversation_id: 'system__conversation_id' });
ok('every LLM-filled write tool property has exactly one value source', happy.calls.slice(1, 4).every((c) => Object.values(c.body.tool_config.api_schema.request_body_schema.properties as Record<string, Record<string, unknown>>).every((p) => ['description', 'dynamic_variable', 'constant_value'].filter((k) => k in p).length === 1)));
eq('the API key rides on every call', happy.calls.every((c) => c.key === 'xi_TESTKEY_123456'), true);
eq('fresh publish state', [r1.state.agent_id, r1.state.tool_id, r1.state.webhook_id, r1.state.webhook_secret, r1.state.write_tool_ids], ['agent_new', 'tool_new', 'wh_new', 'wsec_returned', { book_appointment: 'tool_book_appointment', save_qualification: 'tool_save_qualification', mark_do_not_contact: 'tool_mark_do_not_contact', get_compr_offer: 'tool_get_compr_offer' }]);
eq('fresh publish checks, errors, connected, model', [r1.checks, r1.errors, r1.connected, r1.tts_model_used], [{ api_key: true, agent: true, personalize_webhook: true, tool: true, post_call_webhook: true, write_tools: true }, [], true, 'eleven_v4_turbo']);
eq('retries are switched on', happy.calls[6].body, { is_disabled: false, name: 'CLOZR post-call', retry_enabled: true });
eq('the agent create points at the new tools and webhook, and is tagged', [happy.calls[7].body.conversation_config.agent.prompt.tool_ids, happy.calls[7].body.platform_settings.workspace_overrides.webhooks.post_call_webhook_id, happy.calls[7].body.tags], [['tool_new', 'tool_book_appointment', 'tool_save_qualification', 'tool_mark_do_not_contact'], 'wh_new', ['clozr']]);

const again = mock(() => ({ json: { status: 'ok' } }));
const r2 = await runConnect(again.cfg, r1.state, D, TEMPLATES, urls);
eq('republish updates in place: no POST at all', again.calls.map((c) => `${c.method} ${c.path}`), ['PATCH /v1/convai/tools/tool_new', 'PATCH /v1/convai/tools/tool_book_appointment', 'PATCH /v1/convai/tools/tool_save_qualification', 'PATCH /v1/convai/tools/tool_mark_do_not_contact', 'PATCH /v1/convai/tools/tool_get_compr_offer', 'PATCH /v1/workspace/webhooks/wh_new', 'PATCH /v1/convai/agents/agent_new']);
eq('republish keeps every id and the same secrets', [r2.state, r2.checks.agent], [r1.state, true]);

// A second agent in the workspace reuses the shared tool and webhook and gets its own ElevenLabs agent.
const second = mock((c) => (c.path === '/v1/convai/agents/create' ? { json: { agent_id: 'agent_two' } } : { json: { status: 'ok' } }));
const r2b = await runConnect(second.cfg, { ...r1.state, agent_id: null }, mk({ identity: { name: 'Second' } }), TEMPLATES, urls);
eq('a second agent: tools and webhook updated in place, its own agent created', [second.calls.map((c) => `${c.method} ${c.path}`), r2b.state.agent_id, r2b.state.tool_id, r2b.state.webhook_id], [['PATCH /v1/convai/tools/tool_new', 'PATCH /v1/convai/tools/tool_book_appointment', 'PATCH /v1/convai/tools/tool_save_qualification', 'PATCH /v1/convai/tools/tool_mark_do_not_contact', 'PATCH /v1/convai/tools/tool_get_compr_offer', 'PATCH /v1/workspace/webhooks/wh_new', 'POST /v1/convai/agents/create'], 'agent_two', 'tool_new', 'wh_new']);
const writeGone = mock((c) => {
  if (c.method === 'PATCH' && c.path === '/v1/convai/tools/tool_book_appointment') return { status: 404, json: { detail: 'not found' } };
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { json: { id: 'tool_book_2' } };
  return { json: { status: 'ok' } };
});
const r2c = await runConnect(writeGone.cfg, r1.state, D, TEMPLATES, urls);
eq('a write tool ElevenLabs lost is created again and the agent carries the new id', [r2c.state.write_tool_ids?.book_appointment, writeGone.calls[writeGone.calls.length - 1].body.conversation_config.agent.prompt.tool_ids.includes('tool_book_2')], ['tool_book_2', true]);
const writeDown = mock((c) => {
  if (c.method === 'POST' && c.path === '/v1/convai/tools' && c.body.tool_config.name === 'save_qualification') return { status: 500, json: { detail: 'boom' } };
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { json: { id: toolIdFor(c) } };
  if (c.method === 'POST' && c.path === '/v1/workspace/webhooks') return { json: { webhook_id: 'wh_w', webhook_secret: 'wsec_w' } };
  if (c.path === '/v1/convai/agents/create') return { json: { agent_id: 'agent_w' } };
  return { json: {} };
});
const r2d = await runConnect(writeDown.cfg, fresh, D, TEMPLATES, urls);
eq('one write tool failing: the agent still goes up without it, the step is named', [r2d.connected, r2d.checks.write_tools, r2d.errors.map((e) => e.step), writeDown.calls[writeDown.calls.length - 1].body.conversation_config.agent.prompt.tool_ids], [true, false, ['tool:save_qualification'], ['tool_new', 'tool_book_appointment', 'tool_mark_do_not_contact']]);

const gone = mock((c) => {
  if (c.method === 'PATCH' && c.path === '/v1/convai/agents/agent_new') return { status: 404, json: { detail: { message: 'not found' } } };
  if (c.method === 'POST' && c.path === '/v1/convai/agents/create') return { json: { agent_id: 'agent_2' } };
  return { json: { status: 'ok' } };
});
const r3 = await runConnect(gone.cfg, r1.state, D, TEMPLATES, urls);
eq('an agent ElevenLabs no longer has is created again', [r3.state.agent_id, r3.connected], ['agent_2', true]);

const lost = mock((c) => (c.method === 'POST' && c.path === '/v1/workspace/webhooks' ? { json: { webhook_id: 'wh_2', webhook_secret: 'wsec_2' } } : { json: { status: 'ok' } }));
const r4 = await runConnect(lost.cfg, { ...r1.state, webhook_secret: null }, D, TEMPLATES, urls);
eq('a webhook whose secret was never stored is deleted and recreated', lost.calls.filter((c) => c.path.startsWith('/v1/workspace/webhooks')).map((c) => `${c.method} ${c.path}`), ['DELETE /v1/workspace/webhooks/wh_new', 'POST /v1/workspace/webhooks', 'PATCH /v1/workspace/webhooks/wh_2']);
eq('...and the new secret is kept', r4.state.webhook_secret, 'wsec_2');

const noSecret = mock((c) => {
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { json: { id: 'tool_x' } };
  if (c.method === 'POST' && c.path === '/v1/workspace/webhooks') return { json: { webhook_id: 'wh_x', webhook_secret: null } };
  if (c.method === 'POST' && c.path === '/v1/convai/agents/create') return { json: { agent_id: 'agent_x' } };
  return { json: { status: 'ok' } };
});
const r5 = await runConnect(noSecret.cfg, fresh, D, TEMPLATES, urls);
eq('no signing secret back: post-call check false, agent up', [r5.checks.post_call_webhook, r5.checks.agent, r5.connected, r5.errors.map((e) => e.step)], [false, true, true, ['post_call_webhook']]);
eq('...and the agent is not pointed at a webhook it cannot verify', 'webhooks' in noSecret.calls[noSecret.calls.length - 1].body.platform_settings.workspace_overrides, false);

const broken = mock((c) => {
  if (c.path === '/v1/convai/agents/create') return { status: 422, json: { detail: [{ msg: `bad body ${'P'.repeat(64)} xi_TESTKEY_123456` }] } };
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { json: { id: 'tool_y' } };
  if (c.method === 'POST' && c.path === '/v1/workspace/webhooks') return { json: { webhook_id: 'wh_y', webhook_secret: 'wsec_y' } };
  return { json: { status: 'ok' } };
});
const r6 = await runConnect(broken.cfg, fresh, D, TEMPLATES, urls);
eq('agent failure: not connected, dependent checks false', [r6.connected, r6.checks], [false, { api_key: true, agent: false, personalize_webhook: false, tool: false, post_call_webhook: false, write_tools: false }]);
ok('error messages never carry a secret or the api key', !JSON.stringify(r6.errors).includes('P'.repeat(64)) && !JSON.stringify(r6.errors).includes('xi_TESTKEY_123456'), r6.errors);
eq('the failing step is named and the tool and webhook still got created', [r6.errors.map((e) => e.step), r6.state.tool_id, r6.state.webhook_id], [['agent'], 'tool_y', 'wh_y']);

const toolDown = mock((c) => {
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { status: 500, json: { detail: 'boom' } };
  if (c.method === 'POST' && c.path === '/v1/workspace/webhooks') return { json: { webhook_id: 'wh_z', webhook_secret: 'wsec_z' } };
  if (c.path === '/v1/convai/agents/create') return { json: { agent_id: 'agent_z' } };
  return { json: {} };
});
const r7 = await runConnect(toolDown.cfg, fresh, D, TEMPLATES, urls);
eq('a failed tool does not stop the agent; the tool check is false', [r7.connected, r7.checks.tool, r7.checks.post_call_webhook], [true, false, true]);
eq('...and the agent has no tool_ids', toolDown.calls[toolDown.calls.length - 1].body.conversation_config.agent.prompt.tool_ids, []);
eq('lead_context off: the tool check is false even when the tool exists', (await runConnect(mock((c) => (c.path === '/v1/convai/agents/create' ? { json: { agent_id: 'a' } } : { json: { id: 't', webhook_id: 'w', webhook_secret: 's_ecret12' } })).cfg, fresh, mk({ tools: { lead_context: { enabled: false } } }), TEMPLATES, urls)).checks.tool, false);

const withUnapplied = await runConnect(happy.cfg, fresh, mk({ ...XFER, live_transfer: { ...XFER.live_transfer, mode: 'cold' }, call_handling: { first_response_delay_ms: 400 } }), TEMPLATES, urls);
eq('publish returns what ElevenLabs could not express', withUnapplied.unapplied.map((u) => u.setting), ['live_transfer.mode', 'call_handling.first_response_delay_ms']);

// ---- model fallback ----
const modelReject = mock((c) => {
  if (c.body?.conversation_config?.tts?.model_id === 'eleven_v4_turbo') return { status: 422, json: { detail: [{ loc: ['body', 'conversation_config', 'tts', 'model_id'], msg: "Input should be 'eleven_turbo_v2'..." }] } };
  if (c.method === 'POST' && c.path === '/v1/convai/tools') return { json: { id: 'tool_m' } };
  if (c.method === 'POST' && c.path === '/v1/workspace/webhooks') return { json: { webhook_id: 'wh_m', webhook_secret: 'wsec_m' } };
  if (c.path === '/v1/convai/agents/create') return { json: { agent_id: 'agent_m' } };
  return { json: {} };
});
const rm = await runConnect(modelReject.cfg, fresh, D, TEMPLATES, urls);
eq('publish falls back when the agents API rejects v4 Turbo', [rm.connected, rm.tts_model_used, rm.errors.map((e) => e.step)], [true, FALLBACK_TTS_MODEL, ['tts_model']]);
eq('...having sent v4 Turbo first, then flash', modelReject.calls.filter((c) => c.path === '/v1/convai/agents/create').map((c) => c.body.conversation_config.tts.model_id), ['eleven_v4_turbo', 'eleven_flash_v2_5']);
const flashReject = mock(() => ({ status: 422, json: { detail: [{ loc: ['body', 'conversation_config', 'tts', 'model_id'], msg: 'bad' }] } }));
const rf = await runConnect(flashReject.cfg, fresh, mk({ voice: { tts_model: 'eleven_flash_v2_5' } }), TEMPLATES, urls);
eq('the fallback model itself is not retried', [rf.connected, flashReject.calls.filter((c) => c.path === '/v1/convai/agents/create').length], [false, 1]);
const otherReject = mock((c) => (c.path === '/v1/convai/agents/create' ? { status: 422, json: { detail: [{ loc: ['body', 'name'], msg: 'too long' }] } } : { json: { id: 't', webhook_id: 'w', webhook_secret: 'abcdefgh' } }));
const ro = await runConnect(otherReject.cfg, fresh, D, TEMPLATES, urls);
eq('an unrelated 422 is not retried on another model', [ro.connected, otherReject.calls.filter((c) => c.path === '/v1/convai/agents/create').length], [false, 1]);

// ---- delete ----
const del = mock(() => ({ json: {} }));
await deleteRemoteAgent(del.cfg, 'agent 1');
eq('delete agent request', [del.calls[0].method, del.calls[0].path], ['DELETE', '/v1/convai/agents/agent%201']);
const del404 = mock(() => ({ status: 404, json: { detail: 'not found' } }));
await deleteRemoteAgent(del404.cfg, 'agent_1');
eq('a 404 on delete counts as gone', del404.calls.length, 1);
const del500 = mock(() => ({ status: 500, json: { detail: 'boom' } }));
try { await deleteRemoteAgent(del500.cfg, 'agent_1'); eq('500 throws', 'no throw', 'throw'); } catch (e) { eq('any other delete failure is thrown', e instanceof ElevenError, true); }

// ---- other ElevenLabs reads ----
const badKey = mock(() => ({ status: 401, json: { detail: { status: 'invalid_api_key', message: 'Invalid API key xi_TESTKEY_123456' } } }));
try { await elJson(badKey.cfg, 'GET', '/v1/x'); eq('a 401 throws', 'no throw', 'throw'); } catch (e) {
  eq('a 401 is an ElevenError with the key redacted', [e instanceof ElevenError, (e as ElevenError).status, (e as Error).message], [true, 401, 'Invalid API key ***']);
}
eq('redact ignores short values', redact('abc abc', ['abc']), 'abc abc');

const v = mock(() => ({ json: { voices: [
  { voice_id: 'v1', name: 'Rachel', category: 'premade', labels: { accent: 'american', n: 3 }, preview_url: 'https://x/p.mp3', samples: [{ big: 1 }], settings: { a: 1 }, description: 'long' },
  { name: 'no id' }, null,
] } }));
eq('voices are trimmed to the contract and ids are required', await listVoices(v.cfg, 'rach'), [{ voice_id: 'v1', name: 'Rachel', category: 'premade', labels: { accent: 'american' }, preview_url: 'https://x/p.mp3' }]);
eq('voices request', v.calls[0].path, '/v2/voices?page_size=100&include_total_count=false&search=rach');
eq('trimVoice of junk', trimVoice(7), null);

const tts = mock(() => ({ bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00]) }));
eq('preview returns base64 mp3 and the model that spoke', await previewSpeech(tts.cfg, 'JBFqnCBsd6RMkjVDRZzb', 'Hello there', D.voice), { audio_base64: '//uQAA==', mime: 'audio/mpeg', model: 'eleven_v4_turbo' });
eq('preview uses the agent model and default tuning', [tts.calls[0].method, tts.calls[0].path, tts.calls[0].body], ['POST', '/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_64', { text: 'Hello there', model_id: 'eleven_v4_turbo', voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1 } }]);
const tts2 = mock(() => ({ bytes: new Uint8Array([1]) }));
await previewSpeech(tts2.cfg, 'JBFqnCBsd6RMkjVDRZzb', 'Hi', { tts_model: 'eleven_multilingual_v2', stability: 0.3, similarity: 0.9, speed: 1.1 });
eq('preview uses a chosen model and tuning', [tts2.calls[0].body.model_id, tts2.calls[0].body.voice_settings], ['eleven_multilingual_v2', { stability: 0.3, similarity_boost: 0.9, speed: 1.1 }]);
const ttsV3 = mock(() => ({ bytes: new Uint8Array([1]) }));
const pvV3 = await previewSpeech(ttsV3.cfg, 'JBFqnCBsd6RMkjVDRZzb', '[laughs] Hi', { ...D.voice, tts_model: 'eleven_v3_conversational' });
eq('a v3 Conversational preview speaks with eleven_v3', [ttsV3.calls[0].body.model_id, pvV3.model], ['eleven_v3', 'eleven_v3_conversational']);
const tts3 = mock((c) => (c.body.model_id === 'eleven_v4_turbo' ? { status: 422, json: { detail: [{ loc: ['body', 'model_id'], msg: 'unsupported model' }] } } : { bytes: new Uint8Array([1]) }));
const pv3 = await previewSpeech(tts3.cfg, 'JBFqnCBsd6RMkjVDRZzb', 'Hi', D.voice);
eq('a rejected v4 Turbo preview retries on flash and says so', [tts3.calls.map((c) => c.body.model_id), pv3.model], [['eleven_v4_turbo', FALLBACK_TTS_MODEL], FALLBACK_TTS_MODEL]);
const tts4 = mock(() => ({ status: 429, json: { detail: 'quota' } }));
try { await previewSpeech(tts4.cfg, 'JBFqnCBsd6RMkjVDRZzb', 'Hi', D.voice); eq('429 throws', 'no throw', 'throw'); } catch { eq('a quota error is not retried', tts4.calls.length, 1); }
eq('preview text cap is 300', PREVIEW_MAX_CHARS, 300);

const su = mock(() => ({ json: { signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s' } }));
eq('signed url', await getSignedUrl(su.cfg, 'agent 1'), 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s');
eq('signed url request', su.calls[0].path, '/v1/convai/conversation/get-signed-url?agent_id=agent%201');

// ---- live check ----
const liveAgent = {
  conversation_config: { agent: { prompt: { tool_ids: ['tool_1'] } } },
  platform_settings: { overrides: { enable_conversation_initiation_client_data_from_webhook: true }, workspace_overrides: { conversation_initiation_client_data_webhook: { url: urls.personalize }, webhooks: { post_call_webhook_id: 'wh_1' } } },
};
eq('live checks all true', checksFromAgent(liveAgent, { personalizeUrl: urls.personalize, toolId: 'tool_1', webhookId: 'wh_1' }), { personalize_webhook: true, tool: true, post_call_webhook: true });
eq('live checks catch drift', checksFromAgent({ ...liveAgent, conversation_config: { agent: { prompt: {} } } }, { personalizeUrl: 'https://other', toolId: 'tool_1', webhookId: 'wh_2' }), { personalize_webhook: false, tool: false, post_call_webhook: false });
eq('live checks on junk', checksFromAgent(null, { personalizeUrl: urls.personalize, toolId: null, webhookId: null }), { personalize_webhook: false, tool: false, post_call_webhook: false });

// ---- calls ----
const long = 'Rep: hi\n' + 'x'.repeat(2000);
const co = callOut({ id: 3, occurred_at: '2026-09-29T10:00:00Z', direction: 'inbound', duration_s: 42, status: 'completed', from_phone: '+15125550199', to_phone: '+12105550100', seller_id: 5, buyer_id: null, summary: 'Asked for the offer.', transcript: long, source_id: 'el:conv_123' });
eq('call preview is cut and marked', [co.transcript_preview!.length, co.transcript_preview!.endsWith('...')], [603, true]);
eq('call names its record and conversation', [co.record_kind, co.record_id, co.summary, co.conversation_id], ['seller', 5, 'Asked for the offer.', 'conv_123']);
eq('a call with no transcript or source', [callOut({ id: 4, occurred_at: 'x', buyer_id: 8 }).transcript_preview, callOut({ id: 4, occurred_at: 'x', buyer_id: 8 }).conversation_id, callOut({ id: 4, occurred_at: 'x', buyer_id: 8 }).record_kind, callOut({ id: 4, occurred_at: 'x' }).record_kind], [null, null, 'buyer', null]);

// ---- test session uses the /personalize builder ----
const legIn = { direction: 'inbound' as const, ours: '', theirs: '5125550199' };
const persona = { agentName: 'Riley', company: 'Acme' };
const sample = buildInitiation(resolveCaller([SAMPLE_CANDIDATE]), legIn, SAMPLE_MEMORY, { ...persona, repName: 'Alex' });
eq('sample seller: known, with every documented variable', [sample.dynamic_variables.caller_known, sample.dynamic_variables.do_not_engage, Object.keys(sample.dynamic_variables).sort()], [true, false, [...DYNAMIC_VARIABLES].sort()]);
eq('sample seller opener names them', sample.conversation_config_override.agent.first_message, 'Hey Jamie, thanks for calling back, this is Riley with Acme.');

type Rows = Record<string, any[]>; // deno-lint-ignore no-explicit-any
/** Just enough of the supabase-js chain for the reads voice-agent-db makes. */
function fakeAdmin(tables: Rows) {
  return {
    from(name: string) {
      const rows = tables[name] ?? [];
      const q: any = { // deno-lint-ignore no-explicit-any
        select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, is: () => q, not: () => q, lte: () => q, gte: () => q,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
      };
      return q;
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}
const memoryRow = { workspace_id: 1, record_kind: 'seller', record_id: 11, brief: 'Ann wants a written offer.', facts: { first_name: 'Ann', next_step: 'Send the offer.', property_address: '12 Oak St', asking_price: 210000 }, source_count: 1, updated_at: 'x' };
const tables: Rows = {
  sellers: [{ id: 11, name: 'Ann Smith', tags: [], archived_at: null, assigned_to: 'u1', property_address: '12 Oak St', phone: '5125550199', phone_key: '5125550199', lead_source: 'Website form' }],
  buyers: [], buyer_phones: [], lead_memory: [memoryRow], profiles: [{ full_name: 'Alex Rep', phone: '(512) 555-0100' }], deals: [{ mao: 200000 }],
};
const admin = fakeAdmin(tables);
const cands = await loadCandidates(admin, 1, '5125550199');
eq('loadCandidates reads the seller on the number', cands.map((c) => [c.kind, c.id]), [['seller', 11]]);
const viaDb = await initiationFor(admin, 1, resolveCaller(cands), legIn, persona);
const direct = buildInitiation(resolveCaller(cands), legIn, { brief: 'Ann wants a written offer.', facts: { first_name: 'Ann', preferred_name: null, property_address: '12 Oak St', last_contact_summary: null, next_step: 'Send the offer.' } }, { ...persona, repName: 'Alex' }, {
  rep_phone: '+15125550100', lead_source: 'form', property_facts: '', mortgage_payoff_estimate: '', offer_low: '', offer_high: '', seller_asking_price: '$210,000', call_goal: '', rep_available: 'yes',
});
eq('initiationFor is buildInitiation over the stored memory, rep, source and asking price', viaDb.dynamic_variables, direct.dynamic_variables);
eq('...with the brief, rep and rep phone in it', [viaDb.dynamic_variables.lead_brief, viaDb.dynamic_variables.rep_name, viaDb.dynamic_variables.rep_phone, viaDb.dynamic_variables.caller_known], ['Ann wants a written offer.', 'Alex', '+15125550100', true]);
{
  const now = Date.parse('2026-10-13T15:00:00Z');
  // The overlap is filtered in the database: record the query, answer with what the database would.
  const seen: string[] = [];
  const recorder = (rows: unknown[]) => ({
    from: () => {
      const q: any = {}; // deno-lint-ignore no-explicit-any
      for (const m of ['select', 'eq', 'is', 'lte', 'gte', 'or', 'limit']) q[m] = (...a: unknown[]) => { seen.push(`${m}(${a.join(',')})`); return q; };
      q.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
      return q;
    },
  }) as any; // deno-lint-ignore no-explicit-any
  eq('rep with nothing overlapping is free', await repFreeNow(recorder([]), 1, 'u1', now), true);
  eq('rep with an overlapping appointment is tied up', await repFreeNow(recorder([{ id: 1 }]), 1, 'u1', now), false);
  const q = seen.join(' ');
  eq('the window: starting before 10 minutes ahead, ending after 5 minutes ago (open-ended ones as 30 minutes), however early it started',
    [q.includes(`lte(starts_at,${new Date(now + 600_000).toISOString()})`), q.includes(`ends_at.gt."${new Date(now - 300_000).toISOString()}"`), q.includes(`and(ends_at.is.null,starts_at.gt."${new Date(now - 2_100_000).toISOString()}")`), /gte\(starts_at/.test(q)],
    [true, true, true, false]);
  const started = fakeAdmin({ ...tables, ai_agent_enrollments: [{ record_id: 11, started_by: 'u9', started_at: 'x' }] });
  eq('the rep who switched the AI agent on works the call, before the assigned rep', (await loadCandidates(started, 1, '5125550199')).map((c) => c.assigned_to), ['u9']);
}
eq('no agent: no offer range', [viaDb.dynamic_variables.offer_low, viaDb.dynamic_variables.offer_high], ['', '']);
const withGoal = await initiationFor(admin, 1, resolveCaller(cands), { ...legIn, direction: 'outbound' }, persona, null, '  Follow up on the offer\n we sent Friday. ');
eq('a call the AI agent placed carries its goal, cleaned, after the first-call note', withGoal.dynamic_variables.call_goal, 'FIRST CALL: they have never talked with us. Follow up on the offer we sent Friday.');
eq('...and every other call an empty one', viaDb.dynamic_variables.call_goal, '');
const acq = mk({ offer_authority: { mode: 'range_with_approval', floor_pct_of_mao: 85 } });
const withOffer = await initiationFor(admin, 1, resolveCaller(cands), legIn, persona, acq);
eq('an agent with offer authority gets the range from the deal MAO', [withOffer.dynamic_variables.offer_low, withOffer.dynamic_variables.offer_high, withOffer.dynamic_variables.seller_asking_price], ['$170,000', '$200,000', '$210,000']);
const noOffer = await initiationFor(admin, 1, resolveCaller(cands), legIn, persona, mk({ offer_authority: { mode: 'none' } }));
eq('an agent without offer authority gets none', [noOffer.dynamic_variables.offer_low, noOffer.dynamic_variables.offer_high], ['', '']);
const noMao = await initiationFor(fakeAdmin({ ...tables, deals: [] }), 1, resolveCaller(cands), legIn, persona, acq);
eq('no MAO on file: no range', [noMao.dynamic_variables.offer_low, noMao.dynamic_variables.offer_high], ['', '']);
const virtual = await initiationFor(admin, 1, resolveCaller(cands), legIn, { ...persona, introduceAs: 'virtual_assistant', recordingNotice: 'This call may be recorded.' }, acq);
eq('the opener says virtual assistant and carries the recording notice', virtual.conversation_config_override.agent.first_message, 'Hey Ann, thanks for calling back, this is Riley, a virtual assistant with Acme. This call may be recorded.');

const dncAdmin = fakeAdmin({ ...tables, sellers: [{ ...tables.sellers[0], tags: ['DNC'] }] });
const dnc = await initiationFor(dncAdmin, 1, resolveCaller(await loadCandidates(dncAdmin, 1, '5125550199')), legIn, persona, acq);
eq('a DNC record tests as do_not_engage with nothing about them, not even the range', [dnc.dynamic_variables.do_not_engage, dnc.dynamic_variables.caller_known, dnc.dynamic_variables.lead_brief, dnc.dynamic_variables.first_name, dnc.dynamic_variables.offer_low, dnc.dynamic_variables.seller_asking_price, dnc.dynamic_variables.rep_phone], [true, false, '', '', '', '', '']);
ok('...and a neutral opener', !/Ann/.test(dnc.conversation_config_override.agent.first_message), dnc.conversation_config_override.agent.first_message);

// The templates go through agentBody without a hitch.
for (const id of Object.keys(TEMPLATES)) {
  const t = TEMPLATES[id];
  const s = mk({ ...t.settings, script: { ...(t.settings.script as object), sections: t.sections } });
  ok(`template ${id}: a complete agent body`, typeof body(s).conversation_config.agent.prompt.prompt === 'string' && body(s).conversation_config.agent.prompt.prompt.length > 3000);
}

// ---- a switched-off agent: what /personalize and /tool/lead-context build from ----
{
  const row = (enabled: unknown) => ({ workspace_id: 1, agent_key: 'acq', agent_id: 'ag_1', status: 'live', enabled, live_version: 2, live_settings: mk({}) });
  const fake = (r: unknown) => ({ from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [r], error: null }), }), }), }), }) as never;
  const off = await loadAgentFor(fake(row(false)), 'ag_1', 1);
  const on = await loadAgentFor(fake(row(true)), 'ag_1', 1);
  eq('loadAgentFor carries the enabled flag', [off?.enabled, on?.enabled], [false, true]);
  eq('a disabled live agent is switched off, an enabled one is not', [agentSwitchedOff(off), agentSwitchedOff(on)], [true, false]);
  // /personalize forces the do-not-engage resolution for it, whoever is calling.
  const init = await initiationFor({} as never, 1, { status: 'blocked', matches: [] }, { direction: 'inbound', ours: '2105550100', theirs: '5125550199' }, { agentName: 'Riley', company: 'Acme' }, off?.live_settings ?? null);
  const v = init.dynamic_variables as Record<string, unknown>;
  ok('disabled agent: do_not_engage is true and no lead data or price reaches the prompt', v.do_not_engage === true && v.first_name === '' && v.property_address === '' && v.lead_brief === '' && v.offer_low === '' && v.offer_high === '' && v.seller_asking_price === '');
  ok('disabled agent: the greeting is neutral', init.conversation_config_override.agent.first_message === 'Thanks for calling Acme. How can I help you today?');
  ok('the prompt tells the agent to end the call on do_not_engage', /If \{\{do_not_engage\}\} is true: do not discuss any property, price or offer/.test(assemblePrompt(mk({}), TEMPLATES)));
}

// ---- who a warm transfer rings ----
{
  eq('e164', [e164('(512) 555-0100'), e164('1 512 555 0100'), e164('+15125550100'), e164('555-0100'), e164(null)], ['+15125550100', '+15125550100', '+15125550100', null, null]);
  // profiles by id, rep_phone_numbers by user, workspaces' owner: each query resolves from these.
  const db = (profiles: Record<string, string | null>, lines: Record<string, { phone_e164: string; label: string }[]>, owner = 'own') => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => { f[k] = v; return chain; },
        maybeSingle: () => Promise.resolve({ data: table === 'workspaces' ? { owner_id: owner } : { full_name: 'X Y', phone: profiles[String(f.id)] ?? null }, error: null }),
        limit: () => Promise.resolve({ data: lines[String(f.user_id)] ?? [], error: null }),
      };
      return chain;
    },
  }) as never;
  const lines = { rep: [{ phone_e164: '+18645550111', label: 'smrtPhone test' }, { phone_e164: '+18645550100', label: 'Chris Main' }], own: [{ phone_e164: '+18645550199', label: 'Sam Main' }] };
  eq('the rep\'s profile phone wins', await loadTransferTarget(db({ rep: '512-555-0100' }, lines), 11, 'rep'), { userId: 'rep', phone: '+15125550100' });
  eq('no profile phone: the rep\'s main line', await loadTransferTarget(db({}, lines), 11, 'rep'), { userId: 'rep', phone: '+18645550100' });
  eq('no rep: the owner', await loadTransferTarget(db({ own: '5125550199' }, lines), 11, null), { userId: 'own', phone: '+15125550199' });
  eq('a rep with no number: the owner\'s line', await loadTransferTarget(db({}, { own: lines.own }), 11, 'rep'), { userId: 'own', phone: '+18645550199' });
  eq('nobody has a number', await loadTransferTarget(db({}, {}), 11, 'rep'), null);
}

// ---- the brain: a model that refuses a reasoning effort is published on Thinking auto ----
{
  const seen: string[] = [];
  const r = await withModelFallback(mk({ voice: { llm: 'claude-haiku-4-5', thinking: 'deep' } }), async (cur) => {
    seen.push(`${cur.voice.tts_model}/${cur.voice.thinking}`);
    if (cur.voice.thinking !== 'auto') throw new ElevenError(422, 'reasoning_effort is not supported for this model');
    return 'ok';
  });
  eq('reasoning refused: retried once on auto, same voice model', [seen, r.value, r.fellBack], [['eleven_v4_turbo/deep', 'eleven_v4_turbo/auto'], 'ok', false]);
  const both: string[] = [];
  const r2 = await withModelFallback(mk({ voice: { thinking: 'light' } }), async (cur) => {
    both.push(`${cur.voice.tts_model}/${cur.voice.thinking}`);
    if (cur.voice.tts_model !== FALLBACK_TTS_MODEL) throw new ElevenError(422, 'model_id not allowed');
    return 'ok';
  });
  eq('a refused voice model still falls back, thinking kept', [both, r2.model, r2.fellBack], [['eleven_v4_turbo/light', 'eleven_flash_v2_5/light'], FALLBACK_TTS_MODEL, true]);
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
eq('a big team never crowds out the call words', (() => { const k = asrKeywords(mk({ identity: { name: 'Riley', company: 'Acme Homes' } }), Array.from({ length: 60 }, (_, i) => `Rep${i}`)); return ['earnest money', 'HOA', 'realtor'].every((w) => k.includes(w)) && k.length <= 50; })(), true);
