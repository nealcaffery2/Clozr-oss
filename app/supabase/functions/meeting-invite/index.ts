/**
 * POST /meeting-invite: book a meeting with a Google Meet link and send it.
 *
 * Body: { workspace_id, meeting_type, starts_at, minutes?, seller_id?, buyer_id?,
 *         name?, email?, phone?, recipient_tz?, rep_tz?, send_email?, send_sms?, note?, origin? }
 *   → { ok, appointment_id, meet_link, event_link, emailed, texted, warnings[], when }
 *
 * In order, all as the signed-in rep:
 *   1. The invite is rendered first (_shared/meeting-invite.ts) and must pass
 *      slopFindings(); nothing is created when it does not.
 *   2. An appointment row (meet = true, meeting_type) is inserted already
 *      marked synced, so the regular calendar push cannot create a second
 *      event for it while this request is still talking to Google.
 *   3. The event goes onto the rep's own primary calendar (so Google's
 *      invitation comes from the rep's address, not the CLOZR calendar) with
 *      conferenceData.createRequest (hangoutsMeet, conferenceDataVersion=1)
 *      and sendUpdates=all, so Google sends its own invitation too. Google's
 *      hangoutLink lands on appointments.meet_link. A Google refusal removes
 *      the row again and answers with Google's reason: no half-booked meeting.
 *   4. Our email from the rep's Gmail (mailguard first): the designed invite,
 *      a "Join Google Meet" button, the time in the recipient's zone (else the
 *      rep's), an "Add to Google Calendar" link and invite.ics carrying the
 *      event's own iCalUID, so a calendar that has Google's invitation sees the
 *      same meeting, not a second one. The email says plainly that Google
 *      sends its own invitation for the same meeting.
 *   5. A text through Talkr (blacklist, opt-out and quiet hours apply) with
 *      the time and the Meet link.
 * Steps 4 and 5 failing does not undo the booking; each failure comes back in
 * `warnings` with its reason.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { clientIp, corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';
import { type Account, SCOPE, accessFor, has, messageIdOf, sendMail } from '../_shared/google.ts';
import { guardSend, release } from '../_shared/mailguard.ts';
import { textRecipient } from '../_shared/docs-flow.ts';
import { slopReport } from '../_shared/no-ai-slop.ts';
import {
  DEFAULT_MEETING_TYPES, type InviteInput, type MeetingType, formatWhen, googleCalendarUrl, icsFile, inviteFindings,
  bookingFailure, brandSite, inviteHtml, inviteSms, inviteSubject, inviteText, meetingDescription, meetingTitle, pickZone,
} from '../_shared/meeting-invite.ts';
import { eventBody, writeQuery } from '../google-sync/calendar.ts';

type Any = any;
const CAL = 'https://www.googleapis.com/calendar/v3';
const SELECT = 'id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync, gmail_send, gmail_read, status, sync_token, last_calendar_sync_at, last_gmail_sync_at, gmail_signature, gmail_signature_at';
const EMAIL = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/;
/** What the preflight renders in place of the real link, so the slop check reads the same sentences. */
const SAMPLE_LINK = 'https://meet.google.com/abc-defg-hij';

async function gcal(token: string, url: string, init: RequestInit = {}): Promise<Any> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body?.error?.message ?? `Google Calendar answered ${res.status}`));
  return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = jsonWith(cors);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const projectUrl = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(projectUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const asCaller = createClient(projectUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false },
  });

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'Sign in first.' }, 401);
  const uid = who.user.id;
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: workspace } = await asCaller.from('workspaces').select('id, name, settings').eq('id', ws).maybeSingle();
  if (!workspace) return json({ error: 'You are not a member of that workspace.' }, 403);

  const rl = await rateLimit(admin, `meeting-invite:${uid}:${clientIp(req)}`, 40, 3600);
  if (!rl.allowed) return tooMany(cors, rl);

  try {
    // ---------------------------------------------------------- the input
    const start = new Date(String(b.starts_at ?? ''));
    if (!Number.isFinite(start.getTime())) return json({ error: 'Pick a date and time.' }, 422);
    if (start.getTime() < Date.now() - 5 * 60_000) return json({ error: 'That time has already passed. Pick a time from now on.' }, 422);
    const sendEmail = b.send_email !== false;
    const sendSms = b.send_sms === true;

    const { data: typeRows } = await asCaller.from('meeting_types').select('key, name, minutes, title_pattern, description, sort').eq('workspace_id', ws).eq('active', true);
    const types = (typeRows?.length ? typeRows : DEFAULT_MEETING_TYPES) as MeetingType[];
    const type = types.find((t) => t.key === b.meeting_type) ?? types[0];
    const minutes = Math.min(480, Math.max(5, Math.round(Number(b.minutes) || type.minutes)));
    const end = new Date(start.getTime() + minutes * 60_000);

    // The record, checked against the workspace as the caller (RLS decides).
    const sellerId = Number(b.seller_id) || null;
    const buyerId = Number(b.buyer_id) || null;
    const { data: seller } = sellerId ? await asCaller.from('sellers').select('id, name, email, phone, property_address').eq('id', sellerId).eq('workspace_id', ws).maybeSingle() : { data: null };
    const { data: buyer } = buyerId && !seller ? await asCaller.from('buyers').select('id, name, email, phone').eq('id', buyerId).eq('workspace_id', ws).maybeSingle() : { data: null };
    const rec = (seller ?? buyer) as Any;
    const name = String(b.name ?? rec?.name ?? '').trim().slice(0, 120);
    const email = String(b.email ?? rec?.email ?? '').trim().toLowerCase();
    const phone = String(b.phone ?? rec?.phone ?? '').trim();
    if (sendEmail && !EMAIL.test(email)) return json({ error: 'Add an email address to send the invite by email, or switch email off and text it.' }, 422);
    if (sendSms && !phone) return json({ error: 'Add a mobile number to text the invite, or switch the text off.' }, 422);
    if (!sendEmail && !sendSms) return json({ error: 'Pick email, text or both.' }, 422);

    // ------------------------------------------------------ the rep's Google
    const { data: acct } = await admin.from('google_accounts').select(SELECT).eq('workspace_id', ws).eq('user_id', uid).maybeSingle();
    const account = acct as Account | null;
    if (!account) return json({ error: 'Connect Google in Settings, Integrations first: the invite goes on your Google Calendar with a Meet link.', code: 'not_connected' }, 409);
    if (account.status !== 'active') return json({ error: 'Google needs your approval again. Reconnect it in Settings, Integrations.', code: 'needs_reauth' }, 409);
    if (!has(account, SCOPE.calendar)) return json({ error: 'Your Google connection has no calendar access. Reconnect it in Settings, Integrations and allow Calendar.', code: 'no_calendar' }, 409);
    if (sendEmail && (!account.gmail_send || !has(account, SCOPE.gmailSend))) return json({ error: 'Gmail sending is off for your connection. Turn it on in Settings, Integrations, or send by text only.', code: 'no_gmail' }, 409);
    const token = await accessFor(admin, account);
    if (!token) return json({ error: 'Google needs your approval again. Reconnect it in Settings, Integrations.', code: 'needs_reauth' }, 409);

    const settings = (workspace.settings ?? {}) as Any;
    const company = String(settings?.company?.name || workspace.name || 'CLOZR');
    const { data: prof } = await admin.from('profiles').select('full_name').eq('id', uid).maybeSingle();
    const repName = String(prof?.full_name || account.email.split('@')[0]);
    const repTz = await gcal(token, `${CAL}/users/me/settings/timezone`).then((r) => String(r.value ?? '')).catch(() => '') || String(b.rep_tz ?? '');
    const tz = pickZone(b.recipient_tz, repTz);
    const vars = { company, name, rep: repName, address: (seller as Any)?.property_address ?? null };
    const title = meetingTitle(type, vars);
    const description = meetingDescription(type, { ...vars, type: type.name });
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    const base: Omit<InviteInput, 'meetLink' | 'addToCalendarUrl'> = {
      type, title, description, recipientName: name, repName, repEmail: account.email, company,
      startIso: start.toISOString(), minutes, tz, note, website: brandSite(settings),
    };

    // 1. The copy, before anything exists.
    const preflight = inviteFindings({ ...base, meetLink: SAMPLE_LINK, addToCalendarUrl: 'https://calendar.google.com/' }, sendSms);
    if (preflight.length) return json({ error: `The invite text needs a rewrite before it sends: ${slopReport(preflight)}. Edit the meeting type or the note.`, code: 'slop' }, 422);

    // 2. The row.
    const now = new Date().toISOString();
    const role = seller ? 'seller' : buyer ? 'buyer' : 'other';
    const attendees = EMAIL.test(email) ? [{ email, name: name || null, role, status: 'needsAction' }] : [];
    const { data: row, error: insErr } = await admin.from('appointments').insert({
      workspace_id: ws, seller_id: seller ? sellerId : null, buyer_id: buyer ? buyerId : null,
      title, kind: type.name, starts_at: start.toISOString(), ends_at: end.toISOString(), all_day: false,
      location: null, notes: [description, note].filter(Boolean).join('\n\n'), attendees,
      created_by: uid, assigned_to: uid, source: 'clozr',
      meet: true, meeting_type: type.key,
      sync_state: 'synced', last_synced_at: now,
    }).select('*').single();
    if (insErr || !row) {
      if (/meet|meeting_type/.test(String(insErr?.message))) return json({ error: 'The database is missing migration 270 (meeting invites). It applies on the next merge to main.' }, 503);
      throw new Error(insErr?.message ?? 'appointment insert failed');
    }

    // 3. The Google event with a Meet conference. Only the insert itself can
    // undo the booking (bookingFailure): once Google has the event, the row
    // stays and a later step's failure is reported as that step's.
    let ev: Any = null;
    let calendarId = '';
    try {
      // The rep's own primary calendar, not the CLOZR one: on a secondary
      // calendar Google names that calendar as the organizer in its
      // invitation, so the prospect would see "Compr · CLOZR" instead of the
      // rep's own address. The row is then a mirror of the rep's calendar
      // (google_calendar_feeds.writable false): the pull keeps it current,
      // and a reschedule is done in Google Calendar.
      const primary = await gcal(token, `${CAL}/users/me/calendarList/primary`);
      calendarId = String(primary?.id ?? '');
      if (!calendarId) throw new Error('Could not read your Google Calendar.');
      const origin = String(b.origin || req.headers.get('origin') || Deno.env.get('APP_URL') || '').replace(/\/$/, '');
      const body = eventBody({ ...row, meet: true, meet_link: null } as Any, seller ? { id: Number(sellerId), name: String((seller as Any).name ?? ''), property_address: (seller as Any).property_address ?? null, email: (seller as Any).email ?? null } : null, origin);
      const url = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams(writeQuery(body, attendees.length ? 'all' : 'none'))}`;
      ev = await gcal(token, url, { method: 'POST', body: JSON.stringify(body) });
    } catch (err) {
      const f = bookingFailure(null, 'the calendar insert', err instanceof Error ? err.message : String(err));
      await admin.from('appointments').delete().eq('id', row.id);
      return json({ error: f.error, code: 'google' }, 502);
    }
    const warnings: string[] = [];
    // Google usually returns the link at once; a pending conference fills in a moment later.
    for (let i = 0; i < 4 && !ev.hangoutLink && ev.conferenceData?.createRequest?.status?.statusCode === 'pending'; i++) {
      await sleep(700);
      ev = await gcal(token, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(ev.id)}`).catch(() => ev);
    }
    const { error: stampErr } = await admin.from('appointments').update({
      google_event_id: ev.id, google_calendar_id: calendarId, google_etag: ev.etag ?? null, google_updated_at: ev.updated ?? now,
      meet_link: ev.hangoutLink ?? null, sync_state: 'synced', sync_error: null, last_synced_at: new Date().toISOString(),
    }).eq('id', row.id);
    // The row carries clozr_id on the event, so the pull links it even when this write did not land.
    if (stampErr) warnings.push(`${bookingFailure(ev.id, 'saving the event to CLOZR', stampErr.message).warning} The next calendar sync links it.`);

    const meetLink: string | null = ev.hangoutLink ?? null;
    const addToCalendarUrl = googleCalendarUrl({ title, startIso: start.toISOString(), endIso: end.toISOString(), details: [description, meetLink ? `Google Meet: ${meetLink}` : ''].filter(Boolean).join('\n\n'), location: meetLink });
    const input: InviteInput = { ...base, meetLink, eventLink: ev.htmlLink ?? null, addToCalendarUrl };
    if (!meetLink) warnings.push('Google did not return a Meet link yet. It is on the calendar event and arrives with the next sync.');
    let emailed = false;
    let texted = false;

    // 4. Our email. The meeting exists from here on, so a throw below is that
    // step's warning, never a failed booking.
    if (sendEmail) try {
      const claim = await guardSend(admin, account, [email], 'one_to_one');
      if (!claim.ok) warnings.push(`Email not sent: ${claim.message}`);
      else {
        const subject = inviteSubject(input);
        const ics = icsFile({ uid: String(ev.iCalUID ?? `${ev.id}@google.com`), title, startIso: start.toISOString(), endIso: end.toISOString(), description: inviteText(input), url: meetLink, organizerEmail: account.email, organizerName: repName });
        const sent = await sendMail(token, {
          to: email, subject, html: inviteHtml(input), text: inviteText(input),
          attachments: [{ filename: 'invite.ics', contentType: 'text/calendar; method=PUBLISH; charset=UTF-8', data: new TextEncoder().encode(ics) }],
        });
        if (!sent) { await release(admin, claim.ids); warnings.push('Email not sent: Gmail refused it. Google\'s own invitation still went out.'); }
        else {
          emailed = true;
          const messageId = (await messageIdOf(token, sent.id).catch(() => null)) ?? `gmail:${sent.id}`;
          const { data: comm, error: cErr } = await admin.from('communications').upsert({
            workspace_id: ws, seller_id: seller ? sellerId : null, buyer_id: buyer ? buyerId : null,
            channel: 'email', direction: 'outbound', occurred_at: new Date().toISOString(), subject, body: inviteHtml(input),
            from_email: account.email.toLowerCase(), to_email: email, status: 'sent', source: 'gmail', source_id: messageId, rep_id: uid,
          }, { onConflict: 'workspace_id,source,source_id' }).select('id').maybeSingle();
          if (cErr) console.error('invite email sent but not recorded', cErr.message);
          else if (comm?.id) {
            await admin.from('communication_mailboxes').upsert({ communication_id: comm.id, account_id: account.id, workspace_id: ws, user_id: uid }, { onConflict: 'communication_id,account_id', ignoreDuplicates: true });
          }
        }
      }
    } catch (err) {
      warnings.push(bookingFailure(ev.id, 'the invite email', err instanceof Error ? err.message : String(err)).warning!);
    }

    // 5. The text.
    if (sendSms) try {
      const r = await textRecipient(admin, { workspace_id: ws, created_by: uid, deal_id: null }, { phone, seller_id: seller ? sellerId : null, buyer_id: buyer ? buyerId : null }, inviteSms(input, { emailed: emailed || attendees.length > 0 }), uid, { contractsLine: false });
      if (r.ok) texted = true;
      else warnings.push(`Text not sent: ${r.reason}.`);
    } catch (err) {
      warnings.push(bookingFailure(ev.id, 'the text', err instanceof Error ? err.message : String(err)).warning!);
    }

    if (emailed || texted) await admin.from('appointments').update({ invite_sent_at: new Date().toISOString() }).eq('id', row.id);
    const when = formatWhen(start.toISOString(), minutes, tz);
    return json({ ok: true, appointment_id: row.id, meet_link: meetLink, event_link: ev.htmlLink ?? null, emailed, texted, google_invited: attendees.length > 0, warnings, when: when.line, tz });
  } catch (err) {
    return serverError(cors, 'meeting-invite', err);
  }
});
