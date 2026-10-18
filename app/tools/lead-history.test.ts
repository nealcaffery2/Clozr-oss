// gatherHistory's reads (historyRows): a failed read throws before the model
// call, so a lead memory is never written with parts missing and the record
// stays dirty for the next pass. Run: npx tsx tools/lead-history.test.ts
import assert from 'node:assert/strict';
import { historyRows } from '../lib/lead-memory';

const ok = { data: [{ id: 1 }], error: null };
assert.deepEqual(historyRows(ok, 'messages and calls'), [{ id: 1 }], 'rows come back');
assert.equal(historyRows({ data: null, error: null }, 'record'), null, 'no record is null, not an error');
assert.throws(() => historyRows({ data: null, error: { message: 'timeout' } }, 'messages and calls'), /messages and calls unread: timeout/, 'a failed history read throws');
assert.throws(() => historyRows({ data: null, error: { message: 'relation "public.offers" does not exist' } }, 'offers'), /offers unread/, 'a core read throws even for a missing table');
assert.equal(historyRows({ data: null, error: { message: 'relation "public.buyer_phones" does not exist' } }, 'extras', true), null, 'an optional read skips a missing table');
assert.equal(historyRows({ data: null, error: { message: "Could not find a relationship between 'enrollments' and 'action_plans' in the schema cache" } }, 'extras', true), null, 'an optional read skips a missing relationship');
assert.equal(historyRows({ data: null, error: { message: 'column ai_agent_enrollments.relayed_from does not exist' } }, 'extras', true), null, 'an optional read skips a missing column');
assert.throws(() => historyRows({ data: null, error: { message: 'canceling statement due to statement timeout' } }, 'extras', true), /extras unread/, 'an optional read still throws on a real failure');

console.log('lead-history: ok');
