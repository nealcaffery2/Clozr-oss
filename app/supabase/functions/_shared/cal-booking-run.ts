/**
 * The I/O behind cal-webhook and cal-tick (migration 369). Rules are pure in
 * cal-booking.ts; this file reads and writes.
 *
 * A booking: every non-host person on it is matched to a buyer by email or
 * made one (tag compr-demo, assigned to the host, text consent from the
 * booking when they gave a phone), the meeting links to the mirror of the
 * host's Google event (or a mirror row is made for the pull to adopt by
 * iCalUID), the host gets a bell, and a running "Compr · Missed demo"
 * enrolment stops because they booked again.
 *
 * The tick: confirmation, 60 minute and 5 minute reminders by email (Resend,
 * the workspace's key and blast_from, reply-to the organizer) and text
 * (Talkr, as the host), each claimed in cal_booking_sends first. After the
 * call: a "did they show?" task for the host, then the outcome. A no-show is
 * tagged compr-no-show and enrolled in Missed demo.
 *
 * settings.compr_calcom on the workspace: { paused: true } stops reminders,
 * { sms: false } stops texts, { auto_no_show: false } waits for a tag or
 * Cal.com's no-show mark instead of assuming one two hours after the end.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  type CalEvent, type CalPerson, DEMO_TAG, NO_SHOW_TAG, SHOWED_TAG, CHECK_AFTER_MS,
  bookingSms, dueReminders, formatWhen, outcomeFor, renderBookingEmail,
} from './cal-booking.ts';
import { sendBlock, type Contact } from './compr-lifecycle.ts';
import { slopFindings, slopReport } from './no-ai-slop.ts';
import { blastFrom, filedEmailBody, sendResend } from './resend.ts';
import { resendEnvFor } from './workspace-email.ts';
import { textRecipient } from './docs-flow.ts';
import { withOptOut } from './sms-compliance.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

type Host = { user_id: string | null; name: string; reply_to: string | null; calendar: string | null };
type Attendee = CalPerson & { buyer_id: number | null; no_show?: boolean };
type BuyerRow = Contact & { id: number; name: string | null; assigned_to: string | null };
type Booking = {
  id: number; workspace_id: number; uid: string; status: string; title: string | null; starts_at: string; ends_at: string;
  meeting_url: string | null; location: string | null; organizer_email: string | null; organizer_name: string | null;
  host_user_id: string | null; appointment_id: number | null; attendees: Attendee[]; created_at: string;
  showed_at: string | null; no_show_at: string | null; outcome_at: string | null;
};

const BOOKING_COLS = 'id, workspace_id, uid, status, title, starts_at, ends_at, meeting_url, location, organizer_email, organizer_name, host_user_id, appointment_id, attendees, created_at, showed_at, no_show_at, outcome_at';
const first = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const likeExact = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The Compr workspace: ?ws= when given, else the one whose buyer_profile is compr. */
export async function comprWorkspace(admin: SupabaseClient, ws: number | null): Promise<number | null> {
  if (ws) return ws;
  const { data } = await admin.from('workspaces').select('id').eq('settings->>buyer_profile', 'compr').order('id').limit(1);
  return (data as { id: number }[] | null)?.[0]?.id ?? null;
}

async function settingsOf(admin: SupabaseClient, ws: number): Promise<{ owner: string | null; cfg: { paused?: boolean; sms?: boolean; auto_no_show?: boolean }; rep: string | null }> {
  const { data } = await admin.from('workspaces').select('owner_id, settings').eq('id', ws).maybeSingle();
  const st = ((data as Any)?.settings ?? {}) as Any;
  return { owner: (data as Any)?.owner_id ?? null, cfg: st.compr_calcom ?? {}, rep: st.compr_lifecycle?.rep_user_id ?? null };
}

/** The CLOZR member hosting: their roster email or a connected Google address matches the organizer or a team host. */
async function hostFor(admin: SupabaseClient, ws: number, emails: readonly string[], organizer: { name: string | null; email: string | null }): Promise<Host> {
  const [{ data: roster }, { data: google }, set] = await Promise.all([
    admin.from('workspace_roster').select('user_id, email, full_name').eq('workspace_id', ws),
    admin.from('google_accounts').select('user_id, email').eq('workspace_id', ws).eq('status', 'active'),
    settingsOf(admin, ws),
  ]);
  const team = (roster ?? []) as { user_id: string; email: string | null; full_name: string | null }[];
  const gmail = (google ?? []) as { user_id: string; email: string }[];
  const want = new Set(emails.map((e) => e.toLowerCase()));
  const byRoster = team.find((r) => want.has((r.email ?? '').toLowerCase()));
  const byGoogle = gmail.find((g) => want.has(g.email.toLowerCase()));
  const userId = byRoster?.user_id ?? byGoogle?.user_id ?? set.rep ?? set.owner;
  const member = team.find((r) => r.user_id === userId);
  // Cal.com writes the event to the host's own calendar: the mirror points there, so CLOZR never writes it.
  const calendar = gmail.find((g) => g.user_id === userId && want.has(g.email.toLowerCase()))?.email ?? gmail.find((g) => g.user_id === userId)?.email ?? null;
  return {
    user_id: userId ?? null,
    name: first(organizer.name) || first(member?.full_name) || 'The Compr team',
    reply_to: organizer.email ?? member?.email ?? null,
    calendar,
  };
}

/** Match by email or make the buyer. Booking with a phone is the consent for that booking's texts. */
async function upsertBuyer(admin: SupabaseClient, ws: number, p: CalPerson, hostId: string | null): Promise<number | null> {
  const now = iso();
  const { data: found } = await admin.from('buyers')
    .select('id, name, phone, tags, opted_in_at, assigned_to, archived_at')
    .eq('workspace_id', ws).ilike('email', likeExact(p.email)).order('archived_at', { ascending: false, nullsFirst: true }).order('id').limit(1);
  const b = (found as Any[] | null)?.[0];
  if (b) {
    const tags: string[] = Array.isArray(b.tags) ? b.tags : [];
    const patch: Record<string, unknown> = {};
    if (!tags.some((t) => t.toLowerCase() === DEMO_TAG)) patch.tags = [...tags, DEMO_TAG];
    if (!b.phone && p.phone) patch.phone = p.phone;
    if (!b.opted_in_at && p.phone) { patch.opted_in_at = now; patch.opt_in_source = 'Cal.com booking'; }
    if (!b.assigned_to && hostId) patch.assigned_to = hostId;
    if (!b.name && p.name) patch.name = p.name;
    if (Object.keys(patch).length) await admin.from('buyers').update(patch).eq('id', b.id);
    return b.id as number;
  }
  const { data: made, error } = await admin.from('buyers').insert({
    workspace_id: ws, name: p.name || p.email, email: p.email, phone: p.phone, tags: [DEMO_TAG],
    opted_in_at: p.phone ? now : null, opt_in_source: p.phone ? 'Cal.com booking' : null,
    assigned_to: hostId, source: 'calcom', source_id: `calcom:${p.email}`,
  }).select('id').single();
  if (error) { console.error('cal buyer insert', error.message); return null; }
  return (made as { id: number }).id;
}

async function activity(admin: SupabaseClient, ws: number, buyerId: number, title: string, body: string, actor: string | null) {
  await admin.from('activity').insert({
    workspace_id: ws, entity_type: 'buyer', entity_id: buyerId, kind: 'meeting', title: title.slice(0, 200), body: body.slice(0, 1000), actor_id: actor, occurred_at: iso(),
  });
}

async function bell(admin: SupabaseClient, ws: number, userId: string | null, title: string, body: string, buyerId: number | null) {
  if (!userId) return;
  await admin.from('notifications').insert({ workspace_id: ws, user_id: userId, category: 'Compr', title: title.slice(0, 120), body: body.slice(0, 500), buyer_id: buyerId });
}

async function missedPlan(admin: SupabaseClient, ws: number): Promise<number | null> {
  const { data } = await admin.from('action_plans').select('id').eq('workspace_id', ws).eq('settings->>compr_bucket', 'missed_demo').eq('active', true).order('id').limit(1);
  return (data as { id: number }[] | null)?.[0]?.id ?? null;
}

// ---- webhook ---------------------------------------------------------------------------------

export async function handleCalEvent(admin: SupabaseClient, ws: number, ev: CalEvent, raw: unknown): Promise<Record<string, unknown>> {
  if (ev.kind === 'ping' || ev.kind === 'ignored') return { ok: true, ...(ev.kind === 'ignored' ? { ignored: ev.trigger } : {}) };
  if (ev.kind === 'cancelled') return cancelled(admin, ws, ev.uid, ev.reason);
  if (ev.kind === 'no_show') return noShowMarked(admin, ws, ev.uid, ev.marks);

  const host = await hostFor(admin, ws, ev.hostEmails, ev.organizer);
  const attendees: Attendee[] = [];
  for (const p of ev.attendees) attendees.push({ ...p, buyer_id: await upsertBuyer(admin, ws, p, host.user_id) });
  const buyerIds = attendees.map((a) => a.buyer_id).filter((x): x is number => x != null);

  let carryAppt: number | null = null;
  if (ev.rescheduledFrom) {
    const { data: prev } = await admin.from('cal_bookings').update({ status: 'rescheduled', outcome_at: iso(), updated_at: iso() })
      .eq('workspace_id', ws).eq('uid', ev.rescheduledFrom).select('appointment_id');
    carryAppt = (prev as Any[] | null)?.[0]?.appointment_id ?? null;
  }

  const { data: saved, error } = await admin.from('cal_bookings').upsert({
    workspace_id: ws, uid: ev.uid, ical_uid: ev.icalUid, status: 'booked', event_slug: ev.slug, title: ev.title,
    starts_at: ev.startsAt, ends_at: ev.endsAt, meeting_url: ev.meetingUrl, location: ev.location,
    organizer_email: ev.organizer.email, organizer_name: ev.organizer.name, host_user_id: host.user_id,
    attendees, rescheduled_from: ev.rescheduledFrom, payload: raw, updated_at: iso(),
  }, { onConflict: 'workspace_id,uid' }).select(BOOKING_COLS).single();
  if (error) throw new Error(`cal_bookings: ${error.message}`);
  const booking = saved as Booking;

  const apptId = await linkAppointment(admin, ws, booking, ev.icalUid, host, attendees, carryAppt);
  if (apptId && apptId !== booking.appointment_id) {
    await admin.from('cal_bookings').update({ appointment_id: apptId }).eq('id', booking.id);
  }

  const when = formatWhen(ev.startsAt, ev.organizer.time_zone);
  const names = attendees.map((a) => a.name || a.email).join(', ');
  for (const id of buyerIds) {
    await activity(admin, ws, id, ev.kind === 'rescheduled' ? 'Rescheduled the Compr onboarding call' : 'Booked the Compr onboarding call', `${when} with ${host.name}. Booked on Cal.com.`, host.user_id);
  }
  await bell(admin, ws, host.user_id, `${ev.kind === 'rescheduled' ? 'Rescheduled' : 'New'} Compr call: ${names}`.slice(0, 120), when, buyerIds[0] ?? null);

  // They booked again: the missed-demo follow-up has done its job.
  const plan = await missedPlan(admin, ws);
  if (plan && buyerIds.length) {
    const { data: running } = await admin.from('enrollments').select('id').eq('workspace_id', ws).eq('plan_id', plan).eq('status', 'active').in('buyer_id', buyerIds);
    for (const r of (running ?? []) as { id: number }[]) await admin.rpc('plan_stop_enrollment', { p_enr: r.id, p_reason: 'booked the Compr call again' });
  }

  const tick = await runCalTick(admin, { bookingId: booking.id });
  return { ok: true, booking: booking.id, appointment: apptId, buyers: buyerIds, tick };
}

/**
 * The appointment for a booking. A rescheduled booking keeps the old one; else
 * the mirror the Google pull already made (same iCalUID); else a mirror row
 * here that the pull adopts when it sees the event. Every write stamps
 * last_synced_at so migration 35's trigger leaves it synced: CLOZR never
 * pushes it, because the event is Cal.com's on the host's calendar.
 */
async function linkAppointment(admin: SupabaseClient, ws: number, b: Booking, icalUid: string | null, host: Host, people: Attendee[], carry: number | null): Promise<number | null> {
  const lead = people[0];
  const title = `Compr onboarding call${lead ? `: ${lead.name || lead.email}` : ''}`.slice(0, 300);
  const now = iso();
  const fields = {
    buyer_id: lead?.buyer_id ?? null, title, starts_at: b.starts_at, ends_at: b.ends_at,
    location: b.meeting_url ?? b.location, ...(b.meeting_url ? { meet_link: b.meeting_url } : {}),
    attendees: people.map((p) => ({ email: p.email, name: p.name, status: 'accepted' })),
    assigned_to: host.user_id, ical_uid: icalUid, sync_state: 'synced', last_synced_at: now,
  };
  let id = carry ?? b.appointment_id;
  if (!id && icalUid) {
    const { data } = await admin.from('appointments').select('id').eq('workspace_id', ws).eq('ical_uid', icalUid).is('deleted_at', null).limit(1);
    id = (data as { id: number }[] | null)?.[0]?.id ?? null;
  }
  if (id) {
    const { error } = await admin.from('appointments').update(fields).eq('id', id).eq('workspace_id', ws);
    if (!error) return id;
    console.error('cal appointment update', error.message);
  }
  const { data, error } = await admin.from('appointments').insert({
    workspace_id: ws, ...fields, source: 'calcom', created_by: host.user_id,
    google_calendar_id: host.calendar, notes: 'Booked on Cal.com. Reschedule or cancel from the Cal.com booking.',
  }).select('id').single();
  if (error) { console.error('cal appointment insert', error.message); return null; }
  return (data as { id: number }).id;
}

async function bookingByUid(admin: SupabaseClient, ws: number, uid: string): Promise<Booking | null> {
  const { data } = await admin.from('cal_bookings').select(BOOKING_COLS).eq('workspace_id', ws).eq('uid', uid).maybeSingle();
  return (data as Booking | null) ?? null;
}

async function cancelled(admin: SupabaseClient, ws: number, uid: string, reason: string | null) {
  const b = await bookingByUid(admin, ws, uid);
  if (!b) return { ok: true, unknown: uid };
  if (b.status === 'cancelled') return { ok: true, booking: b.id, already: true };
  await admin.from('cal_bookings').update({ status: 'cancelled', cancel_reason: reason, outcome_at: iso(), updated_at: iso() }).eq('id', b.id);
  if (b.appointment_id) {
    // A row the Google pull never adopted has no event to follow; one it did goes when Google cancels the event.
    await admin.from('appointments').delete().eq('id', b.appointment_id).is('google_event_id', null);
  }
  const lead = b.attendees.find((a) => a.buyer_id);
  const who = lead ? lead.name || lead.email : 'A Compr lead';
  const when = formatWhen(b.starts_at, null);
  if (lead?.buyer_id) {
    await activity(admin, ws, lead.buyer_id, 'Canceled the Compr onboarding call', `Was ${when}.${reason ? ` Reason: ${reason}` : ''}`, b.host_user_id);
    await admin.from('tasks').insert({
      workspace_id: ws, buyer_id: lead.buyer_id, title: `Rebook ${first(who) || who}: canceled the Compr call`.slice(0, 200), task_type: 'call', priority: 'high',
      due_at: iso(), assigned_to: b.host_user_id, created_by: null,
      notes: `${who} canceled the Compr onboarding call set for ${when}.${reason ? ` Reason they gave: ${reason}.` : ''} Call and offer a free underwrite on an address they're working, then rebook: https://cal.com/team/compr/onboarding-call`,
    });
  }
  await bell(admin, ws, b.host_user_id, `Canceled Compr call: ${who}`, when, lead?.buyer_id ?? null);
  return { ok: true, booking: b.id, cancelled: true };
}

async function noShowMarked(admin: SupabaseClient, ws: number, uid: string, marks: { email: string | null; noShow: boolean }[]) {
  const b = await bookingByUid(admin, ws, uid);
  if (!b) return { ok: true, unknown: uid };
  const people = b.attendees.map((a) => {
    const m = marks.find((x) => x.email === null || x.email === a.email);
    return m ? { ...a, no_show: m.noShow } : a;
  });
  await admin.from('cal_bookings').update({ attendees: people, updated_at: iso() }).eq('id', b.id);
  if (b.outcome_at) return { ok: true, booking: b.id, already: true };
  const missed = people.filter((a) => a.no_show === true && a.buyer_id);
  if (missed.length) {
    await resolveNoShow(admin, { ...b, attendees: people }, missed, 'cal');
    return { ok: true, booking: b.id, no_show: missed.length };
  }
  if (people.length && people.every((a) => a.no_show === false)) {
    await resolveShowed(admin, b, 'Cal.com marked them as attended');
    return { ok: true, booking: b.id, showed: true };
  }
  return { ok: true, booking: b.id };
}

// ---- tick ------------------------------------------------------------------------------------

export type TickResult = { bookings: number; emailed: number; texted: number; skipped: number; failed: number; checks: number; no_shows: number; showed: number; errors: string[] };

export async function runCalTick(admin: SupabaseClient, opts: { bookingId?: number; now?: number } = {}): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const out: TickResult = { bookings: 0, emailed: 0, texted: 0, skipped: 0, failed: 0, checks: 0, no_shows: 0, showed: 0, errors: [] };
  let q = admin.from('cal_bookings').select(BOOKING_COLS).eq('status', 'booked').is('outcome_at', null);
  q = opts.bookingId ? q.eq('id', opts.bookingId) : q.lte('starts_at', iso(now + 65 * 60_000)).gte('ends_at', iso(now - 3 * 86_400_000));
  const { data, error } = await q.order('starts_at').limit(200);
  if (error) { out.errors.push(error.message); return out; }
  const wsCache = new Map<number, Awaited<ReturnType<typeof settingsOf>> & { mail: Awaited<ReturnType<typeof resendEnvFor>> }>();
  for (const b of (data ?? []) as Booking[]) {
    out.bookings++;
    try {
      let ws = wsCache.get(b.workspace_id);
      if (!ws) { ws = { ...(await settingsOf(admin, b.workspace_id)), mail: await resendEnvFor(admin, b.workspace_id) }; wsCache.set(b.workspace_id, ws); }
      await tickOne(admin, b, ws, now, out);
    } catch (e) {
      out.errors.push(`${b.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

async function claim(admin: SupabaseClient, row: Record<string, unknown>): Promise<number | null> {
  const { data, error } = await admin.from('cal_booking_sends').upsert(row, { onConflict: 'booking_id,buyer_id,kind,channel', ignoreDuplicates: true }).select('id');
  if (error) throw new Error(`cal_booking_sends: ${error.message}`);
  return (data as { id: number }[] | null)?.[0]?.id ?? null;
}
const settle = (admin: SupabaseClient, id: number, status: string, reason: string | null, extra: Record<string, unknown> = {}) =>
  admin.from('cal_booking_sends').update({ status, reason, ...extra }).eq('id', id);

async function tickOne(admin: SupabaseClient, b: Booking, ws: Awaited<ReturnType<typeof settingsOf>> & { mail: Awaited<ReturnType<typeof resendEnvFor>> }, now: number, out: TickResult) {
  const ids = b.attendees.map((a) => a.buyer_id).filter((x): x is number => x != null);
  if (!ids.length) return;
  const { data: rows } = await admin.from('buyers').select('id, name, email, phone, tags, blacklisted_at, archived_at, opted_in_at, assigned_to').in('id', ids);
  const buyers = new Map(((rows ?? []) as BuyerRow[]).map((r) => [r.id, r]));
  const { data: hostRow } = b.host_user_id ? await admin.from('workspace_roster').select('full_name, email').eq('workspace_id', b.workspace_id).eq('user_id', b.host_user_id).maybeSingle() : { data: null };
  const hostName = first(b.organizer_name) || first((hostRow as Any)?.full_name) || 'The Compr team';
  const replyTo = b.organizer_email ?? (hostRow as Any)?.email ?? null;

  // 1. Reminders.
  const kinds = ws.cfg.paused ? [] : dueReminders({ startsAt: b.starts_at, createdAt: b.created_at }, now);
  if (kinds.length) {
    const emails = [...buyers.values()].map((x) => (x.email ?? '').trim().toLowerCase()).filter(Boolean);
    const { data: sup } = emails.length ? await admin.from('email_suppressions').select('email').eq('workspace_id', b.workspace_id).in('email', emails) : { data: [] };
    const suppressed = new Set(((sup ?? []) as { email: string }[]).map((r) => r.email.trim().toLowerCase()));
    const from = blastFrom(ws.mail.env);
    for (const kind of kinds) {
      for (const a of b.attendees) {
        const buyer = a.buyer_id ? buyers.get(a.buyer_id) : undefined;
        if (!buyer) continue;
        const f = { firstName: first(buyer.name ?? a.name), hostName, when: formatWhen(b.starts_at, a.time_zone), meetingUrl: b.meeting_url, location: b.location, uid: b.uid };
        for (const channel of ['email', 'sms'] as const) {
          if (channel === 'sms' && ws.cfg.sms === false) continue;
          const block = sendBlock(buyer, channel, suppressed);
          const id = await claim(admin, { workspace_id: b.workspace_id, booking_id: b.id, buyer_id: buyer.id, kind, channel, status: block ? 'skipped' : 'pending', reason: block });
          if (!id) continue;
          if (block) { out.skipped++; continue; }
          if (channel === 'email') {
            const m = renderBookingEmail(kind, f);
            const slop = slopFindings(`${m.subject}\n${m.text}`);
            if (slop.length) { await settle(admin, id, 'failed', `slop: ${slopReport(slop)}`); out.failed++; continue; }
            if (!from) { await settle(admin, id, 'failed', 'Resend is not set up for this workspace'); out.failed++; continue; }
            const sent = await sendResend({
              from: from.from, to: buyer.email!.trim(), subject: m.subject, html: m.html, text: m.text, replyTo,
              tags: { kind: 'compr_cal_reminder', stage: kind }, idempotencyKey: `cal-booking-${id}`,
            }, ws.mail.env);
            if (!sent) { await settle(admin, id, 'failed', 'Resend refused the send'); out.failed++; continue; }
            await admin.from('communications').upsert({
              workspace_id: b.workspace_id, buyer_id: buyer.id, rep_id: b.host_user_id, channel: 'email', direction: 'outbound', occurred_at: iso(),
              subject: m.subject, body: filedEmailBody(m.html, m.text), from_email: from.email, to_email: buyer.email, status: 'sent', source: 'resend', source_id: sent.id,
            }, { onConflict: 'workspace_id,source,source_id' });
            await settle(admin, id, 'sent', null, { provider_id: sent.id, sent_at: iso() });
            out.emailed++;
          } else {
            const r = await textRecipient(admin, { workspace_id: b.workspace_id }, { phone: buyer.phone, buyer_id: buyer.id }, withOptOut(bookingSms(kind, f)), b.host_user_id, { contractsLine: false });
            if (r.ok) { await settle(admin, id, 'sent', null, { sent_at: iso() }); out.texted++; continue; }
            // A reminder is only worth anything on time: quiet hours or an opt-out is a skip, not a retry.
            const skip = r.reason === 'quiet hours' || r.reason === 'number opted out of texts' || r.reason === 'no mobile number';
            await settle(admin, id, skip ? 'skipped' : 'failed', r.reason);
            if (skip) out.skipped++; else out.failed++;
          }
        }
      }
    }
  }

  // 2. Outcome, once the call is over.
  const end = Date.parse(b.ends_at);
  if (now < end + CHECK_AFTER_MS) return;
  const lead = b.attendees.find((a) => a.buyer_id && buyers.has(a.buyer_id));
  if (!lead?.buyer_id) return;
  const tags = [...buyers.values()].flatMap((x) => (x.tags ?? []) as string[]);
  const { count: talked } = await admin.from('communications').select('id', { count: 'exact', head: true })
    .eq('workspace_id', b.workspace_id).in('buyer_id', ids).eq('channel', 'call').gte('duration_s', 60)
    .gte('occurred_at', iso(Date.parse(b.starts_at) - 15 * 60_000)).lte('occurred_at', iso(end + 60 * 60_000));
  const { data: checkRow } = await admin.from('cal_booking_sends').select('id').eq('booking_id', b.id).eq('kind', 'check').limit(1);
  const outcome = outcomeFor({
    endsAt: b.ends_at, now, tags,
    calNoShow: b.attendees.some((a) => a.no_show === true), calShowed: b.attendees.length > 0 && b.attendees.every((a) => a.no_show === false),
    talked: (talked ?? 0) > 0, auto: ws.cfg.auto_no_show !== false, checked: !!(checkRow ?? []).length,
  });
  if (outcome === 'check') {
    const id = await claim(admin, { workspace_id: b.workspace_id, booking_id: b.id, buyer_id: lead.buyer_id, kind: 'check', channel: 'task', status: 'sent', sent_at: iso() });
    if (!id) return;
    const who = lead.name || lead.email;
    const auto = ws.cfg.auto_no_show !== false;
    await admin.from('tasks').insert({
      workspace_id: b.workspace_id, buyer_id: lead.buyer_id, title: `Did ${first(who) || who} show for the Compr call?`.slice(0, 200), task_type: 'todo', priority: 'high',
      due_at: iso(now), assigned_to: b.host_user_id, created_by: null,
      notes: `Tag them ${SHOWED_TAG} if they joined, or ${NO_SHOW_TAG} if they did not (marking no-show in Cal.com works too). A no-show starts the Missed demo follow-up.${auto ? ` With neither by ${formatWhen(iso(end + 2 * 3_600_000), null)}, CLOZR treats it as a no-show.` : ''}`,
    });
    out.checks++;
    return;
  }
  if (outcome === 'showed') {
    await resolveShowed(admin, b, (talked ?? 0) > 0 ? 'A call with them was logged around the meeting' : `Tagged ${SHOWED_TAG}`);
    out.showed++;
    return;
  }
  if (outcome === 'no_show') {
    const flagged = b.attendees.some((a) => a.no_show === true);
    const people = flagged ? b.attendees.filter((a) => a.no_show === true) : b.attendees;
    await resolveNoShow(admin, b, people.filter((a) => a.buyer_id), flagged ? 'cal' : tags.some((t) => t.toLowerCase() === NO_SHOW_TAG) ? 'tag' : 'auto');
    out.no_shows++;
  }
}

async function resolveShowed(admin: SupabaseClient, b: Booking, why: string) {
  await admin.from('cal_bookings').update({ showed_at: iso(), outcome_at: iso(), updated_at: iso() }).eq('id', b.id).is('outcome_at', null);
  for (const a of b.attendees) if (a.buyer_id) await activity(admin, b.workspace_id, a.buyer_id, 'Showed for the Compr onboarding call', why, b.host_user_id);
}

async function resolveNoShow(admin: SupabaseClient, b: Booking, people: Attendee[], source: 'cal' | 'tag' | 'auto') {
  const { data: won } = await admin.from('cal_bookings').update({ no_show_at: iso(), no_show_source: source, outcome_at: iso(), updated_at: iso() })
    .eq('id', b.id).is('outcome_at', null).select('id');
  if (!(won ?? []).length) return; // another tick or the webhook got there first
  const plan = await missedPlan(admin, b.workspace_id);
  const why = source === 'cal' ? 'Marked no-show in Cal.com.' : source === 'tag' ? `Tagged ${NO_SHOW_TAG}.` : 'No sign they joined two hours after the end.';
  for (const a of people) {
    if (!a.buyer_id) continue;
    const { data: row } = await admin.from('buyers').select('tags').eq('id', a.buyer_id).maybeSingle();
    const tags: string[] = Array.isArray((row as Any)?.tags) ? (row as Any).tags : [];
    if (!tags.some((t) => t.toLowerCase() === NO_SHOW_TAG)) await admin.from('buyers').update({ tags: [...tags, NO_SHOW_TAG] }).eq('id', a.buyer_id);
    await activity(admin, b.workspace_id, a.buyer_id, 'Missed the Compr onboarding call', why, b.host_user_id);
    if (!plan) continue;
    const id = await claim(admin, { workspace_id: b.workspace_id, booking_id: b.id, buyer_id: a.buyer_id, kind: 'missed', channel: 'task', status: 'pending' });
    if (!id) continue;
    const r = await enrollBuyer(admin, b.workspace_id, plan, a.buyer_id, b.host_user_id, { first_name: first(a.name) });
    await settle(admin, id, r.ok ? 'sent' : 'failed', r.reason, { sent_at: iso() });
  }
  const names = people.map((a) => a.name || a.email).join(', ');
  await bell(admin, b.workspace_id, b.host_user_id, `No-show: ${names}`.slice(0, 120), plan ? 'Started the Missed demo follow-up.' : 'No Missed demo plan is set up, so nothing was sent.', people[0]?.buyer_id ?? null);
}

// ---- enrolment -------------------------------------------------------------------------------

const TASK_TYPE: Record<string, string> = { sms: 'text', call: 'call', email: 'email', rvm: 'rvm', compr_report: 'compr_report' };
const VERB: Record<string, string> = { sms: 'Text', call: 'Call', email: 'Email', rvm: 'RVM' };

/**
 * One buyer into one plan, server side: lib/crm-write.ts enrollBuyerInPlan
 * without the browser (no RVM queue; the Missed demo plan has no drops).
 * Steps are queued as tasks; plan-tick sends the due ones and fills merge
 * fields at send time.
 */
export async function enrollBuyer(admin: SupabaseClient, ws: number, planId: number, buyerId: number, ownerId: string | null, fields: Record<string, string>): Promise<{ ok: boolean; reason: string | null }> {
  const { data: running } = await admin.from('enrollments').select('id').eq('workspace_id', ws).eq('plan_id', planId).eq('buyer_id', buyerId).neq('status', 'done').limit(1);
  if ((running ?? []).length) return { ok: true, reason: 'already enrolled' };
  const { data: enr, error } = await admin.from('enrollments').insert({ workspace_id: ws, plan_id: planId, buyer_id: buyerId, created_by: ownerId }).select('id').maybeSingle();
  if (error) return { ok: false, reason: `enrol: ${error.message}` };
  // enrollments_once (migration 426) refused it: they were on this plan inside the last 30 days.
  if (!enr) return { ok: true, reason: 'already enrolled' };
  const { data: steps } = await admin.from('action_plan_steps').select('id, position, channel, delay_minutes, title, body, config').eq('plan_id', planId).order('position');
  const name = fields.first_name || '';
  let offset = 0;
  const start = Date.now();
  const rows = ((steps ?? []) as Any[]).flatMap((st) => {
    offset += st.delay_minutes ?? 0;
    if (st.channel === 'wait') return [];
    const cfg = (st.config && typeof st.config === 'object' ? st.config : {}) as Any;
    const verb = VERB[st.channel];
    return [{
      workspace_id: ws, buyer_id: buyerId,
      title: (verb ? (st.title ? `${verb} ${name || 'them'}: ${st.title}` : `${verb} ${name || 'them'}`) : st.title || `Follow up with ${name || 'them'}`).slice(0, 200),
      task_type: TASK_TYPE[st.channel] ?? 'todo',
      priority: cfg.priority === 'low' || cfg.priority === 'high' ? cfg.priority : 'normal',
      due_at: iso(start + offset * 60_000),
      assigned_to: typeof cfg.assignee === 'string' && cfg.assignee ? cfg.assignee : ownerId,
      notes: st.body ?? null, enrollment_id: (enr as { id: number }).id, plan_step_id: st.id, created_by: ownerId,
    }];
  });
  if (rows.length) {
    const { error: taskErr } = await admin.from('tasks').upsert(rows, { onConflict: 'enrollment_id,plan_step_id', ignoreDuplicates: true });
    if (taskErr) return { ok: false, reason: `steps: ${taskErr.message}` };
  }
  return { ok: true, reason: null };
}
