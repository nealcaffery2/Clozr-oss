// The AI agent that works a record: who may go on one (never a VIP or a
// fund), the chat, the plan, the next touch and its guard rails, stop words,
// avatars and the report. Run:  npx tsx supabase/functions/_shared/ai-agent.test.ts
//   or: deno run supabase/functions/_shared/ai-agent.test.ts
import {
  MIN_GAP_HOURS, prettyPhone, activityLine, cleanTriggers, deciderSystem, handoffDue, handoffTarget, isQualified, mayQualify, relayPatch, aggregateActions, appendChat, asksToStop, audienceForRole, audienceServes, avatarPrompt, cleanChannels, eligibility,
  firstLookAt, gateDecision, humanize, instructionsFrom, mentionsMoney, nextLookAt, parseDecision, parsePlan, protectedBuyer, readChat, sanitizeSvg, styleBlock, svgDataUri,
  type ChatTurn, type Decision,
} from './ai-agent.ts';
import { defaultSettings, normalizeSettings } from './voice-agent-settings.ts';
import { TEMPLATES } from './voice-agent-templates.ts';
import { assemblePrompt } from './voice-agent-prompt.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; } else console.log(`PASS  ${name}`);
}
function ok(name: string, cond: boolean, detail?: unknown) { eq(name, cond ? true : { failed: detail ?? null }, true); }

const CT = 'America/Chicago';
// Tuesday 2026-10-06 10:00 Central (15:00Z).
const NOW = Date.parse('2026-10-06T15:00:00Z');

// ---- who may go on an agent ----
eq('a VIP buyer is protected', !!protectedBuyer({ vip: true }), true);
eq('a fund or institutional buyer is protected, by type or entity, any case', [protectedBuyer({ buyer_type: 'fund' }), protectedBuyer({ entity_type: 'Fund' }), protectedBuyer({ buyer_type: 'Institutional ' })].every((x) => !!x), true);
eq('an ordinary buyer is not', [protectedBuyer({ vip: false, buyer_type: 'flipper', entity_type: 'llc' }), protectedBuyer(null)], [null, null]);
eq('audiences', [audienceServes('sellers', 'seller'), audienceServes('sellers', 'buyer'), audienceServes('buyers', 'buyer'), audienceServes('both', 'seller'), audienceServes(null, 'seller'), audienceServes(null, 'buyer')], [true, false, true, true, true, false]);
eq('roles start with the right audience', [audienceForRole('buyer_assistant'), audienceForRole('jr_dispo'), audienceForRole('lead_manager'), audienceForRole('custom')], ['buyers', 'buyers', 'sellers', 'sellers']);
eq('channels: known ones, ordered, no repeats; empty falls back', [cleanChannels(['email', 'SMS', 'fax', 'sms']), cleanChannels([]), cleanChannels('call')], [['sms', 'email'], ['sms', 'email'], ['sms', 'email']]);
const reachAll = { phone: true, email: true, call: true };
const base = { kind: 'buyer' as const, record: { vip: false }, dnc: false, audience: 'buyers', channels: ['sms' as const], reach: reachAll };
eq('an ordinary buyer is eligible', eligibility(base), { ok: true });
eq('a VIP is refused before anything else', (eligibility({ ...base, record: { vip: true }, dnc: true }) as { code: string }).code, 'protected');
eq('do not contact is refused', (eligibility({ ...base, dnc: true }) as { code: string }).code, 'dnc');
eq('the wrong audience is refused', (eligibility({ ...base, audience: 'sellers' }) as { code: string }).code, 'audience');
eq('no way to reach them on the chosen channels is refused', (eligibility({ ...base, channels: ['email'], reach: { phone: true, email: false, call: false } }) as { code: string }).code, 'no_reach');
eq('an archived seller is refused', (eligibility({ ...base, kind: 'seller', audience: 'sellers', record: { archived_at: '2026-01-01' } }) as { code: string }).code, 'archived');

// ---- the chat ----
const t0: ChatTurn = { role: 'rep', text: '  Follow up on   the offer\u0000 ', at: 'x' };
let chat = appendChat([], t0);
chat = appendChat(chat, { role: 'agent', text: 'On it.', at: 'y' });
chat = appendChat(chat, { role: 'rep', text: '', at: 'z' });
eq('turns are cleaned and an empty one is dropped', chat.map((c) => c.text), ['Follow up on the offer', 'On it.']);
eq('the chat is capped', appendChat(Array.from({ length: 40 }, (_, i) => ({ role: 'rep' as const, text: String(i), at: '' })), { role: 'agent', text: 'last', at: '' }).length, 40);
eq('instructions are the rep turns, newest last', instructionsFrom([...chat, { role: 'rep', text: 'and text only', at: '' }]), 'Follow up on the offer\nand text only');
eq('readChat drops junk', readChat([{ role: 'rep', text: 'a' }, { role: 'system', text: 'b' }, null, 'x', { role: 'agent', text: 5 }]).map((c) => c.text), ['a']);

// ---- the plan ----
const plan = parsePlan({ summary: 'Warm them up.', goal: 'Book a call', steps: [{ day: 9, channel: 'email', purpose: 'Recap' }, { day: -3, channel: 'sms', purpose: 'Say hi' }, { day: 2, channel: 'call', purpose: 'Call' }, { day: 99, channel: 'sms', purpose: 'Late' }, { day: 1, channel: 'sms', purpose: '' }] }, ['sms', 'email']);
eq('a plan keeps allowed channels, clamps days, sorts, drops empty steps', plan?.steps, [{ day: 0, channel: 'sms', purpose: 'Say hi' }, { day: 9, channel: 'email', purpose: 'Recap' }, { day: 60, channel: 'sms', purpose: 'Late' }]);
eq('nothing usable is no plan', [parsePlan(null, ['sms']), parsePlan({ steps: [] }, ['sms'])], [null, null]);

// ---- the next touch ----
const d = (o: Record<string, unknown>) => parseDecision(o, ['sms', 'email'], { phone: true, email: true, call: false });
eq('a text goes', [d({ action: 'sms', body: 'Hi Ann, it is Riley with Acme Homes.', next_check_hours: 48, reason: 'first touch' }).action, d({ action: 'sms', body: 'x' }).next_check_hours], ['sms', 24]);
eq('a channel that is not on becomes a wait', d({ action: 'call', call_goal: 'x' }).action, 'wait');
eq('a channel that cannot reach them becomes a wait', parseDecision({ action: 'sms', body: 'hi' }, ['sms'], { phone: false, email: true, call: false }).action, 'wait');
eq('nothing to send becomes a wait', d({ action: 'email', body: '  ' }).action, 'wait');
eq('an unknown action becomes a wait', d({ action: 'dance' }).action, 'wait');
ok('a price in writing is held', ['We can do $185,000 cash', 'about 185k', 'our offer is 185,000', 'we could do 150 thousand'].every((b) => d({ action: 'sms', body: b }).action === 'wait'));
ok('...but plain numbers are fine', !mentionsMoney('We close in 14 days. Call me at 2pm.') && d({ action: 'sms', body: 'We can close in 14 days if that helps.' }).action === 'sms');
eq('an email without a subject gets one', d({ action: 'email', body: 'Hello' }).subject, 'Following up');
eq('next check is clamped', [d({ action: 'wait', next_check_hours: 0 }).next_check_hours, d({ action: 'wait', next_check_hours: 9999 }).next_check_hours], [1, 336]);
eq('a long text is cut', d({ action: 'sms', body: 'x'.repeat(900) }).body.length, 480);

const sms: Decision = { action: 'sms', body: 'Hi', subject: '', call_goal: '', next_check_hours: 48, reason: 'r' };
const g = (o: Partial<Parameters<typeof gateDecision>[1]>) => gateDecision(sms, { nowMs: NOW, tz: CT, lastActionAt: null, repliedSince: false, touches: 0, maxTouches: 12, ...o });
eq('inside the window with no recent touch it goes', g({}).action, 'sms');
eq('too soon after the last touch it waits', [g({ lastActionAt: new Date(NOW - 3 * 3_600_000).toISOString() }).action, g({ lastActionAt: new Date(NOW - 3 * 3_600_000).toISOString() }).next_check_hours], ['wait', MIN_GAP_HOURS - 3]);
eq('...unless they replied', g({ lastActionAt: new Date(NOW - 3_600_000).toISOString(), repliedSince: true }).action, 'sms');
eq('outside 9 to 8 it waits', g({ nowMs: Date.parse('2026-10-07T03:30:00Z') }).action, 'wait');
eq('at the cap it finishes', g({ touches: 12 }).action, 'finish');
eq('a wait is never changed', gateDecision({ ...sms, action: 'wait' }, { nowMs: NOW, tz: CT, lastActionAt: null, repliedSince: false, touches: 99, maxTouches: 1 }).action, 'wait');
eq('next look moves into the window', nextLookAt(Date.parse('2026-10-06T23:00:00Z'), 4, CT), '2026-10-07T14:00:00.000Z');
eq('...and stays when it is already inside', nextLookAt(NOW, 2, CT), '2026-10-06T17:00:00.000Z');
eq('switching on looks a minute later inside the window, or at the next opening', [firstLookAt(NOW, CT), firstLookAt(Date.parse('2026-10-07T03:00:00Z'), CT)], ['2026-10-06T15:01:00.000Z', '2026-10-07T14:00:00.000Z']);

// ---- stop words ----
ok('the carrier keywords stop it', ['STOP', 'stop.', ' Unsubscribe ', 'END', 'opt out'].every(asksToStop));
ok('so do the phrases', ['please stop texting me', "don't text me again", 'take me off your list', 'Stop calling me'].every(asksToStop));
ok('an ordinary reply does not', !['I can stop by Tuesday', 'not yet, maybe in spring', 'call me later'].some(asksToStop));

// ---- the agent's voice in writing ----
const s = normalizeSettings({ identity: { name: 'Riley', company: 'Acme Homes' }, rules: { donts: [{ text: 'Never mention the probate' }], forbidden_phrases: ['guaranteed'] }, knowledge: { company_facts: ['We close in as little as 7 days at {{company}}'] } }).settings;
const style = styleBlock(s);
ok('the style block carries rules, forbidden words and facts, with variables resolved', /Never: Never mention the probate|Never: mention the probate/.test(style) && /"guaranteed"/.test(style) && /at Acme Homes/.test(style) && !/\{\{/.test(style), style);
eq('no settings, no style', styleBlock(null), '');

// ---- the timeline ----
eq('a switch names who did it', activityLine('Riley', 'started', 'Plan', 'Sam').title, 'AI agent Riley switched ON by Sam');
eq('an action the agent took does not', activityLine('Riley', 'sms_sent', '"Hi"', 'Sam').title, 'AI agent Riley sent a text');
eq('an unknown action still reads', activityLine('Riley', 'did_a_thing', '').title, 'AI agent Riley did a thing');

// ---- avatars ----
ok('the avatar prompt names the agent and asks for no text', /named Riley/.test(avatarPrompt('Riley', 'buyer_assistant', '')) && /no text/.test(avatarPrompt('Riley', 'x', '')));
ok('a rep\'s description wins', /a fox in a blazer/.test(avatarPrompt('Riley', 'x', 'a fox in a blazer')));
const dirty = `Here you go: <svg viewBox="0 0 256 256" onload="alert(1)"><script>alert(2)</script><circle cx="1" cy="1" r="1" fill="url(https://evil/x)" onclick="x()"/><image href="https://evil/x.png"/><a href="javascript:alert(3)"><rect/></a><use xlink:href="https://evil#a"/><path d="M0 0" fill="url(#g)"/></svg> done`;
const clean = sanitizeSvg(dirty)!;
ok('scripts, handlers, images, links and external urls are gone; internal refs stay', !/script|onload|onclick|<image|<a\b|javascript|evil|<use/i.test(clean) && /url\(#g\)/.test(clean) && clean.startsWith('<svg xmlns='), clean);
eq('not an svg', [sanitizeSvg('hello'), sanitizeSvg('<svg>' + 'x'.repeat(70_000) + '</svg>')], [null, null]);
ok('a data uri round-trips utf-8', svgDataUri('<svg>é</svg>').startsWith('data:image/svg+xml;base64,') && atob(svgDataUri('<svg>é</svg>').split(',')[1]).length === 13);

// ---- the report ----
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const rows = [
  { agent_key: 'riley', action: 'sms_sent', status: 'done', channel: 'sms', record_kind: 'buyer', record_id: 1, created_at: at(1) },
  { agent_key: 'riley', action: 'sms_sent', status: 'done', channel: 'sms', record_kind: 'buyer', record_id: 2, created_at: at(30) },
  { agent_key: 'riley', action: 'sms_sent', status: 'failed', channel: 'sms', record_kind: 'buyer', record_id: 3, created_at: at(2) },
  { agent_key: 'riley', action: 'email_sent', status: 'done', channel: 'email', record_kind: 'buyer', record_id: 1, created_at: at(3) },
  { agent_key: 'riley', action: 'reply_seen', status: 'done', channel: 'sms', record_kind: 'buyer', record_id: 1, created_at: at(4) },
  { agent_key: 'riley', action: 'handoff', status: 'done', channel: 'system', record_kind: 'buyer', record_id: 1, created_at: at(4) },
  { agent_key: 'lm', action: 'call_placed', status: 'done', channel: 'call', record_kind: 'seller', record_id: 9, created_at: at(5) },
  { agent_key: 'lm', action: 'appointment_booked', status: 'done', channel: 'call', record_kind: 'seller', record_id: 9, created_at: at(5) },
];
const rep = aggregateActions(rows, 7, NOW, CT);
const r = rep.find((x) => x.agent_key === 'riley')!;
eq('per-agent counts', [r.texts, r.emails, r.replies, r.handoffs, r.failed, r.records_touched], [2, 1, 1, 1, 1, 2]);
eq('the day axis covers the window, newest last, with touches per day', [r.by_day.length, r.by_day[6].touches, r.by_day[5].touches], [7, 2, 1]);
eq('the voice agent side', (({ calls, booked }) => [calls, booked])(rep.find((x) => x.agent_key === 'lm')!), [1, 1]);

// ---- the buyer assistant template ----
const ba = TEMPLATES.buyer_assistant;
eq('the buyer assistant works buyers and never makes offers', [ba.audience, (ba.settings.offer_authority as { mode: string }).mode, TEMPLATES.lead_manager.audience, TEMPLATES.acquisitions.audience], ['buyers', 'none', 'sellers', 'sellers']);
const baSettings = normalizeSettings({ ...ba.settings, script: { ...(ba.settings.script as object), sections: ba.sections } }, defaultSettings());
eq('the buyer assistant template validates', baSettings.errors, []);
const baPrompt = assemblePrompt(baSettings.settings, TEMPLATES);
ok('its prompt resolves every conditional and books and saves when the tools are on', !/<<|>>/.test(baPrompt) && /call book_appointment to find a real time/.test(baPrompt) && /call save_qualification/i.test(baPrompt));
ok('it never pitches a property or a price', /Never: Pitch a specific property|Never: pitch a specific property/i.test(baPrompt) && /You do not make offers/.test(baPrompt));

// ---- hand-off to the next agent ----
const LM = { agent_key: 'lead_manager', audience: 'sellers', handoff_to: 'acquisitions', handoff_on: ['ready', 'qualified'] };
const ACQ = { agent_key: 'acquisitions', audience: 'sellers', handoff_to: null, handoff_on: ['ready'], enabled: true, live_version: 2 };
const BA = { agent_key: 'buyer_assistant', audience: 'buyers', handoff_to: null, handoff_on: [] };
eq('the next agent is found', handoffTarget(LM, [LM, ACQ, BA], 'seller', []).to?.agent_key, 'acquisitions');
eq('no next agent set: a person', handoffTarget({ ...LM, handoff_to: null }, [LM, ACQ], 'seller', []), { to: null, why: 'no next agent is set' });
eq('a deleted next agent: a person', handoffTarget(LM, [LM], 'seller', []).to, null);
eq('never back to an agent that already worked the run', handoffTarget({ ...ACQ, handoff_to: 'lead_manager' }, [LM, ACQ], 'seller', ['lead_manager']).to, null);
eq('never to an agent that does not work the record', handoffTarget({ ...LM, handoff_to: 'buyer_assistant' }, [LM, BA], 'seller', []).to, null);
eq('never to an agent switched off after going live', handoffTarget(LM, [LM, { ...ACQ, enabled: false }], 'seller', []).to, null);
eq('...but a never-published one can still take it', handoffTarget(LM, [LM, { ...ACQ, enabled: false, live_version: 0 }], 'seller', []).to?.agent_key, 'acquisitions');
eq('triggers are cleaned', [cleanTriggers(['qualified', 'whenever', 'ready', 'ready']), cleanTriggers(null)], [['ready', 'qualified'], []]);
eq('qualified needs motivation, timeline and condition', [isQualified({ motivation: 'divorce', timeline: '60 days', condition: 'needs roof' }), isQualified({ motivation: 'divorce', timeline: ' ', condition: 'ok' }), isQualified(null)], [true, false, false]);
const q = { motivation: 'divorce', timeline: '60 days', condition: 'needs roof' };
eq('qualified fires once the agent has made a touch', [handoffDue(LM, { trigger: 'qualified', touches: 1, record: q }), handoffDue(LM, { trigger: 'qualified', touches: 0, record: q })], [true, false]);
eq('a trigger that is off never fires', [handoffDue(ACQ, { trigger: 'qualified', touches: 3, record: q }), handoffDue({ ...LM, handoff_on: [] }, { trigger: 'ready', touches: 3 })], [false, false]);
eq('ready fires on the agent\'s judgement', handoffDue(LM, { trigger: 'ready', touches: 0 }), true);
// The tick reads the seller's answers only when the trigger could fire: on, and after a touch.
eq('the cheap check before reading the answers', [mayQualify(LM, 1), mayQualify(LM, 0), mayQualify(ACQ, 5), mayQualify({ ...LM, handoff_on: ['qualified'] }, 2)], [true, false, false, true]);
const relayed = relayPatch({ chat: [{ role: 'rep', text: 'Get a call booked', at: 'x' }], instructions: 'Get a call booked', relayed_from: [] }, { agent_key: 'lead_manager', name: 'Riley' }, { agent_key: 'acquisitions', name: 'Morgan', role: 'acquisitions' }, 'qualified on the call', '2026-10-06T15:00:00.000Z');
eq('the relay: new agent, fresh plan, own touch count, history of who worked it', [relayed.agent_key, relayed.plan, relayed.touches, relayed.relayed_from, relayed.mode, relayed.next_action_at], ['acquisitions', {}, 0, ['lead_manager'], 'auto', '2026-10-06T15:00:00.000Z']);
ok('the chat and the instructions say who handed it on and why, and keep what the rep asked', /Riley handed this to Morgan \(acquisitions\): qualified on the call/.test(relayed.chat[relayed.chat.length - 1].text) && /Handed over by Riley/.test(relayed.instructions) && /What the rep asked Riley for: Get a call booked/.test(relayed.instructions), relayed);
ok('the relay keeps last_action_at out of the patch, so the gap between touches still holds', !('last_action_at' in relayed));
const persona = { name: 'Riley', company: 'Acme Homes', role: 'lead manager', rep: 'Sam' };
ok('with a next agent the decider hands off to it, not to a person', /Morgan, the acquisitions specialist, takes over/.test(deciderSystem(persona, 'seller', null, { agent_key: 'acquisitions', name: 'Morgan', role: 'acquisitions specialist' })) && /a person takes over/.test(deciderSystem(persona, 'seller', null)));
eq('a relay counts as a hand-off in the report', aggregateActions([{ agent_key: 'lm', action: 'relayed', status: 'done', channel: 'system', record_kind: 'seller', record_id: 1, created_at: new Date(NOW).toISOString() }], 7, NOW, CT)[0].handoffs, 1);

// Writing like a person: no em or en dashes, no bot openers, no markdown in a text.
eq('an em dash becomes a comma', humanize('Hey Dana \u2014 got your note about the roof'), 'Hey Dana, got your note about the roof');
eq('an en dash between words becomes a comma', humanize('No rush \u2013 whenever works'), 'No rush, whenever works');
eq('a dash between numbers stays a hyphen', humanize('Free 2\u20134pm tomorrow?'), 'Free 2-4pm tomorrow?');
eq('a double hyphen used as a dash goes too', humanize('Sounds good -- talk soon'), 'Sounds good, talk soon');
eq('"I hope this finds you well" is cut, the greeting kept', humanize('Hi Dana, I hope this message finds you well. Did the plumber come out yet?'), 'Hi Dana, did the plumber come out yet?');
eq('"Just following up" is cut', humanize('Just following up on the house. Are you still thinking of selling this spring?'), 'Are you still thinking of selling this spring?');
eq('a short message that is only a check-in is left alone', humanize('Just checking in!'), 'Just checking in!');
eq('a "Great!" opener is cut', humanize('Great! Does Tuesday afternoon work for a quick call with Morgan?'), 'Does Tuesday afternoon work for a quick call with Morgan?');
eq('"Perfect," and "Great to hear." go too', [humanize("Perfect, I'll have the team send it over this afternoon."), humanize('Great to hear. How soon would you want to close on it?')], ["I'll have the team send it over this afternoon.", 'How soon would you want to close on it?']);
eq('a short "Great, thanks!" is left alone', humanize('Great, thanks!'), 'Great, thanks!');
eq('markdown bold and bullets are stripped from a text', humanize('**Quick one**\n- still selling?'), 'Quick one still selling?');
eq('an email keeps its paragraphs', humanize('Hi Dana,\n\nThanks for the call \u2014 talk Friday.\n\nRiley', 'email'), 'Hi Dana,\n\nThanks for the call, talk Friday.\n\nRiley');
ok('a drafted text is humanized before it is checked and sent', parseDecision({ action: 'sms', body: 'Hey \u2014 still good for Friday?', next_check_hours: 24 }, ['sms'], { phone: true, email: false, call: false } as never).body === 'Hey, still good for Friday?');
ok('the decider tells the agent to write without dashes and reply in the thread', /Never use an em dash/.test(deciderSystem(persona, 'seller', null)) && /your message is a reply to that/.test(deciderSystem(persona, 'seller', null)));

// ---- ringless voicemail ----
eq('rvm is a channel, ordered after call, and needs only a phone', [cleanChannels(['email', 'rvm', 'call']), (eligibility({ ...base, channels: ['rvm'], reach: { phone: true, email: false, call: false } }) as { ok: boolean }).ok, (eligibility({ ...base, channels: ['rvm'], reach: { phone: false, email: true, call: false } }) as { code: string }).code], [['call', 'rvm', 'email'], true, 'no_reach']);
const rv = (o: Record<string, unknown>, allowed: Parameters<typeof parseDecision>[1] = ['rvm', 'sms'], reach = { phone: true, email: false, call: false }) => parseDecision({ action: 'rvm', next_check_hours: 48, reason: 'nudge', ...o }, allowed, reach);
eq('a voicemail goes with a script', rv({ body: 'Hi Ann, this is Riley with Acme Homes about your house on Oak. I will text you the details.' }).action, 'rvm');
eq('a voicemail that is not switched on, has no phone, is empty, names a price or carries a link waits', [rv({ body: 'hi' }, ['sms']).action, rv({ body: 'hi' }, ['rvm'], { phone: false, email: true, call: false }).action, rv({ body: ' ' }).action, rv({ body: 'we can do $185,000' }).action, rv({ body: 'see https://x.co' }).action], ['wait', 'wait', 'wait', 'wait', 'wait']);
eq('a long script is cut at the voicemail limit', rv({ body: 'x'.repeat(900) }).body.length, 600);
eq('a voicemail is an outreach for the gate: the gap, the window and the cap hold', [gateDecision({ ...sms, action: 'rvm' }, { nowMs: NOW, tz: CT, lastActionAt: new Date(NOW - 3_600_000).toISOString(), repliedSince: false, touches: 0, maxTouches: 12 }).action, gateDecision({ ...sms, action: 'rvm' }, { nowMs: NOW, tz: CT, lastActionAt: null, repliedSince: false, touches: 12, maxTouches: 12 }).action, gateDecision({ ...sms, action: 'rvm' }, { nowMs: NOW, tz: CT, lastActionAt: null, repliedSince: false, touches: 0, maxTouches: 12 }).action], ['wait', 'finish', 'rvm']);
eq('a dropped voicemail has its timeline line and counts in the report', [activityLine('Riley', 'rvm_sent', 'hi').title, aggregateActions([{ agent_key: 'a', action: 'rvm_sent', status: 'done', channel: 'rvm', record_kind: 'seller', record_id: 1, created_at: new Date(NOW).toISOString() }], 1, NOW)[0]!.voicemails], ['AI agent Riley dropped a voicemail', 1]);

// ---- the number a rep dials from a hand-off ----
eq('a US number reads the way it is dialed', [prettyPhone('+15125550199'), prettyPhone('5125550199'), prettyPhone('+447700900123'), prettyPhone(null)], ['(512) 555-0199', '(512) 555-0199', '+447700900123', '']);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
