// Buyers narrowed to a deal already on the pipeline. Run: npx tsx tools/buyer-pipeline.test.ts
import assert from 'node:assert/strict';
import { buyersForPipelineDeal, pipelineDealOptions } from '../lib/buyer-pipeline';

const deals = [
  { id: 'd1', stage: 'Ready To Market', addr: '10 Main' },
  { id: 'd2', stage: 'Prospect', addr: 'Hidden' },
  { id: 'd3', stage: 'Closed', addr: 'Done' },
  { id: 'd4', stage: 'In Escrow', addr: '10 Main', archived: true },
  { id: 'd5', stage: 'Under Contract Seller', addr: '10 Main' },
  { id: 'd6', stage: 'Buyer Under Contract', addr: '' },
  { id: 'd7', stage: 'Ready To Market', addr: '10 Main' },
];

const opts = pipelineDealOptions(deals);
assert.deepEqual(opts.map((o) => o.id), ['d1', 'd7', 'd5', 'd6']);
assert.equal(opts.find((o) => o.id === 'd1')?.label, '10 Main · Ready To Market (d1)');
assert.equal(opts.find((o) => o.id === 'd7')?.label, '10 Main · Ready To Market (d7)');
assert.equal(opts.find((o) => o.id === 'd5')?.label, '10 Main · Under Contract Seller');
assert.equal(opts.find((o) => o.id === 'd6')?.label, 'Deal · Buyer Under Contract');

assert.equal(buyersForPipelineDeal([], null, false), null);
const scores = buyersForPipelineDeal(
  [{ buyerId: 'b1', score: 40 }, { buyerId: 'b1', score: 80 }, { buyerId: 'b2', score: 10 }],
  'b9',
  true,
);
assert.equal(scores?.get('b1'), 80);
assert.equal(scores?.get('b2'), 10);
assert.equal(scores?.get('b9'), 0);
assert.equal(scores?.has('b3'), false);
const empty = buyersForPipelineDeal([], null, true);
assert.equal(empty?.size, 0);

console.log('buyer-pipeline ok');
