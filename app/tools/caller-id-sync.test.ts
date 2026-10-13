import assert from 'node:assert/strict';
import { callerIdSyncPlan, clozrPickFor, type CallerIdMe, type CallerIdRow } from '../lib/caller-id-sync';

const rows: CallerIdRow[] = [
  { phone_e164: '+12105550169', user_id: 'morgan', is_caller_id: true },
  { phone_e164: '+12105550174', user_id: 'morgan', is_caller_id: false },
  { phone_e164: '+12105550175', user_id: 'alex', is_caller_id: true },
  { phone_e164: '+18305550178', user_id: null, is_caller_id: false },
];
const me = (def: string | null, extra: Partial<CallerIdMe> = {}): CallerIdMe => ({
  id: 'T-morgan',
  default_phone_number_id: def,
  org_numbers: [
    { id: 'n1', phone_e164: '+12105550169', assigned_user_id: 'T-morgan' },
    { id: 'n2', phone_e164: '+12105550174', assigned_user_id: 'T-morgan' },
    { id: 'n3', phone_e164: '+12105550175', assigned_user_id: 'T-alex' },
    { id: 'n4', phone_e164: '+18305550178', assigned_user_id: null },
  ],
  ...extra,
});

// The dialer pick: only the rep's own, not-yet-flagged row is written.
assert.equal(clozrPickFor('morgan', rows, '+12105550174'), '+12105550174');
assert.equal(clozrPickFor('morgan', rows, '(210) 555-0174'), '+12105550174', 'formats are compared as E.164');
assert.equal(clozrPickFor('morgan', rows, '+12105550169'), null, 'already the caller ID');
assert.equal(clozrPickFor('morgan', rows, '+12105550175'), null, "a teammate's line is never moved by someone else's pick");
assert.equal(clozrPickFor('morgan', rows, '+18305550178'), null, 'company line has no owner');
assert.equal(clozrPickFor('morgan', rows, '+15125550100'), null, 'not a CLOZR row');
assert.equal(clozrPickFor('morgan', rows, null), null);

// Talkr has a default: CLOZR follows it.
assert.deepEqual(callerIdSyncPlan('morgan', rows, me('n2')), { write: 'clozr', phone: '+12105550174' });
assert.deepEqual(callerIdSyncPlan('morgan', rows, me('n1')), { write: 'none' }, 'already agree');
assert.deepEqual(callerIdSyncPlan('morgan', rows, me('n3')), { write: 'none' }, "Talkr default on a teammate's CLOZR line: leave CLOZR alone");
assert.deepEqual(callerIdSyncPlan('morgan', rows, me('n4')), { write: 'none' }, 'company line');
// A Talkr default that wins never also pushes CLOZR's line back to Talkr.
assert.deepEqual(callerIdSyncPlan('morgan', [], me('n2')), { write: 'none' });

// Talkr has no default (or one that left the org): Talkr takes CLOZR's.
assert.deepEqual(callerIdSyncPlan('morgan', rows, me(null)), { write: 'talkr', numberId: 'n1' });
assert.deepEqual(callerIdSyncPlan('morgan', rows, me('gone')), { write: 'talkr', numberId: 'n1' });
assert.deepEqual(
  callerIdSyncPlan('morgan', rows, me(null, { org_numbers: [{ id: 'n1', phone_e164: '+12105550169', assigned_user_id: 'T-alex' }] })),
  { write: 'none' },
  'Talkr gives that line to someone else',
);
assert.deepEqual(
  callerIdSyncPlan('morgan', rows, me(null, { org_numbers: [{ id: 'n1', phone_e164: '+12105550169', assigned_user_id: null }] })),
  { write: 'talkr', numberId: 'n1' },
  'an unassigned Talkr line is fine',
);
assert.deepEqual(callerIdSyncPlan('morgan', rows, me(null, { org_numbers: [] })), { write: 'none' }, 'not on Talkr');
assert.deepEqual(callerIdSyncPlan('maria', rows, me(null)), { write: 'none' }, 'no CLOZR caller ID either');

console.log('caller-id-sync: ok');
