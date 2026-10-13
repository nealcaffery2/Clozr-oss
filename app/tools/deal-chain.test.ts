// Daisy chains on the deal team (migration 186): owner first, then W1, W2, W3.
// Run with: npx tsx tools/deal-chain.test.ts

import assert from 'node:assert/strict';
import { CHAIN_POSITIONS, chainOf } from '../lib/deal-parties';

const rows = [
  { id: 1, name: 'Us', chain_position: 'W2' },
  { id: 2, name: 'Title', chain_position: null },
  { id: 3, name: 'Jane Owner', chain_position: 'OOR' },
  { id: 4, name: 'ABC Wholesale', chain_position: 'W1' },
  { id: 5, name: 'Old row' },
];
assert.deepEqual(chainOf(rows).map((r) => r.chain_position), ['OOR', 'W1', 'W2']);
assert.deepEqual(chainOf(rows).map((r) => r.id), [3, 4, 1]);
assert.equal(chainOf([{ chain_position: null }]).length, 0);
assert.equal(chainOf([{ chain_position: 'W9' }]).length, 0);
// The positions the migration's check constraint allows, in order.
assert.deepEqual(CHAIN_POSITIONS.map((c) => c.code), ['OOR', 'W1', 'W2', 'W3']);

console.log('deal-chain ok');
