// lib/dispo-sop.ts: the dispo SOP's checks.
// Run with:  npx tsx tools/dispo-sop.test.ts
import { accessCheck, approvalSurvives, belowAsk, closeDateIn, soldWriteProblem, judgedAsk, needsApproval, compsCheck, contractCheck, daysSince, marketTiming, qualifiedSale } from '../lib/dispo-sop';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};
const today = new Date(2026, 9, 10, 15, 0); // Oct 10 2026, 3 PM local

check('daysSince same day is 0', daysSince('2026-10-10', today) === 0);
check('daysSince 6 days', daysSince('2026-10-04', today) === 6);
check('daysSince null', daysSince(null, today) === null);

check('5 days on market is not MLS yet', !marketTiming('2026-10-05', { today }).mlsDue);
check('6 days on market is MLS time', marketTiming('2026-10-04', { today }).mlsDue && marketTiming('2026-10-04', { today }).dom === 6);
check('a sold deal is never MLS time', !marketTiming('2026-09-01', { today, sold: true }).mlsDue);
check('not marketed: no DOM', marketTiming(null, { today }).dom === null);

check('access: verified is ok', accessCheck({ access_verified_at: '2026-10-09T10:00:00Z' }, today).state === 'ok');
check('access: no occupancy is missing', accessCheck({}, today).state === 'missing');
check('access: vacant, marketed today, inside 24h', accessCheck({ occupancy_status: 'vacant', marketing_started_on: '2026-10-10' }, today).state === 'due');
check('access: vacant, marketed 2 days ago, late', accessCheck({ occupancy_status: 'vacant', marketing_started_on: '2026-10-08' }, today).state === 'late');
check('access: occupied, marketed yesterday, inside 48h', accessCheck({ occupancy_status: 'occupied', marketing_started_on: '2026-10-09' }, today).state === 'due');

check('comps 30 days old pass', compsCheck('2026-09-10', today).state === 'ok');
check('comps 31 days old fail', compsCheck('2026-09-09', today).state === 'late');
check('no comps date is missing', compsCheck(null, today).state === 'missing');

check('contract date means signed', contractCheck({ contract_date: '2026-10-01' }).state === 'ok');
check('no contract is missing', contractCheck({ contract_status: 'Sent' }).state === 'missing');

check('below ask', belowAsk(199000, 200000));
check('at ask is not below', !belowAsk(200000, 200000));
check('no ask, nothing is below', !belowAsk(1, null));

// The ask is the higher of the one logged with the offer and today's; no ask needs approval.
check('judged ask: higher of then and now', judgedAsk(230000, 240000) === 240000);
check('judged ask: lowering the ask does not help', needsApproval(235000, 200000, 240000));
check('judged ask: clearing the ask does not help', needsApproval(235000, null, 240000));
check('no ask at all needs approval', needsApproval(235000, null, null));
check('at the judged ask needs none', !needsApproval(240000, 230000, 240000));
check('null snapshot needs approval, even over today\'s ask', needsApproval(250000, 240000, null));
check('a 0 ask needs approval', needsApproval(1000, 0, 0) && needsApproval(250000, 0, 240000));
check('a 0 snapshot needs approval', needsApproval(250000, 240000, 0));
check('lowered ask: judged against the higher snapshot', needsApproval(235000, 220000, 240000) && judgedAsk(220000, 240000) === 240000);
check('over both asks needs none', !needsApproval(245000, 240000, 240000));
check('not logged yet: snapshot is today\'s ask', !needsApproval(240000, 240000) && needsApproval(239000, 240000));

// An approval belongs to one amount, buyer and deal.
const ap = { amount: 230000, deal_id: 7, buyer_id: 3 };
check('approval survives an unrelated edit', approvalSurvives(ap, { ...ap }));
check('approval cleared by a new amount', !approvalSurvives(ap, { ...ap, amount: 231000 }));
check('approval cleared by another deal', !approvalSurvives(ap, { ...ap, deal_id: 8 }));
check('approval cleared by another buyer', !approvalSurvives(ap, { ...ap, buyer_id: 4 }));

// Marking sold (migration 236).
const unsold = { sold_at: null, sold_price: null, buyer_id: null };
const acc = [{ buyer_id: 3, amount: 230000 }];
check('sold at the accepted price: ok', soldWriteProblem(unsold, { sold_at: 'x', sold_price: 230000, buyer_id: 3 }, acc, false) === null);
check('sold below the accepted price: refused', soldWriteProblem(unsold, { sold_at: 'x', sold_price: 200000, buyer_id: 3 }, acc, false) !== null);
check('sold to another buyer: refused', soldWriteProblem(unsold, { sold_at: 'x', sold_price: 230000, buyer_id: 4 }, acc, false) !== null);
check('sold with no accepted offer: refused', soldWriteProblem(unsold, { sold_at: 'x', sold_price: 230000, buyer_id: 3 }, [], false) !== null);
check('a sold deal is fixed', soldWriteProblem({ sold_at: 'x', sold_price: 230000, buyer_id: 3 }, { sold_at: 'x', sold_price: 1, buyer_id: 3 }, acc, false) !== null);
check('an admin may record any sale', soldWriteProblem(unsold, { sold_at: 'x', sold_price: 1, buyer_id: 9 }, [], true) === null);
check('attaching a buyer to an unsold deal is free', soldWriteProblem(unsold, { sold_at: null, sold_price: null, buyer_id: 3 }, [], false) === null);

const good = { buyerVerified: true, pof: true, executedContract: true, emd: 5000, optionDays: 0, buyerClose: '2026-10-20', abClose: '2026-10-24' };
check('all six: qualified', qualifiedSale(good).qualified);
check('no EMD: not qualified', !qualifiedSale({ ...good, emd: null }).qualified);
check('an option period: not qualified', !qualifiedSale({ ...good, optionDays: 7 }).qualified);
check('closing after AB: not qualified', !qualifiedSale({ ...good, buyerClose: '2026-10-25' }).qualified);
check('closing on the AB date: qualified', qualifiedSale({ ...good, buyerClose: '2026-10-24' }).qualified);
check('no AB date: not qualified', !qualifiedSale({ ...good, abClose: null }).qualified);
check('unverified buyer: flag false', qualifiedSale({ ...good, buyerVerified: false }).flags.verified_buyer === false);

check('close in 14 days', closeDateIn(14, today) === '2026-10-24');
check('close in 0 days is none', closeDateIn(0, today) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
