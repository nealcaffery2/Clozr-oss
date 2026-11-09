// Why a plan step is waiting. Run: npx tsx tools/throttle-explain.test.ts
import { explainWait, groupWaits } from '../lib/throttle-explain';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};
const now = Date.parse('2026-10-20T18:00:00Z');
eq('line cap', explainWait('every text line is at its daily cap', null, now).key, 'line_cap');
eq('Talkr hold reads as line cap', explainWait('line held by Talkr: daily cap', null, now).key, 'line_cap');
eq('sending hours', explainWait("outside the plan's sending hours", null, now).key, 'hours');
eq('quiet hours', explainWait("quiet hours in the lead's time zone", null, now).key, 'hours');
eq('merge field', explainWait('merge field with no value: {{first_name}}', null, now).key, 'merge');
eq('warmed inbox', explainWait('no warmed inbox has room right now', null, now).key, 'inbox');
eq('a later due date is scheduled', explainWait(null, '2026-10-22T16:00:00Z', now).key, 'scheduled');
eq('due and no reason is due now', explainWait(null, '2026-10-20T17:00:00Z', now).key, 'due');
eq('an unknown reason shows as written', explainWait('Talkr not connected', null, now).why, 'Talkr not connected');
eq('grouped, biggest first', groupWaits([
  { reason: null, at: '2026-10-22T16:00:00Z' }, { reason: null, at: '2026-10-22T16:00:00Z' },
  { reason: 'every text line is at its daily cap', at: null },
], now).map((g) => [g.t.key, g.n]), [['scheduled', 2], ['line_cap', 1]]);
if (failed) { console.error(`throttle-explain: ${failed} failed`); process.exit(1); }
console.log('throttle-explain: ok');
