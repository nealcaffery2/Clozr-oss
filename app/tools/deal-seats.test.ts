import assert from 'node:assert/strict';
import { teamSeatsFor } from '../lib/deal-types';

assert.deepEqual(teamSeatsFor('Novation', null), ['listing_agent', 'buyers_agent', 'lender']);
assert.deepEqual(teamSeatsFor('Assignment', 'split_double_close'), ['second_title']);
assert.deepEqual(teamSeatsFor('Double Close', 'liquid_double_close'), ['transactional_funder']);
assert.deepEqual(teamSeatsFor('novation', 'liquid_double_close'), ['listing_agent', 'buyers_agent', 'lender', 'transactional_funder']);
assert.deepEqual(teamSeatsFor(null, 'passthrough_double_close'), []);
console.log('deal-seats ok');
