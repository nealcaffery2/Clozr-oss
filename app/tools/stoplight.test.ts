// The team stoplight: the sheet's colour rule, prorating, the activity
// blocks, ranges, TC file gaps and record links.
// Run: npx tsx tools/stoplight.test.ts
import {
  ACQ_TARGETS, DISPO_TARGETS, LEAD_MANAGER_TARGETS, STOPLIGHT_RANGES, acquisitionsCells, activityLight, dispositionsCells,
  gapCells, gapLight, grade, laneOf, overall, personLight, recordHref, scaled, stoplightRange, tcCells, tcFileGaps, workdaysBetween,
  type StoplightMetrics, type TcFileRow,
} from '../lib/stoplight';
import { tcChecklists } from '../supabase/functions/_shared/tc-checklists';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// The sheet's rule: GREEN met the goal, YELLOW met the expectation, RED below.
const hi = { expectation: 150, goal: 200, direction: 'higher' as const };
eq('higher: at goal is green', grade(200, hi), 'green');
eq('higher: between is yellow', grade(150, hi), 'yellow');
eq('higher: below expectation is red', grade(149, hi), 'red');
eq('no value is not graded', grade(null, hi), 'none');
const lo = { expectation: 21, goal: 14, direction: 'lower' as const };
eq('lower: 14 days is green', grade(14, lo), 'green');
eq('lower: 20 days is yellow', grade(20, lo), 'yellow');
eq('lower: 22 days is red', grade(22, lo), 'red');

// Targets copied from the Drive sheet's Targets tab.
eq('acq revenue $75K / $100K a month', [ACQ_TARGETS.revenue.expectation, ACQ_TARGETS.revenue.goal], [75000, 100000]);
eq('acq pipeline $150K / $200K, not prorated', [ACQ_TARGETS.pipeline.expectation, ACQ_TARGETS.pipeline.prorate], [150000, false]);
eq('lead manager appointments 15 / 30', [LEAD_MANAGER_TARGETS.appointments.expectation, LEAD_MANAGER_TARGETS.appointments.goal], [15, 30]);
eq('dispo deals assigned is a placeholder', DISPO_TARGETS.dealsAssigned.placeholder, true);

// Prorating: 4 weeks of 5 workdays, so a week is a quarter of the month.
eq('a week is a quarter of monthly revenue', scaled(ACQ_TARGETS.revenue, 5), { expectation: 18750, goal: 25000 });
eq('pipeline is the same in any range', scaled(ACQ_TARGETS.pipeline, 5), { expectation: 150000, goal: 200000 });

// Activity blocks.
eq('any: 2 hits green', activityLight(2, 5, 'any'), 'green');
eq('any: 1 hit yellow', activityLight(1, 5, 'any'), 'yellow');
eq('any: 0 hits red', activityLight(0, 5, 'any'), 'red');
eq('all: 4 of 4 green', activityLight(4, 4, 'all'), 'green');
eq('all: 3 of 4 yellow', activityLight(3, 4, 'all'), 'yellow');
eq('all: 2 of 4 red', activityLight(2, 4, 'all'), 'red');
eq('no workdays is not graded', activityLight(0, 0, 'any'), 'none');

eq('overall: a red makes it red', overall(['green', 'red', 'none']), 'red');
eq('overall: all green', overall(['green', 'none', 'green']), 'green');
eq('overall: mixed is yellow', overall(['green', 'yellow']), 'yellow');
eq('overall: nothing graded', overall(['none']), 'none');
eq('gaps: zero is green', gapLight(0), 'green');
eq('gaps: any is red', gapLight(3), 'red');

const zero: StoplightMetrics = {
  calls: 0, talk_min: 0, conversations: 0, appointments: 0, calendar_meetings: 0, offers: 0, contracts: 0,
  buyer_calls: 0, buyer_talk_min: 0, buyer_texts: 0, buyers_added: 0, buyer_offers: 0, deals_marketed: 0, buyer_contracts: 0,
  closed_acq: 0, revenue_acq: 0, closed_dispo: 0, revenue_dispo: 0, pipeline_acq: 0, pipeline_dispo: 0,
};
// Andino's week: 116 calls a day, no offers, no contracts.
const andino = acquisitionsCells({ ...zero, calls: 580, talk_min: 200 }, 5);
const cell = (cells: ReturnType<typeof acquisitionsCells>, k: string) => cells.find((c) => c.key === k)!;
eq('116 calls a day meets the 50 minimum', [cell(andino, 'calls').light, cell(andino, 'calls').shown], ['green', '116/day']);
eq('one minimum hit is a yellow activity block', cell(andino, 'activity').light, 'yellow');
eq('no closings: average fee not graded', cell(andino, 'avgFee').light, 'none');
eq('conversations have no target', cell(andino, 'conversations').target, null);
eq('a week with no revenue is red', cell(andino, 'revenue').light, 'red');
const both = acquisitionsCells({ ...zero, calls: 300, talk_min: 500 }, 5);
eq('calls and talk time is a green block', cell(both, 'activity').light, 'green');
// A missed single minimum doesn't make the row red when the block passes.
const taylor = acquisitionsCells({ ...zero, calls: 290, talk_min: 520, closed_acq: 1, revenue_acq: 32000, pipeline_acq: 214000, appointments: 10 }, 5);
eq('missed offers minimum is red on its own', cell(taylor, 'offers').light, 'red');
eq('...but the row reads green when the block and KPIs pass', personLight(taylor, []), 'green');
const diego = acquisitionsCells(zero, 5);
eq('nothing logged is a red block', cell(diego, 'activity').light, 'red');
const closer = acquisitionsCells({ ...zero, closed_acq: 1, revenue_acq: 28000, pipeline_acq: 210000 }, 5);
eq('one $28K closing: fee green', cell(closer, 'avgFee').light, 'green');
eq('$210K pipeline green', cell(closer, 'pipeline').light, 'green');
eq('$28K in a week passes the $25K goal', cell(closer, 'revenue').light, 'green');

const dispo = dispositionsCells({ ...zero, buyer_calls: 260, buyer_talk_min: 470, buyers_added: 16, buyer_offers: 11 }, 5);
eq('dispo: all four minimums is green', dispo.find((c) => c.key === 'activity')!.light, 'green');
const dispoLow = dispositionsCells({ ...zero, buyer_calls: 260, buyer_talk_min: 470, buyers_added: 16 }, 5);
eq('dispo: three of four is yellow', dispoLow.find((c) => c.key === 'activity')!.light, 'yellow');
eq('dispo: deals marketed has no target', dispo.find((c) => c.key === 'marketed')!.target, null);

const gaps = gapCells({ gaps: { overdue_tasks: 474, overdue_unlinked: 474, untouched_leads: 0, no_next_step: 2 } });
eq('gap lights', gaps.map((g) => g.light), ['red', 'green', 'red']);

// Lanes.
eq('acquisitions role', laneOf({ role: 'acquisitions', is_tc: false }), 'acquisitions');
eq('admin coordinating files is TC', laneOf({ role: 'admin', is_tc: true }), 'tc');
eq('owner is other', laneOf({ role: 'owner', is_tc: false }), 'other');
eq('dispo who also coordinates stays dispo', laneOf({ role: 'dispositions', is_tc: true }), 'dispositions');

// Ranges. Tuesday 2026-10-13, noon.
const now = new Date(2026, 9, 13, 12);
const wk = stoplightRange('This week', now);
eq('this week starts Monday', [wk.from.getDate(), wk.workdays], [12, 2]);
const last = stoplightRange('Last week', now);
eq('last week is Mon 5 to Mon 12, 5 workdays', [last.from.getDate(), last.to.getDate(), last.workdays], [5, 12, 5]);
const mo = stoplightRange('This month', now);
eq('this month: 9 workdays through the 13th', [mo.from.getDate(), mo.workdays], [1, 9]);
const sunday = stoplightRange('This week', new Date(2026, 9, 18, 9));
eq('on Sunday the week has 5 workdays', [sunday.from.getDate(), sunday.workdays], [12, 5]);
eq('workdays skip the weekend', workdaysBetween(new Date(2026, 9, 9), new Date(2026, 9, 13)), 2);
eq('three ranges', STOPLIGHT_RANGES.length, 3);

// TC files. The ids the rules use exist in the checklist.
const ids = new Set([...tcChecklists.assignment.phases, ...tcChecklists.novation.phases].flatMap((p) => p.tasks.map((t) => t.id)));
eq('checklist ids exist', ['a34', 'a11', 'a17', 'a22', 'n41', 'n21', 'n32'].every((i) => ids.has(i)), true);

const file: TcFileRow = {
  transaction_id: 1, deal_id: 5084, seller_id: 42, label: '1 Main St', stage: 'In Escrow', deal_type: 'assignment',
  contract_date: '2026-09-22', ctc_target: '2026-10-02', close_date: '2026-10-22', emd_received_at: null,
  checklist: ['a1', 'a2', 'a11', 'a13'], schedule_c: [], tc_rep_id: 'casey', last_activity_at: '2026-10-12T15:00:00Z',
};
const kinds = (f: TcFileRow, today = '2026-10-13') => tcFileGaps(f, today).map((g) => g.kind);
eq('missed owner check, Schedule C and CTC', kinds(file), ['owner_check', 'schedule_c', 'ctc']);
eq('a fresh file misses nothing', kinds({ ...file, contract_date: '2026-10-13', ctc_target: '2026-10-23' }), []);
eq('EMD due D2', kinds({ ...file, checklist: ['a34', 'a17', 'a22'] }), ['emd']);
eq('EMD receipt on the file counts', kinds({ ...file, checklist: ['a34', 'a17', 'a22'], emd_received_at: '2026-09-24T00:00:00Z' }), []);
eq('no TC and stale', kinds({ ...file, checklist: ['a34', 'a11', 'a17', 'a22'], tc_rep_id: null, last_activity_at: '2026-10-01T00:00:00Z' }), ['no_tc', 'stale']);
eq('never any activity is stale', kinds({ ...file, checklist: ['a34', 'a11', 'a17', 'a22'], last_activity_at: null }), ['stale']);
eq('Schedule C blocker', kinds({ ...file, checklist: ['a34', 'a11', 'a17', 'a22'], schedule_c: [{ id: 'x', text: 'Lien', status: 'red' }] }), ['schedule_c_blocker']);
eq('novation not started', kinds({ ...file, deal_type: 'novation', checklist: [], contract_date: '2026-10-13', ctc_target: null }), ['novation_not_started']);
eq('novation has no D2 EMD line', kinds({ ...file, deal_type: 'novation', checklist: ['n41', 'n21', 'n32'] }), []);

const tc = tcCells([file, { ...file, transaction_id: 2, checklist: ['a34', 'a11', 'a17', 'a22'] }], '2026-10-13', 3);
eq('TC row counts files', tc.find((c) => c.key === 'files')!.shown, '2');
eq('TC row: one owner check missed', tc.find((c) => c.key === 'owner_check')!.shown, '1');
eq('TC row: unlinked tasks red', tc.find((c) => c.key === 'unlinked')!.light, 'red');
// A TC whose only miss is an open Schedule C blocker is not green.
const blockerOnly = tcCells([{ ...file, checklist: ['a34', 'a11', 'a17', 'a22'], schedule_c: [{ id: 'x', text: 'Lien', status: 'red' }] }], '2026-10-13', 0);
eq('Schedule C blocker is graded', blockerOnly.find((c) => c.key === 'schedule_c_blocker')!.light, 'red');
eq('...and makes the files grade red', personLight(blockerOnly, []), 'red');
const cleanFile = tcCells([{ ...file, checklist: ['a34', 'a11', 'a17', 'a22'] }], '2026-10-13', 0);
eq('a clean file grades green', personLight(cleanFile, []), 'green');

// Links follow lib/nav-hash.
eq('TC file link', recordHref({ screen: 'tc', sellerId: 42, dealId: 7 }), '#screen=tc&id=s42&deal=d7&from=reporting');
eq('lead link', recordHref({ screen: 'person', sellerId: 9 }), '#screen=person&id=s9&from=reporting');
eq('buyer link', recordHref({ screen: 'buyer', buyerId: 3 }), '#screen=buyer&id=b3&from=reporting');
eq('demo lead link uses the demo graph id', recordHref({ screen: 'person', sellerId: 1, dealId: 3 }, true), '#screen=person&id=p1&from=reporting');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
