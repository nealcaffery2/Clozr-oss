// The call outcomes: stage rules, the demo mapping, Talkr matching, due times
// and the plan the picker previews. Run: npx tsx tools/call-outcomes.test.ts
import assert from 'node:assert/strict';
import {
  DEMO_STAGES, OFFER_OUTCOMES, OUTCOMES, chipsFor, demoStage, dueAtIn, endsNumberWalk, fmtWhen, liveStage, matchTalkrDisposition, outcomeToast,
  planOutcome, stageBarIndex, type OutcomeKey, type PlanCtx, type TalkrDisposition,
} from '../lib/call-outcomes';
import { SELLER_STAGES, SELLER_STAGE_LABELS, sellerStageGroup } from '../lib/stages';
import { D } from '../lib/clozr-types';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
};

// ---- the outcome set --------------------------------------------------------
test('eight outcomes on keys 1-8', () => {
  assert.deepEqual(OUTCOMES.map((o) => o.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(OUTCOMES.map((o) => o.key)).size, 8);
});
test('demo stages mirror the sample graph', () => assert.deepEqual(DEMO_STAGES, D.STAGES));

// ---- live stages: never lower -----------------------------------------------
const RANK: Record<string, number> = { lead: 0, working: 1, offer: 2, contract: 3, closed: 4 };
const index = (s: string) => SELLER_STAGE_LABELS.indexOf(s);
const PARKED = ['Lead - No Contact', 'Lead - No Contact (Long Term)', 'Appointment Missed', 'Nurture - Short Term (Under 3 Months)', 'Nurture - Long Term (3+ Months)'];
/** Lower in the pipeline: an earlier group, or earlier in the same group. */
const lower = (from: string, to: string) => {
  const a = RANK[sellerStageGroup(from)], b = RANK[sellerStageGroup(to)];
  if (a === undefined || b === undefined) return false;
  return b < a || (a === b && index(to) < index(from));
};
/** The moves down the plan names: re-engaging a parked seller, Nurture, a follow-up on an offer out. */
const allowedDown = (from: string, to: string) =>
  PARKED.includes(from) || to === 'Nurture - Long Term (3+ Months)' || to === 'Offer Made - Follow Up';
const open = (s: string) => ['lead', 'working', 'offer'].includes(sellerStageGroup(s));

for (const o of OUTCOMES) {
  const chips = ['nurture', 'notselling', 'listed', 'retail', 'declined', 'dead', 'refund', null];
  for (const st of SELLER_STAGES) {
    for (const chip of chips) {
      const to = liveStage(o.key, st.label, chip);
      test(`${o.key} from ${st.label} (${chip}) is a real stage`, () => assert.ok(SELLER_STAGE_LABELS.includes(to), to));
      test(`${o.key} from ${st.label} (${chip}) never lowers`, () => assert.ok(to === st.label || !lower(st.label, to) || allowedDown(st.label, to), `${st.label} -> ${to}`));
      test(`${o.key} from ${st.label} leaves contract and later alone`, () => {
        if (!open(st.label)) assert.equal(to, st.label);
      });
      test(`${o.key} from ${st.label}: dead and refund only from an open stage`, () => {
        const g = sellerStageGroup(to);
        if ((g === 'dead' || g === 'refund') && to !== st.label) assert.ok(open(st.label));
      });
    }
  }
}
test('named moves', () => {
  assert.equal(liveStage('noanswer', 'Lead'), 'Lead - No Contact');
  assert.equal(liveStage('vm', 'None'), 'Lead - No Contact');
  assert.equal(liveStage('noanswer', 'Contacted - Follow Up Needed'), 'Contacted - Follow Up Needed');
  assert.equal(liveStage('noanswer', 'New Submission'), 'New Submission');
  assert.equal(liveStage('followup', 'Lead'), 'Contacted - Follow Up Needed');
  assert.equal(liveStage('followup', 'Nurture - Long Term (3+ Months)'), 'Contacted - Follow Up Needed');
  assert.equal(liveStage('followup', 'Offer Made'), 'Offer Made - Follow Up');
  assert.equal(liveStage('followup', 'Appointment Set'), 'Appointment Set');
  assert.equal(liveStage('followup', 'Underwriting'), 'Underwriting');
  assert.equal(liveStage('appt', 'Contacted - Follow Up Needed'), 'Appointment Set');
  assert.equal(liveStage('appt', 'Offer Made'), 'Offer Made');
  assert.equal(liveStage('offer', 'Lead'), 'Underwriting');
  assert.equal(liveStage('offer', 'Offer Made'), 'Offer Made');
  assert.equal(liveStage('notint', 'Lead'), 'Nurture - Long Term (3+ Months)');
  assert.equal(liveStage('notint', 'Lead', 'listed'), 'Listed on MLS - Dead');
  assert.equal(liveStage('notint', 'Lead', 'declined'), 'Nurture - Long Term (3+ Months)', 'Offer declined needs an offer out');
  assert.equal(liveStage('notint', 'Offer Made', 'declined'), 'Offer Made - Follow Up', 'declined stays worked, not dead');
  assert.equal(liveStage('notint', 'Under Contract - Seller'), 'Under Contract - Seller');
  assert.equal(liveStage('wrong', 'Lead'), 'Dead - Wrong Info');
  assert.equal(liveStage('wrong', 'Lead', 'refund'), 'Refund - Wrong Info');
  assert.equal(liveStage('dnc', 'Offer Made'), 'Dead');
  assert.equal(liveStage('dnc', 'Under Contract - Seller'), 'Under Contract - Seller');
});

// ---- demo stages ------------------------------------------------------------
test('demo mapping', () => {
  const at = (s: string) => DEMO_STAGES.indexOf(s);
  for (const o of OUTCOMES) for (const s of DEMO_STAGES) {
    const to = demoStage(o.key, s);
    assert.ok(DEMO_STAGES.includes(to), to);
    if (to !== 'Lost') assert.ok(at(to) >= at(s), `${o.key}: ${s} -> ${to}`);
  }
  assert.equal(demoStage('vm', 'New Lead'), 'New Lead');
  assert.equal(demoStage('followup', 'New Lead'), 'Contacted');
  assert.equal(demoStage('followup', 'Qualified'), 'Qualified');
  assert.equal(demoStage('appt', 'Contacted'), 'Appointment');
  assert.equal(demoStage('offer', 'New Lead'), 'Qualified');
  assert.equal(demoStage('offer', 'Appointment'), 'Appointment');
  assert.equal(demoStage('notint', 'Offer Sent'), 'Lost');
  assert.equal(demoStage('dnc', 'Under Contract'), 'Under Contract');
  assert.equal(stageBarIndex('Offer Sent', 'demo'), 2);
  assert.equal(stageBarIndex('Lost', 'demo'), -1);
});

// ---- Talkr ------------------------------------------------------------------
const orgList: TalkrDisposition[] = [
  { slug: 'not-interested', name: 'Not interested' },
  { slug: 'no-answer', name: 'No answer' },
  { slug: 'interested', name: 'Interested' },
  { slug: 'callback', name: 'Callback', requires_follow_up: true },
  { slug: 'appointment-set', name: 'Appointment set' },
  { slug: 'vm', name: 'Left VM' },
  { slug: 'bad-number', name: 'Wrong #' },
  { slug: 'remove-me', name: 'Remove me', adds_suppression: true },
];
test('Talkr matching picks the right disposition', () => {
  const m = (k: OutcomeKey) => matchTalkrDisposition(k, orgList)?.slug ?? null;
  assert.equal(m('noanswer'), 'no-answer');
  assert.equal(m('vm'), 'vm');
  assert.equal(m('followup'), 'callback');
  assert.equal(m('appt'), 'appointment-set');
  assert.equal(m('offer'), 'interested', 'the old chip matcher took "Not interested" for Interested');
  assert.equal(m('notint'), 'not-interested', 'the old chip matcher took "No answer" for Not interested');
  assert.equal(m('wrong'), 'bad-number');
  assert.equal(m('dnc'), 'remove-me');
});
test('Talkr false positives from the old chip matchers are gone', () => {
  // The old CHIP_MATCH patterns, for the record: both of these matched.
  assert.ok(/interest(?!.*not)|hot|warm|motivated/i.test('Not interested'));
  assert.ok(/not.?interest|dead|no\b/i.test('No answer'));
  const onlyNot: TalkrDisposition[] = [{ slug: 'ni', name: 'Not interested' }];
  const onlyNo: TalkrDisposition[] = [{ slug: 'na', name: 'No answer' }];
  assert.equal(matchTalkrDisposition('offer', onlyNot), null);
  assert.equal(matchTalkrDisposition('notint', onlyNo), null);
  assert.equal(matchTalkrDisposition('noanswer', onlyNot), null);
  assert.equal(matchTalkrDisposition('dnc', [{ slug: 'dnc', name: 'DNC' }])?.slug, 'dnc');
  assert.equal(matchTalkrDisposition('dnc', []), null);
});

// ---- time -------------------------------------------------------------------
const CHI = 'America/Chicago';
test('due times land on the zone’s wall clock', () => {
  const now = new Date('2026-09-23T15:05:00Z'); // Wed 10:05 AM in Chicago
  assert.equal(dueAtIn(CHI, { days: 1, at: [10, 0] }, now), '2026-09-24T15:00:00.000Z');
  assert.equal(dueAtIn(CHI, { days: 2, at: [10, 0] }, now), '2026-09-25T15:00:00.000Z');
  assert.equal(dueAtIn(CHI, { weekday: 1, at: [10, 0] }, now), '2026-09-28T15:00:00.000Z');
  assert.equal(dueAtIn(CHI, { hours: 2 }, now), '2026-09-23T17:05:00.000Z');
  assert.equal(dueAtIn('America/New_York', { days: 1, at: [10, 0] }, now), '2026-09-24T14:00:00.000Z');
  assert.equal(fmtWhen('2026-09-25T15:00:00.000Z', CHI, now), 'Fri 10:00 AM');
  assert.equal(fmtWhen('2026-09-24T15:00:00.000Z', CHI, now), 'tomorrow 10:00 AM');
});
test('due times survive the fall-back and spring-forward changes', () => {
  // Sat Oct 31 2026, 10:00 CDT; tomorrow is Sun Nov 1, after the clocks go back.
  const fall = new Date('2026-10-31T15:00:00Z');
  assert.equal(dueAtIn(CHI, { days: 1, at: [10, 0] }, fall), '2026-11-01T16:00:00.000Z');
  assert.equal(fmtWhen('2026-11-01T16:00:00.000Z', CHI, fall), 'tomorrow 10:00 AM');
  // Sat Mar 7 2026, 10:00 CST; tomorrow is Sun Mar 8, after the clocks go forward.
  const spring = new Date('2026-03-07T16:00:00Z');
  assert.equal(dueAtIn(CHI, { days: 1, at: [10, 0] }, spring), '2026-03-08T15:00:00.000Z');
  // Late evening: "tomorrow" is the zone's tomorrow, not UTC's.
  const lateNight = new Date('2026-09-24T04:30:00Z'); // Wed 11:30 PM in Chicago
  assert.equal(dueAtIn(CHI, { days: 1, at: [10, 0] }, lateNight), '2026-09-24T15:00:00.000Z');
});

// ---- the plan ---------------------------------------------------------------
const john = D.people.find((p) => p.id === 'p3')!;
const kara = D.people.find((p) => p.id === 'p1')!;
const base = (over: Partial<PlanCtx> = {}): PlanCtx => ({
  person: john, vocab: 'demo', task: { id: 'k3', title: 'First call — new Facebook lead' }, claim: true,
  now: new Date('2026-09-23T15:05:00Z'), zone: CHI, repZone: CHI, dispositions: null, hasCall: true,
  recipient: { sellerId: null, name: john.name, phone: john.phone, address: john.property.addr, city: john.property.city, state: john.property.st, zip: john.property.zip },
  send: { repName: 'Taylor Reed', company: 'Acme Homes' }, hasMao: false, ...over,
});
test('voicemail on John previews a call back and the text', () => {
  const plan = planOutcome('vm', base());
  assert.equal(plan.stage, null);
  assert.ok(plan.lines.includes('Stage stays New Lead'));
  assert.ok(plan.lines.some((l) => l.startsWith('Call back Fri 10:00 AM')), plan.lines.join(' | '));
  assert.equal(plan.task?.reschedule?.id, 'k3');
  assert.ok(plan.text?.on);
  assert.equal(plan.text?.body, "Hi John, Taylor with Acme Homes here. I just left you a voicemail about 4410 Bluebonnet Trail. Text me back here whenever works.");
  assert.equal(plan.talkrLine, 'Talkr: not connected in the demo');
  assert.ok(plan.lines[0] === 'Assigns John to you');
  assert.ok(outcomeToast(plan, { demo: true }).endsWith('(demo)'));
});
test('live voicemail on a new lead moves the stage', () => {
  const plan = planOutcome('vm', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, dispositions: orgList }));
  assert.deepEqual(plan.stage, { from: 'Lead', to: 'Lead - No Contact' });
  assert.equal(plan.talkr?.slug, 'vm');
  assert.equal(plan.talkrLine, 'Talkr: Left VM');
  assert.equal(outcomeToast(plan), 'John Smith: voicemail, stage Lead - No Contact, call back Fri 10:00 AM.');
});
test('no answer texts only on a new lead’s first attempt', () => {
  assert.equal(planOutcome('noanswer', base()).text?.on, true);
  assert.equal(planOutcome('noanswer', base({ person: kara, task: null, claim: false })).text?.on, false);
  assert.equal(planOutcome('noanswer', base({ hasCall: false })).text?.on, false, 'no call, no "sorry I missed you"');
  assert.equal(planOutcome('noanswer', base({ person: kara, textOn: true })).text?.on, true);
  const fresh = planOutcome('noanswer', base({ task: null }));
  assert.equal(fresh.task?.create?.title, 'Call back John');
  assert.equal(fresh.task?.create?.dueAt, '2026-09-24T15:00:00.000Z');
});
test('follow up on Kara completes her task and makes the next', () => {
  const plan = planOutcome('followup', base({ person: kara, task: { id: 'k1', title: 'Call seller — discuss revised offer' }, claim: false, chip: 'in3d' }));
  assert.equal(plan.task?.complete?.id, 'k1');
  assert.equal(plan.task?.create?.title, 'Follow up with Kara');
  assert.equal(plan.task?.create?.dueAt, '2026-09-26T15:00:00.000Z');
  assert.equal(plan.stage, null, 'Qualified stays Qualified');
  assert.equal(plan.text, null);
  const ai = planOutcome('followup', base({ person: kara, claim: false, ai: { task: 'Send revised offer', followUp: 'Today 2:00 PM', followUpAt: '2026-09-23T19:00:00.000Z' }, chip: 'ai' }));
  assert.equal(ai.task?.create?.title, 'Send revised offer', 'the AI suggestion is the task, not a second one');
  assert.equal(ai.task?.create?.dueAt, '2026-09-23T19:00:00.000Z');
  assert.deepEqual(ai.chips.map((c) => c.label), ['Tomorrow', 'In 3 days', 'Next week', 'Today 2:00 PM']);
});
test('appointment makes a calendar entry and a confirmation text', () => {
  const plan = planOutcome('appt', base());
  assert.equal(plan.appointment?.title, 'Walkthrough at 4410 Bluebonnet Trail');
  assert.equal(plan.appointment?.startsAt, '2026-09-24T15:00:00.000Z');
  assert.ok(plan.text?.body.includes('Thu, Sep 24 at 10:00 AM'), plan.text?.body);
  const pick = planOutcome('appt', base({ chip: 'pick' }));
  assert.ok(pick.blocked, 'Pick a time with no time blocks Save');
});
test('ready for an offer: underwriting, a send-offer task and COMPR when there is no MAO', () => {
  const live = planOutcome('offer', base({ vocab: 'live', person: { ...kara, stage: 'Contacted - Follow Up Needed' }, dispositions: [] }));
  assert.equal(live.stage?.to, 'Underwriting');
  assert.equal(live.task?.create?.title, 'Send offer to Kara');
  assert.equal(live.task?.create?.dueAt, '2026-09-23T22:00:00.000Z', 'today 5 PM');
  assert.ok(live.compr);
  assert.equal(planOutcome('offer', base({ vocab: 'live', person: kara, hasMao: true, dispositions: [] })).compr, false);
  const late = planOutcome('offer', base({ vocab: 'live', person: kara, now: new Date('2026-09-23T21:00:00Z'), dispositions: [] }));
  assert.equal(late.task?.create?.dueAt, '2026-09-24T15:00:00.000Z', 'after 3 PM: tomorrow 10 AM');
});
test('not interested: nurture makes a 90-day check-back, dead reasons make none', () => {
  const gary = D.people.find((p) => p.id === 'p7')!;
  const n = planOutcome('notint', base({ person: gary, task: null, claim: false }));
  assert.equal(n.stage?.to, 'Lost');
  assert.equal(n.task?.create?.title, 'Check back with Gary');
  assert.equal(outcomeToast(n, { demo: true }), 'Gary Whitfield: not interested, stage Lost, check back Dec 22 (demo)');
  const dead = planOutcome('notint', base({ vocab: 'live', person: { ...gary, stage: 'Offer Made' }, task: null, claim: false, chip: 'notselling', dispositions: [] }));
  assert.equal(dead.stage?.to, 'Not Selling');
  assert.equal(dead.task, null);
  const declined = planOutcome('notint', base({ vocab: 'live', person: { ...gary, stage: 'Offer Made' }, task: null, claim: false, chip: 'declined', dispositions: [] }));
  assert.equal(declined.stage?.to, 'Offer Made - Follow Up');
  assert.deepEqual(chipsFor('notint', 'Offer Made', 'live').chips.map((c) => c.id), ['nurture', 'notselling', 'listed', 'retail', 'declined']);
  assert.deepEqual(chipsFor('notint', 'Lead', 'live').chips.map((c) => c.id), ['nurture', 'notselling', 'listed', 'retail']);
});
test('do not call: tag, no text, and Talkr’s suppression named', () => {
  const plan = planOutcome('dnc', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, dispositions: [{ slug: 'x', name: 'Callback' }] }));
  assert.deepEqual(plan.tags, ['DNC']);
  assert.equal(plan.text, null);
  assert.ok(plan.dropFromQueue);
  assert.ok(plan.talkrLine.includes('Talkr’s own suppression list is not updated'));
  const sup = planOutcome('dnc', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, dispositions: orgList }));
  assert.equal(sup.talkr?.slug, 'remove-me');
  assert.ok(!sup.talkrLine.includes('not updated'));
});
test('wrong number tags the record', () => {
  const plan = planOutcome('wrong', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, chip: 'refund', dispositions: orgList }));
  assert.equal(plan.stage?.to, 'Refund - Wrong Info');
  assert.deepEqual(plan.tags, ['Wrong number']);
  assert.equal(plan.task?.complete?.id, 'k3');
});
test('wrong number on one of their other numbers marks that number, not the seller', () => {
  const other = { id: 41, label: '(210) 555-0101' };
  const plan = planOutcome('wrong', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, chip: 'refund', dispositions: orgList, otherNumber: other }));
  assert.equal(plan.stage, null);
  assert.deepEqual(plan.tags, []);
  assert.equal(plan.wrongNumberId, 41);
  assert.equal(plan.task, null);
  assert.equal(plan.chipKind, null);
  assert.deepEqual(plan.chips, []);
  assert.ok(plan.lines.includes('Marks (210) 555-0101 wrong. John keeps their other numbers'), plan.lines.join(' | '));
  assert.ok(!plan.lines.some((l) => l.startsWith('Completes')));
  assert.equal(plan.talkr?.slug, 'bad-number');
  // On the record's own phone it is the whole record, as before.
  assert.equal(planOutcome('wrong', base({ vocab: 'live', person: { ...john, stage: 'Lead' } })).wrongNumberId, null);
});
test('wrong number on their own phone with other numbers left keeps the lead', () => {
  const plan = planOutcome('wrong', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, chip: 'refund', dispositions: orgList, moreNumbers: 2 }));
  assert.equal(plan.stage, null);
  assert.deepEqual(plan.tags, []);
  assert.equal(plan.wrongPrimary, true);
  assert.equal(plan.wrongNumberId, null);
  assert.equal(plan.task, null);
  assert.ok(plan.lines.includes('Marks their main number wrong. John keeps 2 other numbers'), plan.lines.join(' | '));
  // None left: the whole record, as before.
  const last = planOutcome('wrong', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, moreNumbers: 0 }));
  assert.equal(last.wrongPrimary, false);
  assert.ok(last.tags.includes('Wrong number'));
});
test('after a call on another number the text is off unless the rep turns it on', () => {
  const other = { id: 41, label: '(210) 555-0101' };
  assert.equal(planOutcome('vm', base({ otherNumber: other })).text?.on, false);
  assert.equal(planOutcome('vm', base({ otherNumber: other, textOn: true })).text?.on, true);
  assert.equal(planOutcome('vm', base()).text?.on, true);
  // Anything but Wrong number plans as it always did.
  assert.equal(planOutcome('vm', base({ otherNumber: other })).wrongNumberId, null);
  assert.equal(planOutcome('vm', base({ otherNumber: other })).task?.reschedule?.id, 'k3');
});
test('a session stops walking numbers when they were reached or said do not call', () => {
  assert.deepEqual(OUTCOMES.filter((o) => endsNumberWalk(o.key)).map((o) => o.key), ['followup', 'appt', 'offer', 'notint', 'dnc']);
});
test('a disposition that wants a follow-up says Talkr may refuse it', () => {
  const plan = planOutcome('wrong', base({ vocab: 'live', person: { ...john, stage: 'Lead' }, dispositions: [{ slug: 'w', name: 'Wrong number', requires_follow_up: true }] }));
  assert.ok(plan.talkrLine.includes('may refuse'));
});

// ---- the SOP's offer outcomes ------------------------------------------------
for (const o of OFFER_OUTCOMES) {
  for (const st of SELLER_STAGES) {
    for (const chip of ['nq', 'in3d', 'nextwk', 'in30d', null]) {
      const to = liveStage(o.key, st.label, chip);
      test(`${o.key} from ${st.label} (${chip}) is a real stage`, () => assert.ok(SELLER_STAGE_LABELS.includes(to), to));
      test(`${o.key} from ${st.label} (${chip}) leaves contract alone`, () => assert.ok(open(st.label) || to === st.label, `${st.label} -> ${to}`));
    }
  }
}
test('offer outcomes have no number key', () => assert.deepEqual(OFFER_OUTCOMES.map((o) => o.n), [0, 0, 0]));
test('offer accepted opens the deal and asks for the contract', () => {
  const plan = planOutcome('accepted', base({ vocab: 'live', person: { ...john, stage: 'Offer Made' }, claim: false }));
  assert.deepEqual(plan.stage, { from: 'Offer Made', to: 'Offer Accepted' });
  assert.equal(plan.openDeal, true);
  assert.equal(plan.task?.create?.type, 'Contract');
  assert.equal(plan.followUpAt, plan.task?.create?.dueAt, 'Talkr gets the follow-up time');
  assert.equal(plan.blocked, null);
});
test('declined needs a reason, then follows up and drips', () => {
  const none = planOutcome('declined', base({ vocab: 'live', person: { ...john, stage: 'Offer Made' }, claim: false }));
  assert.equal(none.blocked, 'Pick why they said no');
  const plan = planOutcome('declined', base({ vocab: 'live', person: { ...john, stage: 'Offer Made' }, claim: false, reason: 'Price too low', enroll: { id: 'ap1', name: 'Offer drip' } }));
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.stage, { from: 'Offer Made', to: 'Offer Made - Follow Up' });
  assert.equal(plan.reason, 'Price too low');
  assert.deepEqual(plan.enroll, { id: 'ap1', name: 'Offer drip' });
  assert.ok(plan.task?.create?.title.includes('on the offer'));
  assert.ok(plan.lines.includes('Starts the “Offer drip” drip'), plan.lines.join(' | '));
});
test('no offer: not qualified by default, or a follow-up', () => {
  const nq = planOutcome('nooffer', base({ vocab: 'live', person: { ...john, stage: 'Underwriting' }, claim: false, reason: 'Too much rehab' }));
  assert.deepEqual(nq.stage, { from: 'Underwriting', to: 'Not Qualified' });
  assert.equal(nq.task?.create, undefined);
  const fu = planOutcome('nooffer', base({ vocab: 'live', person: { ...john, stage: 'Underwriting' }, claim: false, reason: 'Too much rehab', chip: 'in3d' }));
  assert.deepEqual(fu.stage, { from: 'Underwriting', to: 'Contacted - Follow Up Needed' });
  assert.ok(fu.task?.create);
  assert.equal(planOutcome('nooffer', base({ vocab: 'live', person: { ...john, stage: 'Underwriting' } })).blocked, 'Pick why there is no offer');
});
test('not interested, offer declined: the follow-up comes even when the stage stays', () => {
  const plan = planOutcome('notint', base({ vocab: 'live', person: { ...john, stage: 'Offer Made - Follow Up' }, claim: false, chip: 'declined' }));
  assert.equal(plan.stage, null);
  assert.ok(plan.task?.create?.title.includes('on the offer'));
});
test('offer accepted late in the day: the contract task is tomorrow morning, not already overdue', () => {
  const plan = planOutcome('accepted', base({ vocab: 'live', person: { ...john, stage: 'Offer Made' }, claim: false, now: new Date('2026-09-23T23:30:00Z') }));
  assert.ok(Date.parse(plan.task!.create!.dueAt) > Date.parse('2026-09-23T23:30:00Z'));
});
test('not interested, offer declined: a 30-day check-back, not a dead end', () => {
  const plan = planOutcome('notint', base({ vocab: 'live', person: { ...john, stage: 'Offer Made' }, claim: false, chip: 'declined' }));
  assert.ok(plan.task?.create?.title.includes('on the offer'));
});

console.log(`call-outcomes: ${passed} checks passed`);
