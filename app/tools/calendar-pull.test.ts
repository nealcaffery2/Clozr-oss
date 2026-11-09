// Which calendar a pulled appointment records, when the same Google event id
// shows up on more than one feed (CLOZR's own calendar and a guest's primary).
// Run: npx tsx tools/calendar-pull.test.ts
import assert from 'node:assert/strict';
import { pulledCalendarId } from '../supabase/functions/_shared/calendar-pull';

const CLOZR = 'clozr-cal@group.calendar.google.com';
const PRIMARY = 'rep@example.com';
const writable = new Set([CLOZR]);

// CLOZR's own event, read again from the rep's primary (they are a guest): it stays on CLOZR's calendar.
assert.equal(pulledCalendarId(CLOZR, PRIMARY, false, writable), CLOZR);
// A teammate's CLOZR event, seen on this rep's primary: not this account's calendar, still not moved.
assert.equal(pulledCalendarId('teammate-clozr@group.calendar.google.com', PRIMARY, false, writable), 'teammate-clozr@group.calendar.google.com');
// Read from the calendar it already records: unchanged.
assert.equal(pulledCalendarId(CLOZR, CLOZR, true, writable), CLOZR);
assert.equal(pulledCalendarId(PRIMARY, PRIMARY, false, writable), PRIMARY);
// A new row, or one never pushed: the feed being read.
assert.equal(pulledCalendarId(null, PRIMARY, false, writable), PRIMARY);
assert.equal(pulledCalendarId(null, CLOZR, true, writable), CLOZR);
// A mirror found on CLOZR's own calendar moves to it, as before.
assert.equal(pulledCalendarId(PRIMARY, CLOZR, true, writable), CLOZR);

console.log('calendar-pull: ok');
