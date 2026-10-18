// Meeting invites with Google Meet: types, titles, times in the recipient's
// zone, the email / text / .ics, the slop check, the event body's conference
// request, and the Meet link surviving a sync.
// Run: npx tsx tools/meeting-invite.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MEETING_TYPES, fill, formatWhen, googleCalendarUrl, icsFile, inviteFindings, inviteHtml, inviteSms, inviteSubject,
  inviteText, meetingDescription, meetingTitle, pickZone, type InviteInput, bookingFailure, bookingMessage, bookingUrlFor, conferenceFor, keepMeetLink, wantsConference, writeQuery,
} from '../supabase/functions/_shared/meeting-invite';
import { slopFindings } from '../supabase/functions/_shared/no-ai-slop';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const type = (key: string) => DEFAULT_MEETING_TYPES.find((t) => t.key === key)!;
const START = '2026-10-16T19:00:00.000Z'; // 2:00 PM in Chicago (CDT), noon in Los Angeles

test('the five default types and their durations', () => {
  assert.deepEqual(DEFAULT_MEETING_TYPES.map((t) => [t.name, t.minutes]), [
    ['Demo', 30], ['Walkthrough', 45], ['Comp analysis', 30], ['Onboarding', 45], ['Check-in', 15],
  ]);
});

test('migration 270 seeds the same defaults as the code', () => {
  const sql = readFileSync(new URL('../supabase/migrations/270_meeting_invites.sql', import.meta.url), 'utf8');
  for (const t of DEFAULT_MEETING_TYPES) {
    assert.ok(sql.includes(`('${t.key}', '${t.name}', ${t.minutes}, '${t.title_pattern}', '${t.description}', ${t.sort})`), t.key);
  }
});

test('titles fill tokens and fall back when the record lacks one', () => {
  const v = { company: 'Compr', name: 'Sarah Lopez', rep: 'Alex Reed', address: '412 Elm St' };
  assert.equal(meetingTitle(type('demo'), v), 'Compr demo with Sarah');
  assert.equal(meetingTitle(type('walkthrough'), v), 'Walkthrough of 412 Elm St');
  // A buyer has no address: no "Walkthrough of" left hanging.
  assert.equal(meetingTitle(type('walkthrough'), { ...v, address: null }), 'Walkthrough with Sarah');
  assert.equal(meetingTitle(type('check_in'), { ...v, name: '' }), 'Check-in');
  assert.equal(fill('{type} for {address}', { type: 'Comp analysis', company: '', name: '', rep: '' }), 'Comp analysis');
  assert.equal(meetingDescription(type('demo'), { ...v, type: 'Demo' }), 'A screen share of Compr. Bring a property you are working on and we will run it together.');
});

test('times are written in the recipient zone, no spaced dash', () => {
  const chi = formatWhen(START, 30, 'America/Chicago');
  assert.equal(chi.day, 'Friday, October 16');
  assert.equal(chi.time, '2:00 to 2:30 PM CDT');
  assert.equal(chi.shortLine, 'Fri, Oct 16 at 2:00 PM CDT');
  const la = formatWhen(START, 45, 'America/Los_Angeles');
  assert.equal(la.time, '12:00 to 12:45 PM PDT');
  // Crossing noon keeps both halves.
  assert.equal(formatWhen('2026-10-16T16:30:00.000Z', 45, 'America/Chicago').time, '11:30 AM to 12:15 PM CDT');
  assert.equal(pickZone('Not/AZone', 'America/New_York'), 'America/New_York');
  assert.equal(pickZone(null, null), 'UTC');
  assert.equal(pickZone('America/Denver', 'America/New_York'), 'America/Denver');
});

const input = (over: Partial<InviteInput> = {}): InviteInput => ({
  type: type('demo'), title: 'Compr demo with Sarah', description: meetingDescription(type('demo'), { type: 'Demo', company: 'Compr', name: 'Sarah Lopez', rep: 'Alex Reed' }),
  recipientName: 'Sarah Lopez', repName: 'Alex Reed', repEmail: 'alex@example.com', company: 'Compr',
  startIso: START, minutes: 30, tz: 'America/Chicago', meetLink: 'https://meet.google.com/abc-defg-hij',
  addToCalendarUrl: googleCalendarUrl({ title: 'Compr demo with Sarah', startIso: START, endIso: '2026-10-16T19:30:00.000Z', details: 'x' }),
  ...over,
});

test('the email has the Meet button, the time, the calendar link and the Google invite note', () => {
  const html = inviteHtml(input());
  assert.match(html, /<a href="https:\/\/meet\.google\.com\/abc-defg-hij"[^>]*>Join Google Meet<\/a>/);
  assert.match(html, /Friday, October 16/);
  assert.match(html, /2:00 to 2:30 PM CDT/);
  assert.match(html, /Add to Google Calendar/);
  assert.match(html, /Google Calendar sends a separate invitation/);
  assert.ok(!/<script|<style/i.test(html), 'inline styles only');
  assert.equal(inviteSubject(input()), 'Compr demo with Sarah, Fri, Oct 16 at 2:00 PM CDT');
  // Escaping: a name cannot inject markup.
  assert.ok(!inviteHtml(input({ recipientName: '<b>x</b>', note: '<img src=x>' })).includes('<img src=x>'));
  // No link yet: the email says where it is instead of a dead button.
  assert.ok(!inviteHtml(input({ meetLink: null })).includes('Join Google Meet</a>'));
});

test('the text carries the time and the link, and is one message', () => {
  const sms = inviteSms(input());
  assert.equal(sms, "Hi Sarah, it's Alex with Compr. Our demo is set for Fri, Oct 16 at 2:00 PM CDT (30 min). Join on Google Meet: https://meet.google.com/abc-defg-hij");
  assert.ok(sms.length <= 320);
});

test('without a link, the text only names an email when one went to them', () => {
  const noLink = input({ meetLink: null });
  const viaEmail = inviteSms(noLink, { emailed: true });
  const textOnly = inviteSms(noLink);
  assert.match(viaEmail, /in the calendar invite sent to your email\.$/);
  assert.ok(!/email/i.test(textOnly), textOnly);
  assert.match(textOnly, /Reply to this text and I'll send you the Google Meet link\.$/);
  assert.match(textOnly, /Fri, Oct 16 at 2:00 PM CDT \(30 min\)/);
  assert.deepEqual(slopFindings(viaEmail), []);
  assert.deepEqual(slopFindings(textOnly), []);
  // With a link, the link is the message whatever went by email.
  assert.match(inviteSms(input(), { emailed: false }), /Join on Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij$/);
});

test('a failure before Google has the event drops the row; after, the row stays', () => {
  const before = bookingFailure(null, 'the calendar insert', 'Invalid attendee');
  assert.equal(before.keepRow, false);
  assert.equal(before.error, 'Google Calendar refused the meeting: Invalid attendee');
  const after = bookingFailure('evt123', 'the invite email', 'mailbox paused.');
  assert.equal(after.keepRow, true);
  assert.equal(after.error, undefined);
  assert.equal(after.warning, 'The meeting is on Google Calendar, but the invite email failed: mailbox paused.');
  assert.ok(!/refused the meeting/.test(after.warning!));
});

test('the function rolls back only around the Google insert', () => {
  const src = readFileSync(new URL('../supabase/functions/meeting-invite/index.ts', import.meta.url), 'utf8');
  const rollback = src.indexOf(".from('appointments').delete()");
  assert.ok(rollback > 0);
  assert.equal(src.indexOf(".from('appointments').delete()", rollback + 1), -1, 'one delete only');
  const insert = src.lastIndexOf("method: 'POST'", rollback);
  const between = src.slice(insert, rollback);
  // Nothing that runs after the event exists (poll, stamp, email, text) sits inside the rolled-back try.
  for (const later of ['sleep(700)', "update({\n      google_event_id", 'guardSend', 'textRecipient']) assert.ok(!between.includes(later), later);
});

test('every default type renders slop-free in email and text', () => {
  for (const t of DEFAULT_MEETING_TYPES) {
    const v = { company: 'Acme Homes', name: 'Dana Ruiz', rep: 'Morgan Cole', address: '18 Oak Ln' };
    const i = input({ type: t, title: meetingTitle(t, v), description: meetingDescription(t, { ...v, type: t.name }), minutes: t.minutes });
    assert.deepEqual(inviteFindings(i, true), [], t.key);
    assert.deepEqual(slopFindings(inviteText(i)), [], t.key);
  }
  // A typed note with slop in it is caught before anything sends.
  assert.ok(inviteFindings(input({ note: "We'll leverage your comps." }), false).length > 0);
});

test('the .ics reuses the Google event UID and folds long lines', () => {
  const ics = icsFile({ uid: 'abc123@google.com', title: 'Compr demo, with Sarah; and more', startIso: START, endIso: '2026-10-16T19:30:00.000Z', description: 'Line one\nLine two '.repeat(10), url: 'https://meet.google.com/abc-defg-hij', organizerEmail: 'alex@example.com', organizerName: 'Alex Reed', now: new Date('2026-10-14T00:00:00Z') });
  assert.match(ics, /METHOD:PUBLISH/);
  assert.match(ics, /UID:abc123@google\.com/);
  assert.match(ics, /DTSTART:20261016T190000Z/);
  assert.ok(ics.includes('SUMMARY:Compr demo\\, with Sarah\\; and more'));
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75), 'folded');
  assert.ok(ics.endsWith('\r\n'));
});

test('add-to-calendar link is Google\'s template with UTC stamps', () => {
  const u = new URL(googleCalendarUrl({ title: 'T', startIso: START, endIso: '2026-10-16T19:30:00.000Z', details: 'd', location: 'https://meet.google.com/x' }));
  assert.equal(u.searchParams.get('action'), 'TEMPLATE');
  assert.equal(u.searchParams.get('dates'), '20261016T190000Z/20261016T193000Z');
});

test('the push asks Google for a Meet conference only when one is wanted and missing', () => {
  const body = conferenceFor({ id: 7, meet: true, meet_link: null }, 1);
  assert.deepEqual(body, { conferenceData: { createRequest: { requestId: 'clozr-7-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } } });
  assert.deepEqual(writeQuery(body, 'all'), { sendUpdates: 'all', conferenceDataVersion: '1' });
  const has = conferenceFor({ id: 7, meet: true, meet_link: 'https://meet.google.com/x' });
  assert.deepEqual(has, {});
  assert.deepEqual(writeQuery(has, 'none'), { sendUpdates: 'none' });
  assert.deepEqual(conferenceFor({ id: 7, meet: false }), {});
  assert.equal(wantsConference({ meet: true, meet_link: null, all_day: true }), false);
});

test('a sync never wipes a stored Meet link', () => {
  assert.equal(keepMeetLink({}, 'https://meet.google.com/a'), 'https://meet.google.com/a');
  assert.equal(keepMeetLink({ hangoutLink: null }, 'https://meet.google.com/a'), 'https://meet.google.com/a');
  assert.equal(keepMeetLink({ hangoutLink: 'https://meet.google.com/b' }, 'https://meet.google.com/a'), 'https://meet.google.com/b');
  assert.equal(keepMeetLink(null, null), null);
});

test('the booking link: the workspace page, else the Compr demo page, else none; the message is clean', () => {
  assert.equal(bookingUrlFor({ buyer_profile: 'compr', compr_lifecycle: { booking_url: 'https://cal.com/x' } }), 'https://cal.com/x');
  assert.equal(bookingUrlFor({ compr_lifecycle: { booking_url: 'javascript:alert(1)' } }), null, 'only an https page');
  assert.equal(bookingUrlFor({}), null, 'Acme Homes has no booking page');
  const m = bookingMessage({ first: 'Dana', repName: 'Alex Reed', company: 'Compr', url: 'https://cal.com/x' });
  assert.equal(m, "Hi Dana, it's Alex with Compr. Pick a time that works for you here: https://cal.com/x");
  assert.equal(slopFindings(m).length, 0);
});

console.log(`meeting-invite: ${passed} passed`);
