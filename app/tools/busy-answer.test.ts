// Second-answer voicemail and the predictive machine script.
// Run: npx tsx tools/busy-answer.test.ts
import assert from 'node:assert/strict';

import { busyAnswer, predictiveVoicemailText, DEFAULT_AMD_TEXT } from '../lib/busy-answer';

assert.equal(busyAnswer({ ownNumber: true }), 'ignore');
assert.equal(busyAnswer({ ownNumber: false }), 'decline'); // a team-line caller is never answered mid-call

// A hand-dialed call is a normal phone: a second caller is declined, never played the rep's voicemail.

assert.equal(predictiveVoicemailText('old line', '  Hi from me.  '), 'Hi from me.');
assert.equal(predictiveVoicemailText('  Keep this.  ', '   '), 'Keep this.');
assert.equal(predictiveVoicemailText('', null), DEFAULT_AMD_TEXT);
assert.equal(predictiveVoicemailText(null, 'x'.repeat(600)).length, 500);

console.log('busy-answer ok');
