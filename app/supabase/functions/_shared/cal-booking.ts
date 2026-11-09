// Cal.com bookings for Compr's onboarding call: the rules, kept pure so the
// test can run them without a database. cal-webhook parses with parseCalEvent,
// cal-tick asks dueReminders and outcomeFor what to do, and both render with
// renderBookingEmail / bookingSms.
//
// The email is Compr's own look (the lifecycle email's tokens: royal blue
// #2d5bff, ink #18181b, Inter, the wordmark with its blue dot), a card with
// when and where, one Join button, and reschedule / cancel links. Table layout
// and inline styles, 560px and fluid, so it reads in every client and on a phone.

// deno-lint-ignore no-explicit-any
type Any = any;

export const DEMO_TAG = 'compr-demo';
export const NO_SHOW_TAG = 'compr-no-show';
export const SHOWED_TAG = 'compr-showed';
export const BOOKING_PAGE = 'https://cal.com/team/compr/onboarding-call';

/** A late sign-up for the 60 minute reminder: inside this window the confirmation already said it all. */
const H1_MIN_LEAD_MS = 70 * 60_000;
/** The reminders' windows, relative to the start. */
const H1_OPEN = -60 * 60_000, H1_CLOSE = -15 * 60_000;
const M5_OPEN = -6 * 60_000, M5_CLOSE = 3 * 60_000;
/** The host is asked "did they show?" this long after the end. */
export const CHECK_AFTER_MS = 15 * 60_000;
/** With no sign either way this long after the end, a no-show is assumed. */
export const AUTO_NO_SHOW_AFTER_MS = 2 * 60 * 60_000;

export type CalPerson = { name: string | null; email: string; phone: string | null; time_zone: string | null };

export type CalEvent =
  | { kind: 'ping' }
  | { kind: 'ignored'; trigger: string }
  | {
    kind: 'booked' | 'rescheduled';
    uid: string; icalUid: string | null; rescheduledFrom: string | null;
    title: string | null; slug: string | null; startsAt: string; endsAt: string;
    organizer: { name: string | null; email: string | null; time_zone: string | null };
    hostEmails: string[]; attendees: CalPerson[]; meetingUrl: string | null; location: string | null;
  }
  | { kind: 'cancelled'; uid: string; reason: string | null }
  | { kind: 'no_show'; uid: string; marks: { email: string | null; noShow: boolean }[] };

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const lower = (v: unknown) => (s(v) ?? '').toLowerCase();
const isEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/** The phone a booker typed, wherever this event type put it. */
function phoneOf(p: Any): string | null {
  const r = p?.responses ?? {};
  const raw = s(r.attendeePhoneNumber?.value) ?? s(r.phone?.value) ?? s(r.phoneNumber?.value) ?? s(p?.attendees?.[0]?.phoneNumber)
    ?? s(p?.smsReminderNumber) ?? (/^\+?[\d\s().-]{10,}$/.test(String(r.location?.value?.optionValue ?? '')) ? s(r.location.value.optionValue) : null);
  if (!raw) return null;
  return raw.replace(/\D/g, '').length >= 10 ? raw : null;
}

function meetingUrlOf(p: Any): string | null {
  const url = s(p?.metadata?.videoCallUrl) ?? s(p?.videoCallData?.url) ?? s(p?.location);
  return url && /^https:\/\//.test(url) ? url : null;
}

/** Cal.com webhook body to what we act on. Unknown triggers are ignored, never an error. */
export function parseCalEvent(body: Any): CalEvent {
  const trigger = String(body?.triggerEvent ?? '').toUpperCase();
  const p = body?.payload ?? {};
  if (trigger === 'PING') return { kind: 'ping' };
  if (trigger === 'BOOKING_CREATED' || trigger === 'BOOKING_RESCHEDULED') {
    const uid = s(p.uid);
    const startsAt = s(p.startTime), endsAt = s(p.endTime);
    if (!uid || !startsAt || !endsAt) return { kind: 'ignored', trigger: `${trigger} without uid or times` };
    const organizer = { name: s(p.organizer?.name), email: lower(p.organizer?.email) || null, time_zone: s(p.organizer?.timeZone) };
    const hostEmails = [...new Set([organizer.email, ...((p.team?.members ?? []) as Any[]).map((m) => lower(m?.email))].filter((e): e is string => !!e))];
    const phone = phoneOf(p);
    const people = new Map<string, CalPerson>();
    for (const a of (p.attendees ?? []) as Any[]) {
      const email = lower(a?.email);
      if (!isEmail(email) || hostEmails.includes(email) || people.has(email)) continue;
      people.set(email, { name: s(a?.name), email, phone: s(a?.phoneNumber), time_zone: s(a?.timeZone) });
    }
    // Guests added on the booking form arrive as bare addresses.
    const guests = p.responses?.guests?.value;
    for (const g of (Array.isArray(guests) ? guests : []) as unknown[]) {
      const email = lower(g);
      if (!isEmail(email) || hostEmails.includes(email) || people.has(email)) continue;
      people.set(email, { name: null, email, phone: null, time_zone: null });
    }
    const attendees = [...people.values()];
    // The phone on the form belongs to the booker: the first attendee.
    if (attendees[0] && !attendees[0].phone && phone) attendees[0] = { ...attendees[0], phone };
    if (attendees[0] && !attendees[0].name) attendees[0] = { ...attendees[0], name: s(p.responses?.name?.value) };
    return {
      kind: trigger === 'BOOKING_RESCHEDULED' ? 'rescheduled' : 'booked',
      uid, icalUid: s(p.iCalUID), rescheduledFrom: s(p.rescheduleUid) ?? s(p.fromReschedule) ?? s(p.originalRescheduledBooking?.uid),
      title: s(p.title), slug: s(p.type) ?? s(p.eventTypeSlug), startsAt, endsAt, organizer, hostEmails, attendees,
      meetingUrl: meetingUrlOf(p), location: s(p.location),
    };
  }
  if (trigger === 'BOOKING_CANCELLED') {
    const uid = s(p.uid);
    return uid ? { kind: 'cancelled', uid, reason: s(p.cancellationReason) } : { kind: 'ignored', trigger };
  }
  if (trigger === 'BOOKING_NO_SHOW_UPDATED') {
    const uid = s(p.bookingUid) ?? s(p.uid);
    if (!uid) return { kind: 'ignored', trigger };
    const marks = ((p.attendees ?? []) as Any[]).map((a) => ({ email: lower(a?.email) || null, noShow: a?.noShow === true }));
    return { kind: 'no_show', uid, marks };
  }
  if (trigger === 'AFTER_GUESTS_CAL_VIDEO_NO_SHOW') {
    const uid = s(p.bookingUid) ?? s(p.uid);
    return uid ? { kind: 'no_show', uid, marks: [{ email: null, noShow: true }] } : { kind: 'ignored', trigger };
  }
  return { kind: 'ignored', trigger: trigger || 'unknown' };
}

/** Cal.com's X-Cal-Signature-256: hex HMAC-SHA256 of the raw body with the webhook's secret. */
export async function verifyCalSignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(raw)));
  const want = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.trim().toLowerCase().replace(/^sha256=/, '');
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ---- when ------------------------------------------------------------------------------------

export type ReminderKind = 'confirm' | 'h1' | 'm5';

/**
 * Which reminders are due now for a booking made at createdAt. The
 * confirmation goes until the call starts; the hour-before only when the
 * booking was made more than 70 minutes ahead; the five-minute one from six
 * minutes before to three after the start. A tick that misses a window skips
 * that reminder rather than sending it late.
 */
export function dueReminders(b: { startsAt: string; createdAt: string }, now: number): ReminderKind[] {
  const start = Date.parse(b.startsAt), made = Date.parse(b.createdAt);
  const out: ReminderKind[] = [];
  const t = now - start;
  if (t < 0) out.push('confirm');
  if (start - made > H1_MIN_LEAD_MS && t >= H1_OPEN && t < H1_CLOSE) out.push('h1');
  if (t >= M5_OPEN && t < M5_CLOSE) out.push('m5');
  return out;
}

export type Outcome = 'wait' | 'check' | 'showed' | 'no_show';

/**
 * Did they come. Tags and Cal.com's own no-show mark win; a connected call
 * with them around the meeting counts as showed; past AUTO_NO_SHOW_AFTER_MS
 * with nothing, a no-show is assumed unless auto is off.
 */
export function outcomeFor(i: {
  endsAt: string; now: number; tags: readonly string[]; calNoShow: boolean; calShowed: boolean; talked: boolean; auto: boolean; checked: boolean;
}): Outcome {
  const tags = i.tags.map((t) => t.trim().toLowerCase());
  if (i.calNoShow || tags.includes(NO_SHOW_TAG)) return 'no_show';
  if (i.calShowed || tags.includes(SHOWED_TAG) || i.talked) return 'showed';
  const since = i.now - Date.parse(i.endsAt);
  if (since < CHECK_AFTER_MS) return 'wait';
  if (i.auto && since >= AUTO_NO_SHOW_AFTER_MS) return 'no_show';
  return i.checked ? 'wait' : 'check';
}

/** "Tue, Oct 21 at 2:00 PM CDT" in the attendee's zone, falling back to the host's, then Central. */
export function formatWhen(iso: string, tz: string | null | undefined): string {
  const zone = validZone(tz) ? tz! : 'America/Chicago';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
  return `${day} at ${time}`;
}

function validZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export const rescheduleUrl = (uid: string) => `https://cal.com/reschedule/${encodeURIComponent(uid)}`;
export const cancelUrl = (uid: string) => `https://cal.com/booking/${encodeURIComponent(uid)}?cancel=true`;

// ---- what it says ----------------------------------------------------------------------------

export type BookingFields = {
  firstName: string; hostName: string; when: string; meetingUrl: string | null; location: string | null; uid: string;
};

const COPY: Record<ReminderKind, { subject: (f: BookingFields) => string; preheader: (f: BookingFields) => string; heading: string; lead: (f: BookingFields) => string }> = {
  confirm: {
    subject: (f) => `You're booked: Compr onboarding call, ${f.when}`,
    preheader: (f) => `${f.hostName} will walk you through Compr on a real deal.`,
    heading: "You're on the calendar",
    lead: (f) => `${f.firstName ? f.firstName + ', thanks' : 'Thanks'} for booking. ${f.hostName} will walk you through Compr on a real deal, so bring one or two addresses you're working and we'll underwrite them live.`,
  },
  h1: {
    subject: () => 'Starting in 1 hour: your Compr onboarding call',
    preheader: (f) => `${f.when}. Have an address ready and we'll run it live.`,
    heading: 'See you in an hour',
    lead: (f) => `${f.firstName ? f.firstName + ', quick' : 'Quick'} reminder that your Compr call with ${f.hostName} starts in an hour. Have an address ready and we'll run the full underwrite together: comps, ARV, repairs and your max offer.`,
  },
  m5: {
    subject: () => 'Starting in 5 minutes: join your Compr call',
    preheader: (f) => `${f.hostName} is joining now.`,
    heading: 'Starting in 5 minutes',
    lead: (f) => `${f.hostName} is getting on now. Use the button below to join.`,
  },
};

const C = {
  bg: '#f4f4f5', card: '#ffffff', line: '#e4e4e7', ink: '#18181b', ink2: '#3f3f46', muted: '#52525b',
  accent: '#2d5bff', accentInk: '#ffffff', accentDim: '#eef2ff', accentText: '#1e47e6',
};
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
export const BOOKING_FOOTER = 'You get this because you booked a call with Compr.\nCompr, 4266 Example Dr W Suite 201, San Antonio, TX 78228';

export function renderBookingEmail(kind: ReminderKind, f: BookingFields): { subject: string; html: string; text: string } {
  const c = COPY[kind];
  const where = f.meetingUrl ? 'Video call (link below)' : (f.location || 'Details in your calendar invite');
  const row = (label: string, value: string) => `
              <tr>
                <td style="padding:6px 0;width:72px;font:600 12px/1.4 ${FONT};letter-spacing:0.04em;text-transform:uppercase;color:${C.muted};vertical-align:top;">${esc(label)}</td>
                <td style="padding:6px 0;font:500 15px/1.4 ${FONT};color:${C.ink};">${esc(value)}</td>
              </tr>`;
  const button = f.meetingUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
              <tr><td style="border-radius:8px;background:${C.accent};">
                <a href="${esc(f.meetingUrl)}" style="display:inline-block;padding:13px 22px;font:600 15px/1 ${FONT};color:${C.accentInk};text-decoration:none;border-radius:8px;">Join the call</a>
              </td></tr>
            </table>`
    : '';
  const manage = kind === 'm5' ? '' : `<p style="margin:0 0 20px;font:400 14px/1.6 ${FONT};color:${C.muted};">Need a different time? <a href="${esc(rescheduleUrl(f.uid))}" style="color:${C.accentText};font-weight:600;">Reschedule</a> or <a href="${esc(cancelUrl(f.uid))}" style="color:${C.accentText};font-weight:600;">cancel</a>. Or just reply to this email.</p>`;
  const footer = BOOKING_FOOTER.split('\n').map(esc).join('<br>');
  const subject = c.subject(f);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${esc(c.preheader(f))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 20px;">
            <a href="https://underwriting.example.com" style="font:800 22px/1 ${FONT};letter-spacing:-0.03em;color:${C.ink};text-decoration:none;">Compr<span style="color:${C.accent};">.</span></a>
          </td>
        </tr>
        <tr>
          <td style="background:${C.card};border:1px solid ${C.line};border-radius:12px;padding:32px 28px 28px;">
            <h1 style="margin:0 0 16px;font:700 22px/1.3 ${FONT};letter-spacing:-0.02em;color:${C.ink};">${esc(c.heading)}</h1>
            <p style="margin:0 0 20px;font:400 15px/1.6 ${FONT};color:${C.ink2};">${esc(c.lead(f))}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:${C.accentDim};border-radius:10px;">
              <tr><td style="padding:14px 18px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${row('When', f.when)}${row('Where', where)}${row('With', `${f.hostName}, Compr`)}
                </table>
              </td></tr>
            </table>
            ${button}
            ${manage}
            <p style="margin:0;font:600 15px/1.4 ${FONT};color:${C.ink};">${esc(f.hostName)}</p>
            <p style="margin:2px 0 0;font:400 13px/1.4 ${FONT};color:${C.muted};">Compr</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 4px 0;font:400 12px/1.6 ${FONT};color:${C.muted};">${footer}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  const text = [
    c.heading, '', c.lead(f), '',
    `When: ${f.when}`, `Where: ${where}`, `With: ${f.hostName}, Compr`,
    ...(f.meetingUrl ? ['', `Join: ${f.meetingUrl}`] : []),
    ...(kind === 'm5' ? [] : ['', `Reschedule: ${rescheduleUrl(f.uid)}`, `Cancel: ${cancelUrl(f.uid)}`]),
    '', f.hostName, 'Compr', '', BOOKING_FOOTER,
  ].join('\n');
  return { subject, html, text };
}

/** The text for one reminder, before withOptOut adds the STOP line. */
export function bookingSms(kind: ReminderKind, f: BookingFields): string {
  const hi = f.firstName ? `${f.firstName}, ` : '';
  const join = f.meetingUrl ? ` Join: ${f.meetingUrl}` : '';
  if (kind === 'confirm') return `Compr: ${hi}you're booked with ${f.hostName} ${f.when}. Bring an address you're working and we'll underwrite it live.${join}`;
  if (kind === 'h1') return `Compr: ${hi}your call with ${f.hostName} starts in 1 hour (${f.when}).${join}`;
  return `Compr: ${hi}${f.hostName} is joining your Compr call now.${join}`;
}
