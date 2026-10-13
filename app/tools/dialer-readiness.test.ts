// What a rep needs before a dial session. Run: npx tsx tools/dialer-readiness.test.ts
import assert from 'node:assert/strict';
import { dialerReadiness, needsAttention, shouldPrompt, warnKey, type ReadinessFacts } from '../lib/dialer-readiness';
import { PHONE_OTHER_TAB, USE_PHONE_HERE } from '../lib/softphone-lock';

const ready: ReadinessFacts = { phone: 'ok', softphone: 'ready', mic: 'granted', callerId: 'n1', ownVoicemails: 1, teamVoicemails: 3 };
const state = (f: Partial<ReadinessFacts>, key: string) => dialerReadiness({ ...ready, ...f }).find((i) => i.key === key)!.state;

assert.deepEqual(needsAttention(dialerReadiness(ready)), [], 'all set');

// Voicemail: their own, a teammate's, or none.
assert.equal(state({ ownVoicemails: 0 }, 'voicemail'), 'warn', 'a teammate’s recording would play');
assert.equal(state({ ownVoicemails: 0, teamVoicemails: 0 }, 'voicemail'), 'missing');
assert.equal(dialerReadiness({ ...ready, ownVoicemails: 0, teamVoicemails: 0 }).find((i) => i.key === 'voicemail')!.fix?.action, 'record_voicemail');
assert.match(dialerReadiness(ready, 'predictive').find((i) => i.key === 'voicemail')!.detail, /Predictive dials the next number/);

// Caller ID, microphone, phone.
assert.equal(state({ callerId: null }, 'caller_id'), 'missing');
assert.equal(state({ mic: 'denied' }, 'mic'), 'missing');
assert.equal(state({ mic: 'prompt' }, 'mic'), 'warn');
assert.equal(state({ mic: 'unknown' }, 'mic'), 'ok', 'a browser that will not say is not flagged');
assert.equal(state({ phone: 'unlinked' }, 'phone'), 'missing');
assert.equal(state({ softphone: 'off' }, 'phone'), 'missing');
assert.equal(state({ softphone: 'connecting' }, 'phone'), 'warn');
assert.equal(state({ phone: 'unreachable' }, 'phone'), 'missing');

// The real softphone reason, not a generic "not connected".
const other = dialerReadiness({ ...ready, softphone: 'error', softphoneReason: PHONE_OTHER_TAB }).find((i) => i.key === 'phone')!;
assert.equal(other.state, 'missing');
assert.equal(other.title, PHONE_OTHER_TAB);
assert.equal(other.fix?.label, USE_PHONE_HERE);
assert.equal(other.fix?.action, 'use_phone_here');
const failed = dialerReadiness({ ...ready, softphone: 'error', softphoneReason: 'Reload and try again' }).find((i) => i.key === 'phone')!;
assert.equal(failed.title, 'Reload and try again');
assert.equal(failed.fix?.label, 'Connect phone');
assert.equal(failed.fix?.action, 'connect_phone');
assert.equal(dialerReadiness({ ...ready, softphone: 'off' }).find((i) => i.key === 'phone')!.title, 'The phone in this browser is not connected');

// When a start stops to ask: anything missing, every time; warnings once a day.
const missing = dialerReadiness({ ...ready, callerId: null });
assert.equal(shouldPrompt(missing, warnKey(missing, '2026-10-02'), '2026-10-02'), true);
const warnOnly = dialerReadiness({ ...ready, ownVoicemails: 0 });
assert.equal(shouldPrompt(warnOnly, null, '2026-10-02'), true);
assert.equal(shouldPrompt(warnOnly, warnKey(warnOnly, '2026-10-02'), '2026-10-02'), false, 'already asked today');
assert.equal(shouldPrompt(warnOnly, warnKey(warnOnly, '2026-10-01'), '2026-10-02'), true, 'a new day asks again');
assert.equal(shouldPrompt(dialerReadiness(ready), null, '2026-10-02'), false);

console.log('dialer-readiness ok');
