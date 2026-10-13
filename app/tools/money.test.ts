// lib/money.ts: what people type into a money field.
// Run with:  npx tsx tools/money.test.ts
import { formatDollars, parseDollarRange, parseDollars } from '../lib/money';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};
const is = (raw: string | number | null, want: number | null) => {
  const r = parseDollars(raw);
  check(`parseDollars(${JSON.stringify(raw)}) = ${want}`, r.value === want && !r.error, r);
};
const bad = (raw: string) => {
  const r = parseDollars(raw);
  check(`parseDollars(${JSON.stringify(raw)}) is an error`, r.value === null && !!r.error, r);
};

is('185000', 185000);
is('$185,000', 185000);
is(' $ 185,000 ', 185000);
is('185k', 185000);
is('185K', 185000);
is('$1.25m', 1250000);
is('1.5M', 1500000);
is('.5k', 500);
is('12.50', 12.5);
is('0', 0);
is('', null);
is('   ', null);
is(null, null);
is(240000, 240000);
is('USD 99', 99);
bad('abc');
bad('12k5');
bad('-5000');
bad('$');
bad('1.2.3');
bad('5 dollars');
check('negative says why', parseDollars('-5').error === 'Amounts can’t be negative');
check('NaN number is an error', !!parseDollars(Number.NaN).error);

const range = (raw: string, low: number | null, high: number | null) => {
  const r = parseDollarRange(raw);
  check(`range ${JSON.stringify(raw)} = ${low}–${high}`, r.low === low && r.high === high && !r.error, r);
};
range('150,000 - 175,000', 150000, 175000);
range('150k–175k', 150000, 175000);
range('$150k to $175k', 150000, 175000);
range('$150,000', 150000, 150000);
range('', null, null);
check('range low > high is an error', !!parseDollarRange('200k - 150k').error);
check('range junk is an error', !!parseDollarRange('lots - more').error);
check('range with a negative start is an error', !!parseDollarRange('-5000').error && !!parseDollarRange('-150k - 175k').error);
check('range three parts is an error', !!parseDollarRange('1 - 2 - 3').error);

check('formatDollars whole', formatDollars(185000) === '$185,000', formatDollars(185000));
check('formatDollars cents', formatDollars(12.5) === '$12.50', formatDollars(12.5));
check('formatDollars null', formatDollars(null) === '');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
