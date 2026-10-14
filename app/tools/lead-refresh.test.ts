// npx tsx tools/lead-refresh.test.ts

import { LEAD_CHUNK, LEAD_HOLD_AT, LEAD_REFRESH_MAX, RELOAD_DEBOUNCE_MS, chunkIds, planLeadRefresh } from '../lib/lead-refresh';

let failed = 0;
const check = (name: string, pass: boolean) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
};

check('a few new leads stay one read each', planLeadRefresh(LEAD_REFRESH_MAX) === 'each' && planLeadRefresh(1) === 'each');
check('a burst above the max is read by id', planLeadRefresh(LEAD_REFRESH_MAX + 1) === 'byIds' && planLeadRefresh(LEAD_HOLD_AT) === 'byIds');
check('past the hold line nothing is read', planLeadRefresh(LEAD_HOLD_AT + 1) === 'hold' && planLeadRefresh(1000) === 'hold');
check('by-id reads are chunks of 200', chunkIds([1, 2, 3], 2).length === 2 && chunkIds(Array.from({ length: 450 }, (_, i) => i), LEAD_CHUNK).map((c) => c.length).join(',') === '200,200,50');
check('a full reload waits at least 3s', RELOAD_DEBOUNCE_MS >= 3_000);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('lead-refresh ok');
