// Cal.com bookings: payload parsing, signature, reminder windows, outcome, copy.
// Run:  deno run supabase/functions/_shared/cal-booking.test.ts
import {
  AUTO_NO_SHOW_AFTER_MS, CHECK_AFTER_MS, NO_SHOW_TAG, SHOWED_TAG, bookingSms, dueReminders, formatWhen, outcomeFor, parseCalEvent,
  renderBookingEmail, verifyCalSignature,
} from './cal-booking.ts';
import { slopFindings } from './no-ai-slop.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failed++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } else console.log(`ok   ${name}`);
}

const created = {
  triggerEvent: 'BOOKING_CREATED',
  payload: {
    type: 'onboarding-call', title: 'Onboarding Call between Alex Lee and Pat Lee',
    startTime: '2026-10-21T19:00:00Z', endTime: '2026-10-21T19:30:00Z',
    organizer: { name: 'Alex Lee', email: 'alex@underwriting.example.com', timeZone: 'America/Chicago' },
    team: { members: [{ email: 'support@underwriting.example.com' }] },
    attendees: [{ name: 'Pat Lee', email: 'PAT@example.com', timeZone: 'America/New_York' }, { name: 'Support', email: 'support@underwriting.example.com' }],
    responses: { name: { value: 'Pat Lee' }, attendeePhoneNumber: { value: '+1 (210) 555-0100' }, guests: { value: ['partner@example.com', 'pat@example.com'] } },
    uid: 'abc123', iCalUID: 'abc123@Cal.com', metadata: { videoCallUrl: 'https://app.cal.com/video/abc123' },
  },
};
const ev = parseCalEvent(created);
eq('created: kind', ev.kind, 'booked');
if (ev.kind === 'booked') {
  eq('created: host emails', ev.hostEmails, ['alex@underwriting.example.com', 'support@underwriting.example.com']);
  eq('created: attendees exclude hosts, add guests once', ev.attendees.map((a) => a.email), ['pat@example.com', 'partner@example.com']);
  eq('created: booker gets the form phone', ev.attendees[0].phone, '+1 (210) 555-0100');
  eq('created: guest has no phone', ev.attendees[1].phone, null);
  eq('created: meeting url', ev.meetingUrl, 'https://app.cal.com/video/abc123');
  eq('created: ical', ev.icalUid, 'abc123@Cal.com');
}
const res = parseCalEvent({ triggerEvent: 'BOOKING_RESCHEDULED', payload: { ...created.payload, uid: 'new1', rescheduleUid: 'abc123' } });
eq('rescheduled: from', res.kind === 'rescheduled' ? res.rescheduledFrom : null, 'abc123');
eq('cancelled', parseCalEvent({ triggerEvent: 'BOOKING_CANCELLED', payload: { uid: 'abc123', cancellationReason: 'conflict' } }), { kind: 'cancelled', uid: 'abc123', reason: 'conflict' });
eq('no-show marks', parseCalEvent({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', payload: { bookingUid: 'abc123', attendees: [{ email: 'Pat@example.com', noShow: true }] } }),
  { kind: 'no_show', uid: 'abc123', marks: [{ email: 'pat@example.com', noShow: true }] });
eq('ping', parseCalEvent({ triggerEvent: 'PING' }).kind, 'ping');
eq('unknown ignored', parseCalEvent({ triggerEvent: 'FORM_SUBMITTED' }).kind, 'ignored');

// Signature: the same HMAC Cal.com computes.
const raw = JSON.stringify(created);
const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(raw)))).map((b) => b.toString(16).padStart(2, '0')).join('');
eq('signature ok', await verifyCalSignature(raw, hex, 's3cret'), true);
eq('signature wrong secret', await verifyCalSignature(raw, hex, 'nope'), false);
eq('signature tampered', await verifyCalSignature(raw + ' ', hex, 's3cret'), false);
eq('signature missing', await verifyCalSignature(raw, null, 's3cret'), false);

// Reminder windows.
const start = Date.parse('2026-10-21T19:00:00Z');
const min = 60_000;
const early = { startsAt: '2026-10-21T19:00:00Z', createdAt: '2026-10-19T12:00:00Z' };
eq('two days out: confirm only', dueReminders(early, start - 48 * 60 * min), ['confirm']);
eq('an hour out: confirm + h1', dueReminders(early, start - 60 * min), ['confirm', 'h1']);
eq('20 min out: h1 still in its window', dueReminders(early, start - 20 * min), ['confirm', 'h1']);
eq('12 min out: confirm only', dueReminders(early, start - 12 * min), ['confirm']);
eq('5 min out: confirm + m5', dueReminders(early, start - 5 * min), ['confirm', 'm5']);
eq('2 min after start: m5 only', dueReminders(early, start + 2 * min), ['m5']);
eq('10 min after start: nothing', dueReminders(early, start + 10 * min), []);
const late = { startsAt: '2026-10-21T19:00:00Z', createdAt: '2026-10-21T18:10:00Z' };
eq('booked 50 min ahead: no h1', dueReminders(late, start - 45 * min), ['confirm']);

// Outcome.
const end = '2026-10-21T19:30:00Z', endMs = Date.parse(end);
const base = { endsAt: end, tags: [] as string[], calNoShow: false, calShowed: false, talked: false, auto: true, checked: false };
eq('during the call: wait', outcomeFor({ ...base, now: endMs - min }), 'wait');
eq('15 min after: ask host', outcomeFor({ ...base, now: endMs + CHECK_AFTER_MS }), 'check');
eq('asked already: wait', outcomeFor({ ...base, now: endMs + CHECK_AFTER_MS, checked: true }), 'wait');
eq('2h after, auto: no-show', outcomeFor({ ...base, now: endMs + AUTO_NO_SHOW_AFTER_MS, checked: true }), 'no_show');
eq('2h after, auto off: wait', outcomeFor({ ...base, now: endMs + AUTO_NO_SHOW_AFTER_MS, checked: true, auto: false }), 'wait');
eq('tagged no-show right away', outcomeFor({ ...base, now: endMs + CHECK_AFTER_MS, tags: [NO_SHOW_TAG] }), 'no_show');
eq('tagged showed', outcomeFor({ ...base, now: endMs + AUTO_NO_SHOW_AFTER_MS, tags: [SHOWED_TAG] }), 'showed');
eq('a connected call counts as showed', outcomeFor({ ...base, now: endMs + AUTO_NO_SHOW_AFTER_MS, talked: true }), 'showed');
eq('cal no-show mark wins', outcomeFor({ ...base, now: endMs + CHECK_AFTER_MS, calNoShow: true, talked: true }), 'no_show');

// Copy.
eq('when, attendee zone', formatWhen('2026-10-21T19:00:00Z', 'America/New_York'), 'Wed, Oct 21 at 3:00 PM EDT');
eq('when, bad zone falls back to Central', formatWhen('2026-10-21T19:00:00Z', 'Mars/Base'), 'Wed, Oct 21 at 2:00 PM CDT');
const f = { firstName: 'Pat', hostName: 'Alex', when: 'Wed, Oct 21 at 3:00 PM EDT', meetingUrl: 'https://app.cal.com/video/abc123', location: null, uid: 'abc123' };
for (const kind of ['confirm', 'h1', 'm5'] as const) {
  const m = renderBookingEmail(kind, f);
  const sms = bookingSms(kind, f);
  eq(`${kind}: no em dash`, /—/.test(m.subject + m.text + m.html + sms), false);
  eq(`${kind}: no slop`, slopFindings(`${m.subject}\n${m.text}\n${sms}`).length, 0);
  eq(`${kind}: join link`, m.html.includes('https://app.cal.com/video/abc123') && sms.includes('https://app.cal.com/video/abc123'), true);
  eq(`${kind}: sms one segment-ish`, sms.length <= 200, true);
}
eq('confirm: reschedule link', renderBookingEmail('confirm', f).text.includes('https://cal.com/reschedule/abc123'), true);
eq('m5: no reschedule link', renderBookingEmail('m5', f).text.includes('reschedule'), false);
eq('confirm subject', renderBookingEmail('confirm', f).subject, "You're booked: Compr onboarding call, Wed, Oct 21 at 3:00 PM EDT");

if (failed) { console.error(`${failed} failed`); Deno.exit(1); }
console.log('all passed');
