// AI Sales Manager: framework parsing, missed-deal flags, insights, the
// scorecard aggregation, and the roleplay grader's plumbing.
// Run: npx tsx tools/sales-manager.test.ts
import assert from 'node:assert/strict';
import {
  CALL_TYPES, FLAG_MIN_SECONDS, REVIEW_SECTION_TITLES, STAGE_IDS, callTypeById, flagIdsOf, missedDealFlags, parseClock, parseFramework, parseInsights,
  parseReviewSections, sectionsOf, stageHitRate, type CallFramework, type StageId, type StageStatus,
} from '../lib/sales-framework';
import { UPLOAD_MAX_BYTES, checkUpload, cleanUploadedText, guessRepSpeaker, labelledTranscript, parseDeepgram, segmentsFromUtterances, uploadPath } from '../lib/call-upload';
import { COACHING_SYSTEM, COACHING_TOOL, buildReview } from '../lib/call-coaching';
import { activeScorecards, buildScorecards, ruleInsights, teamTotals } from '../lib/sales-scorecard';
import {
  ARM_TTL_MINUTES, OBJECTIONS, PERSONAS, ROLEPLAY_TOOL, lineNotice, phoneInitiation, pickArmedSession, buildRoleplayFeedback, gradable, linesFromElevenLabs, parseLines, roleplayAgentBody,
  scoreTrend, sellerPrompt, talkRatio, transcriptText,
} from '../lib/roleplay';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const allStages = (s: StageStatus): Record<StageId, StageStatus> => Object.fromEntries(STAGE_IDS.map((id) => [id, s])) as Record<StageId, StageStatus>;
const signals = (over: Partial<CallFramework['signals']> = {}): CallFramework['signals'] => ({
  not_a_seller: false, seller_motivated: true, rep_asked_price: true, seller_gave_price: true, price_workable: true,
  appointment_or_agreement: true, next_step_set: true, rep_interruptions: 0, ...over,
});
const fw = (sig: Partial<CallFramework['signals']> = {}, stages: Partial<Record<StageId, StageStatus>> = {}): CallFramework => {
  const st = { ...allStages('hit'), ...stages };
  return { version: 1, stages: st, hit_rate: stageHitRate(st), signals: signals(sig) };
};
const ids = (f: CallFramework, ctx: Parameters<typeof missedDealFlags>[1] = { durationS: 300, repTalk: 40 }) => missedDealFlags(f, ctx).map((x) => x.id);

// ---- framework parse / normalize ---------------------------------------------------

test('stage hit rate: hit 1, partial half, na ignored, all-na null', () => {
  assert.equal(stageHitRate({ intro: 'hit', price_discovery: 'partial', motivation: 'miss', reverse_sell: 'na' }), 50);
  assert.equal(stageHitRate(allStages('na')), null);
  assert.equal(stageHitRate(allStages('hit')), 100);
});

test('parseFramework normalises statuses and signals, tolerates strings', () => {
  const f = parseFramework({
    stages: { ...Object.fromEntries(STAGE_IDS.map((s) => [s, 'na'])), intro: 'HIT', price_discovery: 'missed', motivation: 'Partial', timeline: 'bogus' },
    signals: { seller_motivated: 'true', rep_asked_price: false, seller_gave_price: true, price_workable: null, appointment_or_agreement: false, next_step_set: 'yes', rep_interruptions: '4.4', not_a_seller: false },
  })!;
  assert.equal(f.stages.intro, 'hit');
  assert.equal(f.stages.price_discovery, 'miss');
  assert.equal(f.stages.motivation, 'partial');
  assert.equal(f.stages.timeline, 'na');
  assert.equal(f.hit_rate, 50);
  assert.equal(f.signals.seller_motivated, true);
  assert.equal(f.signals.next_step_set, true);
  assert.equal(f.signals.price_workable, null);
  assert.equal(f.signals.rep_interruptions, 4);
});

test('parseFramework: missing or mostly-missing stages is null (old scorecards)', () => {
  assert.equal(parseFramework({ scores: {} }), null);
  assert.equal(parseFramework({ stages: { intro: 'hit' } }), null);
  assert.equal(parseFramework(null), null);
});

test('parseClock reads m:ss, h:mm:ss, numbers and transcript prefixes', () => {
  assert.equal(parseClock('3:04'), 184);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('[12] 0:45'), 45);
  assert.equal(parseClock(90.7), 90);
  assert.equal(parseClock('75'), 75);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('soon'), null);
});

test('parseInsights keeps 3, cleans dashes and quotes, drops empties', () => {
  const out = parseInsights([
    { title: 'Price came too early', quote: '"What would you take?"', at: '0:42', tip: 'Ask why now first — then price.' },
    { title: '', tip: 'x' },
    { title: 'No next step', quote: 'ok bye', at: '', tip: 'Book the time.' },
    { title: 'A', tip: 'b' }, { title: 'C', tip: 'd' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.at_s, 42);
  assert.equal(out[0]!.quote, 'What would you take?');
  assert.ok(!out[0]!.tip.includes('—'));
  assert.equal(out[1]!.at_s, null);
});

// ---- missed-deal flags ---------------------------------------------------------------

test('clean call: no flags', () => assert.deepEqual(ids(fw()), []));

test('motivated + workable price + no appointment = missed deal (and no next step)', () => {
  const got = ids(fw({ appointment_or_agreement: false, next_step_set: false }));
  assert.deepEqual(got, ['motivated_no_close', 'no_next_step']);
});

test('motivated_no_close needs a workable price', () => {
  assert.ok(!ids(fw({ appointment_or_agreement: false, price_workable: false })).includes('motivated_no_close'));
  assert.ok(!ids(fw({ appointment_or_agreement: false, price_workable: null })).includes('motivated_no_close'));
  assert.ok(!ids(fw({ appointment_or_agreement: false, seller_motivated: false })).includes('motivated_no_close'));
});

test('never asked price only when no price came up at all', () => {
  assert.ok(ids(fw({ rep_asked_price: false, seller_gave_price: false, price_workable: null })).includes('never_asked_price'));
  assert.ok(!ids(fw({ rep_asked_price: false, seller_gave_price: true })).includes('never_asked_price'));
});

test('a next step set (without an appointment) clears no_next_step', () => {
  assert.ok(!ids(fw({ appointment_or_agreement: false, next_step_set: true, price_workable: false })).includes('no_next_step'));
});

test('talked over: interruptions or rep talk share', () => {
  assert.ok(ids(fw({ rep_interruptions: 3 })).includes('talked_over'));
  assert.ok(!ids(fw({ rep_interruptions: 2 })).includes('talked_over'));
  assert.ok(ids(fw(), { durationS: 300, repTalk: 70 }).includes('talked_over'));
});

test('skipped motivation only when the stage was missed and none came out', () => {
  assert.ok(ids(fw({ seller_motivated: false }, { motivation: 'miss' })).includes('skipped_motivation'));
  assert.ok(!ids(fw({ seller_motivated: true }, { motivation: 'miss' })).includes('skipped_motivation'));
});

test('gates: short calls, non-sellers, buyer calls, unreadable framework', () => {
  const bad = fw({ appointment_or_agreement: false, next_step_set: false });
  assert.deepEqual(ids(bad, { durationS: FLAG_MIN_SECONDS - 1 }), []);
  assert.ok(ids(bad, { durationS: null }).length > 0, 'unknown length is not gated');
  assert.deepEqual(ids(fw({ not_a_seller: true, appointment_or_agreement: false })), []);
  assert.deepEqual(ids(bad, { durationS: 300, sellerCall: false }), []);
  assert.deepEqual(missedDealFlags(null, { durationS: 300 }), []);
});

test('flags are ordered by severity definition', () => {
  const got = ids(fw({ appointment_or_agreement: false, next_step_set: false, rep_asked_price: false, seller_gave_price: false, price_workable: null, rep_interruptions: 5, seller_motivated: false }, { motivation: 'miss' }));
  assert.deepEqual(got, ['never_asked_price', 'no_next_step', 'talked_over', 'skipped_motivation']);
});

// ---- the scorecard carries the framework ---------------------------------------------------

const MODEL_OUT = {
  scores: { opening: 7, empathy: 6, emotion: 6, non_neediness: 5, stories: 4, assertive: 6, self_sell: 5, isolate: 4, close: 3, next_steps: 2 },
  verdict: 'Good open and Carl told you why he is moving. You never asked for his number and the call ended on maybe. Next time book the time before hanging up.',
  keep: ['Opened with who you are.'],
  fix: ['Ask the price after motivation.', 'Isolate the HR date as the only block.', 'Book a time for the follow up.'],
  worst_line: 'Ok I will check in sometime next week.',
  better_line: 'Let us put Thursday at 4 on the calendar, does that work?',
  stages: { ...Object.fromEntries(STAGE_IDS.map((s) => [s, 'na'])), intro: 'hit', price_discovery: 'miss', motivation: 'partial', close: 'miss' },
  signals: { not_a_seller: false, seller_motivated: true, rep_asked_price: false, seller_gave_price: false, price_workable: null, appointment_or_agreement: false, next_step_set: false, rep_interruptions: 0 },
  insights: [{ title: 'No price ask', quote: 'So what is going on with the house?', at: '1:10', tip: 'After the why, ask what number they want.' }, { title: 'Soft ending', quote: 'check in sometime', at: '4:02', tip: 'Book a time.' }],
};

test('coaching tool and prompt teach the framework', () => {
  assert.ok('stages' in COACHING_TOOL.input_schema.properties);
  assert.ok((COACHING_TOOL.input_schema.required as readonly string[]).includes('signals'));
  assert.match(COACHING_SYSTEM, /Reverse selling/);
  assert.equal(COACHING_SYSTEM.includes('—') || COACHING_SYSTEM.includes('–'), false);
});

test('buildReview stores framework, flags, flag_ids, insights and duration', () => {
  const r = buildReview(MODEL_OUT, { repName: 'Ed', prospectName: 'Carl', talk: { rep: 45, prospect: 55 }, durationS: 260, sellerCall: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.review.framework?.hit_rate, 38); // hit + partial of 4
  assert.deepEqual(r.review.flag_ids, ['never_asked_price', 'no_next_step']);
  assert.equal(r.review.insights?.length, 2);
  assert.equal(r.review.insights?.[1]?.at_s, 242);
  assert.equal(r.review.duration_s, 260);
  assert.deepEqual(flagIdsOf(r.review), ['never_asked_price', 'no_next_step']);
});

test('buildReview without framework still works (older shape), no flags', () => {
  const { stages: _s, signals: _g, insights: _i, ...old } = MODEL_OUT;
  void _s; void _g; void _i;
  const r = buildReview(old, { repName: 'Ed', prospectName: 'Carl', talk: { rep: 45, prospect: 55 } });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.review.framework, undefined); assert.equal(r.review.flag_ids, undefined); }
});

test('buildReview: a buyer call gets the framework but no flags', () => {
  const r = buildReview(MODEL_OUT, { repName: 'Ed', prospectName: 'Carl', talk: { rep: 45, prospect: 55 }, durationS: 260, sellerCall: false });
  assert.ok(r.ok && r.review.framework && r.review.flag_ids?.length === 0);
});

// ---- scorecard aggregation --------------------------------------------------------------

const review = (rep: string, at: string, overall: number, stages: Partial<Record<StageId, StageStatus>>, flags: string[]) => ({
  id: Math.floor(Math.random() * 1e9), rep_id: rep, occurred_at: at, duration_s: 200,
  coaching_review: { status: 'completed', overall, framework: { version: 1, stages: { ...allStages('na'), ...stages }, hit_rate: stageHitRate({ ...allStages('na'), ...stages }), signals: signals() }, flag_ids: flags },
});
const W = { start: Date.parse('2026-09-28T05:00:00Z'), end: Date.parse('2026-10-05T05:00:00Z') };
const NOW = Date.parse('2026-10-04T18:00:00Z');

test('buildScorecards aggregates activity, reviews, flags, stages, roleplay, held appointments', () => {
  const cards = buildScorecards({
    activity: [
      { id: 'u1', name: 'Ed Rep', totalCalls: 40, conversations: 9, totalTalkTime: 5400, appointments: 3, offersMade: 2, dealsUnderContract: 1 },
      { id: 'u2', name: 'Quiet Rep' },
    ],
    reviews: [
      review('u1', '2026-09-29T15:00:00Z', 60, { intro: 'hit', price_discovery: 'miss', motivation: 'hit' }, ['never_asked_price']),
      review('u1', '2026-09-30T15:00:00Z', 80, { intro: 'hit', price_discovery: 'miss', motivation: 'partial' }, ['never_asked_price', 'no_next_step']),
      review('u1', '2026-09-01T15:00:00Z', 10, { intro: 'miss' }, ['talked_over']), // out of window
      { id: 1, rep_id: 'u1', occurred_at: '2026-09-30T16:00:00Z', duration_s: 20, coaching_review: { status: 'skipped' } },
      review('u2', '2026-09-30T15:00:00Z', 50, {}, []),
    ],
    roleplays: [
      { user_id: 'u1', started_at: '2026-10-01T10:00:00Z', score: 70, status: 'scored' },
      { user_id: 'u1', started_at: '2026-10-02T10:00:00Z', score: null, status: 'abandoned' },
      { user_id: 'u1', started_at: '2026-10-03T10:00:00Z', score: 80, status: 'scored' },
    ],
    appointments: [
      { assigned_to: 'u1', starts_at: '2026-09-30T15:00:00Z' },
      { assigned_to: null, seller_rep: 'u1', starts_at: '2026-10-01T15:00:00Z' },
      { assigned_to: 'u1', starts_at: '2026-10-04T23:00:00Z' }, // future: not held
      { assigned_to: 'u1', starts_at: '2026-09-30T15:00:00Z', deleted_at: '2026-09-30T00:00:00Z' },
    ],
    window: W, now: NOW,
  });
  const ed = cards[0]!;
  assert.equal(ed.calls, 40);
  assert.equal(ed.reviewedCalls, 2);
  assert.equal(ed.avgCallScore, 70);
  assert.equal(ed.stageHitRates.intro, 100);
  assert.equal(ed.stageHitRates.price_discovery, 0);
  assert.equal(ed.stageHitRates.motivation, 75);
  assert.equal(ed.stageHitRates.close, null);
  assert.equal(ed.flags.never_asked_price, 2);
  assert.equal(ed.flags.no_next_step, 1);
  assert.equal(ed.flags.talked_over, 0);
  assert.equal(ed.flaggedCalls, 2);
  assert.deepEqual(ed.weakStages, ['price_discovery']);
  assert.equal(ed.roleplaySessions, 2);
  assert.equal(ed.avgRoleplayScore, 75);
  assert.equal(ed.appointmentsSet, 3);
  assert.equal(ed.appointmentsHeld, 2);
  assert.equal(ed.contractRate, 50);
  assert.equal(ed.frameworkHitRate, 59); // per-call 67 and 50, averaged
  const quiet = cards[1]!;
  assert.equal(quiet.calls, 0);
  assert.equal(quiet.reviewedCalls, 1);
  assert.equal(quiet.contractRate, null);
  assert.equal(activeScorecards(cards).length, 2);
  const t = teamTotals(cards);
  assert.equal(t.reviewedCalls, 3);
  assert.equal(t.avgCallScore, 63); // (70*2 + 50*1) / 3
});

test('ruleInsights: weakest stage first, then flags, max three', () => {
  const [ed] = buildScorecards({
    activity: [{ id: 'u1', name: 'Ed', totalCalls: 5 }],
    reviews: [
      review('u1', '2026-09-29T15:00:00Z', 60, { price_discovery: 'miss', close: 'miss' }, ['never_asked_price']),
      review('u1', '2026-09-30T15:00:00Z', 60, { price_discovery: 'miss', close: 'partial' }, ['never_asked_price', 'talked_over']),
    ],
    roleplays: [], window: W, now: NOW,
  });
  const lines = ruleInsights(ed!);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^Price discovery: hit on 0%/);
  assert.match(lines[1]!, /^Future-framed close: hit on 25%/);
  assert.match(lines[2]!, /^Never asked price on 2 calls/);
});

test('ruleInsights for a rep with calls but nothing graded', () => {
  const [c] = buildScorecards({ activity: [{ id: 'u', name: 'N', totalCalls: 12 }], reviews: [], roleplays: [], window: W, now: NOW });
  assert.match(ruleInsights(c!)[0]!, /long enough to grade/);
});

// ---- roleplay ----------------------------------------------------------------------------

test('personas and objections cover the brief', () => {
  assert.equal(PERSONAS.length, 8);
  for (const id of ['inheritor', 'tired_landlord', 'pre_foreclosure', 'just_a_number', 'wants_retail', 'divorce', 'hostile', 'engineer']) assert.ok(PERSONAS.some((p) => p.id === id), id);
  for (const id of ['too_low', 'spouse', 'other_investor', 'realtor']) assert.ok(OBJECTIONS.some((o) => o.id === id), id);
});

test('sellerPrompt plays the seller with the drill and difficulty', () => {
  const p = sellerPrompt({ persona: PERSONAS[0]!, difficulty: 'hard', objection: 'spouse', company: 'Acme Homes', voice: true });
  assert.match(p, /you play the SELLER/);
  assert.match(p, /Donna/);
  assert.match(p, /talk to your spouse/);
  assert.match(p, /three objections/);
  assert.match(p, /Acme Homes/);
  assert.match(p, /speaking out loud/);
});

test('parseLines maps ElevenLabs roles and drops junk', () => {
  const lines = parseLines([{ role: 'user', message: 'Hi Donna' }, { role: 'agent', text: 'Hello?', time_in_call_secs: 3.4 }, { role: 'x', text: 'no' }, { role: 'rep', text: '   ' }]);
  assert.deepEqual(lines, [{ role: 'rep', text: 'Hi Donna', at_s: null }, { role: 'seller', text: 'Hello?', at_s: 3 }]);
  assert.equal(linesFromElevenLabs({ transcript: [{ role: 'agent', message: 'Hello?', time_in_call_secs: 0 }, { role: 'user', message: null }] }).length, 1);
});

const LINES = parseLines([
  { role: 'seller', text: 'Hello? Yes, this is Donna.' },
  { role: 'rep', text: 'Hi Donna, this is Ed with Acme Homes, calling about the house on Oak. Are you still thinking of selling it?' },
  { role: 'seller', text: 'Maybe. It has been a lot.' },
  { role: 'rep', text: 'What has got you thinking about selling right now?' },
  { role: 'seller', text: 'My mom passed and I live four hours away.' },
  { role: 'rep', text: 'I am sorry. What number were you hoping to get for it?' },
  { role: 'seller', text: 'Around 180.' },
]);

test('talkRatio, gradable, transcriptText', () => {
  const t = talkRatio(LINES)!;
  assert.equal(t.rep + t.seller, 100);
  assert.ok(t.rep > 50);
  assert.equal(gradable(LINES), true);
  assert.equal(gradable(LINES.slice(0, 3)), false);
  assert.match(transcriptText(LINES, { rep: 'Ed', seller: 'Donna' }), /^Donna: Hello\?/);
});

test('buildRoleplayFeedback: scorecard + objection + model answer, no flags', () => {
  assert.ok('hardest_moment' in ROLEPLAY_TOOL.input_schema.properties);
  const r = buildRoleplayFeedback({
    ...MODEL_OUT,
    objection: { score: 6.6, note: 'You named the spouse but never asked what she cares about.' },
    hardest_moment: { quote: 'I need to talk to my husband.', model_answer: 'Of course. What do you think he will ask first? Let us get him on the phone for five minutes tomorrow.' },
  }, { repName: 'Ed', sellerName: 'Donna', lines: LINES });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.feedback.objection?.score, 7);
  assert.match(r.feedback.hardest_moment!.model_answer, /five minutes/);
  assert.equal(r.feedback.flag_ids, undefined);
  assert.ok(r.feedback.framework);
  assert.equal(r.feedback.rep_talk + r.feedback.prospect_talk, 100);
});

test('scoreTrend orders by time and compares halves', () => {
  const t = scoreTrend([{ at: '2026-10-03', score: 80 }, { at: '2026-10-01', score: 50 }, { at: '2026-10-02', score: null }, { at: '2026-10-04', score: 90 }, { at: '2026-09-30', score: 40 }]);
  assert.deepEqual(t.points, [40, 50, 80, 90]);
  assert.equal(t.delta, 40);
  assert.equal(scoreTrend([{ at: 'x', score: 1 }]).delta, null);
});

test('roleplay agent: prompt and opener are dynamic variables, signed urls only', () => {
  const b = roleplayAgentBody({ company: 'Acme Homes' });
  assert.equal(b.conversation_config.agent.prompt.prompt, '{{persona_prompt}}');
  assert.equal(b.conversation_config.agent.first_message, '{{first_message}}');
  assert.ok('persona_prompt' in b.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders);
  assert.equal(b.platform_settings.auth.enable_auth, true);
  assert.ok(!('voice_id' in b.conversation_config.tts));
  assert.equal((roleplayAgentBody({ voiceId: 'v1' }).conversation_config.tts as { voice_id?: string }).voice_id, 'v1');
});

// ---- the four review sections --------------------------------------------------------

test('parseReviewSections normalises all four, with times and outcomes', () => {
  const s = parseReviewSections({
    hidden_objections: [{ objection: 'Brother co-owns', quote: '"my brother wants to keep it"', at: '2:10', handle: 'Ask what he would need to agree.' }, { objection: '', handle: 'x' }],
    missed_closes: [{ quote: 'that would actually help', at: '5:01', say: 'Then let us lock the 30th. Can I send the agreement?' }],
    improvement: { strengths: ['Calm open'], gaps: ['No price ask', ''], steps: ['Ask price after motivation', 'Book the time'] },
    emotional: { summary: 'Warm start, flat finish.', tone: 'calm', energy: 'LOUD', turning_points: [{ quote: 'I just want it done', at: '3:00', outcome: 'won', why: 'Matched her relief.' }, { quote: 'ok', outcome: 'weird', why: 'Lost energy.' }] },
  })!;
  assert.equal(s.hidden_objections.length, 1);
  assert.equal(s.hidden_objections[0]!.at_s, 130);
  assert.equal(s.hidden_objections[0]!.quote, 'my brother wants to keep it');
  assert.equal(s.missed_closes[0]!.at_s, 301);
  assert.deepEqual(s.improvement.gaps, ['No price ask']);
  assert.equal(s.emotional.energy, null);
  assert.equal(s.emotional.turning_points[0]!.outcome, 'won');
  assert.equal(s.emotional.turning_points[1]!.outcome, 'neutral');
  assert.equal(parseReviewSections({}), null);
  assert.equal(parseReviewSections(null), null);
});

test('the scorecard asks for and stores the four sections, by their names', () => {
  for (const t of Object.values(REVIEW_SECTION_TITLES)) assert.ok(COACHING_SYSTEM.includes(t), t);
  assert.ok((COACHING_TOOL.input_schema.required as readonly string[]).includes('sections'));
  const r = buildReview({ ...MODEL_OUT, sections: { hidden_objections: [], missed_closes: [{ quote: 'q', at: '1:00', say: 'Close.' }], improvement: { strengths: [], gaps: [], steps: ['Do x'] }, emotional: { summary: 's', tone: 't', energy: 'high', turning_points: [] } } },
    { repName: 'Ed', prospectName: 'Carl', talk: { rep: 45, prospect: 55 }, durationS: 200 });
  assert.ok(r.ok && r.review.sections?.missed_closes[0]?.at_s === 60);
  assert.ok(r.ok && sectionsOf(r.review)?.improvement.steps[0] === 'Do x');
});

test('call scoring types: seller types flag, buyer type does not', () => {
  assert.deepEqual(CALL_TYPES.map((c) => c.id), ['seller_acquisitions', 'seller_follow_up', 'buyer_dispositions']);
  assert.equal(callTypeById('buyer_dispositions')?.seller, false);
  assert.equal(callTypeById('nope'), null);
});

// ---- Submit a call for review: uploads ---------------------------------------------------

test('checkUpload: txt and audio in, other types and >25MB out', () => {
  assert.deepEqual(checkUpload('call.TXT', 10), { ok: true, kind: 'text', ext: 'txt', contentType: 'text/plain' });
  assert.equal((checkUpload('a.m4a', 100) as { contentType: string }).contentType, 'audio/mp4');
  assert.equal((checkUpload('a.wav', 100) as { contentType: string }).contentType, 'audio/wav');
  assert.equal(checkUpload('a.mp3', UPLOAD_MAX_BYTES + 1).ok, false);
  assert.equal(checkUpload('a.pdf', 100).ok, false);
  assert.equal(checkUpload('a.mp3', 0).ok, false);
  assert.match(uploadPath(11, 'abc-123', 'mp3', 5), /^11\/uploads\/abc-123-5\.mp3$/);
});

test('Deepgram utterances: parse, find the rep, label', () => {
  const dg = parseDeepgram({
    metadata: { duration: 182.4 },
    results: { utterances: [
      { speaker: 0, start: 0.2, end: 1, transcript: 'Hello?' },
      { speaker: 1, start: 1.1, end: 5, transcript: 'Hi, this is Ed with Acme Homes, calling about the house on Oak. Still thinking of selling?' },
      { speaker: 0, start: 5.2, end: 8, transcript: 'Maybe, depends on the number.' },
      { speaker: 1, start: 8.1, end: 10, transcript: 'What number were you hoping for?' },
      { speaker: 1, start: 10, end: 10, transcript: '  ' },
    ] },
  });
  assert.equal(dg.utterances.length, 4);
  assert.equal(dg.durationS, 182);
  const rep = guessRepSpeaker(dg.utterances);
  assert.equal(rep, 1);
  const segs = segmentsFromUtterances(dg.utterances, rep);
  assert.equal(segs[1]!.speaker, 'rep');
  assert.match(labelledTranscript(segs, { rep: 'Ed', prospect: 'Seller' }), /^Seller: Hello\?\nEd: Hi/);
  // No cues either way: the second speaker (the seller usually picks up first).
  assert.equal(guessRepSpeaker([{ speaker: 3, start: 0, end: 1, text: 'yo' }, { speaker: 7, start: 1, end: 2, text: 'hey' }]), 7);
  assert.equal(parseDeepgram(null).utterances.length, 0);
});

test('cleanUploadedText normalises line breaks and caps', () => {
  assert.equal(cleanUploadedText('Ed: hi\r\n\r\n\r\nSam:  yo  '), 'Ed: hi\n\nSam: yo');
  assert.equal(cleanUploadedText('x'.repeat(100), 10).length, 10);
});

// ---- the roleplay phone line ---------------------------------------------------------------

test('pickArmedSession: newest armed phone session inside 30 minutes', () => {
  const now = Date.parse('2026-10-04T18:00:00Z');
  const s = (id: number, minAgo: number, status = 'armed', mode = 'phone') => ({ id, status, mode, started_at: new Date(now - minAgo * 60_000).toISOString() });
  assert.equal(pickArmedSession([s(1, 20), s(2, 5), s(3, 1, 'active'), s(4, 2, 'armed', 'voice')], now)?.id, 2);
  assert.equal(pickArmedSession([s(1, ARM_TTL_MINUTES + 1)], now), null);
  assert.equal(pickArmedSession([], now), null);
});

test('line answers: persona initiation, and notices that end the call', () => {
  const init = phoneInitiation('PROMPT', 'Hello?');
  assert.equal(init.type, 'conversation_initiation_client_data');
  assert.deepEqual(init.dynamic_variables, { persona_prompt: 'PROMPT', first_message: 'Hello?' });
  assert.equal(init.conversation_config_override.agent.first_message, 'Hello?');
  assert.match(lineNotice('unknown_caller').dynamic_variables.first_message, /profile/);
  assert.match(lineNotice('not_armed').dynamic_variables.persona_prompt, /end the call/);
});

test('roleplay agent wired to voice-agent webhooks when the line is set up', () => {
  const b = roleplayAgentBody({ wiring: { personalizeUrl: 'https://x/functions/v1/voice-agent/personalize', secretHeader: 'X-Voice-Agent-Secret', personalizeSecret: 's3', webhookId: 'wh1' } });
  const p = b.platform_settings as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(p.overrides.enable_conversation_initiation_client_data_from_webhook, true);
  assert.equal(p.workspace_overrides.conversation_initiation_client_data_webhook.request_headers['X-Voice-Agent-Secret'], 's3');
  assert.equal(p.workspace_overrides.webhooks.post_call_webhook_id, 'wh1');
  assert.ok(!('overrides' in roleplayAgentBody({}).platform_settings));
});

console.log(`${passed} passed`);
