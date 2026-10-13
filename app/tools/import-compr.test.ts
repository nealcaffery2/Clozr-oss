// COMPR after a bulk import: off unless chosen, never for anything but a new
// seller with an address, and never more than the count confirmed.
//
// Pure functions, no network. Run with:  npx tsx tools/import-compr.test.ts

import { comprCandidates, comprConfirmText, comprQueue } from '../lib/import-compr';
import type { Action } from '../lib/import-dedupe';

let failed = 0;
const check = (name: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!pass) failed++;
};

const records = [
  { addr: '330 Vista Dr', problem: null }, // 0 new, address
  { addr: null, problem: null }, // 1 new, no address
  { addr: '1803 Cypress Ln', problem: null }, // 2 updates an existing seller
  { addr: '9 Elm St', problem: null }, // 3 co-seller
  { addr: '  ', problem: null }, // 4 new, blank address
  { addr: '12 Oak St', problem: 'No name, phone or address' }, // 5 unusable
  { addr: '77 Pine St', problem: null }, // 6 skipped
];
const actions: (Action | null)[] = ['create', 'create', 'fill', 'coseller', 'create', 'create', 'skip'];

check('candidates: only rows created with an address', comprCandidates('sellers', records, actions) === 1);
check('candidates: buyers and vendors never', comprCandidates('buyers', records, actions) === 0 && comprCandidates('vendors', records, actions) === 0);

const report = [
  { row: 1, result: 'created', id: 101 },
  { row: 2, result: 'created', id: 102 },
  { row: 3, result: 'updated', id: 50 },
  { row: 4, result: 'co-seller', id: 103 },
  { row: 5, result: 'created', id: 104 },
  { row: 6, result: 'skipped', id: null },
  { row: 7, result: 'skipped', id: 51 },
];
check('queue: the created seller with an address, nothing else', JSON.stringify(comprQueue('sellers', report, records, 1)) === '[101]', JSON.stringify(comprQueue('sellers', report, records, 1)));
check('queue: nothing unless a count was confirmed', comprQueue('sellers', report, records, 0).length === 0);
check('queue: buyers never', comprQueue('buyers', report, records, 10).length === 0);

// 240 new leads with addresses: the confirmed count caps the queue.
const many = Array.from({ length: 240 }, (_, i) => ({ addr: `${i} Main St`, problem: null }));
const manyActions = many.map(() => 'create' as const);
const manyReport = many.map((_, i) => ({ row: i + 1, result: i === 7 ? 'error' : 'created', id: i === 7 ? null : 1000 + i }));
const n = comprCandidates('sellers', many, manyActions);
check('240 new leads → 240 candidates', n === 240);
const q = comprQueue('sellers', manyReport, many, n);
check('a failed row is not queued; never more than confirmed', q.length === 239 && comprQueue('sellers', manyReport, many, 10).length === 10, String(q.length));
check('confirm text names the count and the billing', comprConfirmText(240) === 'Import, then run 240 COMPR reports on the new leads? Each report is billed.' && comprConfirmText(1).includes('1 COMPR report on the new lead?'));

console.log(failed ? `\n${failed} FAILED` : '\nall import COMPR checks passed');
process.exit(failed ? 1 : 0);
