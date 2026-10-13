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
console.log(`"" → ${parseDue('', now)} (empty stays null: ${parseDue('', now) === null ? 'PASS' : 'FAIL'})`);
if (parseDue('', now) !== null) failed++;
console.log(`"nonsense" → ${parseDue('nonsense', now)} (${parseDue('nonsense', now) === null ? 'PASS' : 'FAIL'})`);
if (parseDue('nonsense', now) !== null) failed++;

const hours: [string, number][] = [['Immediately', 0], ['2 hours', 2], ['Day 1', 0], ['Day 3', 48], ['1 week', 168], ['3 days', 72], ['30 min', 1]];
for (const [inp, exp] of hours) {
  const got = delayToHours(inp);
  console.log(`${got === exp ? 'PASS' : 'FAIL'}  delay "${inp}" → ${got}h (expected ${exp})`);
  if (got !== exp) failed++;
}
console.log(failed ? `\n${failed} FAILED` : '\nall due-parser checks passed');
process.exit(failed ? 1 : 0);
