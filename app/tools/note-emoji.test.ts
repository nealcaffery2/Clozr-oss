// The note reaction picker's free-text box keeps the first emoji typed (Win+. or a phone keyboard) and nothing else.
// Run: npx tsx tools/note-emoji.test.ts
import assert from 'node:assert/strict';
import { firstEmoji } from '../app/components/record/NoteThread';

assert.equal(firstEmoji('👍'), '👍');
assert.equal(firstEmoji(' 👍🏽 extra'), '👍🏽');
assert.equal(firstEmoji('❤️'), '❤️');
assert.equal(firstEmoji('🇺🇸'), '🇺🇸');
assert.equal(firstEmoji('👨‍👩‍👧'), '👨‍👩‍👧');
assert.equal(firstEmoji('ok'), null);
assert.equal(firstEmoji('1'), null);
assert.equal(firstEmoji(''), null);
console.log('note-emoji: ok');
