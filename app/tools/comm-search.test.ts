// Search across calls, texts and emails (lib/comm-search.ts, migration 271):
// what is worth a round trip, how a snippet's matches split out, and the row title.
// Run: npx tsx tools/comm-search.test.ts
import assert from 'node:assert/strict';
import { hitTitle, searchable, snippetParts } from '../lib/comm-search';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

test('three letters or more, and not a phone number', () => {
  assert.equal(searchable('ro'), false);
  assert.equal(searchable('  r f  '), false);
  assert.equal(searchable('roof'), true);
  assert.equal(searchable('"new roof"'), true);
  assert.equal(searchable('(210) 555-0136'), false);
  assert.equal(searchable('+12105550136'), false);
  assert.equal(searchable('2014 roof'), true);
});

test('a snippet splits into plain and matched runs', () => {
  assert.deepEqual(snippetParts('the \u0002roof\u0003 is new'), [
    { text: 'the ', hit: false }, { text: 'roof', hit: true }, { text: ' is new', hit: false },
  ]);
  assert.deepEqual(snippetParts('\u0002Roofs\u0003 and the \u0002roof\u0003'), [
    { text: 'Roofs', hit: true }, { text: ' and the ', hit: false }, { text: 'roof', hit: true },
  ]);
  assert.deepEqual(snippetParts('no match\n\nhere'), [{ text: 'no match here', hit: false }]);
  assert.deepEqual(snippetParts(''), []);
});

test('the title says what it was and with whom', () => {
  assert.equal(hitTitle({ channel: 'call', direction: 'outbound', recordName: 'Kara Mitchell' }), 'Call with Kara Mitchell');
  assert.equal(hitTitle({ channel: 'sms', direction: 'inbound', recordName: 'Kara Mitchell' }), 'Text from Kara Mitchell');
  assert.equal(hitTitle({ channel: 'email', direction: 'outbound', recordName: 'Harbor Capital' }), 'Email to Harbor Capital');
  assert.equal(hitTitle({ channel: 'voicemail', direction: 'outbound', recordName: null }), 'Voicemail');
  assert.equal(hitTitle({ channel: 'fax', direction: null, recordName: ' ' }), 'Message');
});

console.log(`comm-search: ${passed} passed`);
