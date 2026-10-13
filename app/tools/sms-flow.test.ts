import assert from 'node:assert/strict';
import { DEFAULT_HOURS, autoReplyFor, blankSmsFlow, cleanSmsFlow, isOpen, smsSummary } from '../lib/sms-flow';

// Tuesday 2026-10-06 15:00 UTC is 10:00 in Chicago; 02:00 UTC Wednesday is Tuesday 21:00 there.
const tueMorning = new Date('2026-10-06T15:00:00Z');
const tueNight = new Date('2026-10-07T02:00:00Z');
const saturday = new Date('2026-10-10T17:00:00Z');

assert.equal(isOpen(DEFAULT_HOURS, tueMorning), true);
assert.equal(isOpen(DEFAULT_HOURS, tueNight), false);
assert.equal(isOpen(DEFAULT_HOURS, saturday), false);
assert.equal(isOpen(null, tueNight), true);
assert.equal(isOpen({ timezone: 'Not/AZone', days: {} }, tueNight), true);

const flow = { ...blankSmsFlow('+12105550100'), auto_reply_enabled: true, auto_reply_body: 'Got it, back soon.' };

// Off, empty, keywords.
assert.deepEqual(autoReplyFor(null, { body: 'hi', at: tueMorning }), { send: false, reason: 'off' });
assert.deepEqual(autoReplyFor({ ...flow, auto_reply_body: '  ' }, { body: 'hi', at: tueMorning }), { send: false, reason: 'no message' });
assert.deepEqual(autoReplyFor(flow, { body: ' STOP ', at: tueMorning }), { send: false, reason: 'keyword' });
assert.deepEqual(autoReplyFor(flow, { body: 'hi', at: tueMorning }), { send: true, body: 'Got it, back soon.' });

// After hours only.
const after = { ...flow, auto_reply_when: 'after_hours' as const, hours: DEFAULT_HOURS };
assert.deepEqual(autoReplyFor(after, { body: 'hi', at: tueMorning }), { send: false, reason: 'open' });
assert.equal(autoReplyFor(after, { body: 'hi', at: tueNight }).send, true);

// Cooldown: once per texter per 24 hours.
assert.deepEqual(autoReplyFor(flow, { body: 'hi', at: tueMorning, lastReplyAt: '2026-10-06T00:00:00Z' }), { send: false, reason: 'cooldown' });
assert.equal(autoReplyFor(flow, { body: 'hi', at: tueMorning, lastReplyAt: '2026-10-05T14:00:00Z' }).send, true);
assert.equal(autoReplyFor({ ...flow, cooldown_hours: 0 }, { body: 'hi', at: tueMorning, lastReplyAt: tueMorning }).send, true);

// Validation.
assert.deepEqual(cleanSmsFlow({ ...flow, auto_reply_body: '' }), { ok: false, error: 'Write the auto-reply' });
assert.deepEqual(cleanSmsFlow({ ...after, hours: null }), { ok: false, error: 'Set the business hours' });
assert.deepEqual(cleanSmsFlow({ ...after, hours: { timezone: 'America/Chicago', days: { mon: ['17:00', '09:00'] } } }), { ok: false, error: "Check Mon's hours" });
const saved = cleanSmsFlow({ ...flow, notify_user_ids: ['a', 'a', 'b'], auto_reply_body: ' hi ' });
assert.ok(saved.ok && saved.flow.auto_reply_body === 'hi' && saved.flow.notify_user_ids.length === 2);

// Summary.
const names: Record<string, string> = { a: 'Morgan', b: 'Casey', c: 'Alex' };
assert.equal(smsSummary(null, (id) => names[id] ?? null), 'Default');
assert.equal(smsSummary({ notify_user_ids: ['a'], auto_reply_enabled: false, auto_reply_when: 'always' }, (id) => names[id] ?? null), 'Morgan');
assert.equal(smsSummary({ notify_user_ids: ['a', 'b', 'c'], auto_reply_enabled: true, auto_reply_when: 'after_hours' }, (id) => names[id] ?? null), 'Morgan +2 · auto-reply after hours');

console.log('sms-flow ok');
