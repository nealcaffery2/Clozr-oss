/**
 * Meeting invites with a Google Meet link: the meeting types, the time line
 * in the recipient's zone, the designed email, the text, the .ics and the
 * "Add to Google Calendar" link.
 *
 * Pure (no Deno, no network) so the browser modal previews exactly what the
 * meeting-invite edge function sends, and tools/meeting-invite.test.ts runs it
 * under tsx. The copy here goes to sellers, buyers and Compr prospects, so it
 * follows MESSAGE_RULES and every rendered invite goes through slopFindings()
 * before it sends (inviteFindings below).
 */
import { slopFindings, type SlopFinding } from './no-ai-slop.ts';

export type MeetingType = {
  key: string;
  name: string;
  minutes: number;
  /** Tokens: {type} {company} {name} {first_name} {rep} {address}. An empty token drops out with its neighbour words kept tidy. */
  title_pattern: string;
  /** One or two plain sentences the recipient reads under the time. Same tokens. */
  description: string;
  sort: number;
};

/** Seeded per workspace by migration 270; used as-is when the table is missing or empty. */
export const DEFAULT_MEETING_TYPES: readonly MeetingType[] = [
  { key: 'demo', name: 'Demo', minutes: 30, sort: 10, title_pattern: '{company} demo with {first_name}',
    description: 'A screen share of {company}. Bring a property you are working on and we will run it together.' },
  { key: 'walkthrough', name: 'Walkthrough', minutes: 45, sort: 20, title_pattern: 'Walkthrough of {address}',
    description: 'We go through the property together: condition, repairs and what happens next.' },
  { key: 'comp_analysis', name: 'Comp analysis', minutes: 30, sort: 30, title_pattern: 'Comp analysis for {address}',
    description: 'We look at recent sales near the property and what they mean for the price.' },
  { key: 'onboarding', name: 'Onboarding', minutes: 45, sort: 40, title_pattern: '{company} onboarding with {first_name}',
    description: 'We set up your account with you and get your first deal running.' },
  { key: 'check_in', name: 'Check-in', minutes: 15, sort: 50, title_pattern: 'Check-in with {first_name}',
    description: 'A short call to see how things are going and answer your questions.' },
];

export type InviteVars = {
  type: string; company: string; name: string; rep: string; address?: string | null;
};

const firstName = (n: string) => String(n ?? '').trim().split(/\s+/)[0] ?? '';

/** A pattern with its tokens filled. A token with no value is removed, and a phrase left dangling ("for", "with", "of") goes with it. */
export function fill(pattern: string, v: InviteVars): string {
  const map: Record<string, string> = {
    type: v.type, company: v.company, name: v.name, first_name: firstName(v.name), rep: v.rep, address: (v.address ?? '').trim(),
  };
  let out = pattern.replace(/\{(\w+)\}/g, (_m, k: string) => (map[k] ?? '').trim());
  out = out.replace(/\b(?:with|for|of|at)\s*$/i, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
  return out;
}

/**
 * The event title. A pattern that needs a value the record lacks (a
 * walkthrough of a buyer, who has no address) falls back to "{type} with
 * {first_name}" rather than "Walkthrough of".
 */
export function meetingTitle(t: Pick<MeetingType, 'name' | 'title_pattern'>, v: Omit<InviteVars, 'type'>): string {
  const vars = { ...v, type: t.name };
  const needs = [...t.title_pattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const missing = needs.some((k) => k === 'address' ? !(v.address ?? '').trim() : k === 'name' || k === 'first_name' ? !v.name.trim() : false);
  const title = missing ? fill('{type} with {first_name}', vars) : fill(t.title_pattern, vars);
  return (title || t.name).slice(0, 200);
}

export function meetingDescription(t: Pick<MeetingType, 'description'>, v: InviteVars): string {
  return fill(t.description, v).slice(0, 600);
}

/** A time zone the runtime knows, else null. */
export function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

export type When = { day: string; shortDay: string; time: string; start: string; zone: string; line: string; shortLine: string };

/**
 * "Thursday, October 16" / "2:00 to 2:30 PM CDT" in `tz`. "to" rather than a
 * spaced en dash: the slop check reads a spaced dash as an em dash, and a
 * plain word reads the same in a text message.
 */
export function formatWhen(startIso: string, minutes: number, tz: string): When {
  const zone = validZone(tz) ?? 'UTC';
  const start = new Date(startIso);
  const end = new Date(start.getTime() + Math.max(5, minutes) * 60_000);
  const part = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...o }).format(d);
  const day = part(start, { weekday: 'long', month: 'long', day: 'numeric' });
  const shortDay = part(start, { weekday: 'short', month: 'short', day: 'numeric' });
  const hm = (d: Date) => part(d, { hour: 'numeric', minute: '2-digit' });
  const zoneName = (new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(start).find((p) => p.type === 'timeZoneName')?.value) ?? zone;
  const s = hm(start), e = hm(end);
  const sameHalf = s.slice(-2) === e.slice(-2);
  const time = `${sameHalf ? s.slice(0, -3) : s} to ${e} ${zoneName}`;
  return { day, shortDay, time, start: `${s} ${zoneName}`, zone: zoneName, line: `${day}, ${time}`, shortLine: `${shortDay} at ${s} ${zoneName}` };
}

const gcalStamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Google's own "add this to my calendar" link: a copy the recipient keeps, for someone not on Google's invite. */
export function googleCalendarUrl(e: { title: string; startIso: string; endIso: string; details: string; location?: string | null }): string {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${gcalStamp(e.startIso)}/${gcalStamp(e.endIso)}`, details: e.details });
  if (e.location) q.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${q}`;
}

const icsEsc = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** RFC 5545 folds lines at 75 octets; continuation lines start with a space. */
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ' ' + rest.slice(74); }
  out.push(rest);
  return out.join('\r\n');
};

/**
 * An .ics with METHOD:PUBLISH and the Google event's own iCalUID, so a
 * calendar that already has Google's invitation treats this as the same
 * meeting instead of adding a second one.
 */
export function icsFile(e: { uid: string; title: string; startIso: string; endIso: string; description: string; url?: string | null; location?: string | null; organizerEmail?: string | null; organizerName?: string | null; now?: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meeting invite//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid.replace(/[\r\n]/g, '')}`,
    `DTSTAMP:${gcalStamp((e.now ?? new Date()).toISOString())}`,
    `DTSTART:${gcalStamp(e.startIso)}`,
    `DTEND:${gcalStamp(e.endIso)}`,
    `SUMMARY:${icsEsc(e.title)}`,
    `DESCRIPTION:${icsEsc(e.description)}`,
    ...(e.location || e.url ? [`LOCATION:${icsEsc(e.location || e.url || '')}`] : []),
    ...(e.url ? [`URL:${e.url.replace(/[\r\n]/g, '')}`] : []),
    ...(e.organizerEmail ? [`ORGANIZER;CN=${icsEsc(e.organizerName || e.organizerEmail)}:mailto:${e.organizerEmail.replace(/[\r\n]/g, '')}`] : []),
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export type InviteInput = {
  type: Pick<MeetingType, 'name' | 'minutes' | 'title_pattern' | 'description'>;
  title: string;
  description: string;
  recipientName: string;
  repName: string;
  repEmail: string;
  company: string;
  startIso: string;
  minutes: number;
  /** The zone the times are written in: the recipient's when known, else the rep's. */
  tz: string;
  meetLink: string | null;
  /** Google's own page for the event (htmlLink); opens it in a guest's calendar. */
  eventLink?: string | null;
  addToCalendarUrl: string;
  note?: string | null;
  /** The sender's site, shown as the brand line. */
  website?: string | null;
};

/** The site to show for a workspace: its company website, else none. */
export function brandSite(settings: { company?: { website?: string | null } | null; buyer_profile?: string | null } | null | undefined): string | null {
  const w = String(settings?.company?.website ?? '').trim();
  if (w) return /^https?:\/\//i.test(w) ? w : `https://${w}`;
  return null;
}
const siteLabel = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '');

const escHtml = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The subject line. Plain: what, when. */
export function inviteSubject(i: Pick<InviteInput, 'title' | 'startIso' | 'minutes' | 'tz'>): string {
  return `${i.title}, ${formatWhen(i.startIso, i.minutes, i.tz).shortLine}`.slice(0, 200);
}

/** The plain-text part, and what the slop check reads. */
export function inviteText(i: InviteInput): string {
  const w = formatWhen(i.startIso, i.minutes, i.tz);
  const hi = firstName(i.recipientName);
  return [
    `${hi ? `Hi ${hi},` : 'Hi,'}`,
    `${i.repName} with ${i.company} set up a ${i.type.name.toLowerCase()} with you.`,
    `When: ${w.line}`,
    i.meetLink ? `Join on Google Meet: ${i.meetLink}` : 'The Google Meet link is on the calendar invite from Google.',
    i.description,
    i.note ? i.note : '',
    `Add it to your calendar: ${i.addToCalendarUrl}`,
    'Google Calendar also sends you its own invitation for this meeting with Yes / No / Maybe buttons. Both are the same meeting.',
    `Need a different time? Reply to this email or write to ${i.repEmail}.`,
    i.website ? `${i.company}, ${siteLabel(i.website)}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * The designed email. Table layout and inline styles because Gmail, Outlook
 * and Apple Mail strip <style> and flexbox; one green button (the CLOZR accent)
 * for the one thing to do, a quiet secondary link for the calendar.
 */
export function inviteHtml(i: InviteInput): string {
  const w = formatWhen(i.startIso, i.minutes, i.tz);
  const hi = firstName(i.recipientName);
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const row = (label: string, value: string) => `<tr>
    <td style="padding:10px 0;border-top:1px solid #f0f0f1;font:500 12px/1.4 ${font};color:#71717a;width:96px;vertical-align:top">${escHtml(label)}</td>
    <td style="padding:10px 0;border-top:1px solid #f0f0f1;font:500 14px/1.45 ${font};color:#18181b;vertical-align:top">${value}</td>
  </tr>`;
  const button = i.meetLink
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 8px"><tr><td style="border-radius:8px;background:#0A8560">
        <a href="${escHtml(i.meetLink)}" style="display:inline-block;padding:13px 22px;font:600 15px/1 ${font};color:#ffffff;text-decoration:none;border-radius:8px">Join Google Meet</a>
      </td></tr></table>
      <p style="margin:0 0 4px;font:400 12px/1.5 ${font};color:#71717a">Or open <a href="${escHtml(i.meetLink)}" style="color:#0A8560;text-decoration:underline">${escHtml(i.meetLink.replace(/^https?:\/\//, ''))}</a></p>`
    : `<p style="margin:20px 0 4px;font:500 14px/1.5 ${font};color:#18181b">The Google Meet link is on the calendar invitation Google sends you.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(i.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
    <tr><td style="padding:24px 24px 4px">
      <p style="margin:0 0 6px;font:500 12px/1.4 ${font};color:#71717a">${i.website ? `<a href="${escHtml(i.website)}" style="color:#18181b;font-weight:700;text-decoration:none">${escHtml(i.company)}</a>` : `<span style="color:#18181b;font-weight:700">${escHtml(i.company)}</span>`} · ${escHtml(i.type.name)}, ${escHtml(String(i.minutes))} min</p>
      <h1 style="margin:0;font:700 20px/1.3 ${font};color:#18181b;letter-spacing:-0.01em">${escHtml(i.title)}</h1>
      <p style="margin:8px 0 0;font:600 15px/1.45 ${font};color:#18181b">${escHtml(w.day)}<br><span style="font-weight:500;color:#3f3f46">${escHtml(w.time)}</span></p>
      ${button}
    </td></tr>
    <tr><td style="padding:12px 24px 4px">
      <p style="margin:0 0 12px;font:400 14px/1.55 ${font};color:#3f3f46">${hi ? `Hi ${escHtml(hi)}, ` : ''}${escHtml(i.repName)} set this up with you. ${escHtml(i.description)}</p>
      ${i.note ? `<p style="margin:0 0 12px;font:400 14px/1.55 ${font};color:#3f3f46">${escHtml(i.note)}</p>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${row('When', `${escHtml(w.day)}<br>${escHtml(w.time)}`)}
        ${row('Where', i.meetLink ? `Google Meet, <a href="${escHtml(i.meetLink)}" style="color:#0A8560">${escHtml(i.meetLink.replace(/^https?:\/\//, ''))}</a>` : 'Google Meet')}
        ${row('With', `${escHtml(i.repName)}, ${escHtml(i.company)}<br><a href="mailto:${escHtml(i.repEmail)}" style="color:#0A8560">${escHtml(i.repEmail)}</a>${i.website ? `<br><a href="${escHtml(i.website)}" style="color:#0A8560">${escHtml(siteLabel(i.website))}</a>` : ''}`)}
        ${row('Calendar', `<a href="${escHtml(i.addToCalendarUrl)}" style="color:#0A8560;font-weight:600">Add to Google Calendar</a><span style="color:#71717a"> · or open the attached invite.ics</span>`)}
      </table>
    </td></tr>
    <tr><td style="padding:12px 24px 24px">
      <p style="margin:0;padding:12px;background:#fafafa;border-radius:8px;font:400 12px/1.5 ${font};color:#52525b">Google Calendar sends a separate invitation for this meeting with Yes / No / Maybe buttons. It is the same meeting, so answering either one is enough. Need another time? Reply to this email.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** The text message: who, when (in their zone) and the link. One message, no sign-off fluff. */
/**
 * The text message: who, when (in their zone) and the link. One message.
 *
 * Without a link (Google still creating the conference) it only points at an
 * email when one actually went to them: `emailed` is true when our invite or
 * Google's own invitation was sent to their address. A text-only invite
 * asks them to reply for the link instead of naming an email they never got.
 */
export function inviteSms(
  i: Pick<InviteInput, 'recipientName' | 'repName' | 'company' | 'type' | 'startIso' | 'minutes' | 'tz' | 'meetLink'>,
  opts: { emailed?: boolean } = {},
): string {
  const w = formatWhen(i.startIso, i.minutes, i.tz);
  const hi = firstName(i.recipientName);
  const rep = firstName(i.repName) || i.repName;
  const what = i.type.name.toLowerCase();
  const link = i.meetLink ? ` Join on Google Meet: ${i.meetLink}`
    : opts.emailed ? ' The Google Meet link is in the calendar invite sent to your email.'
    : " Reply to this text and I'll send you the Google Meet link.";
  return `${hi ? `Hi ${hi}, ` : ''}it's ${rep} with ${i.company}. Our ${what} is set for ${w.shortLine} (${i.minutes} min).${link}`;
}

/**
 * What a failure during booking means for the appointment row. Before Google
 * has the event, the row is ours alone and goes. Once Google has it, the
 * meeting is real (Google may already have mailed the guest), so the row
 * stays with its google_event_id and the later step's failure is reported as
 * itself; deleting it would leave a live event and make a retry double-book.
 */
export function bookingFailure(eventId: string | null | undefined, step: string, message: string): { keepRow: boolean; error?: string; warning?: string } {
  if (!eventId) return { keepRow: false, error: `Google Calendar refused the meeting: ${message}` };
  return { keepRow: true, warning: `The meeting is on Google Calendar, but ${step} failed: ${message.replace(/[.\s]+$/, '')}.` };
}

/** Slop in anything the invite would send. Empty means it may go. */
export function inviteFindings(i: InviteInput, sms: boolean): SlopFinding[] {
  const text = [inviteSubject(i), inviteText(i), sms ? inviteSms(i) : '', sms ? inviteSms({ ...i, meetLink: null }, { emailed: true }) : '', sms ? inviteSms({ ...i, meetLink: null }) : ''].join('\n\n');
  return slopFindings(text);
}

/** Which zone to write the times in: the recipient's, else the rep's, else UTC. */
export function pickZone(recipientTz: string | null | undefined, repTz: string | null | undefined): string {
  return validZone(recipientTz) ?? validZone(repTz) ?? 'UTC';
}

// ------------------------------------------------- the Google event's Meet
/** True when the push must ask Google for a conference: Meet wanted, none on the event yet, and a timed event. */
export const wantsConference = (row: { meet?: boolean; meet_link?: string | null; all_day?: boolean }): boolean => !!row.meet && !row.meet_link && !row.all_day;

/** The conferenceData part of an event body: a hangoutsMeet create request, or nothing (a patch without it leaves an existing conference alone). */
export function conferenceFor(row: { id: number; meet?: boolean; meet_link?: string | null; all_day?: boolean }, now = Date.now()): { conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } } } } {
  return wantsConference(row) ? { conferenceData: { createRequest: { requestId: `clozr-${row.id}-${now}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {};
}

/** Query params for an insert or patch: conferenceDataVersion=1 whenever the body asks for a conference, or Google ignores the request. */
export const writeQuery = (body: { conferenceData?: unknown } | null | undefined, sendUpdates: 'all' | 'none'): Record<string, string> =>
  body?.conferenceData ? { sendUpdates, conferenceDataVersion: '1' } : { sendUpdates };

/** The Meet link to keep: Google's when it has one, else what we stored, so a pull or push never blanks it. */
export const keepMeetLink = (ev: { hangoutLink?: string | null } | null | undefined, stored: string | null | undefined): string | null =>
  (typeof ev?.hangoutLink === 'string' && ev.hangoutLink) ? ev.hangoutLink : (stored ?? null);

/** The rep's booking page: the workspace's own (compr_lifecycle.booking_url), else none. */
export function bookingUrlFor(settings: { buyer_profile?: string; compr_lifecycle?: { booking_url?: string } } | null | undefined): string | null {
  const own = (settings?.compr_lifecycle?.booking_url ?? '').trim();
  if (/^https:\/\//.test(own)) return own;
  return null;
}

/** The message that hands them the booking page instead of a fixed time. */
export const bookingMessage = (o: { first: string; repName: string; company: string; url: string }) =>
  `Hi ${o.first}, it's ${(o.repName || '').split(' ')[0] || 'me'} with ${o.company}. Pick a time that works for you here: ${o.url}`;
