// Bulk Text/Email on Submissions goes to each sender once.
// Run: npx tsx tools/sub-senders.test.ts
import assert from 'node:assert/strict';
import { messageTargets } from '../lib/sub-senders';

const sender: Record<string, string> = { 'sub:1': 's9', 'sub:2': 's9', 'sub:3': 's4' };
const r = messageTargets(['sub:1', 'sub:2', 'sub:3', 'sub:4', 's7', 's4'], (id) => sender[id]);
assert.deepEqual(r.ids, ['s9', 's4', 's7'], 'senders once, in order, people kept');
assert.equal(r.noSender, 1, 'a submission with no sender is counted, not sent');
assert.deepEqual(messageTargets([], () => null), { ids: [], noSender: 0 });
console.log('sub-senders: all passed');
