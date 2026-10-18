// The focus mail check's throttle. Run: npx tsx tools/mail-focus.test.ts
import { MAIL_ON_FOCUS_MS, dueNow } from '../lib/mail-focus';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const asked = new Map<number, number>();
eq('first focus asks', dueNow(asked, 11, 1_000), true);
eq('a second focus inside the minute does not', dueNow(asked, 11, 1_000 + MAIL_ON_FOCUS_MS - 1), false);
eq('another workspace has its own clock', dueNow(asked, 13, 2_000), true);
eq('a focus a minute later asks again', dueNow(asked, 11, 1_000 + MAIL_ON_FOCUS_MS), true);
eq('a refused ask does not push the clock back', (() => { const m = new Map<number, number>(); dueNow(m, 1, 0); dueNow(m, 1, 30_000); return dueNow(m, 1, 60_000); })(), true);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
