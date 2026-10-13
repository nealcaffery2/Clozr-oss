// Second-answer voicemail and the predictive machine script.
// Run: npx tsx tools/busy-answer.test.ts
import assert from 'node:assert/strict';
import { busyAnswer, predictiveVoicemailText, DEFAULT_AMD_TEXT } from '../lib/busy-answer';

assert.equal(busyAnswer({ ownNumber: true, hasDrop: true }), 'ignore');
assert.equal(busyAnswer({ ownNumber: true, hasDrop: false }), 'ignore');
assert.equal(busyAnswer({ ownNumber: false, hasDrop: true }), 'drop');
assert.equal(busyAnswer({ ownNumber: false, hasDrop: false }), 'decline');

assert.equal(predictiveVoicemailText('old line', '  Hi from me.  '), 'Hi from me.');
assert.equal(predictiveVoicemailText('  Keep this.  ', '   '), 'Keep this.');
assert.equal(predictiveVoicemailText('', null), DEFAULT_AMD_TEXT);
assert.equal(predictiveVoicemailText(null, 'x'.repeat(600)).length, 500);

console.log('busy-answer ok');
