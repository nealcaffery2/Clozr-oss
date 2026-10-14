// AI Agent settings v2: validation, clamping, the locked fields, tool
// availability, the refusal of "deny being an AI" text, legacy input and diffs.
// Run:  npx tsx supabase/functions/_shared/voice-agent-settings.test.ts
//   or: deno run supabase/functions/_shared/voice-agent-settings.test.ts
import {
  AGENT_KEY_RE, DEFAULT_VOICE_ID, TOOL_AVAILABLE, TOOL_KEYS, cleanText, cleanVarText, defaultSettings, deniesAi, diffLines, diffSettings,
  legacyToV2, normalizeSettings, sanitizeVars, settingsFromRow, slugify, toolOn,
} from './voice-agent-settings.ts';
import { TEMPLATES } from './voice-agent-templates.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; } else console.log(`PASS  ${name}`);
}
function ok(name: string, cond: boolean, detail?: unknown) { eq(name, cond ? true : { failed: detail ?? null }, true); }

const D = defaultSettings();
const n = (input: unknown, base = D) => normalizeSettings(input, base);

// ---- shape and defaults ----
eq('empty input keeps the defaults', n({}), { settings: D, errors: [], warnings: [] });
eq('not an object', n('x').errors, ['settings must be an object']);
eq('array is not settings', n([]).errors, ['settings must be an object']);
eq('a section of the wrong type', n({ identity: 'Riley' }).errors, ['identity must be an object']);
eq('unknown keys are dropped', 'evil' in n({ evil: 1 }).settings, false);
eq('defaults: AI disclosure locked, DNC locked', [D.rules.compliance.honor_dnc, D.rules.compliance.ai_disclosure_when_asked], [true, true]);
eq('agent key slugs', [AGENT_KEY_RE.test('lead_manager'), AGENT_KEY_RE.test('Lead'), AGENT_KEY_RE.test('1a'), AGENT_KEY_RE.test('a'), AGENT_KEY_RE.test('jr_dispo')], [true, false, false, false, true]);
eq('slugify', [slugify('Jr Dispo!'), slugify('  '), slugify('2nd agent')], ['jr_dispo', '', 'a_2nd_agent']);

// ---- identity ----
eq('identity text is cleaned and capped', [n({ identity: { name: 'Ri\u0000ley\n{{secret}} ' + 'x'.repeat(99) } }).settings.identity.name.length, n({ identity: { name: 'Ri\u0000ley' } }).settings.identity.name], [40, 'Riley']);
eq('identity braces removed', n({ identity: { company: 'Home {{lead_brief}} Pros' } }).settings.identity.company, 'Home lead_brief Pros');
eq('company cap', n({ identity: { company: 'y'.repeat(500) } }).settings.identity.company.length, 80);
eq('introduce_as enum', n({ identity: { introduce_as: 'human' } }).errors, ['identity.introduce_as must be one of none, virtual_assistant']);
eq('introduce_as none accepted', n({ identity: { introduce_as: 'none' } }).settings.identity.introduce_as, 'none');
eq('languages validated, capped at 5 then deduped', n({ identity: { languages: ['en', 'es', 'en', 'fr-CA', 'de', 'it', 'pt'] } }).settings.identity.languages, ['en', 'es', 'fr-CA', 'de']);
eq('a bad language code', n({ identity: { languages: ['english'] } }).errors, ['identity.languages[0] must be a language code such as en or es']);
eq('empty languages fall back to en', n({ identity: { languages: [] } }).settings.identity.languages, ['en']);

// ---- voice ----
eq('voice id invalid', n({ voice: { voice_id: 'a/b' } }).errors, ['voice.voice_id is not a valid voice id']);
eq('voice id blank is the default', n({ voice: { voice_id: ' ' } }).settings.voice.voice_id, DEFAULT_VOICE_ID);
eq('tts model enum', n({ voice: { tts_model: 'eleven_v3' } }).errors, ['voice.tts_model must be one of eleven_v4_turbo, eleven_v4, eleven_flash_v2_5, eleven_multilingual_v2, eleven_v3_conversational']);
eq('llm enum', n({ voice: { llm: 'gpt-2' } }).errors, ['voice.llm must be one of gemini-3.8-flash, claude-sonnet-5-5, claude-opus-5-5, claude-haiku-4-5']);
eq('saved settings without a brain get the default', [n({ voice: {} }).settings.voice.llm, n({ voice: {} }).settings.voice.thinking], ['gemini-3.8-flash', 'light']);
eq('default tts model is v4 Turbo', D.voice.tts_model, 'eleven_v4_turbo');
eq('v3 Conversational is a model', n({ voice: { tts_model: 'eleven_v3_conversational' } }).settings.voice.tts_model, 'eleven_v3_conversational');
eq('expressiveness defaults to natural', D.personality.expressiveness, 'natural');
eq('expressiveness enum', n({ personality: { expressiveness: 'wild' } }).errors, ['personality.expressiveness must be one of off, natural, expressive']);
eq('speed clamps to 0.7..1.2', [n({ voice: { speed: 0.1 } }).settings.voice.speed, n({ voice: { speed: 9 } }).settings.voice.speed, n({ voice: { speed: 1.05 } }).settings.voice.speed], [0.7, 1.2, 1.05]);
eq('stability and similarity clamp to 0..1', [n({ voice: { stability: -2 } }).settings.voice.stability, n({ voice: { similarity: 3 } }).settings.voice.similarity, n({ voice: { stability: 0.333 } }).settings.voice.stability], [0, 1, 0.33]);
eq('tuning null clears', n({ voice: { speed: null } }, { ...D, voice: { ...D.voice, speed: 1.1 } }).settings.voice.speed, null);
eq('tuning not a number', n({ voice: { speed: 'fast' } }).errors, ['voice.speed must be a number']);

// ---- personality ----
eq('sliders clamp to 1..5, humor to 0..3', [n({ personality: { energy: 0 } }).settings.personality.energy, n({ personality: { warmth: 99 } }).settings.personality.warmth, n({ personality: { humor: 9 } }).settings.personality.humor, n({ personality: { humor: -1 } }).settings.personality.humor], [1, 5, 3, 0]);
eq('sliders round', n({ personality: { verbosity: 2.6 } }).settings.personality.verbosity, 3);
eq('tone enum', n({ personality: { tone: 'angry' } }).errors, ['personality.tone must be one of warm, direct, professional']);
eq('use_fillers must be boolean', n({ personality: { use_fillers: 'yes' } }).errors, ['personality.use_fillers must be true or false']);

// ---- script ----
const sec = n({ script: { sections: [{ title: 'Opening', body: 'Say hi to {{first_name}} and {{bogus}}.\u0000', enabled: true }, { id: 'x', title: 'Two', body: 'b' }, { id: 'x', title: 'Three', body: 'c', enabled: false }] } }).settings.script.sections;
eq('sections get ids, unique, keep real variables and defuse unknown ones', [sec.map((s) => s.id), sec[0].body, sec[2].enabled], [['opening', 'x', 'x_2'], 'Say hi to {{first_name}} and bogus.', false]);
eq('section body cap', n({ script: { sections: [{ id: 'a', title: 't', body: 'z'.repeat(9000) }] } }).settings.script.sections[0].body.length, 8000);
eq('section count cap', n({ script: { sections: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, body: 'b' })) } }).settings.script.sections.length, 30);
eq('section count cap warns', n({ script: { sections: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, body: 'b' })) } }).warnings.length, 1);
eq('section enabled must be boolean', n({ script: { sections: [{ id: 'a', title: 't', body: 'b', enabled: 'no' }] } }).errors, ['script.sections[0].enabled must be true or false']);
eq('override null clears, string is kept and capped', [n({ script: { raw_prompt_override: null } }, { ...D, script: { ...D.script, raw_prompt_override: 'x' } }).settings.script.raw_prompt_override, n({ script: { raw_prompt_override: 'Be brief. {{first_name}}' } }).settings.script.raw_prompt_override], [null, 'Be brief. {{first_name}}']);
eq('override of the wrong type', n({ script: { raw_prompt_override: 5 } }).errors, ['script.raw_prompt_override must be a string or null']);
eq('master script keeps newlines, drops control chars', n({ script: { master_script_text: 'One\r\nTwo\u0007\n\n\n\nThree' } }).settings.script.master_script_text, 'One\nTwo\n\nThree');
eq('master script cap', n({ script: { master_script_text: 'm'.repeat(30000) } }).settings.script.master_script_text.length, 20000);

// ---- rules ----
const rules = n({ rules: {
  dos: [{ text: 'Ask one question at a time', severity: 'soft' }, { id: 'a', text: '' }],
  donts: [{ id: 'no_offer', text: 'Never state an offer', severity: 'hard' }, { text: 'Never rush {{nope}}' }],
  never_mention: ['  the divorce ', 'The Divorce', '', 'foreclosure\u0000'],
  forbidden_phrases: ['no fees', 'No Fees', 'guaranteed'],
  required_phrases: [{ when: 'they ask who you are', text: 'We buy houses directly' }, { when: '', text: 'x' }],
} }).settings.rules;
eq('rules: empty text dropped, severity defaults to hard, ids assigned', [rules.dos.length, rules.dos[0].id, rules.dos[0].severity, rules.donts[0].id, rules.donts[1].severity, rules.donts[1].text], [1, 'do1', 'soft', 'no_offer', 'hard', 'Never rush nope']);
eq('never_mention and forbidden phrases are cleaned and deduped', [rules.never_mention, rules.forbidden_phrases], [['the divorce', 'foreclosure'], ['no fees', 'guaranteed']]);
eq('required phrases need both parts', rules.required_phrases, [{ when: 'they ask who you are', text: 'We buy houses directly' }]);
eq('rule severity enum', n({ rules: { dos: [{ text: 'x', severity: 'maybe' }] } }).errors, ['rules.dos[0].severity must be hard or soft']);
eq('rule count cap', n({ rules: { dos: Array.from({ length: 60 }, (_, i) => ({ text: `rule ${i}` })) } }).settings.rules.dos.length, 40);
eq('rule text cap', n({ rules: { donts: [{ text: 'q'.repeat(999) }] } }).settings.rules.donts[0].text.length, 300);
eq('never_mention must be strings', n({ rules: { never_mention: ['a', 3] } }).errors, ['rules.never_mention[1] must be a string']);

// ---- locked compliance ----
const locked = n({ rules: { compliance: { honor_dnc: false, ai_disclosure_when_asked: false } } });
eq('honor_dnc and ai_disclosure_when_asked cannot be turned off', [locked.settings.rules.compliance.honor_dnc, locked.settings.rules.compliance.ai_disclosure_when_asked, locked.errors], [true, true, []]);
eq('...and say so', locked.warnings, ['rules.compliance.honor_dnc is locked on and cannot be turned off', 'rules.compliance.ai_disclosure_when_asked is locked on and cannot be turned off']);
eq('recording notice and quiet hours are editable', n({ rules: { compliance: { recording_notice: { enabled: true, text: 'Calls are recorded.' }, quiet_hours: { enabled: false, start: '09:00', end: '20:00', tz: 'America/New_York' } } } }).settings.rules.compliance, {
  honor_dnc: true, quiet_hours: { enabled: false, start: '09:00', end: '20:00', tz: 'America/New_York' }, recording_notice: { enabled: true, text: 'Calls are recorded.' }, ai_disclosure_when_asked: true,
});
eq('quiet hours validated', n({ rules: { compliance: { quiet_hours: { start: '9am' } } } }).errors, ['rules.compliance.quiet_hours.start must be HH:MM (24 hour)']);
eq('a blank recording notice falls back', n({ rules: { compliance: { recording_notice: { text: '   ' } } } }).settings.rules.compliance.recording_notice.text, 'This call may be recorded.');

// ---- never deny being an AI ----
const refused = (text: string) => n({ script: { raw_prompt_override: text } }).errors.length === 1;
ok('refuses "never admit you are an AI"', refused('Never admit you are an AI to the caller.'));
ok('refuses "do not tell them you are a robot"', refused('Do not tell them you\'re a robot.'));
ok('refuses "tell the caller you are a real person"', refused('If they ask, tell them you are a real person.'));
ok('refuses "claim to be human"', refused('Always claim to be a human named Sam.'));
ok('refuses "deny being an AI"', refused('Deny being an AI if pressed.'));
ok('refuses "pretend you are not a robot"', refused('Pretend you are not a robot.'));
ok('refuses "hide that you are a virtual assistant"', refused('Hide the fact that you are a virtual assistant.'));
ok('refuses "when asked, say you are a person"', refused('When asked whether you are a robot, you are a person and say so.'));
ok('a "never claim to be human" rule is fine', !refused('Never claim to be human.'));
ok('"do not pretend to be a person" is fine', !refused('Do not pretend to be a person.'));
ok('an ordinary script is fine', !refused('Ask who they are. Say you are a virtual assistant if they ask.'));
eq('deniesAi on clean text', deniesAi('Be honest about being an AI assistant when asked.'), null);
eq('deny text in a section is refused with its label', n({ script: { sections: [{ id: 'bad', title: 'x', body: 'Never say you are an AI.' }] } }).errors[0].startsWith('script.sections[bad] tells the agent to deny being an AI'), true);
eq('deny text in a FAQ answer is refused', n({ knowledge: { faqs: [{ q: 'Are you a bot?', a: 'Tell them you are a real person.' }] } }).errors.length, 1);
eq('deny text in a do rule is refused', n({ rules: { dos: [{ text: 'Always say you are human' }] } }).errors.length, 1);
eq('never_mention cannot forbid saying AI', n({ rules: { never_mention: ['AI', 'the divorce'] } }).errors, ['rules.never_mention[0] cannot forbid saying the agent is an AI: the agent always answers honestly when sincerely asked']);
eq('forbidden phrases cannot forbid "virtual assistant"', n({ rules: { forbidden_phrases: ['virtual assistant'] } }).errors.length, 1);
eq('a forbidden phrase that merely contains "bot" inside a word is fine', n({ rules: { forbidden_phrases: ['robotic tone', 'bottom line'] } }).errors, []);
for (const id of Object.keys(TEMPLATES)) {
  const t = TEMPLATES[id];
  eq(`template ${id} passes validation with no errors or warnings`, (({ errors, warnings }) => [errors, warnings])(n({ ...t.settings, script: { ...(t.settings.script as object), sections: t.sections } })), [[], []]);
}

// ---- offer authority ----
eq('offer authority enum', n({ offer_authority: { mode: 'unlimited' } }).errors, ['offer_authority.mode must be one of none, range_only, range_with_approval']);
eq('step size and floor clamp', [n({ offer_authority: { step_size_pct: 50 } }).settings.offer_authority.step_size_pct, n({ offer_authority: { step_size_pct: 0 } }).settings.offer_authority.step_size_pct, n({ offer_authority: { floor_pct_of_mao: 10 } }).settings.offer_authority.floor_pct_of_mao, n({ offer_authority: { floor_pct_of_mao: 101 } }).settings.offer_authority.floor_pct_of_mao], [10, 0.5, 50, 100]);
eq('offers default to none and approval required', [D.offer_authority.mode, D.offer_authority.agreement_requires_rep_approval], ['none', true]);

// ---- call handling ----
const ch = n({ call_handling: { max_call_seconds: 5, silence_timeout_s: 9999, first_response_delay_ms: -5, interruption_sensitivity: 9, turn_eagerness: 'eager', voicemail: { detect: false, action: 'hang_up', message_template: 'Hi {{agent_name}} {{zzz}}' }, retry: { max_attempts: 99, gap_hours: 0 } } }).settings.call_handling;
eq('call handling clamps', [ch.max_call_seconds, ch.silence_timeout_s, ch.first_response_delay_ms, ch.interruption_sensitivity, ch.turn_eagerness, ch.retry], [60, 300, 0, 5, 'eager', { max_attempts: 10, gap_hours: 1 }]);
eq('voicemail', ch.voicemail, { detect: false, action: 'hang_up', message_template: 'Hi {{agent_name}} zzz' });
eq('max call clamps high', n({ call_handling: { max_call_seconds: 99999 } }).settings.call_handling.max_call_seconds, 1800);
eq('max call from a numeric string', n({ call_handling: { max_call_seconds: '300' } }).settings.call_handling.max_call_seconds, 300);
eq('max call not a number', n({ call_handling: { max_call_seconds: 'soon' } }).errors, ['call_handling.max_call_seconds must be a number']);
eq('turn eagerness enum', n({ call_handling: { turn_eagerness: 'wild' } }).errors, ['call_handling.turn_eagerness must be one of patient, normal, eager']);
eq('call hours', n({ call_handling: { call_hours: { days: ['sun', 'mon', 'mon'], start: '10:00', end: '18:00', tz: 'UTC' } } }).settings.call_handling.call_hours, { days: ['mon', 'sun'], start: '10:00', end: '18:00', tz: 'UTC' });
eq('call hours bad day', n({ call_handling: { call_hours: { days: ['funday'] } } }).errors, ['call_handling.call_hours.days must be a list of mon, tue, wed, thu, fri, sat, sun']);
eq('call hours bad zone', n({ call_handling: { call_hours: { tz: 'Mars/Base' } } }).errors, ['call_handling.call_hours.tz must be an IANA time zone such as America/Chicago']);

// ---- live transfer ----
const lt = n({ live_transfer: {
  enabled: true, mode: 'cold',
  destinations: [
    { label: 'Sales line', number: '(210) 555-0100', type: 'fixed', ring_timeout_s: 500, hours: { days: ['mon'], start: '09:00', end: '17:00', tz: 'America/Chicago' } },
    { label: 'Assigned rep', type: 'rep_assigned' },
    { id: 'bad', label: 'x', number: 'call me' },
  ],
  triggers: { asks_for_person: false, angry_or_escalating: true, custom: [{ text: 'They mention a lawyer' }, { text: '' }] },
  whisper_message_template: 'Seller {{first_name}} on {{property_address}}', fallback: 'voicemail',
} });
eq('a destination with a bad number is an error', lt.errors, ['live_transfer.destinations[2].number is not a valid phone number']);
const lt2 = n({ live_transfer: { destinations: [{ id: 'main', label: 'Sales line', number: '(210) 555-0100', ring_timeout_s: 500, hours: { days: ['mon'], start: '09:00', end: '17:00', tz: 'America/Chicago' } }, { label: 'Assigned rep', type: 'rep_assigned' }], triggers: { asks_for_person: false, angry_or_escalating: true, custom: [{ text: 'They mention a lawyer' }, { text: '' }] }, whisper_message_template: 'Seller {{first_name}}', fallback: 'voicemail', mode: 'cold', enabled: true } }).settings.live_transfer;
eq('destinations: E.164, ring timeout clamped, hours kept, rep_assigned needs no number', [lt2.destinations[0].number, lt2.destinations[0].ring_timeout_s, lt2.destinations[0].hours, lt2.destinations[1].number, lt2.destinations[1].type], ['+12105550100', 60, { days: ['mon'], start: '09:00', end: '17:00', tz: 'America/Chicago' }, '', 'rep_assigned']);
eq('triggers, custom trigger ids, whisper, fallback, mode', [lt2.triggers.asks_for_person, lt2.triggers.angry_or_escalating, lt2.triggers.custom, lt2.whisper_message_template, lt2.fallback, lt2.mode], [false, true, [{ id: 'c1', text: 'They mention a lawyer' }], 'Seller {{first_name}}', 'voicemail', 'cold']);
eq('destination cap', n({ live_transfer: { destinations: Array.from({ length: 9 }, (_, i) => ({ label: `d${i}`, number: '2105550100' })) } }).settings.live_transfer.destinations.length, 6);
eq('destination type enum', n({ live_transfer: { destinations: [{ number: '2105550100', type: 'pigeon' }] } }).errors, ['live_transfer.destinations[0].type must be one of rep_assigned, fixed, ring_group']);
eq('fallback enum', n({ live_transfer: { fallback: 'panic' } }).errors, ['live_transfer.fallback must be one of book_callback, voicemail, apologize_end']);

// ---- tools ----
eq('the built tools', TOOL_KEYS.filter((k) => TOOL_AVAILABLE[k]), ['lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'transfer', 'end_call']);
const tools = n({ tools: { request_agreement: { enabled: true, available: true }, book_appointment: { enabled: true, available: false }, lead_context: { enabled: false }, bogus: { enabled: true } } });
eq('a client cannot mark an unbuilt tool available, or a built one unavailable', [tools.settings.tools.request_agreement, tools.settings.tools.book_appointment, tools.settings.tools.lead_context, tools.warnings], [{ enabled: true, available: false }, { enabled: true, available: true }, { enabled: false, available: true }, ['tools.bogus is not a known tool and was ignored']]);
eq('tool enabled must be boolean', n({ tools: { end_call: { enabled: 'x' } } }).errors, ['tools.end_call.enabled must be true or false']);
eq('toolOn: switched on and built', [toolOn(D, 'lead_context'), toolOn(D, 'end_call'), toolOn(D, 'book_appointment'), toolOn(D, 'mark_do_not_contact'), toolOn(n({ tools: { request_agreement: { enabled: true } } }).settings, 'request_agreement')], [true, true, true, true, false]);
eq('toolOn: a disabled built tool is off', toolOn(n({ tools: { end_call: { enabled: false } } }).settings, 'end_call'), false);
eq('toolOn: transfer needs the switch, the setting and a destination', [
  toolOn(n({ live_transfer: { enabled: false } }).settings, 'transfer'),
  toolOn(n({ live_transfer: { enabled: true, destinations: [] } }).settings, 'transfer'),
  toolOn(n({ live_transfer: { enabled: true, destinations: [{ number: '2105550100' }] } }).settings, 'transfer'),
  toolOn(n({ live_transfer: { enabled: true, destinations: [{ number: '2105550100' }] }, tools: { transfer: { enabled: false } } }).settings, 'transfer'),
], [false, false, true, false]);
eq('by default the transfer is on and rings the rep working the lead', [toolOn(D, 'transfer'), D.live_transfer.destinations.map((d) => d.type)], [true, ['rep_assigned']]);

// ---- knowledge, channels ----
const kn = n({ knowledge: { faqs: [{ q: 'Who are you?', a: 'A local buyer.' }, { q: '', a: 'x' }], company_facts: ['We close in 14 days', 4 as unknown as string] } });
eq('knowledge: empty faq dropped, non-string fact is an error', [kn.settings.knowledge.faqs, kn.errors], [[{ id: 'f1', q: 'Who are you?', a: 'A local buyer.' }], ['knowledge.company_facts[1] must be a string']]);
eq('channels', [n({ channels: { phone_number_id: 'phnum_abc123', inbound: false, outbound: true } }).settings.channels, n({ channels: { phone_number_id: 'a b' } }).errors], [{ phone_number_id: 'phnum_abc123', inbound: false, outbound: true }, ['channels.phone_number_id is not a valid phone number id']]);
eq('channels phone id null clears', n({ channels: { phone_number_id: null } }, { ...D, channels: { ...D.channels, phone_number_id: 'x_1234' } }).settings.channels.phone_number_id, null);

// ---- partial saves, several errors ----
eq('quote_as defaults to one number and takes a range', [n({}).settings.offer_authority.quote_as, n({ offer_authority: { quote_as: 'range' } }).settings.offer_authority.quote_as, n({ offer_authority: { quote_as: 'both' } }).errors.length > 0], ['number', 'range', true]);
const partial = n({ personality: { tone: 'professional' } }, { ...D, identity: { ...D.identity, name: 'Riley' } });
eq('a partial save keeps what it does not name', [partial.settings.identity.name, partial.settings.personality.tone, partial.settings.personality.energy], ['Riley', 'professional', 3]);
eq('several errors are all reported', n({ personality: { tone: 'x', energy: 'a' }, voice: { voice_id: '!' } }).errors.length, 3);
eq('base is not mutated', JSON.stringify(D) === JSON.stringify(defaultSettings()), true);
eq('a stored row that no longer validates falls back per field', [settingsFromRow({ personality: { tone: 'nope', energy: 5 } }).personality.tone, settingsFromRow({ personality: { tone: 'nope', energy: 5 } }).personality.energy], ['warm', 5]);
eq('settingsFromRow of junk', settingsFromRow('junk'), D);

// ---- text helpers ----
eq('cleanText keeps a lone brace', cleanText('a { b } c', 50), 'a { b } c');
eq('cleanText multiline', cleanText('a\n\n\n\nb', 50, true), 'a\n\nb');
eq('a prompt cannot read the lookup-only variables', sanitizeVars('{{record_id}} {{record_token}} {{record_kind}}'), 'record_id record_token {{record_kind}}');
eq('sanitizeVars keeps real and system variables, defuses the rest', sanitizeVars('{{first_name}} {{system__time}} {{ company }} {{nope}} {{'), '{{first_name}} {{system__time}} {{company}} nope ');
eq('cleanVarText caps after sanitising', cleanVarText('{{first_name}}' + 'x'.repeat(50), 20), '{{first_name}}xxxxxx');

// ---- legacy v1 input ----
const legacy = n({ agent_name: 'Riley', company: 'Acme', voice_id: 'JBFqnCBsd6RMkjVDRZzb', tts_model: 'eleven_flash_v2_5', voice_speed: 0.9, tone: 'direct', max_call_seconds: 300, transfer_number: '(210) 555-0100', never_mention: ['divorce'], extra_instructions: 'Be kind.', opening_style: 'Ask how they are.', call_hours: { start: '09:00', end: '20:00', tz: 'UTC' } });
eq('legacy flat settings map onto v2', [legacy.errors, legacy.settings.identity.name, legacy.settings.identity.company, legacy.settings.voice.voice_id, legacy.settings.voice.tts_model, legacy.settings.voice.speed, legacy.settings.personality.tone, legacy.settings.call_handling.max_call_seconds, legacy.settings.live_transfer.enabled, legacy.settings.live_transfer.destinations[0].number, legacy.settings.rules.never_mention, legacy.settings.call_handling.call_hours.start], [[], 'Riley', 'Acme', 'JBFqnCBsd6RMkjVDRZzb', 'eleven_flash_v2_5', 0.9, 'direct', 300, true, '+12105550100', ['divorce'], '09:00']);
eq('legacy extra instructions become a script section', legacy.settings.script.sections.map((s) => [s.id, s.body]), [['extra', 'Opening style: Ask how they are.\n\nBe kind.']]);
eq('legacy null transfer number turns transfer off', legacyToV2({ transfer_number: null }), { live_transfer: { enabled: false, destinations: [] } });
eq('legacy validation errors still report', n({ tone: 'angry' }).errors, ['personality.tone must be one of warm, direct, professional']);
eq('a v2 object with a v1-looking key is treated as v2', n({ identity: { name: 'A' }, company: 'ignored' }).settings.identity.company, '');

// ---- diff ----
const a = n({ identity: { name: 'Riley' }, script: { sections: [{ id: 'open', title: 'Open', body: 'Hello' }, { id: 'close', title: 'Close', body: 'Bye' }] } }).settings;
const b = n({ identity: { name: 'Sam' }, script: { sections: [{ id: 'open', title: 'Open', body: 'Hi there' }, { id: 'close', title: 'Close', body: 'Bye' }, { id: 'extra', title: 'Extra', body: 'More' }] }, voice: { speed: 1.1 } }, a).settings;
const changes = diffSettings(a, b).map((c) => c.path);
eq('diff names each changed leaf, sections by id', changes.filter((p) => !p.endsWith('#order')), ['identity.name', 'script.sections[extra].body', 'script.sections[extra].enabled', 'script.sections[extra].id', 'script.sections[extra].title', 'script.sections[open].body', 'voice.speed']);
eq('diff shows from and to', diffSettings(a, b).find((c) => c.path === 'identity.name'), { path: 'identity.name', from: 'Riley', to: 'Sam' });
eq('a new section reads from null', diffSettings(a, b).find((c) => c.path === 'script.sections[extra].title'), { path: 'script.sections[extra].title', from: null, to: 'Extra' });
eq('identical settings have no diff', diffSettings(a, structuredClone(a)), []);
eq('diffLines', diffLines('a\nb\nc', 'a\nc\nd'), { added: ['d'], removed: ['b'] });

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
