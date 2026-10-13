// AI Autopilot (migration 146): who speed to lead may call and when, the first
// touch inside and outside the calling window, the call outcome, the cadence,
// the stop rules, nightly reactivation (the same rules as the People smart
// lists), and the report's funnel. Run: npx tsx tools/ai-autopilot.test.ts
import assert from 'node:assert/strict';
import {
  CALL_LABEL, DEFAULT_AUTOPILOT, LEGAL_WINDOW, reviewCall, timeBucket, timelineFar, type SpeedLead, autopilotStop, cadencePlan, callOutcome, cleanCadence, clampWindow, firstTouch, funnel, inCallWindow, isHumanTouch, leadZone,
  median, nextCadenceDay, nextWindowOpen, normalizeAutopilot, orderedChannels, reactivationEligible, secondsLabel, sourceKind, sourceSelected, speedCallGoal, speedEligibility,
  speedEmail, speedText, spreadAt, streetOf, whoOf, type AutopilotSettings, type ReactivationRow, nextMorningMs, spendCheck,
} from '../supabase/functions/_shared/ai-autopilot';
import { mentionsMoney } from '../supabase/functions/_shared/ai-agent';
import { withOptOut } from '../supabase/functions/_shared/sms-compliance';
import { isDeadLeadStage, isReactivationLead, reactivationListsOf } from '../lib/reactivation';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const on = (patch: Partial<AutopilotSettings['speed']> = {}, more: Partial<AutopilotSettings> = {}): AutopilotSettings =>
  normalizeAutopilot({ ...DEFAULT_AUTOPILOT, ...more, speed: { ...DEFAULT_AUTOPILOT.speed, enabled: true, sources: ['Jotform', 'zapier'], ...patch } });

// A Tuesday, 2026-10-06. 15:00 UTC = 10am Central, 11am Eastern, 8am Pacific.
const T = Date.parse('2026-10-06T15:00:00Z');
const CHI = 'America/Chicago';
const LA = 'America/Los_Angeles';

// ---- settings ----
test('settings default to everything off, and nothing is speed-dialed until a source is picked', () => {
  const s = normalizeAutopilot(undefined);
  assert.equal(s.speed.enabled, false);
  assert.deepEqual(s.speed.sources, []);
  assert.equal(s.reactivation.enabled, false);
  assert.deepEqual(s.speed.channels, ['call', 'sms', 'email']);
  assert.equal(s.followup.enabled, true);
});
test('settings are cleaned: unknown channels dropped, order kept, numbers clamped, bad keys and ids nulled', () => {
  const s = normalizeAutopilot({ send_as: 'nope', speed: { channels: ['sms', 'fax', 'call', 'sms'], fallback_minutes: 999, agent_key: 'Bad Key' }, reactivation: { daily_cap: 0, idle_days: 5, lists: ['dead_leads', 'bogus'] } });
  assert.deepEqual(s.speed.channels, ['sms', 'call']);
  assert.equal(s.speed.fallback_minutes, 30);
  assert.equal(s.speed.agent_key, null);
  assert.equal(s.send_as, null);
  assert.equal(s.reactivation.daily_cap, 1);
  assert.equal(s.reactivation.idle_days, 30);
  assert.deepEqual(s.reactivation.lists, ['dead_leads']);
});
const ALL = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
test('the calling window can be narrowed, never widened past 8am to 9pm; every day by default', () => {
  assert.deepEqual(clampWindow({ start: '06:00', end: '23:30' }), { ...LEGAL_WINDOW, days: ALL });
  assert.deepEqual(clampWindow({ start: '09:30', end: '19:00', days: ['Mon', 'tue', 'xyz'] }), { start: '09:30', end: '19:00', days: ['mon', 'tue'] });
  assert.deepEqual(clampWindow({ start: '20:30', end: '21:00' }), { ...LEGAL_WINDOW, days: ALL }, 'a window under an hour falls back');
  assert.deepEqual(clampWindow('junk'), { ...LEGAL_WINDOW, days: ALL });
  assert.deepEqual(normalizeAutopilot({}).speed.window.days, ALL, '24/7 by default');
});
test('a schedule without weekends waits for Monday', () => {
  const sat = Date.parse('2026-10-10T17:00:00Z'); // Saturday noon Central
  const weekdays = { start: '08:00', end: '21:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  assert.equal(inCallWindow(sat, CHI, weekdays), false);
  assert.equal(new Date(nextWindowOpen(sat, CHI, weekdays)).toISOString(), '2026-10-12T13:00:00.000Z');
});
test('the cadence starts at day 0, ascends, stays within 60 days', () => {
  assert.deepEqual(cleanCadence([7, 1, 1, 90, -2, 4]), [0, 1, 4, 7]);
  assert.deepEqual(cleanCadence([]), [0, 1, 2, 4, 7, 14, 30, 60]);
});

// ---- sources ----
test('a source matches the picked ones whatever the case or spacing; no source never matches', () => {
  assert.equal(sourceSelected(' JOTFORM ', ['jotform']), true);
  assert.equal(sourceSelected('podio', ['jotform']), false);
  assert.equal(sourceSelected(null, ['jotform']), false);
  assert.equal(sourceSelected('', ['']), false);
});
test('source hints: forms and lead services read inbound, pulled lists read as lists', () => {
  assert.equal(sourceKind('jotform'), 'inbound');
  assert.equal(sourceKind('Google PPC'), 'inbound');
  assert.equal(sourceKind('PPL - Motivated Sellers'), 'inbound');
  assert.equal(sourceKind('Propstream Anderson SC Tired Landlord'), 'list');
  assert.equal(sourceKind('Cold call'), 'list');
  assert.equal(sourceKind('podio'), 'list');
  assert.equal(sourceKind('Mark Spain 10.02.2026'), 'unknown');
});

// ---- speed eligibility ----
const lead: SpeedLead = { source: 'jotform', archived_at: null, created_at: new Date(T - 30_000).toISOString(), phone: '+12105550100', email: null };
test('a fresh lead from a picked source is eligible', () => assert.deepEqual(speedEligibility(on(), lead, { dnc: false, onAgent: false, nowMs: T }), { ok: true }));
test('speed to lead refuses: off, unpicked source, archived, DNC, unreachable, already on an agent, old', () => {
  const code = (s: AutopilotSettings, l: SpeedLead, f: Partial<{ dnc: boolean; onAgent: boolean }> = {}) => {
    const r = speedEligibility(s, l, { dnc: false, onAgent: false, nowMs: T, ...f });
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(code(normalizeAutopilot({ speed: { sources: ['jotform'] } }), lead), 'disabled');
  assert.equal(code(on(), { ...lead, source: 'Propstream Anderson SC Tired Landlord' }), 'source');
  assert.equal(code(on(), { ...lead, archived_at: '2026-10-01T00:00:00Z' }), 'archived');
  assert.equal(code(on(), lead, { dnc: true }), 'dnc');
  assert.equal(code(on(), { ...lead, phone: null }), 'no_reach');
  assert.equal(code(on(), lead, { onAgent: true }), 'enrolled');
  assert.equal(code(on(), { ...lead, created_at: new Date(T - 49 * 3_600_000).toISOString() }), 'old');
});
test('a purchased list is only speed-dialed when the owner picked it', () => {
  const list = { ...lead, source: 'Propstream Anderson SC Tired Landlord' };
  assert.equal(speedEligibility(on(), list, { dnc: false, onAgent: false, nowMs: T }).ok, false);
  assert.equal(speedEligibility(on({ sources: ['Propstream Anderson SC Tired Landlord'] }), list, { dnc: false, onAgent: false, nowMs: T }).ok, true);
});

// ---- the window, in the lead's zone ----
test("the lead's zone: the property's state first, then the area code", () => {
  assert.equal(leadZone('+12105550100', 'CA'), LA);
  assert.equal(leadZone('+12125550100', null), 'America/New_York');
  assert.equal(leadZone(null, null, CHI), CHI);
});
test('inside 8am to 9pm local, any day of the week', () => {
  assert.equal(inCallWindow(T, CHI), true);
  assert.equal(inCallWindow(T, LA), true, '8:00 Pacific is open');
  assert.equal(inCallWindow(T - 60_000, LA), false, '7:59 Pacific is not');
  const sundayNoon = Date.parse('2026-10-04T17:00:00Z');
  assert.equal(inCallWindow(sundayNoon, CHI), true, 'weekends count');
  assert.equal(inCallWindow(Date.parse('2026-10-07T02:30:00Z'), CHI), false, '9:30pm Central is closed');
});
test('the next window opening is 8am local the next morning', () => {
  const late = Date.parse('2026-10-07T03:10:00Z'); // 10:10pm Central Tuesday
  const open = nextWindowOpen(late, CHI);
  assert.equal(new Date(open).toISOString(), '2026-10-07T13:00:00.000Z');
  assert.equal(nextWindowOpen(T, CHI), T, 'already open: now');
  assert.equal(new Date(nextWindowOpen(late, CHI, { start: '09:30', end: '20:00' })).toISOString(), '2026-10-07T14:30:00.000Z');
});

// ---- the first touch ----
const ft = (i: Partial<Parameters<typeof firstTouch>[0]>) => firstTouch({ nowMs: T, tz: CHI, window: LEGAL_WINDOW, channels: ['call', 'sms', 'email'], canCall: true, hasPhone: true, hasEmail: true, afterHoursText: true, ...i });
test('inside the window: a call when the agent can call', () => assert.equal(ft({}).now, 'call'));
test('inside the window: a text right away when it cannot', () => assert.equal(ft({ canCall: false }).now, 'sms'));
test('no phone: an email', () => assert.equal(ft({ hasPhone: false }).now, 'email'));
test('the owner\'s channel order wins', () => assert.equal(ft({ channels: ['sms', 'call'] }).now, 'sms'));
test('outside the window: a text now and the call when it opens', () => {
  const late = Date.parse('2026-10-07T03:10:00Z');
  const r = ft({ nowMs: late });
  assert.equal(r.now, 'sms');
  assert.equal(r.later, 'call');
  assert.equal(new Date(r.later_at!).toISOString(), '2026-10-07T13:00:00.000Z');
});
test('outside the window with after-hours texts off: an email may go, the call and text wait', () => {
  const late = Date.parse('2026-10-07T03:10:00Z');
  const r = ft({ nowMs: late, afterHoursText: false });
  assert.equal(r.now, 'email');
  assert.equal(r.later, 'call');
  const r2 = ft({ nowMs: late, afterHoursText: false, hasEmail: false });
  assert.equal(r2.now, null);
  assert.equal(r2.later, 'call');
});
test('nothing can reach them: nothing now, nothing later', () => assert.deepEqual(ft({ hasPhone: false, hasEmail: false }), { now: null, later: null, later_at: null, reason: 'no channel can reach them' }));

// ---- did the call connect ----
test('a call of 20 seconds or more is answered; a voicemail, no-answer or short call is missed; nothing filed yet is pending, then missed', () => {
  assert.equal(callOutcome({ duration_s: 95, status: 'done' }, T, T + 60_000), 'answered');
  assert.equal(callOutcome({ duration_s: 12, status: 'done' }, T, T + 60_000), 'missed');
  assert.equal(callOutcome({ duration_s: 40, status: 'voicemail' }, T, T + 60_000), 'missed');
  assert.equal(callOutcome(null, T, T + 3 * 60_000), 'pending');
  assert.equal(callOutcome(null, T, T + 13 * 60_000), 'missed');
});

// ---- the words ----
const who = whoOf({ name: 'Ann Lee', agent: 'Riley Bot', company: 'Acme Homes', address: '1204 Oak St, San Antonio, TX 78209', source: 'jotform' });
test('the first texts: name, company, the street, no price, no dashes, short with the opt-out line', () => {
  for (const kind of ['first', 'missed_call', 'after_hours'] as const) {
    const t = withOptOut(speedText(kind, who));
    assert.ok(t.includes('Riley') && t.includes('Acme Homes') && t.includes('1204 Oak St'), t);
    assert.equal(mentionsMoney(t), false, t);
    assert.equal(/[–—]/.test(t), false, t);
    assert.ok(t.endsWith('Reply STOP to opt out.'), t);
    assert.ok(t.length <= 320, String(t.length));
  }
  assert.ok(speedText('first', who).includes('Thanks for reaching out'));
  assert.ok(speedText('first', { ...who, inbound: false }).includes("I'm reaching out"), 'a list lead is not thanked for reaching out');
  assert.equal(streetOf('1204 Oak St, San Antonio, TX'), '1204 Oak St');
});
test('the first email and the call goal say no number', () => {
  const m = speedEmail(who, 'Sam');
  assert.equal(mentionsMoney(m.subject + m.body), false);
  assert.ok(m.body.includes('Sam'));
  const g = speedCallGoal({ source: 'jotform', minutesOld: 0.2, transferOn: true });
  assert.ok(/just now/.test(g) && /transfer/.test(g) && /Never name a number/.test(g) && g.length <= 400);
  assert.equal(/transfer/.test(speedCallGoal({ source: null, minutesOld: 5, transferOn: false })), false);
});

// ---- the cadence ----
test('the follow-up plan: day 0 call and text, then the cadence days on alternating channels', () => {
  const p = cadencePlan('followup', [0, 1, 2, 4, 7, 14, 30, 60], ['call', 'sms', 'email'], true);
  assert.deepEqual(p.steps.slice(0, 3).map((s) => [s.day, s.channel]), [[0, 'call'], [0, 'sms'], [1, 'sms']]);
  assert.ok(p.steps.length <= 12);
  assert.ok(/then monthly/.test(p.summary));
  const noCall = cadencePlan('followup', [0, 1, 2], ['call', 'sms'], false);
  assert.ok(noCall.steps.every((s) => s.channel !== 'call'), 'an agent that cannot call gets no call steps');
});
test('a ringless voicemail is one step on the second cadence day, after the first call and text, once', () => {
  const p = cadencePlan('followup', [0, 1, 2, 4, 7, 14, 30, 60], ['call', 'rvm', 'sms', 'email'], true);
  const rvm = p.steps.filter((s) => s.channel === 'rvm');
  assert.deepEqual(rvm.map((s) => s.day), [1]);
  assert.deepEqual(p.steps.slice(0, 4).map((s) => [s.day, s.channel]), [[0, 'call'], [0, 'sms'], [1, 'sms'], [1, 'rvm']], 'the voicemail follows the day 1 text');
  assert.equal(p.steps.filter((s) => s.channel !== 'rvm').length, 9, 'the cadence days keep their own steps: eight plus the day 0 text');
  assert.deepEqual(cadencePlan('followup', [0], ['sms', 'rvm'], false).steps.map((s) => [s.day, s.channel]), [[0, 'sms'], [0, 'rvm']], 'a one-day cadence gets it on day 0');
  assert.equal(cadencePlan('followup', [0, 1, 2], ['sms', 'email'], false).steps.some((s) => s.channel === 'rvm'), false, 'off when not picked');
  const re = cadencePlan('reactivation', [0, 3, 7, 14, 30], ['rvm', 'sms', 'email'], false);
  assert.deepEqual(re.steps.filter((s) => s.channel === 'rvm').map((s) => s.day), [0], 'reactivation drops one on its first day');
  assert.deepEqual(re.steps.slice(0, 2).map((s) => s.channel), ['sms', 'rvm']);
});
test('rvm is a known channel for the programs but never the first touch', () => {
  assert.deepEqual(orderedChannels(['rvm', 'sms', 'fax'], ['sms']), ['rvm', 'sms']);
  assert.deepEqual(normalizeAutopilot({ followup: { channels: ['call', 'rvm'] } }).followup.channels, ['call', 'rvm']);
  const f = ft({ channels: ['rvm', 'email'], hasEmail: false });
  assert.equal(f.now, null, 'a voicemail is never the first touch');
  assert.equal(ft({ channels: ['rvm', 'sms'] }).now, 'sms');
});
test('the next cadence day, then every 30 days after the last', () => {
  const c = [0, 1, 2, 4, 7, 14, 30, 60];
  assert.equal(nextCadenceDay(0, c), 1);
  assert.equal(nextCadenceDay(4, c), 7);
  assert.equal(nextCadenceDay(60, c), 90);
  assert.equal(nextCadenceDay(95, c), 120);
});

// ---- stop rules ----
const none = { booked: false, dnc: false, archived: false, notInterested: false, stageGroup: 'lead', humanTouch: false } as const;
test('nothing happened: keep going', () => assert.equal(autopilotStop({ ...none }), null));
test('stop rules: booked, DNC, not interested, a rep took it, past qualification, a dead stage', () => {
  assert.deepEqual(autopilotStop({ ...none, booked: true }), { reason: 'booked: an appointment is on the calendar', status: 'done' });
  assert.equal(autopilotStop({ ...none, dnc: true })?.status, 'stopped');
  assert.equal(autopilotStop({ ...none, archived: true })?.status, 'stopped');
  assert.equal(autopilotStop({ ...none, notInterested: true })?.reason, 'not interested');
  assert.match(autopilotStop({ ...none, humanTouch: true })!.reason, /rep took the lead/);
  assert.match(autopilotStop({ ...none, stageGroup: 'offer' })!.reason, /past qualification/);
  assert.match(autopilotStop({ ...none, stageGroup: 'contract' })!.reason, /past qualification/);
  assert.match(autopilotStop({ ...none, stageGroup: 'dead' })!.reason, /dead stage/);
});
test('a reactivated dead lead is not stopped for being in the dead stage it started in', () => {
  assert.equal(autopilotStop({ ...none, stageGroup: 'dead', startStageGroup: 'dead' }), null);
  assert.equal(autopilotStop({ ...none, stageGroup: 'working', startStageGroup: 'dead' }), null);
});
test("a rep's touch is a human touch; the agent's own texts, emails and calls are not", () => {
  const ids = new Set([10]); const bodies = new Set(['Hi Ann, this is Riley']);
  assert.equal(isHumanTouch({ id: 11, direction: 'outbound', source: 'talkr', channel: 'call' }, ids), true);
  assert.equal(isHumanTouch({ id: 10, direction: 'outbound', source: 'talkr', channel: 'sms' }, ids), false);
  assert.equal(isHumanTouch({ id: 12, direction: 'outbound', source: 'elevenlabs', channel: 'call' }, ids), false);
  assert.equal(isHumanTouch({ id: 13, direction: 'outbound', source: 'talkr', channel: 'sms', body: 'Hi Ann, this is Riley' }, ids, bodies), false);
  assert.equal(isHumanTouch({ id: 14, direction: 'inbound', source: 'talkr', channel: 'sms' }, ids), false);
  assert.equal(isHumanTouch({ id: 15, direction: 'outbound', source: 'clozr', channel: 'note' }, ids), false);
});

// ---- reactivation: the People smart lists' rules ----
const re = normalizeAutopilot({ reactivation: { enabled: true, idle_days: 90 } });
const day = 86_400_000;
const row = (p: Partial<ReactivationRow> = {}): ReactivationRow => ({
  id: 1, lead_stage: 'Unresponsive', source: 'podio', tags: [], archived_at: null, phone: '+12105550100', email: null,
  last_touch_at: new Date(T - 120 * day).toISOString(), created_at: new Date(T - 400 * day).toISOString(), enrolled: false, reactivated_before: false, ...p,
});
const why = (r: ReactivationRow, s = re, dnc = false) => { const x = reactivationEligible(r, s, { dnc, nowMs: T }); return x.ok ? x.list : x.reason; };
test('a dead lead quiet for 120 days is on the Dead Leads list', () => assert.equal(why(row()), 'dead_leads'));
test('a working lead that went quiet is on the Reactivation list', () => assert.equal(why(row({ lead_stage: 'Contacted - Follow Up Needed' })), 'reactivation'));
test('a lead nobody ever reached, old enough, is on the No Contact list', () => assert.equal(why(row({ lead_stage: 'Lead - No Contact', last_touch_at: null })), 'no_contact'));
test('reactivation refuses: recent contact, too new, under contract, closed, wholesaler, DNC, archived, enrolled, done before, unreachable, off', () => {
  assert.match(why(row({ last_touch_at: new Date(T - 10 * day).toISOString() })), /touched in the last 90 days/);
  assert.match(why(row({ lead_stage: 'Lead', last_touch_at: null, created_at: new Date(T - 5 * day).toISOString() })), /newer than/);
  assert.match(why(row({ lead_stage: 'Under Contract - Seller' })), /never reactivated/);
  assert.match(why(row({ lead_stage: 'Closed' })), /never reactivated/);
  assert.match(why(row({ lead_stage: 'Wholesaler' })), /never reactivated/);
  assert.match(why(row(), re, true), /do-not-contact/);
  assert.equal(why(row({ archived_at: '2026-01-01' })), 'archived');
  assert.match(why(row({ enrolled: true })), /already working/);
  assert.match(why(row({ reactivated_before: true })), /already reactivated/);
  assert.match(why(row({ phone: null })), /no phone/);
  assert.match(why(row(), normalizeAutopilot({ reactivation: { enabled: false } })), /switched off/);
});
test('only the picked lists and sources', () => {
  const deadOnly = normalizeAutopilot({ reactivation: { enabled: true, lists: ['dead_leads'] } });
  assert.match(why(row({ lead_stage: 'Contacted - Follow Up Needed' }), deadOnly), /not on a picked list/);
  const jot = normalizeAutopilot({ reactivation: { enabled: true, sources: ['jotform'] } });
  assert.match(why(row(), jot), /source not picked/);
});
test('the lists agree with the People smart lists', () => {
  assert.equal(isDeadLeadStage('Unresponsive'), true);
  assert.equal(isDeadLeadStage('Refund - Wrong Info'), true);
  assert.equal(isDeadLeadStage('Lead'), false);
  assert.equal(isReactivationLead('Contacted - Follow Up Needed', 5000), true, 'quiet past the smart list threshold');
  assert.equal(isReactivationLead('Contacted - Follow Up Needed', 100), false);
  assert.equal(isReactivationLead('Dead', 99999), false, 'dead leads are on Dead Leads, not Reactivation');
  assert.equal(isReactivationLead('Closed', 99999), false);
  assert.deepEqual(reactivationListsOf('Offer Declined', null, 1000), ['dead_leads']);
  assert.deepEqual(reactivationListsOf('Lead - No Contact', null, 1000), ['no_contact']);
});
test('first looks spread across the morning', () => assert.equal(spreadAt(T, 3) - T, 12 * 60_000));

// ---- reading a call ----
test('a call is read and scored: hot, warm, nurture, not interested, wrong number, DNC, no answer', () => {
  const r = (c: Partial<Parameters<typeof reviewCall>[0]>) => { const x = reviewCall({ answered: true, ...c }); return `${x.label}/${x.next}`; };
  assert.equal(r({ booked: true }), 'hot/booked');
  assert.equal(r({ transferred: true }), 'hot/booked');
  assert.equal(r({ outcome: 'booked' }), 'hot/booked');
  assert.equal(r({}), 'warm/follow_up');
  assert.equal(r({ outcome: 'callback' }), 'warm/follow_up');
  assert.equal(r({ timeline: 'maybe next year' }), 'nurture/nurture');
  assert.equal(r({ timeline: '6 months or so' }), 'nurture/nurture');
  assert.equal(r({ timeline: '30 days' }), 'warm/follow_up');
  assert.equal(r({ not_interested: true }), 'not_interested/drop');
  assert.equal(r({ outcome: 'wrong_person' }), 'wrong_number/drop');
  assert.equal(r({ dnc_requested: true, booked: true }), 'dnc/drop', 'do-not-contact wins');
  assert.equal(r({ answered: false }), 'no_answer/follow_up');
  assert.equal(CALL_LABEL.nurture, 'Long-term nurture');
});
test('far timelines', () => {
  assert.equal(timelineFar('2 months'), false);
  assert.equal(timelineFar('3-4 months'), true);
  assert.equal(timelineFar('after the holidays'), true);
  assert.equal(timelineFar('ASAP'), false);
  assert.equal(timelineFar(null), false);
});
test('when a lead came in: business hours, after hours, weekend (workspace clock)', () => {
  assert.equal(timeBucket('2026-10-06T15:00:00Z', CHI), 'business');
  assert.equal(timeBucket('2026-10-07T01:00:00Z', CHI), 'after_hours');
  assert.equal(timeBucket('2026-10-10T17:00:00Z', CHI), 'weekend');
  assert.equal(timeBucket(null, CHI), null);
});

// ---- the funnel ----
test('median: odd, even, empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 3);
  assert.equal(median([]), null);
});
test('the funnel counts distinct sellers and the speed to first touch', () => {
  const at = (s: number) => new Date(T + s * 1000).toISOString();
  const f = funnel({
    newLeads: 10,
    tz: CHI, aiCalls: 30, days: 7,
    speed: [
      { seller_id: 1, lead_created_at: at(0), first_touch_at: at(6), status: 'touched' },
      { lead_created_at: at(0), first_touch_at: at(9), status: 'touched' },
      { lead_created_at: at(0), first_touch_at: at(300), status: 'touched' },
      { lead_created_at: at(0), first_touch_at: null, status: 'skipped' },
    ],
    touched: new Set(['1', '2', '3', '9']), conversations: new Set(['1', '9']), qualified: new Set(['1']), booked: new Set(['1', '9']),
    transferred: new Set(['2']), contracts: new Set(['1']), reactivated: new Set(['9', '8']),
  });
  assert.deepEqual(f, {
    new_leads: 10, speed_queued: 4, contacted: 4, median_first_touch_s: 9, under_60s: 2, conversations: 2, qualified: 1, appointments: 2, transfers: 1, contracts: 1,
    contact_rate: 50, reactivated: 2, reactivated_replied: 1, reactivated_booked: 1,
    by_time: { business: { leads: 4, contacted: 3, booked: 1 }, after_hours: { leads: 0, contacted: 0, booked: 0 }, weekend: { leads: 0, contacted: 0, booked: 0 } },
    ai_calls: 30, ai_calls_per_day: 4.3,
  });
});
test('seconds read as seconds, minutes, hours', () => {
  assert.equal(secondsLabel(8), '8s');
  assert.equal(secondsLabel(65), '1m 05s');
  assert.equal(secondsLabel(7800), '2h 10m');
  assert.equal(secondsLabel(null), '–');
});

test('daily spend limits: defaults, clamping, the gate and the next morning', () => {
  assert.deepEqual(normalizeAutopilot({}).limits, { daily_touches: 150, daily_steps: 500 });
  assert.deepEqual(normalizeAutopilot({ limits: { daily_touches: 99999, daily_steps: -4 } }).limits, { daily_touches: 5000, daily_steps: 0 });
  assert.deepEqual(normalizeAutopilot({ limits: { daily_touches: '40' } }).limits, { daily_touches: 40, daily_steps: 500 });
  const lim = { daily_touches: 2, daily_steps: 5 };
  assert.equal(spendCheck(lim, { touches: 1, steps: 4 }).ok, true);
  const t1 = spendCheck(lim, { touches: 2, steps: 0 });
  assert.equal(!t1.ok && t1.outcome, 'touches');
  const s1 = spendCheck(lim, { touches: 0, steps: 5 });
  assert.equal(!s1.ok && s1.outcome, 'steps');
  assert.equal(spendCheck({ daily_touches: 0, daily_steps: 0 }, { touches: 0, steps: 0 }).ok, false);
  // 3pm Chicago (20:00Z in October, CDT) → 9am next day = 14:00Z.
  const now = Date.parse('2026-10-05T20:00:00Z');
  assert.equal(new Date(nextMorningMs(now, 'America/Chicago')).toISOString(), '2026-10-06T14:00:00.000Z');
  // 6am Chicago → 9am the same day.
  assert.equal(new Date(nextMorningMs(Date.parse('2026-10-05T11:00:00Z'), 'America/Chicago')).toISOString(), '2026-10-05T14:00:00.000Z');
});

console.log(`ai-autopilot: ${passed} passed`);
