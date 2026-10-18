// The phone-busy flag the busy-drop URL keys on. Run: npx tsx tools/phone-busy.test.ts
import assert from 'node:assert/strict';
import { onPhoneBusy, phoneBusy, setPhoneBusy } from '../lib/phone-busy';

let heard = 0;
const off = onPhoneBusy(() => { heard += 1; });

assert.equal(phoneBusy(), false, 'idle until the phone says otherwise');
setPhoneBusy(true);
assert.equal(phoneBusy(), true);
assert.equal(heard, 1, 'a call starting wakes the listener');
setPhoneBusy(true);
assert.equal(heard, 1, 'the same value again is not a change');
setPhoneBusy(false);
assert.equal(phoneBusy(), false);
assert.equal(heard, 2, 'the call ending is a change too');

off();
setPhoneBusy(true);
assert.equal(heard, 2, 'an unsubscribed listener hears nothing');

console.log('phone-busy: ok');
