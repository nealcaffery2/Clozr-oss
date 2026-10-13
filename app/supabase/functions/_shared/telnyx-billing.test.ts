// Telnyx top-up rules.  Run:  npx tsx supabase/functions/_shared/telnyx-billing.test.ts
import { MAX_TOPUP, readBalance, topupAmount } from './telnyx-billing.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

eq('a whole dollar amount', topupAmount('25'), { amount: '25.00' });
eq('a dollar sign and cents', topupAmount('$25.50'), { amount: '25.50' });
eq('a number', topupAmount(100), { amount: '100.00' });
eq('under the floor is refused', 'error' in topupAmount('5'), true);
eq('over the ceiling is refused', 'error' in topupAmount(String(MAX_TOPUP + 1)), true);
eq('fractions of a cent are refused', 'error' in topupAmount('10.005'), true);
eq('text is refused', 'error' in topupAmount('ten'), true);
eq('nothing is refused', 'error' in topupAmount(undefined), true);

eq('balance strings become numbers', readBalance({ balance: '3.12', available_credit: '3.12', credit_limit: '0.00', pending: '0.00', currency: 'USD' }),
  { balance: 3.12, available: 3.12, creditLimit: 0, pending: 0, currency: 'USD' });
eq('an empty body is no balance', readBalance({}), null);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
