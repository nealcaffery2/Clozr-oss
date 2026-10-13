// lib/crm-write.ts buyerRow: what an edit to a buyer writes.
// Run with:  npx tsx tools/buyer-row.test.ts
import { buyerRow } from '../lib/crm-write';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};
const NOW = () => '2026-10-10T12:00:00.000Z';
const was = '2025-01-01T00:00:00.000Z';

// A new buyer: every flag that is on is stamped now.
{
  const r = buyerRow({ name: ' Ann ', pof_verified: true, vetted: false, active: true }, null, NOW);
  check('new: name trimmed', r.name === 'Ann', r);
  check('new: POF stamped now', r.pof_verified_at === NOW(), r);
  check('new: vetted off writes nothing', !('vetted_at' in r), r);
  check('new: status Active', r.status === 'Active', r);
}

// An edit with the flag unchanged keeps the old date.
{
  const before = { status: 'Active', pof_verified_at: was, vetted_at: was, blacklisted_at: null };
  const r = buyerRow({ pof_verified: true, vetted: true, blacklisted: false }, before, NOW);
  check('edit: unchanged flags move no date', !('pof_verified_at' in r) && !('vetted_at' in r) && !('blacklisted_at' in r), r);
}

// Flips stamp now, or clear.
{
  const before = { status: 'Active', pof_verified_at: null, vetted_at: was, blacklisted_at: null };
  const r = buyerRow({ pof_verified: true, vetted: false }, before, NOW);
  check('edit: POF on stamps now', r.pof_verified_at === NOW(), r);
  check('edit: vetted off clears', r.vetted_at === null, r);
}

// Status moves only on a real switch.
{
  const r1 = buyerRow({ active: true }, { status: 'Prospect' }, NOW);
  check('edit: a Prospect saved with active on stays a Prospect', !('status' in r1), r1);
  const r2 = buyerRow({ active: true }, { status: 'Qualified' }, NOW);
  check('edit: Qualified stays Qualified', !('status' in r2), r2);
  const r3 = buyerRow({ active: true }, { status: 'Inactive' }, NOW);
  check('edit: switching an Inactive buyer on is Active', r3.status === 'Active', r3);
  const r4 = buyerRow({ active: false }, { status: 'Active' }, NOW);
  check('edit: switching off is Inactive', r4.status === 'Inactive', r4);
  const r5 = buyerRow({ phone: '2145550101' }, { status: 'Prospect' }, NOW);
  check('edit: no active key, no status', !('status' in r5), r5);
}

// Only the keys given are written.
{
  const r = buyerRow({ phone: ' 214 555 0101 ' }, { status: 'Active' }, NOW);
  check('edit: phone alone writes phone alone', Object.keys(r).join() === 'phone' && r.phone === '214 555 0101', r);
  const b = buyerRow({ criteria: { price: { min: 100000, max: 250000 } } }, { status: 'Active' }, NOW);
  check('edit: buy box writes the price columns', b.min_purchase_price === 100000 && b.max_purchase_price === 250000, b);
  check('edit: buy box leaves the name alone', !('name' in b) && !('email' in b), b);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
