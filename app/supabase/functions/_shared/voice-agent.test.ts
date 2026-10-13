// Voice agent webhooks: who is calling, what the agent opens with, DNC,
// the post-call transcript, and the ElevenLabs signature.
// Run:  npx tsx supabase/functions/_shared/voice-agent.test.ts
//   or: deno run supabase/functions/_shared/voice-agent.test.ts
import {
  buildInitiation, callLeg, DYNAMIC_VARIABLES, hmacHex, isDoNotEngage, mapTranscript, matchSecret, parsePostCall, phoneKey,
  NO_EXTRAS, pickPersona, resolveCaller, secretConfigured, toE164, verifySignature, verifySignatureAny, type Candidate, type SecretRow,
} from './voice-agent.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

// ---- phones ----
eq('phoneKey strips formatting and country code', phoneKey('+1 (210) 555-0100'), '2105550100');
eq('phoneKey refuses a short number', phoneKey('555-0100'), null);
eq('toE164 from ten digits', toE164('210.555.0100'), '+12105550100');
eq('toE164 keeps an 11-digit NANP', toE164('12105550100'), '+12105550100');
eq('toE164 empty', toE164(''), null);

const ours = new Set(['2105550100']);
eq('inbound: called number is ours', callLeg('+15125550199', '+12105550100', ours), { direction: 'inbound', ours: '2105550100', theirs: '5125550199' });
eq('outbound: caller id is ours', callLeg('+12105550100', '(512) 555-0199', ours), { direction: 'outbound', ours: '2105550100', theirs: '5125550199' });
eq('neither end is ours', callLeg('+15125550199', '+17135550111', ours), null);

// ---- match resolution ----
const ann: Candidate = { kind: 'seller', id: 1, name: 'ann smith', tags: [], property_address: '12 Oak St' };
const bob: Candidate = { kind: 'seller', id: 2, name: 'Bob Jones', tags: [] };
const buyer: Candidate = { kind: 'buyer', id: 9, name: 'Cash Co', tags: [] };
eq('no match', resolveCaller([]).status, 'none');
eq('one seller', resolveCaller([ann]), { status: 'one', match: ann });
eq('same row twice is still one', resolveCaller([ann, { ...ann }]).status, 'one');
eq('two sellers share the number', resolveCaller([ann, bob]).status, 'many');
eq('a sole seller wins over a buyer on the same number', resolveCaller([buyer, ann]).status === 'one' && (resolveCaller([buyer, ann]) as { match: Candidate }).match.id, 1);
eq('one buyer', resolveCaller([buyer]).status, 'one');
eq('an archived seller is not the match', resolveCaller([{ ...ann, archived_at: '2026-01-01' }]).status, 'none');

// ---- DNC ----
eq('DNC tag blocks', isDoNotEngage({ ...ann, tags: ['Hot', 'DNC'] }), true);
eq('do not call tag blocks', isDoNotEngage({ ...ann, tags: ['do not call'] }), true);
eq('secret blacklist tag blocks', isDoNotEngage({ ...ann, tags: ['secret-blacklist'] }), true);
eq('blacklisted buyer blocks', isDoNotEngage({ ...buyer, blacklisted_at: '2026-05-01' }), true);
eq('a DNC-flagged buyer number blocks', isDoNotEngage({ ...buyer, number_dnc: true }), true);
eq('plain tags do not block', isDoNotEngage({ ...ann, tags: ['Hot lead'] }), false);
eq('one DNC match blocks the whole number', resolveCaller([bob, { ...ann, tags: ['DNC'] }]).status, 'blocked');
eq('an archived DNC seller still blocks', resolveCaller([{ ...ann, tags: ['dnc'], archived_at: '2026-01-01' }]).status, 'blocked');

// ---- personalization ----
const persona = { agentName: 'Sam', company: 'Acme Homes', repName: 'Sam' };
const mem = { brief: 'Ann inherited 12 Oak St, wants to sell before winter. We offered $140,000.', facts: { first_name: 'Ann', preferred_name: null, property_address: '12 Oak St', last_contact_summary: 'Asked for the offer in writing.', next_step: 'Email the written offer' } };
const inLeg = { direction: 'inbound' as const, ours: '2105550100', theirs: '5125550199' };
const one = buildInitiation({ status: 'one', match: ann }, inLeg, mem, persona);
eq('response type', one.type, 'conversation_initiation_client_data');
eq('every configured variable is present', Object.keys(one.dynamic_variables).sort(), [...DYNAMIC_VARIABLES].sort());
eq('known caller: first name', one.dynamic_variables.first_name, 'Ann');
eq('known caller: brief', one.dynamic_variables.lead_brief, mem.brief);
eq('known caller: next step', one.dynamic_variables.next_step, 'Email the written offer');
eq('known caller: greeting by name', one.conversation_config_override.agent.first_message, 'Hey Ann, thanks for calling back, this is Sam with Acme Homes.');
eq('known caller without memory uses the record name', buildInitiation({ status: 'one', match: ann }, inLeg, null, persona).dynamic_variables.first_name, 'Ann');
const outOne = buildInitiation({ status: 'one', match: ann }, { ...inLeg, direction: 'outbound' }, mem, persona);
eq('outbound: confirms who picked up first', outOne.conversation_config_override.agent.first_message, 'Hi, is this Ann? This is Sam with Acme Homes.');
const many = buildInitiation({ status: 'many', matches: [ann, bob] }, inLeg, mem, persona);
eq('many: no name', many.dynamic_variables.first_name, '');
eq('many: no brief', many.dynamic_variables.lead_brief, '');
eq('many: asks who is calling', many.conversation_config_override.agent.first_message, 'Thanks for calling Acme Homes, this is Sam. Who am I speaking with?');
eq('none: caller_known false', buildInitiation({ status: 'none' }, inLeg, null, persona).dynamic_variables.caller_known, false);
const blocked = buildInitiation({ status: 'blocked', matches: [ann] }, inLeg, mem, persona);
eq('blocked: do_not_engage', blocked.dynamic_variables.do_not_engage, true);
eq('blocked: nothing about the person', [blocked.dynamic_variables.first_name, blocked.dynamic_variables.lead_brief, blocked.dynamic_variables.property_address], ['', '', '']);
eq('blocked: neutral opener', blocked.conversation_config_override.agent.first_message, 'Thanks for calling Acme Homes. How can I help you today?');
eq('no agent name configured', buildInitiation({ status: 'one', match: ann }, inLeg, mem, { ...persona, agentName: null }).conversation_config_override.agent.first_message,
  "Hey Ann, thanks for calling back, you've reached Acme Homes.");

// ---- post-call ----
const turns = [
  { role: 'agent', message: 'Hey Ann, thanks for calling back.', time_in_call_secs: 0 },
  { role: 'user', message: 'Hi. Did you send the offer?', time_in_call_secs: 3 },
  { role: 'agent', message: null, time_in_call_secs: 6, tool_calls: [{}] },
  { role: 'agent', message: 'It goes out today.', time_in_call_secs: 7 },
];
eq('transcript text with Rep/Contact labels', mapTranscript(turns, 12).text, 'Rep: Hey Ann, thanks for calling back.\nContact: Hi. Did you send the offer?\nRep: It goes out today.');
eq('segments end where the next begins, the last at the duration', mapTranscript(turns, 12).segments, [
  { start: 0, end: 3, speaker: 'rep', text: 'Hey Ann, thanks for calling back.' },
  { start: 3, end: 7, speaker: 'contact', text: 'Hi. Did you send the offer?' },
  { start: 7, end: 12, speaker: 'rep', text: 'It goes out today.' },
]);
eq('no timestamps, no segments', mapTranscript([{ role: 'user', message: 'hi' }], 5).segments, null);

const event = {
  type: 'post_call_transcription', event_timestamp: 1790000100,
  data: {
    agent_id: 'agent_1', conversation_id: 'conv_1', status: 'done', transcript: turns,
    metadata: { start_time_unix_secs: 1790000000, call_duration_secs: 12, phone_call: { type: 'sip_trunking', direction: 'inbound', agent_number: '+12105550100', external_number: '+15125550199', call_sid: 'x', phone_number_id: 'p' } },
    analysis: { transcript_summary: 'Ann asked about the written offer.', call_summary_title: 'Offer follow-up' },
  },
};
const pc = parsePostCall(event)!;
eq('post-call ids and direction', [pc.conversationId, pc.direction, pc.ourNumber, pc.theirNumber], ['conv_1', 'inbound', '+12105550100', '+15125550199']);
eq('post-call time and duration', [pc.occurredAt, pc.durationS], [new Date(1790000000 * 1000).toISOString(), 12]);
eq('post-call summary with title', pc.summary, 'Offer follow-up. Ann asked about the written offer.');
eq('post-call status', pc.status, 'completed');
eq('audio webhook is not a transcript', parsePostCall({ type: 'post_call_audio', data: { conversation_id: 'c' } }), null);
const noPhone = parsePostCall({ type: 'post_call_transcription', data: { conversation_id: 'c2', transcript: [], metadata: {}, conversation_initiation_client_data: { dynamic_variables: { system__caller_id: '5125550199', system__called_number: '2105550100' } } } })!;
eq('post-call without phone_call falls back to system variables', [noPhone.theirNumber, noPhone.ourNumber, noPhone.status], ['+15125550199', '+12105550100', 'no-answer']);

// ---- signature ----
const secret = 'wsec_test';
const body = JSON.stringify(event);
const now = 1790000200 * 1000;
const t = String(now / 1000 - 60);
const good = `t=${t},v0=${await hmacHex(secret, `${t}.${body}`)}`;
eq('valid signature', await verifySignature(body, good, secret, now), { ok: true });
eq('tampered body', await verifySignature(body + ' ', good, secret, now), { ok: false, reason: 'mismatch' });
eq('wrong secret', await verifySignature(body, good, 'other', now), { ok: false, reason: 'mismatch' });
eq('missing header', await verifySignature(body, null, secret, now), { ok: false, reason: 'missing' });
eq('no v0', await verifySignature(body, `t=${t}`, secret, now), { ok: false, reason: 'malformed' });
const old = String(now / 1000 - 31 * 60);
eq('older than 30 minutes', await verifySignature(body, `t=${old},v0=${await hmacHex(secret, `${old}.${body}`)}`, secret, now), { ok: false, reason: 'stale' });
// Known vector: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
eq('hmac matches the RFC 4231-style vector', await hmacHex('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');

// ---- per-workspace secrets (migration 111) ----
const rows: SecretRow[] = [
  { workspace_id: 7, personalize_secret: 'pers-seven-aaaaaaaa', tool_secret: 'tool-seven-aaaaaaaa', webhook_secret: 'wsec_seven' },
  { workspace_id: 9, personalize_secret: 'pers-nine-bbbbbbbbb', tool_secret: null, webhook_secret: 'wsec_nine' },
];
const hdr = (h: Record<string, string>) => new Headers(h);
eq('row secret names its workspace', matchSecret(hdr({ 'x-voice-agent-secret': 'pers-nine-bbbbbbbbb' }), rows, 'personalize_secret', null), { ok: true, workspaceId: 9, source: 'row' });
eq('bearer works for a row secret', matchSecret(hdr({ authorization: 'Bearer pers-seven-aaaaaaaa' }), rows, 'personalize_secret', 'env-secret'), { ok: true, workspaceId: 7, source: 'row' });
eq('env secret matches with no workspace', matchSecret(hdr({ 'x-voice-agent-secret': 'env-secret' }), rows, 'personalize_secret', 'env-secret'), { ok: true, workspaceId: null, source: 'env' });
eq('a personalize secret does not open the tool route', matchSecret(hdr({ 'x-voice-agent-secret': 'pers-seven-aaaaaaaa' }), rows, 'tool_secret', null), { ok: false });
eq('a row with no tool secret matches nothing', matchSecret(hdr({ 'x-voice-agent-secret': '' }), rows, 'tool_secret', null), { ok: false });
eq('wrong secret', matchSecret(hdr({ 'x-voice-agent-secret': 'nope' }), rows, 'personalize_secret', 'env-secret'), { ok: false });
eq('no credential at all', matchSecret(hdr({}), rows, 'personalize_secret', 'env-secret'), { ok: false });
eq('no rows, no env: nothing configured (503)', secretConfigured([], 'tool_secret', undefined), false);
eq('env only is configured', secretConfigured([], 'tool_secret', 'x'), true);
eq('a row secret alone is configured', secretConfigured(rows, 'tool_secret', undefined), true);
eq('a row with the field null is not', secretConfigured([rows[1]], 'tool_secret', undefined), false);

const sigBody = '{"type":"post_call_transcription"}';
const sigNow = 1790000200 * 1000;
const sigT = String(sigNow / 1000 - 5);
const signedWith = async (sec: string) => `t=${sigT},v0=${await hmacHex(sec, `${sigT}.${sigBody}`)}`;
eq('signature from workspace 9 names workspace 9', await verifySignatureAny(sigBody, await signedWith('wsec_nine'), rows, null, sigNow), { ok: true, workspaceId: 9, source: 'row' });
eq('signature from the env secret', await verifySignatureAny(sigBody, await signedWith('env-wsec'), rows, 'env-wsec', sigNow), { ok: true, workspaceId: null, source: 'env' });
eq('signature nobody holds', await verifySignatureAny(sigBody, await signedWith('unknown'), rows, 'env-wsec', sigNow), { ok: false, reason: 'mismatch' });
eq('missing signature header', await verifySignatureAny(sigBody, null, rows, null, sigNow), { ok: false, reason: 'missing' });
eq('stale signature is stale, not mismatch', await verifySignatureAny(sigBody, await signedWith('wsec_seven'), rows, null, sigNow + 40 * 60 * 1000), { ok: false, reason: 'stale' });

eq('persona: settings win', pickPersona({ agent_name: ' Riley ', company: 'Acme' }, { name: 'Sam', company: 'Env Co' }, 'Workspace'), { agentName: 'Riley', company: 'Acme' });
eq('persona: env next', pickPersona({ agent_name: '', company: '' }, { name: 'Sam', company: 'Env Co' }, 'Workspace'), { agentName: 'Sam', company: 'Env Co' });
eq('persona: workspace name last, as before migration 111', pickPersona(null, { name: null, company: null }, 'Workspace'), { agentName: null, company: 'Workspace' });
eq('persona: nothing at all', pickPersona(null, {}, ''), { agentName: null, company: 'our office' });

// ---- agent persona, extras (v2) ----
const annOne: Candidate = { kind: 'seller', id: 1, name: 'ann smith', tags: [], property_address: '12 Oak St' };
const leg = { direction: 'inbound' as const, ours: '2105550100', theirs: '5125550199' };
const extras = { ...NO_EXTRAS, rep_phone: '+15125550100', lead_source: 'form', offer_low: '$170,000', offer_high: '$200,000', seller_asking_price: '$210,000' };
const withExtras = buildInitiation(resolveCaller([annOne]), leg, null, { agentName: 'Riley', company: 'Acme', repName: 'Alex' }, extras);
eq('extras reach the variables for a known caller', [withExtras.dynamic_variables.offer_low, withExtras.dynamic_variables.offer_high, withExtras.dynamic_variables.rep_phone, withExtras.dynamic_variables.lead_source, withExtras.dynamic_variables.seller_asking_price], ['$170,000', '$200,000', '+15125550100', 'form', '$210,000']);
eq('there are 20 variables and extras default to empty', [DYNAMIC_VARIABLES.length, buildInitiation({ status: 'none' }, null, null, { agentName: null, company: 'Acme', repName: null }).dynamic_variables.offer_high, buildInitiation({ status: 'none' }, null, null, { agentName: null, company: 'Acme', repName: null }).dynamic_variables.call_goal], [20, '', '']);
const blockedExtras = buildInitiation({ status: 'blocked', matches: [{ ...annOne, tags: ['DNC'] }] }, leg, null, { agentName: 'Riley', company: 'Acme', repName: 'Alex' }, extras);
eq('a blocked caller gets none of the extras', [blockedExtras.dynamic_variables.offer_low, blockedExtras.dynamic_variables.rep_phone, blockedExtras.dynamic_variables.seller_asking_price, blockedExtras.dynamic_variables.do_not_engage], ['', '', '', true]);
eq('virtual assistant intro', buildInitiation(resolveCaller([annOne]), leg, null, { agentName: 'Riley', company: 'Acme', repName: null, introduceAs: 'virtual_assistant' }).conversation_config_override.agent.first_message, 'Hey Ann, thanks for calling back, this is Riley, a virtual assistant with Acme.');
eq('recording notice ends every opener, blocked too', [
  buildInitiation({ status: 'none' }, null, null, { agentName: null, company: 'Acme', repName: null, recordingNotice: 'This call may be recorded.' }).conversation_config_override.agent.first_message,
  blockedExtras.conversation_config_override.agent.first_message.endsWith('recorded.'),
], ['Thanks for calling Acme. Who am I speaking with? This call may be recorded.', false]);
eq('outbound virtual assistant intro', buildInitiation(resolveCaller([annOne]), { direction: 'outbound', ours: '2105550100', theirs: '5125550199' }, null, { agentName: 'Riley', company: 'Acme', repName: null, introduceAs: 'virtual_assistant' }).conversation_config_override.agent.first_message, 'Hi, is this Ann? This is Riley, a virtual assistant with Acme.');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');

// Casual agents answer like a person, never "us".
eq('casual known caller', buildInitiation(resolveCaller([annOne]), leg, null, { agentName: 'Cody', company: 'Compr', repName: null, casual: true }).conversation_config_override.agent.first_message, 'Hey Ann! This is Cody from Compr, how can I help ya?');
eq('casual unknown caller', buildInitiation({ status: 'none' }, leg, null, { agentName: 'Cody', company: 'Compr', repName: null, casual: true }).conversation_config_override.agent.first_message, 'Hey, this is Cody from Compr, how can I help ya?');
