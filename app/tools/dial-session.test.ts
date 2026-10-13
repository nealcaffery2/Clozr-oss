// A CLOZR dial session: progress, the tally, resume, run it again, setup checks.
// Run: npx tsx tools/dial-session.test.ts
import assert from 'node:assert/strict';
import {
  emptyTally, firstRows, outcomeForDisposition, parsePrefs, parseSavedRun, personKey, resumeLabel, runAgainCounts, runAgainList,
  sessionProgress, setupCheck, tallyDrop, tallyOutcome, talkTime, type SavedRow, type SavedRun,
} from '../lib/dial-session';
import type { ReadinessFacts } from '../lib/dialer-readiness';

const row = (id: string, phone: string, n?: number, of?: number): SavedRow => ({ target: { name: id, phone, personId: id }, ...(of ? { n, of } : {}) });
const buyerRow = (id: string, phone: string): SavedRow => ({ target: { name: id, phone, buyerId: id } });
const vendor = (phone: string): SavedRow => ({ target: { name: 'Vendor', phone } });

// ---- who a row is
assert.equal(personKey({ phone: '1', personId: 's1' }), 'p:s1');
assert.equal(personKey({ phone: '1', buyerId: 'b1' }), 'b:b1');
assert.equal(personKey({ phone: '(512) 555-0101' }), 'n:5125550101', 'a row with no record is its number');

// ---- the tally
let t = emptyTally();
t = tallyOutcome(t, 'noanswer', 'p:a', 25);
t = tallyOutcome(t, 'appt', 'p:b', 312);
t = tallyOutcome(t, 'vm', 'p:c', 40);
t = tallyOutcome(t, 'offer', 'p:d', 120);
t = tallyOutcome(t, 'wrong', 'p:e', 8);
t = tallyOutcome(t, 'dnc', 'p:f', 5);
t = tallyOutcome(t, 'notint', 'p:g', 60);
t = tallyOutcome(t, 'followup', 'p:h', 90);
assert.equal(t.logged, 8);
assert.equal(t.connects, 4, 'appointment, offer, not interested and follow up are conversations');
assert.equal(t.appointments, 1);
assert.equal(t.offers, 1);
assert.equal(t.followUps, 1);
assert.equal(t.notInterested, 1);
assert.equal(t.noAnswer, 1);
assert.equal(t.voicemails, 1);
assert.equal(t.wrong, 1);
assert.equal(t.dnc, 1);
assert.equal(t.talkSeconds, 312 + 120 + 8 + 5 + 60 + 90, 'ringing into no answer or voicemail is not talk time');
assert.equal(t.last['p:b'], 'appt');
assert.deepEqual(emptyTally().last, {}, 'the tally is not mutated');

// A drop only stands in when nothing else was logged for them.
assert.equal(tallyDrop(emptyTally(), 'p:x').last['p:x'], 'vm');
assert.equal(tallyDrop(t, 'p:b').last['p:b'], 'appt');

// Talkr dispositions (buyer and unknown wrap-ups) map onto the outcomes.
assert.equal(outcomeForDisposition('Not interested'), 'notint');
assert.equal(outcomeForDisposition('Interested'), 'offer');
assert.equal(outcomeForDisposition('Appointment set'), 'appt');
assert.equal(outcomeForDisposition('Callback'), 'followup');
assert.equal(outcomeForDisposition('Left voicemail'), 'vm');
assert.equal(outcomeForDisposition('No answer'), 'noanswer');
assert.equal(outcomeForDisposition('Wrong number'), 'wrong');
assert.equal(outcomeForDisposition('Do not call'), 'dnc');
assert.equal(outcomeForDisposition('DNC'), 'dnc');
assert.equal(outcomeForDisposition(''), null);
assert.equal(outcomeForDisposition('Sent to dispo'), null);

// ---- progress: "23 of 140", by people however many numbers they have
const list = [row('a', '5125550101', 1, 2), row('a', '5125550102', 2, 2), row('b', '5125550103'), buyerRow('c', '5125550104'), vendor('5125550105')];
let p = sessionProgress({ list, pos: 0, at: -1, dialed: 0, reached: [] }, emptyTally());
assert.equal(p.people, 4);
assert.equal(p.position, 0, 'before the first call');
assert.equal(p.numbersLeft, 5);
assert.equal(p.percent, 0);
p = sessionProgress({ list, pos: 2, at: 1, dialed: 2, reached: [] }, emptyTally());
assert.equal(p.position, 1, 'still on the first person, their second number');
assert.deepEqual(p.number, { n: 2, of: 2 });
assert.equal(p.depth, 2);
p = sessionProgress({ list, pos: 3, at: 2, dialed: 3, reached: ['p:a'] }, tallyOutcome(emptyTally(), 'appt', 'p:b'));
assert.equal(p.position, 2);
assert.equal(p.reached, 1);
assert.equal(p.numbersLeft, 2);
assert.equal(p.percent, 50);
assert.equal(p.number, null);
// Someone reached on their first number: their other numbers are not "left".
p = sessionProgress({ list, pos: 1, at: 0, dialed: 1, reached: ['p:a'] }, emptyTally());
assert.equal(p.numbersLeft, 3);

assert.equal(talkTime(45), '45s');
assert.equal(talkTime(750), '12m 30s');
assert.equal(talkTime(3840), '1h 04m');

// ---- before the first call
const ready: ReadinessFacts = { phone: 'ok', softphone: 'ready', mic: 'granted', callerId: 'n1', ownVoicemails: 1, teamVoicemails: 1 };
const fine = { people: 10, noNumber: 0, dnc: 0, claimed: 0 };
assert.deepEqual(setupCheck(ready, fine, 1), { blockers: [], warnings: [] });
assert.equal(setupCheck(null, fine, 1).blockers.length, 0, 'the demo checks the list only');
assert.match(setupCheck(ready, { people: 0, noNumber: 0, dnc: 0, claimed: 0 }, 1).blockers[0]!, /Nobody is on this list/);
assert.match(setupCheck(ready, { people: 3, noNumber: 2, dnc: 1, claimed: 0 }, 1).blockers[0]!, /has a number you can call/);
assert.equal(setupCheck(ready, { people: 3, noNumber: 3, dnc: 0, claimed: 0 }, 'all').blockers.length, 0, 'their other numbers may still ring');
assert.match(setupCheck(ready, { people: 10, noNumber: 2, dnc: 1, claimed: 1 }, 1).warnings[0]!, /4 of 10 will be skipped: 2 with no number, 1 do not call, 1 claimed/);
assert.match(setupCheck({ ...ready, mic: 'denied' }, fine, 1).blockers[0]!, /microphone is blocked/);
assert.match(setupCheck({ ...ready, callerId: null }, fine, 1).blockers[0]!, /no number to call from/);
assert.match(setupCheck({ ...ready, phone: 'unreachable' }, fine, 1).blockers[0]!, /cannot be reached/);
assert.match(setupCheck({ ...ready, softphone: 'off' }, fine, 1).blockers[0]!, /not connected/);
assert.match(setupCheck({ ...ready, softphone: 'error', softphoneReason: 'Phone is open in another tab' }, fine, 1).blockers[0]!, /Phone is open in another tab/);
assert.match(setupCheck({ ...ready, softphone: 'error', softphoneReason: 'Reload and try again' }, fine, 1).blockers[0]!, /Reload and try again/);
assert.equal(setupCheck({ ...ready, softphone: 'connecting' }, fine, 1).blockers.length, 0, 'still connecting is a wait, not a stop');
assert.equal(setupCheck({ ...ready, phone: 'unlinked' }, fine, 1).blockers.length, 0, 'unlinked falls back to the rep’s phone');
assert.equal(setupCheck({ ...ready, mic: 'prompt' }, fine, 1).blockers.length, 0);
const noVm = setupCheck({ ...ready, ownVoicemails: 0, teamVoicemails: 0 }, fine, 1);
assert.equal(noVm.blockers.length, 0, 'no voicemail is a warning');
assert.match(noVm.warnings[0]!, /No voicemail recorded/);

// ---- remembered choices
assert.deepEqual(parsePrefs('{"mode":"predictive","depth":"all","vmClipId":7}'), { mode: 'predictive', depth: 'all', vmClipId: 7 });
assert.deepEqual(parsePrefs('{"mode":"turbo","depth":9,"vmClipId":"x"}'), {});
assert.deepEqual(parsePrefs('not json'), {});
assert.deepEqual(parsePrefs(null), {});

// ---- resume
const now = Date.UTC(2026, 9, 3, 19, 0);
const saved: SavedRun = {
  v: 1, title: 'Today', mode: 'power', depth: 2, list, origin: firstRows(list), pos: 3, at: 2, reached: [], dialed: 3, skipped: 0, dropped: 1,
  tally: tallyOutcome(emptyTally(), 'noanswer', 'p:a'), startedAt: now - 3_600_000, savedAt: now - 60_000,
};
const raw = JSON.stringify(saved);
const back = parseSavedRun(raw, now);
assert.ok(back);
assert.equal(back.pos, 3);
assert.equal(back.tally.noAnswer, 1);
assert.equal(back.origin.length, 4, 'one row per person');
assert.equal(resumeLabel(back, '2:14pm'), 'Resume session (2 of 4, started 2:14pm)');
assert.equal(parseSavedRun(raw, now + 8 * 86_400_000), null, 'a week-old session is not offered');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, v: 2 }), now), null, 'another shape');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, pos: 99 }), now), null, 'position past the end');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, at: 5 }), now), null, 'last row out of range');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, list: [] }), now), null, 'empty list');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, list: [{ target: { name: 1 } }] }), now), null, 'a broken row');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, dialed: -1 }), now), null);
assert.equal(parseSavedRun(JSON.stringify({ ...saved, mode: 'turbo' }), now), null);
assert.equal(parseSavedRun(JSON.stringify({ ...saved, savedAt: now + 3_600_000 }), now), null, 'from the future');
assert.equal(parseSavedRun('{oops', now), null);
assert.equal(parseSavedRun(null, now), null);
assert.equal(parseSavedRun(JSON.stringify({ ...saved, pos: 5 }), now), null, 'nothing left: it finished');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, pos: 4, reached: ['n:5125550105'] }), now), null, 'everyone left was reached');
assert.ok(parseSavedRun(JSON.stringify({ ...saved, tally: { connects: 'x', last: { 'p:a': 'bogus', 'p:b': 'vm' } } }), now)?.tally.last['p:b'] === 'vm', 'a bad tally is cleaned, not fatal');
assert.equal(parseSavedRun(JSON.stringify({ ...saved, origin: undefined }), now)?.origin.length, 4, 'origin rebuilt from the list');

// ---- run it again
const origin = [row('a', '1'), row('b', '2'), row('c', '3'), row('d', '4'), row('e', '5'), vendor('6')];
let last = emptyTally();
last = tallyOutcome(last, 'appt', 'p:a');
last = tallyOutcome(last, 'noanswer', 'p:b');
last = tallyOutcome(last, 'vm', 'p:c');
last = tallyOutcome(last, 'dnc', 'p:d');
last = tallyOutcome(last, 'wrong', 'p:e');
const names = (rows: SavedRow[]) => rows.map((r) => r.target.personId ?? r.target.buyerId ?? r.target.phone);
assert.deepEqual(names(runAgainList(origin, last, ['p:a', 'p:d'], 'all')), ['a', 'b', 'c', 'e', '6'], 'everyone but do not call');
assert.deepEqual(names(runAgainList(origin, last, ['p:a', 'p:d'], 'not_reached')), ['b', 'c', 'e', '6'], 'no conversation, no DNC; never-dialed stays');
assert.deepEqual(names(runAgainList(origin, last, ['p:a', 'p:d'], 'no_answer')), ['b', 'c'], 'rang and nobody picked up');
assert.deepEqual(runAgainCounts(origin, last, ['p:a', 'p:d']), { all: 5, not_reached: 4, no_answer: 2 });
// A spliced row (number 2 of 3) goes back as the person's plain row.
assert.deepEqual(runAgainList([row('z', '9', 2, 3)], emptyTally(), [], 'all')[0], { target: { name: 'z', phone: '9', personId: 'z' }, n: undefined, of: undefined });
assert.deepEqual(names(firstRows(list)), ['a', 'b', 'c', '5125550105']);

console.log('dial-session: all passed');
