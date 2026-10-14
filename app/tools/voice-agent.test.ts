// The AI Agent console's rules: reading the function's v2 answers, validating
// and cleaning settings, dirty checks, what a server refusal points at, diff
// text, hours, lists, stats, scores, the demo API, voice search, the test
// call's helpers, and the read-only preview's view of voice-agent-admin.
// Run: npx tsx tools/voice-agent.test.ts
import assert from 'node:assert/strict';
import {
  CHECK_ROWS, LIMITS, TOOL_KEYS, addChip, agentStatus, blockingErrors, cleanQuery, defaultSettings, filterVoices, formatDuration, formatLimit, hasErrors, hoursProblem,
  indexPathToId, interpretReply, isDirty, levelPercent, micProblem, modelDiffers, normalizeAgents, normalizeCalls, normalizeConnectErrors, normalizeDetail, normalizeDiff,
  normalizePhone, normalizePreview, normalizePublish, normalizeScenarios, normalizeScore, normalizeSettings, normalizeStats, normalizeTemplates, normalizeVersions, normalizeVoices,
  enabledNote, normalizeEnabled, orderVariables, pushLine, roleLabel, sampleLine, scenarioFits, savePayload, serverErrorsToFields, timeAgo, ttsLabel, tuningIsDefault, validateSettings, voiceTraits,
  type AgentSettings,
} from '../lib/voice-agent';
import {
  MAX_AGENTS, addLanguage, agentKeyFor, callHoursOutsideQuiet, canAddAgent, changeSummary, daysSummary, describeChange, diffLines, diffSettings, dirtyTabs, errorsByTab, fieldId,
  formatAvg, formatTime12, formatValue, getIn, gradesSorted, groupChanges, groupWarnings, hoursSummary, insertAtCursor, moveItem, pathCandidates, pathLabel, pathTab, removeAt,
  scoreTone, scriptSource, setIn, statTiles, toggleDay, uniqueId, unknownVariables, visibleChanges,
} from '../lib/voice-agent-console';
import { audioSrc } from '../lib/voice-agent-client';
import { DEMO_CALLS, DEMO_SCENARIOS, DEMO_SCRIPT, DEMO_VOICES, createDemoApi, demoScore, demoTestSession } from '../lib/voice-agent-demo';
import { isSupabaseWrite } from '../lib/read-only';

let passed = 0;
const queue: Promise<void>[] = [];
const test = (name: string, fn: () => void | Promise<void>) => {
  try {
    const r = fn();
    if (r) queue.push(r.then(() => { passed++; }, (e) => { console.error('FAIL', name); throw e; }));
    else passed++;
  } catch (e) { console.error('FAIL', name); throw e; }
};

const ok: AgentSettings = normalizeSettings({ identity: { name: 'Sam', company: 'Acme Homes' } });
const withSettings = (patch: (s: AgentSettings) => void): AgentSettings => { const s = structuredClone(ok); patch(s); return s; };

// ---- the function's answers ------------------------------------------------------------

test('an error body wins even on a 200, and names the reason', () => {
  assert.deepEqual(interpretReply({ error: 'Not a workspace admin' }, null), { ok: false, error: 'Not a workspace admin' });
});
test('a non-2xx keeps the function\'s own error over the transport text', () => {
  assert.deepEqual(interpretReply({ error: 'ELEVENLABS_API_KEY is not set' }, 'Edge Function returned a non-2xx status code'), { ok: false, error: 'ELEVENLABS_API_KEY is not set' });
});
test('a 422 keeps its errors[] so each can land on its field', () => {
  assert.deepEqual(interpretReply({ error: 'a; b', errors: ['a', 'b', 3] }, null), { ok: false, error: 'a; b', errors: ['a', 'b'] });
});
test('a call that never reached the function says it is not deployed', () => {
  const r = interpretReply(null, 'Failed to send a request to the Edge Function');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /not deployed/);
});
test('ok:false without a reason is still a failure', () => assert.equal(interpretReply({ ok: false }, null).ok, false));
test('an ok body passes its fields through', () => {
  const r = interpretReply({ ok: true, voices: [] }, null);
  assert.equal(r.ok, true);
  assert.deepEqual((r as { data: unknown }).data, { ok: true, voices: [] });
});

// ---- reading settings ---------------------------------------------------------------------

test('a bare object reads as the defaults, and nothing throws on junk', () => {
  assert.deepEqual(normalizeSettings({}), defaultSettings());
  assert.deepEqual(normalizeSettings(null), defaultSettings());
  assert.deepEqual(normalizeSettings('nope'), defaultSettings());
  const s = normalizeSettings({ identity: 'x', rules: { dos: 'no', compliance: 5 }, tools: { transfer: { enabled: 'yes' } }, personality: { tone: 'shouty' } });
  assert.equal(s.personality.tone, 'warm');
  assert.deepEqual(s.rules.dos, []);
  assert.equal(s.tools.transfer.enabled, true);
});
test('numbers are clamped to what the server allows, and rounded', () => {
  const s = normalizeSettings({
    personality: { energy: 9, humor: -2, warmth: '4' }, offer_authority: { step_size_pct: 0.1, floor_pct_of_mao: 10 },
    call_handling: { max_call_seconds: 10, silence_timeout_s: 999, first_response_delay_ms: 9999, interruption_sensitivity: 0 },
  });
  assert.deepEqual([s.personality.energy, s.personality.humor, s.personality.warmth], [5, 0, 4]);
  assert.deepEqual([s.offer_authority.step_size_pct, s.offer_authority.floor_pct_of_mao], [0.5, 50]);
  assert.deepEqual([s.call_handling.max_call_seconds, s.call_handling.silence_timeout_s, s.call_handling.first_response_delay_ms, s.call_handling.interruption_sensitivity], [60, 300, 3000, 1]);
  assert.equal(normalizeSettings({ offer_authority: { floor_pct_of_mao: 101 } }).offer_authority.floor_pct_of_mao, 100);
});
test('the two compliance locks read as on whatever they are sent', () => {
  const c = normalizeSettings({ rules: { compliance: { honor_dnc: false, ai_disclosure_when_asked: false } } }).rules.compliance;
  assert.equal(c.honor_dnc, true);
  assert.equal(c.ai_disclosure_when_asked, true);
});
test('a tool is available only when the server said so', () => {
  const s = normalizeSettings({ tools: { lead_context: { enabled: true, available: true }, book_appointment: { enabled: true } } });
  assert.equal(s.tools.lead_context.available, true);
  assert.equal(s.tools.book_appointment.available, false);
  assert.equal(s.tools.book_appointment.enabled, true);
  assert.deepEqual(Object.keys(s.tools), [...TOOL_KEYS]);
});
test('list items lose their empties, and ids that repeat are renumbered', () => {
  const s = normalizeSettings({
    rules: { dos: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two', severity: 'soft' }, { id: 'b', text: '   ' }], donts: [{ text: 'x', severity: 'weird' }] },
    script: { sections: [{ id: 's', title: '', body: '' }, { id: 's', title: 'T', body: '', enabled: false }] },
    knowledge: { faqs: [{ q: 'q', a: '' }, { q: 'q', a: 'a' }], company_facts: ['x', ' ', 'y'] },
  });
  assert.deepEqual(s.rules.dos.map((r) => [r.id, r.severity]), [['a', 'hard'], ['a_2', 'soft']]);
  assert.equal(s.rules.donts[0]!.severity, 'hard');
  assert.deepEqual(s.script.sections.map((x) => [x.id, x.enabled]), [['s', false]]);
  assert.equal(s.knowledge.faqs.length, 1);
  assert.deepEqual(s.knowledge.company_facts, ['x', 'y']);
});
test('destinations: phones normalize, the type defaults, the ring time is clamped, hours keep their day order', () => {
  const d = normalizeSettings({ live_transfer: { destinations: [
    { label: '', number: '(512) 555-0142', type: 'nope', ring_timeout_s: 500, hours: { days: ['fri', 'mon'], start: '09:00', end: '17:00', tz: 'America/Denver' } },
    { id: 'rep', type: 'rep_assigned', number: '' },
  ] } }).live_transfer.destinations;
  assert.equal(d[0]!.number, '+15125550142');
  assert.equal(d[0]!.label, 'Destination 1');
  assert.equal(d[0]!.type, 'fixed');
  assert.equal(d[0]!.ring_timeout_s, 60);
  assert.deepEqual(d[0]!.hours!.days, ['mon', 'fri']);
  assert.equal(d[1]!.type, 'rep_assigned');
  assert.equal(d[1]!.hours, undefined);
});
test('chips are trimmed, capped and never repeat regardless of case', () => {
  assert.deepEqual(addChip(['Probate'], '  probate '), ['Probate']);
  assert.deepEqual(addChip([], '  Foreclosure   notice '), ['Foreclosure notice']);
  assert.deepEqual(addChip([], '   '), []);
  const full = Array.from({ length: LIMITS.neverMentionCount }, (_, i) => 'topic ' + i);
  assert.equal(addChip(full, 'one more'), full);
  assert.equal(addChip([], 'x'.repeat(200))[0]!.length, 80);
  assert.deepEqual(normalizeSettings({ rules: { never_mention: ['A', 'a', ' B '] } }).rules.never_mention, ['A', 'B']);
});
test('languages: two letters or two-two, lower then upper case, no repeats, five at most', () => {
  assert.deepEqual(addLanguage(['en'], ' ES '), ['en', 'es']);
  assert.deepEqual(addLanguage(['en'], 'pt-br'), ['en', 'pt-BR']);
  assert.deepEqual(addLanguage(['en'], 'english'), ['en']);
  assert.deepEqual(addLanguage(['en'], 'EN'), ['en']);
  assert.equal(addLanguage(['a1', 'b1', 'c1', 'd1', 'e1'], 'fr').length, 5);
});
test('phones: US formats normalize, garbage is refused, empty means none', () => {
  assert.equal(normalizePhone('(512) 555-0142'), '+15125550142');
  assert.equal(normalizePhone('1 512 555 0142'), '+15125550142');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('555-0142'), null);
  assert.equal(normalizePhone(''), null);
});

// ---- saving, and what counts as a change ---------------------------------------------------------------

test('the payload carries every group and never the server-owned available flag', () => {
  const p = savePayload(ok) as Record<string, Record<string, unknown>>;
  for (const k of ['identity', 'voice', 'personality', 'script', 'rules', 'offer_authority', 'call_handling', 'live_transfer', 'tools', 'knowledge', 'channels']) assert.ok(k in p, k);
  assert.deepEqual(Object.keys(p.tools!.lead_context as object), ['enabled']);
  assert.equal(p.voice!.stability, null);
});
test('dirty: identical is clean, whitespace-only edits are clean, real edits are dirty', () => {
  assert.equal(isDirty(ok, structuredClone(ok)), false);
  assert.equal(isDirty(ok, withSettings((s) => { s.identity.name = 'Sam  '; })), false);
  assert.equal(isDirty(ok, withSettings((s) => { s.identity.name = 'Sky'; })), true);
  assert.equal(isDirty(ok, withSettings((s) => { s.personality.tone = 'direct'; })), true);
  assert.equal(isDirty(ok, withSettings((s) => { s.voice.voice_id = 'voice_two'; })), true);
});
test('dirty: a new rule with no text is not a change until it has text', () => {
  const blank = withSettings((s) => { s.rules.dos.push({ id: 'do_1', text: '  ', severity: 'soft' }); });
  assert.equal(isDirty(ok, blank), false);
  const typed = withSettings((s) => { s.rules.dos.push({ id: 'do_1', text: 'Ask one question at a time.', severity: 'soft' }); });
  assert.equal(isDirty(ok, typed), true);
});
test('dirty: reordering, toggling and changing strictness all count', () => {
  const two = withSettings((s) => { s.script.sections = [{ id: 'a', title: 'A', body: 'x', enabled: true }, { id: 'b', title: 'B', body: 'y', enabled: true }]; });
  assert.equal(isDirty(two, withSettings((s) => { s.script.sections = [...two.script.sections].reverse(); })), true);
  assert.equal(isDirty(two, withSettings((s) => { s.script.sections = two.script.sections.map((x) => ({ ...x, enabled: x.id === 'a' })); })), true);
  const rule = withSettings((s) => { s.rules.donts = [{ id: 'r', text: 'Never x', severity: 'hard' }]; });
  assert.equal(isDirty(rule, withSettings((s) => { s.rules.donts = [{ id: 'r', text: 'Never x', severity: 'soft' }]; })), true);
});
test('dirty: a phone typed in another format is the same number, and available flags are not edits', () => {
  const a = withSettings((s) => { s.live_transfer.destinations = [{ id: 'd', label: 'Office', number: '+15125550142', type: 'fixed', ring_timeout_s: 25 }]; });
  assert.equal(isDirty(a, withSettings((s) => { s.live_transfer.destinations = [{ id: 'd', label: 'Office', number: '(512) 555-0142', type: 'fixed', ring_timeout_s: 25 }]; })), false);
  assert.equal(isDirty(ok, withSettings((s) => { s.tools.transfer.available = !s.tools.transfer.available; })), false);
});
test('dirty: an empty prompt override is no override', () => {
  assert.equal(isDirty(ok, withSettings((s) => { s.script.raw_prompt_override = ''; })), false);
  assert.equal(isDirty(ok, withSettings((s) => { s.script.raw_prompt_override = 'You are Sam.'; })), true);
});

// ---- validation -------------------------------------------------------------------------------

test('a named company is a valid draft, and so is an empty one (the server only warns about a missing name)', () => {
  assert.equal(hasErrors(validateSettings(ok)), false);
  assert.equal(hasErrors(validateSettings(defaultSettings())), false);
});
test('text past its limit says by how much, keyed by the field path', () => {
  const e = validateSettings(withSettings((s) => {
    s.script.sections = [{ id: 'a', title: 't', body: 'x'.repeat(LIMITS.sectionBody + 1), enabled: true }];
    s.rules.dos = [{ id: 'd', text: 'y'.repeat(LIMITS.ruleText + 12), severity: 'soft' }];
    s.identity.name = 'n'.repeat(LIMITS.name + 3);
  }));
  assert.match(e['script.sections[a].body'] ?? '', /^1 characters over the 8,000 limit/);
  assert.match(e['rules.dos[d].text'] ?? '', /^12 characters over/);
  assert.match(e['identity.name'] ?? '', /^3 characters over/);
});
test('hours: real times, a zone, a window that is not zero wide, and at least one day', () => {
  const h = (start: string, end: string, tz = 'America/Chicago', days: string[] = ['mon']) => hoursProblem({ start, end, tz, days });
  assert.equal(h('08:00', '21:00'), null);
  assert.equal(h('22:00', '06:00'), null);
  assert.match(h('', '21:00') ?? '', /start and an end/);
  assert.match(h('25:00', '21:00') ?? '', /start and an end/);
  assert.match(h('09:00', '09:00') ?? '', /cannot be the same/);
  assert.match(h('08:00', '21:00', ' ') ?? '', /time zone/);
  assert.equal(h('08:00', '21:00', 'America/Chicago', []), 'Pick at least one day.');
});
test('call hours and quiet hours report their own path when unusable', () => {
  const e = validateSettings(withSettings((s) => { s.call_handling.call_hours.days = []; s.rules.compliance.quiet_hours.start = '09:00'; s.rules.compliance.quiet_hours.end = '09:00'; }));
  assert.equal(e['call_handling.call_hours'], 'Pick at least one day.');
  assert.ok(e['rules.compliance.quiet_hours']);
  assert.equal(validateSettings(withSettings((s) => { s.rules.compliance.quiet_hours = { enabled: false, start: '09:00', end: '09:00', tz: 'America/Chicago' }; }))['rules.compliance.quiet_hours'], undefined);
});
test('destinations need a number unless the assigned rep is dialed', () => {
  const mk = (type: 'fixed' | 'rep_assigned' | 'ring_group', number: string) => validateSettings(withSettings((s) => { s.live_transfer.destinations = [{ id: 'd', label: 'x', number, type, ring_timeout_s: 25 }]; }));
  assert.equal(mk('rep_assigned', '')['live_transfer.destinations[d].number'], undefined);
  assert.equal(mk('fixed', '')['live_transfer.destinations[d].number'], 'Add the number to dial.');
  assert.match(mk('fixed', '555-0142')['live_transfer.destinations[d].number'] ?? '', /full number/);
  assert.equal(mk('ring_group', '(512) 555-0142')['live_transfer.destinations[d].number'], undefined);
});
test('transfer on with no destination is guidance, not a reason to refuse the save', () => {
  const e = validateSettings(withSettings((s) => { s.live_transfer.enabled = true; s.live_transfer.destinations = []; }));
  assert.ok(e['live_transfer.destinations']);
  assert.equal(hasErrors(blockingErrors(e)), false);
  const hard = validateSettings(withSettings((s) => { s.identity.name = 'n'.repeat(60); }));
  assert.equal(hasErrors(blockingErrors(hard)), true);
});

// ---- what the server refused ---------------------------------------------------------------------------

const withLists = withSettings((s) => {
  s.rules.dos = [{ id: 'a', text: 'one', severity: 'soft' }, { id: 'b', text: 'two', severity: 'soft' }];
  s.script.sections = [{ id: 'job', title: 'Job', body: 'x', enabled: true }];
  s.live_transfer.destinations = [{ id: 'main', label: 'Main', number: '+15125550142', type: 'fixed', ring_timeout_s: 25 }];
});
test('a position in a list becomes the item id, and anything else is left alone', () => {
  assert.equal(indexPathToId('rules.dos[1].text', withLists), 'rules.dos[b].text');
  assert.equal(indexPathToId('live_transfer.destinations[0].number', withLists), 'live_transfer.destinations[main].number');
  assert.equal(indexPathToId('rules.dos[7].text', withLists), 'rules.dos[7].text');
  assert.equal(indexPathToId('rules.never_mention[0]', withLists), 'rules.never_mention[0]');
  assert.equal(indexPathToId('identity.name', withLists), 'identity.name');
});
test('each 422 line lands on the field it starts with', () => {
  const f = serverErrorsToFields([
    'script.sections[job] tells the agent to deny being an AI ("hide that you are a bot"), which is not allowed',
    'rules.dos[0].severity must be hard or soft',
    'voicemail.message_template tells the agent to deny being an AI ("lie about the recording"), which is not allowed',
    'identity.languages[0] must be a language code such as en or es',
    'settings must be an object',
  ], withLists);
  assert.match(f['script.sections[job]'] ?? '', /^Tells the agent to deny being an AI/);
  assert.equal(f['rules.dos[a].severity'], 'Must be hard or soft');
  assert.match(f['call_handling.voicemail.message_template'] ?? '', /deny being an AI/);
  assert.match(f['identity.languages[0]'] ?? '', /language code/);
  assert.equal(f._general, 'settings must be an object');
});
test('two refusals on one field are both kept', () => {
  const f = serverErrorsToFields(['rules.dos[0].text is a', 'rules.dos[0].text is b'], withLists);
  assert.equal(f['rules.dos[a].text'], 'Is a Is b');
});

// ---- where a path lives on screen -------------------------------------------------------------------------

test('a settings path belongs to the tab that edits it', () => {
  assert.equal(pathTab('identity.name'), 'identity');
  assert.equal(pathTab('rules.dos[a].text'), 'rules');
  assert.equal(pathTab('rules.compliance.quiet_hours'), 'rules');
  assert.equal(pathTab('offer_authority.mode'), 'offer');
  assert.equal(pathTab('call_handling.call_hours'), 'handling');
  assert.equal(pathTab('channels.inbound'), 'handling');
  assert.equal(pathTab('live_transfer.destinations[main].number'), 'transfer');
  assert.equal(pathTab('tools.book_appointment'), 'tools');
  assert.equal(pathTab('script.sections#order'), 'script');
  assert.equal(pathTab('script'), 'script');
  assert.equal(pathTab('_general'), null);
  assert.equal(pathTab('long_prompt'), null);
});
test('field ids are safe DOM ids and the same for the same path', () => {
  assert.equal(fieldId('rules.dos[no_offer].text'), 'va-f-rules-dos-no_offer-text');
  assert.equal(fieldId('script.sections#order'), 'va-f-script-sections-order');
  assert.equal(fieldId('identity.name'), fieldId('identity.name'));
  assert.match(fieldId('live_transfer.destinations[a b].number'), /^[A-Za-z0-9_-]+$/);
});
test('a path tries itself, then each parent, until a field is on screen', () => {
  assert.deepEqual(pathCandidates('rules.dos[a].text'), ['rules.dos[a].text', 'rules.dos[a]', 'rules.dos', 'rules']);
  assert.deepEqual(pathCandidates('identity.name'), ['identity.name', 'identity']);
  assert.deepEqual(pathCandidates('script.sections#order'), ['script.sections', 'script']);
  assert.deepEqual(pathCandidates('script'), ['script']);
});
test('errors are counted per tab, and a path that is not a setting is not counted', () => {
  assert.deepEqual(errorsByTab({ 'identity.name': 'x', 'identity.company': 'y', 'rules.dos[a].text': 'z', _general: 'q' }), { identity: 2, rules: 1 });
});

// ---- immutable edits and lists -------------------------------------------------------------------------------

test('setIn returns a copy, shares what it did not touch, and reaches into arrays', () => {
  const a = { x: { y: 1 }, z: [1, 2], w: { k: 1 } };
  const b = setIn(a, ['x', 'y'], 2);
  assert.equal(a.x.y, 1);
  assert.equal(b.x.y, 2);
  assert.equal(b.z, a.z);
  assert.deepEqual(setIn(a, ['z', 1], 9).z, [1, 9]);
  assert.deepEqual(a.z, [1, 2]);
  assert.equal(getIn(b, ['x', 'y']), 2);
  assert.equal(getIn(b, ['nope', 'y']), undefined);
});
test('moving an item one step, and refusing at either end', () => {
  const l = [1, 2, 3];
  assert.deepEqual(moveItem(l, 0, 1), [2, 1, 3]);
  assert.deepEqual(moveItem(l, 2, -1), [1, 3, 2]);
  assert.equal(moveItem(l, 0, -1), l);
  assert.equal(moveItem(l, 2, 1), l);
  assert.deepEqual(removeAt(l, 1), [1, 3]);
});
test('a new id is the first free number', () => {
  assert.equal(uniqueId('dont', []), 'dont_1');
  assert.equal(uniqueId('dont', ['dont_1', 'dont_3']), 'dont_2');
});
test('a variable goes where the cursor is, replacing a selection', () => {
  assert.deepEqual(insertAtCursor('Hello  there', 6, 6, '{{first_name}}'), { text: 'Hello {{first_name}} there', cursor: 20 });
  assert.deepEqual(insertAtCursor('Hi NAME!', 3, 7, '{{first_name}}'), { text: 'Hi {{first_name}}!', cursor: 17 });
  assert.deepEqual(insertAtCursor('abc', 99, 99, 'X'), { text: 'abcX', cursor: 4 });
  assert.deepEqual(insertAtCursor('', 0, 0, 'X'), { text: 'X', cursor: 1 });
});
test('a {{name}} the agent does not have is reported once; real and system variables are not', () => {
  assert.deepEqual(unknownVariables('Hi {{first_name}} {{ foo }} {{system__time}} {{foo}} {{Bar}}'), ['foo', 'Bar']);
  assert.deepEqual(unknownVariables('no braces'), []);
  assert.deepEqual(unknownVariables('{{offer_low}} to {{offer_high}}'), []);
});
test('the agent key from a name: a slug, a letter first, never a taken one', () => {
  assert.equal(agentKeyFor('Riley', []), 'riley');
  assert.equal(agentKeyFor('Riley Two!', []), 'riley_two');
  assert.equal(agentKeyFor('Riley', ['riley']), 'riley_2');
  assert.equal(agentKeyFor('   ', []), '');
  assert.equal(agentKeyFor('9 lives', []), '');
  assert.equal(agentKeyFor('A', []), 'a_agent');
  assert.equal(canAddAgent(MAX_AGENTS - 1), true);
  assert.equal(canAddAgent(MAX_AGENTS), false);
});
test('the script the agent gets follows the server\'s order', () => {
  const s = (f: (x: AgentSettings['script']) => void) => { const c = structuredClone(ok.script); f(c); return scriptSource(c); };
  assert.equal(s(() => undefined), 'none');
  assert.equal(s((x) => { x.template_id = 'lead_manager'; }), 'template');
  assert.equal(s((x) => { x.template_id = 'lead_manager'; x.master_script_text = 'm'; }), 'master');
  assert.equal(s((x) => { x.master_script_text = 'm'; x.sections = [{ id: 'a', title: 'A', body: 'b', enabled: true }]; }), 'sections');
  assert.equal(s((x) => { x.sections = [{ id: 'a', title: 'A', body: 'b', enabled: false }]; }), 'none');
  assert.equal(s((x) => { x.raw_prompt_override = 'o'; x.sections = [{ id: 'a', title: 'A', body: 'b', enabled: true }]; }), 'override');
});

// ---- hours -------------------------------------------------------------------------------------------------------

test('toggling a day keeps Monday-first order', () => {
  assert.deepEqual(toggleDay(['mon', 'wed'], 'tue'), ['mon', 'tue', 'wed']);
  assert.deepEqual(toggleDay(['mon', 'wed'], 'mon'), ['wed']);
  assert.deepEqual(toggleDay(['sun'], 'mon'), ['mon', 'sun']);
  assert.deepEqual(toggleDay([], 'sat'), ['sat']);
});
test('days read the way a person would say them', () => {
  assert.equal(daysSummary(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), 'Every day');
  assert.equal(daysSummary(['mon', 'tue', 'wed', 'thu', 'fri']), 'Weekdays');
  assert.equal(daysSummary(['sat', 'sun']), 'Weekends');
  assert.equal(daysSummary(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']), 'Mon to Sat');
  assert.equal(daysSummary(['mon', 'wed', 'fri']), 'Mon, Wed, Fri');
  assert.equal(daysSummary(['mon', 'tue']), 'Mon, Tue');
  assert.equal(daysSummary([]), 'No days');
});
test('times are 12 hour, with midnight and noon right', () => {
  assert.equal(formatTime12('00:00'), '12:00 am');
  assert.equal(formatTime12('12:30'), '12:30 pm');
  assert.equal(formatTime12('21:00'), '9:00 pm');
  assert.equal(formatTime12('08:05'), '8:05 am');
  assert.equal(formatTime12('nope'), 'nope');
});
test('an hours line, overnight noted', () => {
  assert.equal(hoursSummary({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '08:00', end: '21:00', tz: 'America/Chicago' }), 'Mon to Sat, 8:00 am to 9:00 pm, America/Chicago');
  assert.match(hoursSummary({ start: '22:00', end: '06:00' }), /\(overnight\)/);
  assert.equal(hoursSummary({ start: '09:00', end: '17:00' }), '9:00 am to 5:00 pm');
});
test('call hours wider than quiet hours are flagged, only in the same zone and only while quiet hours are on', () => {
  assert.equal(callHoursOutsideQuiet(ok), false);
  assert.equal(callHoursOutsideQuiet(withSettings((s) => { s.call_handling.call_hours.end = '22:00'; })), true);
  assert.equal(callHoursOutsideQuiet(withSettings((s) => { s.call_handling.call_hours.start = '07:00'; })), true);
  assert.equal(callHoursOutsideQuiet(withSettings((s) => { s.call_handling.call_hours.end = '22:00'; s.call_handling.call_hours.tz = 'America/Denver'; })), false);
  assert.equal(callHoursOutsideQuiet(withSettings((s) => { s.call_handling.call_hours.end = '22:00'; s.rules.compliance.quiet_hours.enabled = false; })), false);
});

// ---- diffs -----------------------------------------------------------------------------------------------------

test('a path reads as a breadcrumb, with item ids in quotes', () => {
  assert.equal(pathLabel('rules.dos[stop_bye].text'), 'Rules · Always rules · “stop_bye” · Text');
  assert.equal(pathLabel('call_handling.call_hours.start'), 'Call handling · Call hours · Start');
  assert.equal(pathLabel('script.sections#order'), 'Script · Script sections · Order');
  assert.equal(pathLabel('voice.tts_model'), 'Voice · Speech model');
});
test('values read as one short line', () => {
  assert.equal(formatValue(null), 'empty');
  assert.equal(formatValue(''), 'empty');
  assert.equal(formatValue(true), 'On');
  assert.equal(formatValue(false), 'Off');
  assert.equal(formatValue(5), '5');
  assert.equal(formatValue(['a', 'b']), 'a, b');
  assert.equal(formatValue([]), 'empty');
  const long = formatValue('x'.repeat(200));
  assert.ok(long.length <= 90 && long.endsWith('…'));
});
test('the same leaf-level diff as the server: items by id, so a reworded rule is one change', () => {
  const a = { rules: { dos: [{ id: 'x', text: 'one' }, { id: 'y', text: 'two' }] }, n: 1 };
  const b = { rules: { dos: [{ id: 'x', text: 'ONE' }, { id: 'y', text: 'two' }] }, n: 1 };
  assert.deepEqual(diffSettings(a, b), [{ path: 'rules.dos[x].text', from: 'one', to: 'ONE' }]);
  assert.deepEqual(diffSettings(a, a), []);
  const c = diffSettings(a, { rules: { dos: [{ id: 'y', text: 'two' }, { id: 'x', text: 'one' }] }, n: 1 });
  assert.deepEqual(c.map((x) => x.path), ['rules.dos#order']);
});
test('prompt lines: only whole lines that are on one side', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc\nd'), { added: ['B', 'd'], removed: ['b'] });
  assert.deepEqual(diffLines('a', 'a'), { added: [], removed: [] });
  assert.deepEqual(diffLines('a\n\n', 'a'), { added: [], removed: [] });
});
test('empty lists turning into items, and items coming or going, are not shown as changes of the list itself', () => {
  const noisy = diffSettings({ r: { dos: [] } }, { r: { dos: [{ id: 'a', text: 'x' }] } });
  assert.ok(noisy.length > 1);
  assert.deepEqual(visibleChanges(noisy), [{ path: 'r.dos[a]', from: null, to: 'x' }]);
  const removed = diffSettings({ r: { dos: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] } }, { r: { dos: [{ id: 'b', text: 'y' }] } });
  assert.deepEqual(visibleChanges(removed), [{ path: 'r.dos[a]', from: 'x', to: null }]);
  const reorder = diffSettings({ r: [{ id: 'a' }, { id: 'b' }] }, { r: [{ id: 'b' }, { id: 'a' }] });
  assert.deepEqual(visibleChanges(reorder).map((c) => c.path), ['r#order']);
});
test('a change is described as added, removed or changed, with its tab', () => {
  assert.deepEqual(describeChange({ path: 'rules.dos[a].text', from: null, to: 'x' }), { path: 'rules.dos[a].text', tab: 'rules', group: 'Rules', label: 'Rules · Always rules · “a” · Text', from: 'empty', to: 'x', kind: 'added' });
  assert.equal(describeChange({ path: 'identity.name', from: 'Sam', to: null }).kind, 'removed');
  assert.equal(describeChange({ path: 'identity.name', from: 'Sam', to: 'Sky' }).kind, 'changed');
});
test('changes group by tab in the order they first appear, and summarize in a line', () => {
  const ch = [
    { path: 'rules.dos[a].text', from: 'a', to: 'b' }, { path: 'script.sections[s].body', from: 'a', to: 'b' }, { path: 'rules.donts[d].severity', from: 'hard', to: 'soft' },
  ];
  const g = groupChanges(ch);
  assert.deepEqual(g.map((x) => [x.group, x.items.length]), [['Rules', 2], ['Script', 1]]);
  assert.equal(changeSummary(ch), '3 changes in Rules and Script.');
  assert.equal(changeSummary([]), 'No changes to the settings.');
  assert.equal(changeSummary([ch[0]!]), '1 change in Rules.');
  assert.equal(changeSummary([...ch, { path: 'voice.speed', from: null, to: 1.1 }, { path: 'identity.name', from: 'a', to: 'b' }]), '5 changes in Rules, Script and 2 more.');
});
test('the tabs with unsaved edits are the ones whose settings differ', () => {
  const draft = withSettings((s) => { s.identity.name = 'Sky'; s.rules.dos.push({ id: 'd', text: 'x', severity: 'soft' }); s.call_handling.max_call_seconds = 480; });
  assert.deepEqual([...dirtyTabs(ok, draft)].sort(), ['handling', 'identity', 'rules']);
  assert.equal(dirtyTabs(ok, structuredClone(ok)).size, 0);
});
test('warnings split into things to fix and notes', () => {
  const g = groupWarnings([{ code: 'a', level: 'info', message: 'i', path: null }, { code: 'b', level: 'warning', message: 'w', path: 'identity.name' }]);
  assert.deepEqual([g.warnings.map((w) => w.code), g.notes.map((w) => w.code)], [['b'], ['a']]);
});

// ---- reading the function's other answers ----------------------------------------------------------------------

test('agent status: draft until published, unpublished when the draft moved on', () => {
  assert.equal(agentStatus({ status: 'draft', live_version: 0, has_unpublished_changes: true }), 'draft');
  assert.equal(agentStatus({ status: 'live', live_version: 0, has_unpublished_changes: false }), 'draft');
  assert.equal(agentStatus({ status: 'live', live_version: 3, has_unpublished_changes: true }), 'unpublished');
  assert.equal(agentStatus({ status: 'live', live_version: 3, has_unpublished_changes: false }), 'live');
  assert.equal(roleLabel('lead_manager'), 'Lead manager');
  assert.equal(roleLabel('jr_dispo'), 'Dispositions');
  assert.equal(roleLabel('closer_2'), 'Closer 2');
  assert.equal(roleLabel(''), 'Agent');
});
test('get: a sparse body reads as safe defaults, never throws', () => {
  const d = normalizeDetail({ agent_key: 'a', status: 'live', live_version: '3', settings: { identity: { name: 'Sam' } }, can_edit: true, live_settings: null, checks: { agent: true, tool: 'yes' } });
  assert.equal(d.settings.identity.name, 'Sam');
  assert.equal(d.live_settings, null);
  assert.equal(d.live_version, 3);
  assert.equal(d.can_edit, true);
  assert.equal(d.checks.agent, true);
  assert.equal(d.checks.tool, false);
  assert.equal(d.enabled, false);
  assert.deepEqual(normalizeDetail(undefined).webhook_urls, { personalize: '', tool: '', post_call: '' });
  assert.equal(normalizeDetail({}).can_edit, false);
});
test('the agent list keeps agents with a key and drops the rest', () => {
  const a = normalizeAgents([{ agent_key: 'lead_manager', name: 'Sam', enabled: true }, { name: 'no key' }, null]);
  assert.deepEqual(a.map((x) => x.agent_key), ['lead_manager']);
  assert.equal(a[0]!.enabled, true);
  assert.deepEqual(normalizeAgents('nope'), []);
});
test('every check the function reports has a row in the checklist', () => {
  assert.deepEqual(CHECK_ROWS.map((c) => c.key), ['api_key', 'agent', 'personalize_webhook', 'tool', 'post_call_webhook']);
});
test('a publish keeps its checks, manual steps and errors', () => {
  const p = normalizePublish({ version: 4, live_version: 4, agent_key: 'a', agent_id: 'ag1', checks: { agent: true }, manual: [{ step: 's', value_to_paste: 'v', where: 'w' }, { value_to_paste: 'x' }], errors: [{ step: 'tts', message: 'fell back' }, { step: 'x' }], tts_model_used: 'eleven_flash_v2_5' });
  assert.equal(p.version, 4);
  assert.deepEqual(p.manual, [{ step: 's', value_to_paste: 'v', where: 'w' }]);
  assert.deepEqual(p.errors, [{ step: 'tts', message: 'fell back' }]);
  assert.equal(p.checks.agent, true);
  assert.equal(p.tts_model_used, 'eleven_flash_v2_5');
  assert.deepEqual(normalizeConnectErrors([{ step: 'tts_model', message: 'fell back' }, { step: 'x' }, null]), [{ step: 'tts_model', message: 'fell back' }]);
});
test('a prompt preview keeps warning levels and paths', () => {
  const p = normalizePreview({ prompt: 'x', tokens: '12', warnings: [{ code: 'missing_name', level: 'warning', message: 'm', path: 'identity.name' }, { code: 'i', level: 'weird', message: 'n' }, { code: 'z' }], not_applied: ['a', 3] });
  assert.equal(p.tokens, 12);
  assert.deepEqual(p.warnings.map((w) => [w.level, w.path]), [['warning', 'identity.name'], ['warning', null]]);
  assert.deepEqual(p.not_applied, ['a']);
});
test('versions and diffs read cleanly', () => {
  const v = normalizeVersions({ live_version: 3, versions: [{ version: 3, note: 'n', created_at: 't', is_live: true, prompt_tokens: 900 }, { version: 0 }, {}] });
  assert.equal(v.versions.length, 1);
  assert.equal(v.versions[0]!.is_live, true);
  const d = normalizeDiff({ from: 'v1', to: 'draft', changes: [{ path: 'a.b', from: undefined, to: 1 }, { from: 1 }], prompt: { added: ['x', 2], removed: [], tokens_from: 10, tokens_to: 12 } });
  assert.deepEqual(d.changes, [{ path: 'a.b', from: null, to: 1 }]);
  assert.deepEqual(d.prompt.added, ['x']);
});
test('stats read as counts, with the basis kept for the footnote', () => {
  const s = normalizeStats({ days: 30, agents: [{ agent_key: 'a', calls: '4', avg_duration_s: 61.4, booked: 0 }, { calls: 1 }], totals: { calls: 4 }, basis: { booked_and_transferred: 'exact', x: 5 } });
  assert.equal(s.agents.length, 1);
  assert.deepEqual([s.agents[0]!.calls, s.agents[0]!.avg_duration_s, s.agents[0]!.transferred], [4, 61, 0]);
  assert.deepEqual(s.basis, { booked_and_transferred: 'exact' });
  assert.equal(normalizeStats(undefined).days, 30);
});
test('the stat tiles: six numbers, zeros for an agent with no row', () => {
  const t = statTiles(undefined);
  assert.deepEqual(t.map((x) => x.key), ['calls', 'avg', 'booked', 'transferred', 'dnc', 'ni']);
  assert.deepEqual(t.map((x) => x.value), ['0', '–', '0', '0', '0', '0']);
  assert.equal(statTiles({ agent_key: 'a', calls: 42, avg_duration_s: 187, booked: 0, transferred: 6, dnc_requests: 2, not_interested: 9 })[1]!.value, '3:07');
  assert.equal(formatAvg(0), '–');
});
test('scenarios need an id and a checklist; a score falls back to counting its items', () => {
  const sc = normalizeScenarios([{ id: 'a', title: 'A', summary: 's', persona: 'p', checklist: [{ id: 'c', text: 't' }, { text: 'no id' }] }, { id: 'b', checklist: [] }, { checklist: [{ id: 'c' }] }]);
  assert.equal(sc.length, 1);
  assert.equal(sc[0]!.audience, 'seller');
  const buy = normalizeScenarios([{ id: 'x', audience: 'buyer', checklist: [{ id: 'c', text: 't' }] }, { id: 'y', audience: 'any', checklist: [{ id: 'c', text: 't' }] }]);
  assert.deepEqual(buy.map((s) => [scenarioFits(s, 'seller'), scenarioFits(s, 'buyer')]), [[false, true], [true, true]]);
  assert.equal(sc[0]!.checklist.length, 1);
  const r = normalizeScore({ items: [{ id: 'a', pass: true }, { id: 'b', pass: false, quote: 'q', quote_found: true }] });
  assert.deepEqual([r.passed, r.total, r.score], [1, 2, 50]);
  assert.equal(normalizeScore({ passed: 3, total: 4, score: 75, items: [] }).score, 75);
});
test('scores are green from 80, amber from 50, and failed items sort first', () => {
  assert.deepEqual([scoreTone(100), scoreTone(80), scoreTone(79), scoreTone(50), scoreTone(49)], ['good', 'good', 'mid', 'mid', 'bad']);
  const g = gradesSorted([{ id: 'a', text: '', pass: true, quote: '', note: '', quote_found: false }, { id: 'b', text: '', pass: false, quote: '', note: '', quote_found: false }, { id: 'c', text: '', pass: true, quote: '', note: '', quote_found: false }]);
  assert.deepEqual(g.map((x) => x.id), ['b', 'a', 'c']);
});
test('templates and calls read cleanly', () => {
  assert.deepEqual(normalizeTemplates([{ id: 'lead_manager', name: 'Lead manager', open_items: ['a', 2] }, { name: 'x' }]).map((t) => [t.id, t.open_items.length]), [['lead_manager', 1]]);
  const c = normalizeCalls([{ id: 1, occurred_at: '2026-09-29T10:00:00Z', duration_s: '61.4', record_kind: 'buyer', record_id: '7', conversation_id: 'conv_1' }, { duration_s: 3 }, { id: 'c2', record_kind: 'vendor', record_id: 0 }]);
  assert.equal(c.length, 2);
  assert.deepEqual([c[0]!.id, c[0]!.conversation_id, c[0]!.started_at, c[0]!.duration_s, c[0]!.record_kind, c[0]!.record_id], ['1', 'conv_1', '2026-09-29T10:00:00Z', 61, 'buyer', 7]);
  assert.deepEqual([c[1]!.record_kind, c[1]!.record_id, c[1]!.conversation_id], [null, null, null]);
});
test('voices drop rows with no id and keep only string labels', () => {
  const v = normalizeVoices([{ voice_id: '', name: 'x' }, { voice_id: 'a', name: 'Ann', labels: { gender: 'female', n: 4 }, preview_url: 'https://x/y.mp3' }, null]);
  assert.equal(v.length, 1);
  assert.deepEqual(v[0]!.labels, { gender: 'female' });
  assert.equal(v[0]!.preview_url, 'https://x/y.mp3');
  assert.deepEqual(normalizeVoices('nope'), []);
});

// ---- voices and tuning -----------------------------------------------------------------------------------------

test('voice search matches name, category and any label, all words at once', () => {
  assert.deepEqual(filterVoices(DEMO_VOICES, 'george').map((v) => v.name), ['George']);
  assert.ok(filterVoices(DEMO_VOICES, 'female british').every((v) => v.labels.gender === 'female' && v.labels.accent === 'british'));
  assert.equal(filterVoices(DEMO_VOICES, 'cloned').length, 1);
  assert.equal(filterVoices(DEMO_VOICES, '   ').length, DEMO_VOICES.length);
  assert.equal(filterVoices(DEMO_VOICES, 'zzzz').length, 0);
});
test('traits line: three labels at most, capitalised, no repeats', () => {
  assert.equal(voiceTraits({ voice_id: 'a', name: 'A', category: '', preview_url: null, labels: { gender: 'female', accent: 'american', descriptive: 'calm', age: 'young' } }), 'Female · American · Calm');
  assert.equal(voiceTraits({ voice_id: 'a', name: 'A', category: '', preview_url: null, labels: {} }), '');
});
test('the sample line names the agent and company, with sane fallbacks, and does not announce an AI', () => {
  assert.match(sampleLine({ name: 'Mia', company: 'Acme' }), /this is Mia with Acme/);
  assert.match(sampleLine({ name: '', company: '' }), /this is Sam with our team/);
  assert.doesNotMatch(sampleLine(ok.identity), /AI assistant/);
});
test('an unknown or missing model reads as the default, a known one is kept', () => {
  assert.equal(normalizeSettings({}).voice.tts_model, 'eleven_v4_turbo');
  assert.equal(normalizeSettings({ voice: { tts_model: 'gpt-voice' } }).voice.tts_model, 'eleven_v4_turbo');
  assert.equal(normalizeSettings({ voice: { tts_model: 'eleven_flash_v2_5' } }).voice.tts_model, 'eleven_flash_v2_5');
});
test('tuning is clamped to its range, rounded to 2 places, and null when unset or not a number', () => {
  const s = normalizeSettings({ voice: { stability: 1.7, similarity: 0.123456, speed: 0.2 } }).voice;
  assert.deepEqual([s.stability, s.similarity, s.speed], [1, 0.12, 0.7]);
  const n = normalizeSettings({ voice: { stability: '0.5', speed: null } }).voice;
  assert.deepEqual([n.stability, n.similarity, n.speed], [null, null, null]);
  assert.equal(tuningIsDefault(n), true);
  assert.equal(tuningIsDefault(s), false);
  assert.equal(normalizeSettings({ voice: { speed: 1.9 } }).voice.speed, 1.2);
});
test('changing the model or a slider, or resetting it, moves the dirty flag', () => {
  assert.equal(isDirty(ok, withSettings((s) => { s.voice.tts_model = 'eleven_multilingual_v2'; })), true);
  const fast = withSettings((s) => { s.voice.speed = 1.1; });
  assert.equal(isDirty(ok, fast), true);
  assert.equal(isDirty(fast, withSettings((s) => { s.voice.speed = null; })), true);
  assert.equal(isDirty(fast, structuredClone(fast)), false);
});
test('a model other than the chosen one is flagged, and only then', () => {
  assert.equal(modelDiffers('eleven_v4_turbo', 'eleven_flash_v2_5'), true);
  assert.equal(modelDiffers('eleven_v4_turbo', 'eleven_v4_turbo'), false);
  assert.equal(modelDiffers('eleven_v4_turbo', null), false);
  assert.equal(ttsLabel('eleven_flash_v2_5'), 'Flash v2.5');
  assert.equal(ttsLabel('mystery'), 'mystery');
});

// ---- the test call -----------------------------------------------------------------------------------------------

test('transcript lines number up and skip blanks', () => {
  let l = pushLine([], 'agent', ' hello ');
  l = pushLine(l, 'user', '   ');
  l = pushLine(l, 'user', 'hi');
  assert.deepEqual(l, [{ id: 1, role: 'agent', text: 'hello' }, { id: 2, role: 'user', text: 'hi' }]);
});
test('the meter is empty on silence, never past 100, and shows a sliver for quiet speech', () => {
  assert.equal(levelPercent(0), 0);
  assert.equal(levelPercent(NaN), 0);
  assert.equal(levelPercent(-1), 0);
  assert.equal(levelPercent(0.0001), 4);
  assert.equal(levelPercent(5), 100);
  assert.ok(levelPercent(0.25) > levelPercent(0.05));
});
test('mic failures map to what the person should do', () => {
  assert.equal(micProblem({ name: 'NotAllowedError' }), 'denied');
  assert.equal(micProblem({ name: 'NotFoundError' }), 'missing');
  assert.equal(micProblem({ name: 'NotReadableError' }), 'busy');
  assert.equal(micProblem(new Error('boom')), 'other');
  assert.equal(micProblem(null), 'other');
});
test('variables list reads in rep order and leaves the brief for its own block', () => {
  const v = orderVariables({ zeta: 1, lead_brief: 'long', rep_name: 'Diego', first_name: 'Kara', do_not_engage: false });
  assert.deepEqual(v.map((x) => x.key), ['first_name', 'rep_name', 'do_not_engage', 'zeta']);
  assert.equal(v[2]!.value, 'false');
});
test('variables list hides the lookup token', () => {
  assert.deepEqual(orderVariables({ record_id: '12', record_token: '1800000000.abc', first_name: 'Kara' }).map((x) => x.key), ['first_name', 'record_id']);
});
test('the demo session carries every variable the agent prompt expects, and the opener does not announce an AI', () => {
  const t = demoTestSession(ok, { key: 'lead_manager', version: 3 });
  for (const k of ['first_name', 'property_address', 'lead_brief', 'last_contact_summary', 'next_step', 'rep_name', 'company', 'agent_name', 'caller_known', 'do_not_engage', 'record_kind', 'offer_low', 'offer_high', 'property_facts', 'mortgage_payoff_estimate']) {
    assert.ok(k in t.dynamic_variables, k);
  }
  assert.match(t.first_message, /Acme Homes/);
  assert.doesNotMatch(t.first_message, /AI assistant/);
  assert.equal(t.live_version, 3);
  assert.equal(demoTestSession(ok, { key: 'a', version: 1 }, 'Derek Ross').dynamic_variables.first_name, 'Derek');
  const b = demoTestSession(ok, { key: 'a', version: 1 }, undefined, undefined, 'buyer');
  assert.deepEqual([b.dynamic_variables.record_kind, b.dynamic_variables.first_name, b.dynamic_variables.seller_asking_price], ['buyer', 'Marcus', '']);
  assert.ok(DEMO_SCRIPT.every((l) => !/AI assistant/.test(l.text)));
  assert.ok(DEMO_CALLS.every((c) => !/AI assistant/.test(c.transcript_preview)));
});

// ---- formatting and the rest -------------------------------------------------------------------------------------

test('durations and limits', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(214), '3:34');
  assert.equal(formatDuration(-4), '0:00');
  assert.equal(formatLimit(600), '10 min');
  assert.equal(formatLimit(90), '1 min 30 s');
});
test('time ago, and nothing for a bad date', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(timeAgo('2026-09-29T11:58:00Z', now), '2 min ago');
  assert.equal(timeAgo('2026-09-29T09:00:00Z', now), '3 h ago');
  assert.equal(timeAgo('nope', now), '');
  assert.equal(timeAgo(null, now), '');
});
test('search text loses anything PostgREST would read as syntax', () => {
  assert.equal(cleanQuery('  Kara,(x)  Mitchell% '), 'Kara x Mitchell');
  assert.equal(cleanQuery("O'Brien-Smith"), "O'Brien-Smith");
  assert.equal(cleanQuery('a'.repeat(200)).length, 60);
});
test('preview audio becomes a data URL with the function\'s mime', () => {
  assert.equal(audioSrc({ audio_base64: 'AAA', mime: 'audio/mpeg' }), 'data:audio/mpeg;base64,AAA');
});

// ---- the demo, end to end ------------------------------------------------------------------------------------------

test('the demo has the seller and buyer scenarios and a scripted score with one failing item', () => {
  assert.deepEqual(DEMO_SCENARIOS.map((s) => s.id), ['hostile_seller', 'dnc_mid_call', 'price_dodge', 'wrong_person', 'are_you_a_robot', 'above_range_ask', 'ready_to_sign', 'buyer_buy_box', 'buyer_no_pof', 'buyer_retrade', 'buyer_fishing', 'buyer_ready', 'buyer_middleman']);
  const r = demoScore('price_dodge');
  assert.equal(r.total, 4);
  assert.equal(r.passed, 3);
  assert.equal(r.score, 75);
  assert.equal(r.items.filter((i) => !i.pass).length, 1);
});
test('demo: two agents, one with unpublished changes and one never published; both pass the form\'s own checks', async () => {
  const api = createDemoApi('Acme', 0);
  const list = await api.listAgents();
  assert.ok(list.ok);
  if (!list.ok) return;
  assert.deepEqual(list.data.agents.map((a) => [a.agent_key, agentStatus(a)]), [['lead_manager', 'unpublished'], ['acquisitions', 'draft']]);
  const d = await api.getAgent('lead_manager');
  assert.ok(d.ok && d.data.settings.identity.company === 'Acme' && d.data.live_settings);
  if (d.ok) assert.equal(hasErrors(blockingErrors(validateSettings(d.data.settings))), false);
});
test('demo: publishing makes an agent live, adds a version, and the diff empties', async () => {
  const api = createDemoApi('Acme', 0);
  const before = await api.diff('lead_manager', 'live', 'draft');
  assert.ok(before.ok && before.data.changes.length > 0);
  if (before.ok) {
    const paths = visibleChanges(before.data.changes).map((c) => c.path);
    assert.ok(paths.includes('call_handling.max_call_seconds'));
    assert.ok(paths.includes('rules.dos[acknowledge]'));
  }
  const pub = await api.publish('lead_manager', 'Shorter calls');
  assert.ok(pub.ok && pub.data.version === 4 && pub.data.live_version === 4);
  const after = await api.diff('lead_manager', 'live', 'draft');
  assert.ok(after.ok && after.data.changes.length === 0);
  const v = await api.versions('lead_manager');
  assert.ok(v.ok && v.data.versions[0]!.version === 4 && v.data.versions[0]!.note === 'Shorter calls' && v.data.versions[0]!.is_live);
  const first = await api.publish('acquisitions');
  assert.ok(first.ok && first.data.manual.length > 0 && first.data.version === 1);
  const a = await api.listAgents();
  assert.ok(a.ok && a.data.agents.every((x) => agentStatus(x) === 'live'));
});
test('demo: a rollback is a new version that carries the old settings', async () => {
  const api = createDemoApi('Acme', 0);
  const r = await api.rollback('lead_manager', 1);
  assert.ok(r.ok && r.data.version === 4);
  const d = await api.diff('lead_manager', 1, 'live');
  assert.ok(d.ok && d.data.changes.length === 0);
  const bad = await api.rollback('lead_manager', 99);
  assert.equal(bad.ok, false);
});
test('set_enabled: the reply is read only as a real boolean, and the copy says what the switch does', () => {
  assert.deepEqual(normalizeEnabled({ ok: true, agent_key: 'riley', enabled: false }, 'x'), { agent_key: 'riley', enabled: false });
  assert.deepEqual(normalizeEnabled({ enabled: true }, 'sam'), { agent_key: 'sam', enabled: true });
  for (const bad of ['false', 0, 1, null, undefined]) assert.throws(() => normalizeEnabled({ enabled: bad }, 'sam'));
  assert.throws(() => normalizeEnabled({}, 'sam'));
  assert.match(enabledNote({ enabled: false, live_version: 3 }), /do-not-engage/);
  assert.match(enabledNote({ enabled: false, live_version: 3 }), /Publishing does not turn it back on/);
  assert.match(enabledNote({ enabled: true, live_version: 3 }), /^Answering calls/);
  assert.match(enabledNote({ enabled: false, live_version: 0 }), /first publish/);
  for (const a of [{ enabled: true, live_version: 1 }, { enabled: false, live_version: 1 }, { enabled: false, live_version: 0 }]) assert.equal(enabledNote(a).includes('\u2014'), false);
});
test('demo: switching an agent off sticks, a publish does not turn it back on, and only a first publish switches an agent on', async () => {
  const api = createDemoApi('Acme', 0);
  const off = await api.setEnabled('lead_manager', false);
  assert.ok(off.ok && off.data.enabled === false && off.data.agent_key === 'lead_manager');
  let list = await api.listAgents();
  assert.ok(list.ok && list.data.agents.find((a) => a.agent_key === 'lead_manager')!.enabled === false);
  const pub = await api.publish('lead_manager', 'Still off');
  assert.ok(pub.ok);
  list = await api.listAgents();
  assert.ok(list.ok && list.data.agents.find((a) => a.agent_key === 'lead_manager')!.enabled === false);
  const on = await api.setEnabled('lead_manager', true);
  assert.ok(on.ok && on.data.enabled === true);
  const first = await api.publish('acquisitions');
  assert.ok(first.ok);
  list = await api.listAgents();
  assert.ok(list.ok && list.data.agents.find((a) => a.agent_key === 'acquisitions')!.enabled === true);
  const gone = await api.setEnabled('nope', false);
  assert.equal(gone.ok, false);
});
test('demo: saving text that tells the agent to deny being an AI is refused with an error on the field', async () => {
  const api = createDemoApi('Acme', 0);
  const d = await api.getAgent('lead_manager');
  assert.ok(d.ok);
  if (!d.ok) return;
  const bad = withSettings((s) => { Object.assign(s, structuredClone(d.data.settings)); s.script.sections[0]!.body = 'If asked, hide that you are a bot.'; });
  const r = await api.saveDraft('lead_manager', bad);
  assert.equal(r.ok, false);
  if (r.ok) return;
  const f = serverErrorsToFields(r.errors ?? [], bad);
  assert.match(f[`script.sections[${bad.script.sections[0]!.id}]`] ?? '', /deny being an AI/);
});
test('demo: creating, duplicating and deleting agents, with a ten agent cap', async () => {
  const api = createDemoApi('Acme', 0);
  const made = await api.createAgent({ template: 'acquisitions', name: 'Riley' });
  assert.ok(made.ok && made.data.settings.identity.name === 'Riley' && made.data.settings.offer_authority.mode === 'range_with_approval');
  const dup = await api.duplicateAgent('lead_manager', 'Sam two');
  assert.ok(dup.ok && dup.data.settings.identity.name === 'Sam two' && dup.data.agent.live_version === 0);
  let n = 4;
  for (; n < MAX_AGENTS; n++) assert.ok((await api.createAgent({ name: `A${n}` })).ok);
  const eleventh = await api.createAgent({ template: 'lead_manager' });
  assert.equal(eleventh.ok, false);
  if (!eleventh.ok) assert.match(eleventh.error, /up to 10/);
  const gone = await api.deleteAgent('acquisitions');
  assert.ok(gone.ok && gone.data.remote_deleted === false);
  const list = await api.listAgents();
  assert.ok(list.ok && list.data.agents.length === MAX_AGENTS - 1);
  assert.ok((await api.createAgent({ template: 'lead_manager' })).ok);
});
test('demo: a test call needs a published agent, and a scored call returns the scripted grade', async () => {
  const api = createDemoApi('Acme', 0);
  const no = await api.startTestSession('acquisitions', { sample: 'seller' });
  assert.ok(!no.ok && /Publish the agent first/.test(no.error));
  const yes = await api.startTestSession('lead_manager', { sample: 'seller' });
  assert.ok(yes.ok && yes.data.live_version === 3 && !/AI assistant/.test(yes.data.first_message));
  const sc = await api.scoreCall('lead_manager', 'conv_demo_test01', 'hostile_seller');
  assert.ok(sc.ok && sc.data.total === 4);
  const st = await api.stats(undefined, 30);
  assert.ok(st.ok && st.data.totals.calls === 42 && Object.keys(st.data.basis).length === 2);
});
test('demo: the prompt preview flags a missing name and points at its field', async () => {
  const api = createDemoApi('Acme', 0);
  const made = await api.createAgent({ template: 'lead_manager' });
  assert.ok(made.ok);
  if (!made.ok) return;
  const p = await api.previewPrompt(made.data.agent.agent_key);
  assert.ok(p.ok);
  if (!p.ok) return;
  const w = p.data.warnings.find((x) => x.code === 'missing_name');
  assert.equal(w?.path, 'identity.name');
  assert.equal(pathTab(w?.path ?? ''), 'identity');
  assert.ok(p.data.tokens > 100);
});

// ---- the read-only preview -----------------------------------------------------------------------------------------

test('a read-only preview can read, hear and test the agents but not change, publish or score them', () => {
  const url = 'https://x.supabase.co/functions/v1/voice-agent-admin';
  const w = (action: string) => isSupabaseWrite(url, 'POST', JSON.stringify({ action }));
  for (const a of ['list_agents', 'templates', 'get', 'preview_prompt', 'versions', 'diff', 'scenarios', 'calls', 'stats', 'voices', 'preview', 'test_session']) assert.equal(w(a), false, a);
  for (const a of ['save_draft', 'save_settings', 'connect', 'publish', 'rollback', 'create_agent', 'duplicate_agent', 'delete_agent', 'score_call']) assert.equal(w(a), true, a);
});

await Promise.all(queue);
console.log(`voice-agent: ${passed} passed`);
