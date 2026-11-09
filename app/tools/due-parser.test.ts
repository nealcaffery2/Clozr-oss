// parseDue against what people actually type into the Quick Add "Due" field.
// Run with:  npx tsx tools/due-parser.test.ts
import { delayToHours, parseDue } from '../lib/crm-write';

// A fixed "now": Saturday 12 Sep 2026, 14:00 local.
const now = new Date(2026, 8, 12, 14, 0, 0);
let failed = 0;
const check = (input: string, expect: (d: Date) => boolean, label: string) => {
  const iso = parseDue(input, now);
  const d = iso ? new Date(iso) : null;
  const pass = !!d && expect(d);
  console.log(`${pass ? 'PASS' : 'FAIL'}  "${input}" → ${iso ?? 'null'}  (${label})`);
  if (!pass) failed++;
};
const same = (d: Date, y: number, m: number, day: number, h?: number, min?: number) =>
  d.getFullYear() === y && d.getMonth() === m && d.getDate() === day && (h === undefined || d.getHours() === h) && (min === undefined || d.getMinutes() === min);

check('Today', (d) => same(d, 2026, 8, 12, 9, 0), 'today at 9');
check('Today 1:30 PM', (d) => same(d, 2026, 8, 12, 13, 30), 'the case that used to come back null');
check('tomorrow 10am', (d) => same(d, 2026, 8, 13, 10, 0), 'tomorrow with a time');
check('Fri 2pm', (d) => same(d, 2026, 8, 18, 14, 0), 'next Friday');
check('sat', (d) => same(d, 2026, 8, 12, 9, 0), 'a weekday name for today means today');
check('Sept 30', (d) => same(d, 2026, 8, 30, 9, 0), 'month + day');
check('9/30 3pm', (d) => same(d, 2026, 8, 30, 15, 0), 'numeric date with time');
check('Jan 5', (d) => same(d, 2027, 0, 5), 'a month already past rolls to next year');
check('in 2 days', (d) => same(d, 2026, 8, 14, 9, 0), 'relative days');
check('in 1 week', (d) => same(d, 2026, 8, 19, 9, 0), 'relative weeks');
check('2026-10-01', (d) => same(d, 2026, 9, 1), 'ISO date');
// Import "Created" columns: a timestamp with seconds, a two-digit year.
check('2019-03-14 10:22:05', (d) => same(d, 2019, 2, 14, 10, 22), 'ISO date with seconds (was null: the seconds broke the day)');
check('2024-05-02 14:03:11', (d) => same(d, 2024, 4, 2, 14, 3), 'ISO date, afternoon with seconds, local');
check('3/14/19', (d) => same(d, 2019, 2, 14, 9, 0), 'two-digit year (was null: 2026 was appended)');
check('12:30', (d) => same(d, 2026, 8, 12, 12, 30), '12:30 with no am/pm is half past noon, not midnight');
check('12:30 am', (d) => same(d, 2026, 8, 12, 0, 30), '12:30 am stays midnight');
check('12pm', (d) => same(d, 2026, 8, 12, 12, 0), '12pm is noon');
check('14:03', (d) => same(d, 2026, 8, 12, 14, 3), '24-hour time');
console.log(`"" → ${parseDue('', now)} (empty stays null: ${parseDue('', now) === null ? 'PASS' : 'FAIL'})`);
if (parseDue('', now) !== null) failed++;
console.log(`"nonsense" → ${parseDue('nonsense', now)} (${parseDue('nonsense', now) === null ? 'PASS' : 'FAIL'})`);
if (parseDue('nonsense', now) !== null) failed++;

// Minutes come back as fractional hours: savePlan turns the difference into delay_minutes, so "15 minutes" must not round to 0 (fires at once) or "30 minutes" to a whole hour.
const hours: [string, number][] = [['Immediately', 0], ['2 hours', 2], ['Day 1', 0], ['Day 3', 48], ['1 week', 168], ['3 days', 72], ['30 min', 0.5], ['15 minutes', 0.25], ['45 min', 0.75], ['90 minutes', 1.5]];
for (const [inp, exp] of hours) {
  const got = delayToHours(inp);
  console.log(`${got === exp ? 'PASS' : 'FAIL'}  delay "${inp}" → ${got}h (expected ${exp})`);
  if (got !== exp) failed++;
}
console.log(failed ? `\n${failed} FAILED` : '\nall due-parser checks passed');
// A date typed as ISO is that calendar day, and the clock-change day does not eat "tomorrow".
{
  const { parseDue: pd, dueDateOf } = await import('../lib/crm-write');
  const d = new Date(pd('2026-10-20', new Date(2026, 9, 1, 15))!);
  if (d.getFullYear() !== 2026 || d.getMonth() !== 9 || d.getDate() !== 20) { console.error('FAIL ISO date stays on its day', d.toString()); process.exit(1); }
  if (dueDateOf('2026-10-20', new Date(2026, 9, 1, 15)) !== '2026-10-20') { console.error('FAIL dueDateOf keeps the local day'); process.exit(1); }
  const tomorrow = new Date(pd('tomorrow', new Date(2026, 10, 1, 8))!);
  if (tomorrow.getDate() !== 2 || tomorrow.getMonth() !== 10) { console.error('FAIL tomorrow across the clock change', tomorrow.toString()); process.exit(1); }
  console.log('PASS  ISO dates and calendar days');
}

process.exit(failed ? 1 : 0);
