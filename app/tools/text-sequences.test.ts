// Enrolling CLOZR sellers in a Talkr text sequence: known numbers go straight
// in, unknown ones become Talkr contacts first, refusals come back as skipped.
// Run: npx tsx tools/text-sequences.test.ts
import assert from 'node:assert/strict';
import { ApiError } from '../lib/talkr-web/api';
import { enrollSellers } from '../app/components/sequences/enrollSellers';

const calls: unknown[] = [];
const fake = {
  enrollInSequence: async (_id: string, input: { contact_ids?: string[]; phones?: string[] }) => {
    calls.push(input);
    if (input.phones) {
      return {
        enrolled: 1, already_enrolled: 0, skipped: 3,
        skipped_details: [
          { ref: '+12145550002', reason: 'unknown_phone' },
          { ref: '+12145550003', reason: 'unknown_phone' },
          { ref: '+12145550004', reason: 'invalid_phone' },
        ],
      };
    }
    return { enrolled: input.contact_ids!.length, already_enrolled: 0, skipped: 0, skipped_details: [] };
  },
  createContact: async (input: { phone?: string }) => {
    calls.push({ create: input.phone });
    if (input.phone === '+12145550003') throw new ApiError(409, 'duplicate', 'dup', { contact_id: 'c-existing' });
    return { contact: { id: 'c-new' } };
  },
};

void (async () => {
  const r = await enrollSellers('seq1', [
    { name: 'Known', phone: '(214) 555-0001' },
    { name: 'New', phone: '214-555-0002' },
    { name: 'Dup', phone: '2145550003' },
    { name: 'Bad', phone: '2145550004' },
    { name: 'Again', phone: '+1 214 555 0001' },
    { name: 'Blank', phone: '' },
  ], fake);
  assert.deepEqual(calls[0], { phones: ['+12145550001', '+12145550002', '+12145550003', '+12145550004'] });
  assert.deepEqual(calls.at(-1), { contact_ids: ['c-new', 'c-existing'] });
  assert.equal(r.enrolled, 3);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['invalid_phone', 'no_phone']);
  console.log('text-sequences: ok');
})();
