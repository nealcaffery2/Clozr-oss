// lib/crm-write.ts withStamps: a *_at column moves only when its flag flips.
// Run with:  npx tsx tools/patch-record.test.ts
import { withStamps } from '../lib/crm-write';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};
const NOW = () => '2026-10-09T12:00:00.000Z';
const stamps = { is_dnc: 'dnc_at' };

const on = withStamps({ is_dnc: true }, { is_dnc: false }, stamps, NOW);
check('turning a flag on stamps now', on.dnc_at === NOW() && on.is_dnc === true, on);
const off = withStamps({ is_dnc: false }, { is_dnc: true, dnc_at: 'x' }, stamps, NOW);
check('turning it off clears the stamp', off.dnc_at === null, off);
const same = withStamps({ is_dnc: true }, { is_dnc: true, dnc_at: 'old' }, stamps, NOW);
check('saving the same value leaves the stamp alone', !('dnc_at' in same), same);
const other = withStamps({ asking: 1 }, { is_dnc: true }, stamps, NOW);
check('an unrelated field never stamps', !('dnc_at' in other) && other.asking === 1, other);
const sneaky = withStamps({ asking: 1, dnc_at: 'forged' }, { is_dnc: true }, stamps, NOW);
check('a stamp in the patch without a flip is dropped', !('dnc_at' in sneaky), sneaky);
const fresh = withStamps({ is_dnc: true, dnc_at: 'x' }, null, stamps, NOW);
check('no before row: nothing is known to flip, no stamp written', !('dnc_at' in fresh) && fresh.is_dnc === true, fresh);
const none = withStamps({ asking: 2 }, null, undefined, NOW);
check('no stamps: patch unchanged', JSON.stringify(none) === '{"asking":2}', none);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
