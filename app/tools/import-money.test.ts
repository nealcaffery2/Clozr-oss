// The import's money cells (lib/import importMoney).  Run: npx tsx tools/import-money.test.ts
import assert from 'node:assert/strict';
import { importMoney } from '../lib/import';

const cases: [string | undefined, number | null, boolean][] = [
  ['$189K', 189000, false],
  ['$150,000 - $175,000', 150000, true],
  ['150k–175k', 150000, true],
  ['$185,000', 185000, false],
  ['about 150k', 150000, false],
  ['0', null, false],
  ['', null, false],
  [undefined, null, false],
  ['call me', null, false],
  ['Call 210-555-0100 to discuss', null, false],
  ['3 bed, wants retail', null, false],
  ['wants $240,000 firm', 240000, false],
];
let n = 0;
for (const [raw, value, range] of cases) {
  assert.deepEqual(importMoney(raw), { value, range }, String(raw));
  n++;
}
console.log(`import-money: ${n} passed`);
