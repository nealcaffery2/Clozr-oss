// lib/inbox-schedule.ts: Send later presets and the scheduled-send due rule.
// Run with:  npx tsx tools/inbox-schedule.test.ts
import { dueRows, isDue, presetTime, scheduleProblem, sendsLabel, toLocalInput } from '../lib/inbox-schedule';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

// Wednesday 2026-10-21 14:30 local.
const wed = new Date(2026, 9, 21, 14, 30);
check('in 1 hour', presetTime('hour', wed)!.getTime() === wed.getTime() + 3600_000);
const tom = presetTime('tomorrow', wed)!;
check('tomorrow 9am', tom.getDate() === 22 && tom.getHours() === 9 && tom.getMinutes() === 0, tom);
const mon = presetTime('monday', wed)!;
check('monday from a wednesday is the 26th', mon.getDate() === 26 && mon.getDay() === 1 && mon.getHours() === 9, mon);
const monEarly = presetTime('monday', new Date(2026, 9, 26, 7, 0))!;
check('monday before 9am is today', monEarly.getDate() === 26, monEarly);
const monLate = presetTime('monday', new Date(2026, 9, 26, 10, 0))!;
check('monday after 9am is next week', monLate.getDate() === 2 && monLate.getMonth() === 10, monLate);
check('pick has no time', presetTime('pick', wed) === null);
check('datetime-local format', toLocalInput(wed) === '2026-10-21T14:30', toLocalInput(wed));

check('past is refused', scheduleProblem(new Date(wed.getTime() - 1000), wed) !== null);
check('a minute out is fine', scheduleProblem(new Date(wed.getTime() + 120_000), wed) === null);
check('91 days is refused', scheduleProblem(new Date(wed.getTime() + 91 * 86_400_000), wed) !== null);
check('bad date is refused', scheduleProblem(new Date('nope'), wed) !== null);

check('label today', sendsLabel(new Date(2026, 9, 21, 15, 15), wed).startsWith('Sends today 3:15'), sendsLabel(new Date(2026, 9, 21, 15, 15), wed));
check('label tomorrow', sendsLabel(tom, wed).startsWith('Sends tomorrow 9:00'), sendsLabel(tom, wed));
check('label weekday', sendsLabel(mon, wed).startsWith('Sends Mon 9:00'), sendsLabel(mon, wed));
check('label far out names the date', /^Sends Nov \d+ /.test(sendsLabel(new Date(2026, 10, 20, 9, 0), wed)), sendsLabel(new Date(2026, 10, 20, 9, 0), wed));

const now = new Date('2026-10-21T20:00:00Z');
const iso = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
const rows = [
  { id: 1, status: 'scheduled', send_at: iso(-5), claimed_at: null },
  { id: 2, status: 'scheduled', send_at: iso(5), claimed_at: null },
  { id: 3, status: 'scheduled', send_at: iso(-30), claimed_at: iso(-2) },
  { id: 4, status: 'scheduled', send_at: iso(-30), claimed_at: iso(-15) },
  { id: 5, status: 'sent', send_at: iso(-30), claimed_at: null },
  { id: 6, status: 'cancelled', send_at: iso(-30), claimed_at: null },
];
check('due: past and unclaimed', isDue(rows[0], now));
check('not due: future', !isDue(rows[1], now));
check('not due: claimed 2 minutes ago', !isDue(rows[2], now));
check('due again: claim older than 10 minutes', isDue(rows[3], now));
check('sent and cancelled never run', !isDue(rows[4], now) && !isDue(rows[5], now));
check('due rows oldest first', dueRows(rows, now).map((r) => r.id).join() === '4,1', dueRows(rows, now).map((r) => r.id));
check('limit', dueRows(rows, now, 1).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
