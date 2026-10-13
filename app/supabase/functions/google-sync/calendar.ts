/**
 * The calendar, both directions, for one connected Google account.
 *
 * An appointment row owns its Google event (appointments.google_event_id, on
 * the calendar in appointments.google_calendar_id). Which account an
 * appointment belongs to is decided here once, the same way every run:
 *
 *   assigned_to's account, else created_by's, else the workspace's first
 *   connected account (lowest google_accounts.id) — so a row always has a
 *   home even when the rep who booked it never connected Google.
 *
 * CLOZR writes to exactly one calendar — the one it created in the account
 * (google_accounts.calendar_id) — and reads several (google_calendar_feeds,
 * migration 74), the member's own primary among them. An appointment mirrored
 * from a calendar CLOZR does not own is read-only: the push never creates,
 * patches or deletes on it, because a delete there is a real meeting cancelled
 * and every attendee emailed, from a click in a CRM.
 *
 * PUSH  rows whose sync_state is not 'synced', or that carry deleted_at
 *       insert  → events.insert with attendees; sendUpdates=all when there
 *                 are attendees, so Google emails each an invitation
 *       change  → events.patch (same rule for sendUpdates: 'all' when the
 *                 attendee list or the time changed, otherwise 'none')
 *       delete  → events.delete with sendUpdates=all, then the row is purged
 *       Success stamps google_event_id, google_etag, google_updated_at,
 *       sync_state='synced' and last_synced_at, which is the one write the
 *       pending-trigger leaves alone.
 *
 * PULL  events.list on each enabled feed with that feed's own syncToken, so
 *       Google returns only what changed since the last run (any change:
 *       moved, renamed, attendee answered, deleted). No token — first run, or
 *       a 410 Gone because the token expired — is a full read of the bounded
 *       window and a fresh token. One cursor cannot serve two calendars, which
 *       is why it moved out of google_accounts.sync_token.
 *       cancelled  → the row is deleted (a delete on Google is a delete here)
 *       known id   → the row is updated when Google's `updated` is newer than
 *                    what we stored and the row is not itself pending
 *                    (the CRM's unsent edit wins; it is pushed next)
 *       new id     → an appointment is inserted with source='google', on the
 *                    account holder's calendar, kind guessed from the title
 *       task event → due_at follows the event start (legacy links table)
 *
 * Tasks still ride google_event_links, one-way plus the moved date coming
 * back: a due task is a reminder, nobody is invited to it.
 *
 * Everything is idempotent: a second run with nothing changed does nothing
 * but list.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { Account, Feed } from '../_shared/google.ts';

type Any = any;

const CAL = 'https://www.googleapis.com/calendar/v3';
const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();

/**
 * Whether two RFC3339 timestamps are the same moment, whatever offset or
 * precision each was written with. Undefined on both sides counts as unchanged
 * (an all-day event carries `date`, not `dateTime`); one side missing is a
 * real change, which is what switching between all-day and timed is.
 */
const sameInstant = (a: string | undefined | null, b: string | undefined | null): boolean => {
  if (!a || !b) return !a && !b;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  return Number.isFinite(pa) && Number.isFinite(pb) ? pa === pb : a === b;
};

class GoogleError extends Error {
  status: number;
  reason?: string;
  constructor(message: string, status: number, reason?: string) { super(message); this.status = status; this.reason = reason; }
}

async function api(accessToken: string, url: string, init: RequestInit = {}): Promise<Any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(String(body?.error?.message ?? body?.error ?? `HTTP ${res.status}`), res.status, body?.error?.errors?.[0]?.reason);
  return body;
}

const evUrl = (calendarId: string, eventId?: string, q?: Record<string, string>) => {
  const base = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events${eventId ? '/' + encodeURIComponent(eventId) : ''}`;
  return q ? `${base}?${new URLSearchParams(q)}` : base;
};

// -------------------------------------------------------------------- rows
type Attendee = { email: string; name?: string | null; role?: string; status?: string };

type ApptRow = {
  id: number; workspace_id: number; seller_id: number | null; buyer_id: number | null;
  title: string; kind: string; starts_at: string; ends_at: string | null; all_day: boolean;
  location: string | null; notes: string | null; created_by: string | null; assigned_to: string | null;
  attendees: Attendee[]; source: string;
  google_event_id: string | null; google_calendar_id: string | null; google_etag: string | null; google_updated_at: string | null;
  sync_state: string; invites_requested_at: string | null; deleted_at: string | null; last_synced_at: string | null;
};

const APPT = 'id, workspace_id, seller_id, buyer_id, title, kind, starts_at, ends_at, all_day, location, notes, created_by, assigned_to, attendees, source, google_event_id, google_calendar_id, google_etag, google_updated_at, sync_state, invites_requested_at, deleted_at, last_synced_at';

type SellerLite = { id: number; name: string; property_address: string | null; email: string | null };

/** Which account a row belongs to. `accounts` is every active account in the workspace, lowest id first. */
function homeAccount(row: ApptRow, accounts: Pick<Account, 'id' | 'user_id'>[]): number | null {
  const owner = row.assigned_to ?? row.created_by;
  const own = owner ? accounts.find((a) => a.user_id === owner) : null;
  return own?.id ?? accounts[0]?.id ?? null;
}

const localDate = (isoStr: string) => new Date(isoStr).toISOString().slice(0, 10);
const nextDate = (isoStr: string) => new Date(new Date(isoStr).getTime() + 24 * HOUR).toISOString().slice(0, 10);

/** The event body for a row. Attendees carry `email` only; Google fills in the rest. */
function eventBody(row: ApptRow, seller: SellerLite | null, origin: string): Any {
  const start = new Date(row.starts_at);
  const end = row.ends_at ? new Date(row.ends_at) : new Date(start.getTime() + HOUR);
  const who = seller ? `${seller.name}${seller.property_address ? ' — ' + seller.property_address : ''}` : '';
  return {
    summary: row.title || row.kind || 'Appointment',
    description: [who, row.notes ?? '', `${origin}/clozr/`].filter(Boolean).join('\n\n'),
    location: row.location ?? seller?.property_address ?? undefined,
    start: row.all_day ? { date: localDate(row.starts_at) } : { dateTime: iso(start) },
    end: row.all_day ? { date: nextDate(row.ends_at ?? row.starts_at) } : { dateTime: iso(end > start ? end : new Date(start.getTime() + 30 * 60_000)) },
    attendees: (row.attendees ?? []).filter((a) => a?.email).map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
    guestsCanInviteOthers: false,
    extendedProperties: { private: { clozr: '1', clozr_source: 'appointment', clozr_id: String(row.id), clozr_ws: String(row.workspace_id), clozr_kind: row.kind } },
    source: { title: 'Open in CLOZR', url: `${origin}/clozr/` },
    status: 'confirmed',
  };
}

const attendeeKey = (list: Attendee[] | null | undefined) => (list ?? []).map((a) => String(a.email ?? '').toLowerCase()).filter(Boolean).sort().join(',');

/** What Google says each attendee answered, merged back onto our list (which keeps role and name). */
function mergeAnswers(ours: Attendee[] | null | undefined, theirs: Any[] | undefined): Attendee[] {
  const byEmail = new Map<string, Any>();
  for (const g of theirs ?? []) if (g?.email && !g.self && !g.organizer) byEmail.set(String(g.email).toLowerCase(), g);
  const out: Attendee[] = [];
  const seen = new Set<string>();
  for (const a of ours ?? []) {
    const email = String(a.email ?? '').toLowerCase();
    if (!email) continue;
    seen.add(email);
    const g = byEmail.get(email);
    out.push({ ...a, email, name: a.name ?? g?.displayName ?? null, status: g?.responseStatus ?? a.status ?? 'needsAction' });
  }
  // Someone added on Google's side is an attendee here too.
  for (const [email, g] of byEmail) if (!seen.has(email)) out.push({ email, name: g.displayName ?? null, role: 'other', status: g.responseStatus ?? 'needsAction' });
  return out;
}

const guessKind = (summary: string): string => {
  const s = (summary ?? '').toLowerCase();
  if (s.includes('walk') || s.includes('inspect') || s.includes('showing')) return 'Walkthrough';
  if (s.includes('clos') || s.includes('signing')) return 'Closing';
  if (s.includes('call')) return 'Call';
  return 'Appointment';
};

// -------------------------------------------------------------------- push
export type PushResult = { created: number; updated: number; removed: number; invited: number; failed: number; skipped: number };

/**
 * Whether a row's Google event sits on a calendar CLOZR may write to.
 *
 * `writable` is every calendar CLOZR created; in practice that is the one in
 * google_accounts.calendar_id. A row with no calendar yet has not been pushed,
 * so it is ours to create.
 *
 * Everything else is a mirror of the member's own calendar and is not written
 * to — not patched, and above all not deleted. The delete below passes
 * sendUpdates=all, so on a calendar of theirs it would cancel a real meeting
 * and mail every attendee. The rows written before migration 74 are the live
 * case: all of them carry google_calendar_id 'primary' and a real event id on
 * the member's own calendar, and deleting one in CLOZR would have taken the
 * meeting with it.
 */
const writableFor = (row: ApptRow, writable: ReadonlySet<string>): boolean =>
  !row.google_calendar_id || writable.has(row.google_calendar_id);

/** What a mirrored row's owner is told when they edit it here instead of in Google. */
const MIRROR_NOTE = 'This event lives on your own Google calendar. CLOZR mirrors it and never writes to it — edit it in Google Calendar.';

export async function pushAppointments(admin: SupabaseClient, account: Account, accessToken: string, accounts: Pick<Account, 'id' | 'user_id'>[], origin: string, feeds: Feed[] = []): Promise<PushResult> {
  const out: PushResult = { created: 0, updated: 0, removed: 0, invited: 0, failed: 0, skipped: 0 };
  const calendarId = account.calendar_id;
  if (!calendarId) return out;
  const ws = account.workspace_id;
  // The calendar CLOZR owns is writable whether or not the feeds table is
  // there, so a deployment still waiting on migration 74 behaves as before for
  // its own events and stays read-only on everything else.
  const writable = new Set<string>([calendarId, ...feeds.filter((f) => f.writable).map((f) => f.calendar_id)]);

  const { data } = await admin.from('appointments').select(APPT).eq('workspace_id', ws)
    .or('sync_state.neq.synced,deleted_at.not.is.null').order('starts_at').limit(500);
  const rows = ((data ?? []) as ApptRow[]).filter((r) => homeAccount(r, accounts) === account.id);
  if (!rows.length) return out;

  const sellerIds = Array.from(new Set(rows.map((r) => r.seller_id).filter((x): x is number => x != null)));
  const { data: sellers } = sellerIds.length ? await admin.from('sellers').select('id, name, property_address, email').in('id', sellerIds) : { data: [] as SellerLite[] };
  const sellerOf = new Map<number, SellerLite>(((sellers ?? []) as SellerLite[]).map((s) => [s.id, s]));

  for (const row of rows) {
    const now = iso(new Date());
    try {
      const ours = writableFor(row, writable);

      // A delete: take the event down (Google tells the guests), then purge.
      // On a mirror only the local copy goes: the meeting is the member's, and
      // CLOZR removing it from their calendar — mailing the guests on the way
      // — is not a thing a CRM gets to do.
      if (row.deleted_at) {
        if (ours && row.google_event_id) {
          const cal = row.google_calendar_id ?? calendarId;
          try { await api(accessToken, evUrl(cal, row.google_event_id, { sendUpdates: 'all' }), { method: 'DELETE' }); }
          catch (err) { if (!(err instanceof GoogleError && (err.status === 404 || err.status === 410))) throw err; }
        }
        await admin.from('appointments').delete().eq('id', row.id);
        out.removed++;
        continue;
      }

      // A pending edit to a mirror has nowhere to go. Parking it out of
      // 'pending' is what keeps the row alive: the pull skips anything pending
      // (the CRM's unsent edit wins, because the push is about to carry it),
      // so a mirror left pending would never push and never pull again. As
      // 'error' it takes Google's next change normally. Stamping last_synced_at
      // is also what stops migration 35's trigger putting it straight back to
      // pending — that trigger fires on every write that does not.
      if (!ours) {
        await admin.from('appointments').update({
          sync_state: 'error', sync_error: MIRROR_NOTE, last_synced_at: now,
        }).eq('id', row.id);
        out.skipped++;
        continue;
      }

      const body = eventBody(row, row.seller_id ? sellerOf.get(row.seller_id) ?? null : null, origin);
      const wantsMail = (row.attendees ?? []).length > 0;
      let ev: Any;
      if (row.google_event_id) {
        const cal = row.google_calendar_id ?? calendarId;
        try {
          // Send mail when something a guest would care about moved; a note edit is quiet.
          const prior = row.last_synced_at ? await api(accessToken, evUrl(cal, row.google_event_id)).catch(() => null) : null;
          // Compare the instant, not the text. We send `2026-09-21T17:00:00.000Z`
          // (Date.toISOString) and Google hands back `2026-09-21T10:00:00-07:00`
          // in the calendar's own zone, without milliseconds. Those two strings
          // are never equal even when they are the same moment, so a string
          // compare made `timeChanged` permanently true — every edit to an
          // appointment with guests re-mailed all of them "Updated invitation",
          // however little had changed. The line above has always claimed
          // otherwise.
          const timeChanged = !prior
            || !sameInstant(prior.start?.dateTime, body.start.dateTime)
            || prior.start?.date !== body.start.date
            || !sameInstant(prior.end?.dateTime, body.end.dateTime);
          const guestsChanged = !prior || attendeeKey(prior.attendees?.filter((a: Any) => !a.self && !a.organizer)) !== attendeeKey(row.attendees);
          const invitesAsked = !!row.invites_requested_at && (!row.last_synced_at || row.invites_requested_at > row.last_synced_at);
          const sendUpdates = wantsMail && (timeChanged || guestsChanged || invitesAsked) ? 'all' : 'none';
          ev = await api(accessToken, evUrl(cal, row.google_event_id, { sendUpdates }), { method: 'PATCH', body: JSON.stringify(body) });
          if (sendUpdates === 'all') out.invited += (row.attendees ?? []).length;
          out.updated++;
        } catch (err) {
          if (!(err instanceof GoogleError && (err.status === 404 || err.status === 410))) throw err;
          // Gone on Google's side while we still wanted it: recreate.
          ev = await api(accessToken, evUrl(calendarId, undefined, { sendUpdates: wantsMail ? 'all' : 'none' }), { method: 'POST', body: JSON.stringify(body) });
          if (wantsMail) out.invited += (row.attendees ?? []).length;
          out.created++;
        }
      } else {
        ev = await api(accessToken, evUrl(calendarId, undefined, { sendUpdates: wantsMail ? 'all' : 'none' }), { method: 'POST', body: JSON.stringify(body) });
        if (wantsMail) out.invited += (row.attendees ?? []).length;
        out.created++;
      }
      await admin.from('appointments').update({
        google_event_id: ev.id, google_calendar_id: calendarId, google_etag: ev.etag ?? null, google_updated_at: ev.updated ?? now,
        attendees: mergeAnswers(row.attendees, ev.attendees),
        sync_state: 'synced', sync_error: null, last_synced_at: now,
      }).eq('id', row.id);
    } catch (err) {
      out.failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error('appointment push failed', { id: row.id, message });
      await admin.from('appointments').update({ sync_state: 'error', sync_error: message.slice(0, 300), last_synced_at: now }).eq('id', row.id);
    }
  }
  return out;
}

// -------------------------------------------------------------------- pull
export type PullResult = { applied: number; added: number; deleted: number; full: boolean; pullFailed: number };

/** How far back and forward a full read reaches. Exported for the cleanup migration's twin. */
export const PULL_BACK_DAYS = 90;
export const PULL_FORWARD_DAYS = 400;

const windowStartMs = () => Date.now() - PULL_BACK_DAYS * 24 * HOUR;
const windowEndMs = () => Date.now() + PULL_FORWARD_DAYS * 24 * HOUR;

/** Start instant of a Google event, or NaN when it has none (a bare cancellation). */
function eventStartMs(ev: Any): number {
  const raw = ev?.start?.dateTime ?? (ev?.start?.date ? `${ev.start.date}T12:00:00Z` : null);
  return raw ? Date.parse(raw) : NaN;
}

/** True when the event sits inside the window a full read would have asked for. */
function inPullWindow(ev: Any): boolean {
  const t = eventStartMs(ev);
  if (!Number.isFinite(t)) return true; // cancellations often carry no start; keep them
  return t >= windowStartMs() && t <= windowEndMs();
}

/**
 * One read of the calendar: incremental through the stored syncToken, or a
 * full read bounded to a window around today.
 *
 * `singleEvents: true` asks Google to expand recurring events into individual
 * instances, which is what lets an appointment row stand for one meeting. With
 * a `timeMin` and no `timeMax` it expands them to the end of the recurrence —
 * which, for the weekly stand-up nobody put an end date on, is forever. One
 * workspace had 1,349 of its 1,486 appointments produced this way: two weekly
 * meetings, expanded 52 rows a year out to 2054, burying the real ones.
 *
 * So a full read is bounded at both ends. The window is inherited by the
 * syncToken Google returns, so every later incremental read stays inside it,
 * and a meeting set more than ~13 months out is not carried until the next
 * full read reaches it. That is the trade for a calendar that is mostly real
 * appointments.
 *
 * A syncToken minted before the window existed can return instances outside
 * it. Those are dropped before any database work and the cursor is kept.
 * Forcing another full read in the same pass was the CPU spike (status 546)
 * that stopped Gmail from running.
 */
async function listChanges(accessToken: string, calendarId: string, syncToken: string | null): Promise<{ items: Any[]; nextSyncToken: string | null; full: boolean }> {
  const run = async (full: boolean, token: string | null): Promise<{ items: Any[]; nextSyncToken: string | null; full: boolean }> => {
    const items: Any[] = [];
    let pageToken: string | null = null;
    let nextSyncToken: string | null = null;
    let isFull = full;
    for (let guard = 0; guard < 40; guard++) {
      const q: Record<string, string> = { maxResults: '250', showDeleted: 'true', singleEvents: 'true' };
      if (pageToken) q.pageToken = pageToken;
      else if (!isFull && token) q.syncToken = token;
      else {
        isFull = true;
        // timeMin and timeMax are only accepted on a full read — Google rejects
        // either alongside a syncToken.
        q.timeMin = iso(new Date(windowStartMs()));
        q.timeMax = iso(new Date(windowEndMs()));
      }
      let page: Any;
      try {
        page = await api(accessToken, evUrl(calendarId, undefined, q));
      } catch (err) {
        // 410: the token is too old. Start over with a full read.
        if (err instanceof GoogleError && err.status === 410 && !isFull) {
          isFull = true;
          pageToken = null;
          items.length = 0;
          token = null;
          continue;
        }
        throw err;
      }
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken ?? null;
      if (!pageToken) { nextSyncToken = page.nextSyncToken ?? null; break; }
    }
    return { items, nextSyncToken, full: isFull };
  };

  let result = await run(!syncToken, syncToken);
  if (!result.full) {
    const outside = result.items.reduce((n, ev) => n + (inPullWindow(ev) ? 0 : 1), 0);
    // A recurring-series edit comes back as every instance, including ones
    // past timeMax. Dropping those (pullFeed already does) and keeping the
    // cursor is the whole fix. Restarting as a bounded full read in the same
    // isolate re-listed the calendar and burned the CPU budget before Gmail
    // ran — HTTP 546, and last_gmail_sync_at never moved.
    if (outside > 50) {
      console.error('calendar incremental skipped out-of-window instances', { calendarId, outside, total: result.items.length });
    }
  }
  return result;
}

/** Every enabled feed, read one after another into the same result. */
export async function pullAppointments(admin: SupabaseClient, account: Account, accessToken: string, feeds: Feed[] = []): Promise<PullResult> {
  const out: PullResult = { applied: 0, added: 0, deleted: 0, full: false, pullFailed: 0 };
  const list = feeds.length
    ? feeds
    // Migration 74 not applied here: read the one calendar, exactly as before.
    : (account.calendar_id ? [{ calendar_id: account.calendar_id, summary: null, writable: true, enabled: true, sync_token: account.sync_token }] : []);
  for (const feed of list) {
    try {
      await pullFeed(admin, account, accessToken, feed, out);
    } catch (err) {
      out.pullFailed++;
      console.error('calendar feed read failed', { account: account.id, calendar: feed.calendar_id, err: String(err) });
      await admin.from('google_calendar_feeds')
        .update({ last_error: String(err).slice(0, 300) })
        .eq('account_id', account.id).eq('calendar_id', feed.calendar_id);
    }
  }
  return out;
}

async function pullFeed(admin: SupabaseClient, account: Account, accessToken: string, feed: Feed, out: PullResult): Promise<void> {
  const calendarId = feed.calendar_id;
  const ws = account.workspace_id;

  const { items, nextSyncToken, full } = await listChanges(accessToken, calendarId, feed.sync_token);
  if (full) out.full = true;

  // Drop far-future / far-past instances before any database work. A cancelled
  // event keeps its place so a junk row we already stored can still be purged.
  const work = items.filter((ev) => ev.status === 'cancelled' || inPullWindow(ev));
  const skipped = items.length - work.length;
  if (skipped > 0) console.error('calendar pull skipped out-of-window events', { calendarId, skipped, kept: work.length });

  // One round-trip per 200 ids instead of one per event: the CPU death spiral
  // that produced status 546 was thousands of select-by-google_event_id calls.
  const byEventId = new Map<string, ApptRow>();
  const ids = work.map((ev) => String(ev.id ?? '')).filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from('appointments').select(APPT).eq('workspace_id', ws).in('google_event_id', ids.slice(i, i + 200));
    for (const r of (data ?? []) as ApptRow[]) if (r.google_event_id) byEventId.set(r.google_event_id, r);
  }
  // Legacy rows stamped before google_event_id was written, keyed by clozr_id.
  const legacyIds = work
    .filter((ev) => !byEventId.has(String(ev.id ?? '')) && ev.extendedProperties?.private?.clozr_source === 'appointment')
    .map((ev) => Number(ev.extendedProperties.private.clozr_id))
    .filter((id) => Number.isFinite(id));
  const byLegacyId = new Map<number, ApptRow>();
  if (legacyIds.length) {
    for (let i = 0; i < legacyIds.length; i += 200) {
      const { data } = await admin.from('appointments').select(APPT).eq('workspace_id', ws).in('id', legacyIds.slice(i, i + 200)).is('google_event_id', null);
      for (const r of (data ?? []) as ApptRow[]) byLegacyId.set(r.id, r);
    }
  }

  for (const ev of work) {
    try {
      const props = ev.extendedProperties?.private ?? {};
      // A task's reminder: only its date is ours to follow.
      if (props.clozr_source === 'task') {
        const id = Number(props.clozr_id);
        const start = ev.start?.dateTime ?? null;
        if (ev.status !== 'cancelled' && Number.isFinite(id) && start) {
          const { data: row } = await admin.from('tasks').select('id, due_at').eq('id', id).eq('workspace_id', ws).maybeSingle();
          if (row && (!row.due_at || new Date(row.due_at).getTime() !== new Date(start).getTime())) {
            await admin.from('tasks').update({ due_at: new Date(start).toISOString() }).eq('id', id);
            out.applied++;
          }
        }
        continue;
      }

      let r: ApptRow | null = byEventId.get(String(ev.id ?? '')) ?? null;
      if (!r && props.clozr_source === 'appointment' && Number.isFinite(Number(props.clozr_id))) {
        r = byLegacyId.get(Number(props.clozr_id)) ?? null;
      }
      const now = iso(new Date());

      if (ev.status === 'cancelled') {
        if (r) { await admin.from('appointments').delete().eq('id', r.id); out.deleted++; }
        continue;
      }

      // Outside the window and not a cancellation of a known row: already
      // filtered above, but keep the guard so a future change cannot reintroduce it.
      if (!inPullWindow(ev)) continue;

      const allDay = !!ev.start?.date && !ev.start?.dateTime;
      const start = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T12:00:00Z` : null);
      const end = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T12:00:00Z` : null);
      if (!start) continue;
      // An all-day event's end is the day after; the row keeps the last day.
      const endsAt = allDay && end ? new Date(new Date(end).getTime() - 24 * HOUR).toISOString() : (end ? new Date(end).toISOString() : null);

      if (r) {
        if (r.deleted_at) continue; // being deleted from our side; the push will finish it
        const theirs = ev.updated ? new Date(ev.updated).getTime() : 0;
        const ours = r.google_updated_at ? new Date(r.google_updated_at).getTime() : 0;
        if (r.sync_state === 'pending') continue; // our unsent edit wins; the push carries it over
        if (theirs <= ours && r.google_etag === ev.etag) continue;
        await admin.from('appointments').update({
          title: String(ev.summary ?? r.title ?? 'Appointment').slice(0, 300),
          starts_at: new Date(start).toISOString(),
          ends_at: endsAt,
          all_day: allDay,
          location: ev.location ? String(ev.location).slice(0, 500) : r.location,
          notes: stripOurFooter(ev.description, r.notes),
          attendees: mergeAnswers(r.attendees, ev.attendees),
          google_event_id: ev.id, google_calendar_id: calendarId, google_etag: ev.etag ?? null, google_updated_at: ev.updated ?? now,
          sync_state: 'synced', sync_error: null, last_synced_at: now,
        }).eq('id', r.id);
        out.applied++;
      } else {
        // Made on Google: it becomes an appointment here. `google_calendar_id`
        // records which calendar, which is what tells the push later whether
        // this row is CLOZR's to write to or a mirror it must not touch.
        const { error } = await admin.from('appointments').insert({
          workspace_id: ws,
          title: String(ev.summary ?? 'Appointment').slice(0, 300),
          kind: props.clozr_kind ?? guessKind(ev.summary),
          starts_at: new Date(start).toISOString(),
          ends_at: endsAt,
          all_day: allDay,
          location: ev.location ? String(ev.location).slice(0, 500) : null,
          notes: stripOurFooter(ev.description, null),
          attendees: mergeAnswers([], ev.attendees),
          created_by: account.user_id, assigned_to: account.user_id,
          source: 'google',
          google_event_id: ev.id, google_calendar_id: calendarId, google_etag: ev.etag ?? null, google_updated_at: ev.updated ?? now,
          sync_state: 'synced', last_synced_at: now,
        });
        if (error) throw error;
        out.added++;
      }
    } catch (err) {
      out.pullFailed++;
      console.error('appointment pull failed', { event: ev?.id, err: String(err) });
    }
  }

  // Far-future junk left by an earlier unbounded sync: drop it in the same
  // pass so the calendar screen stops showing meetings from 2035. Only mirrors
  // (source=google) — never a row CLOZR created and pushed.
  const { data: junk, error: junkErr } = await admin.from('appointments').select('id')
    .eq('workspace_id', ws).eq('source', 'google').eq('google_calendar_id', calendarId)
    .gt('starts_at', iso(new Date(windowEndMs())));
  if (junkErr) console.error('far-future cleanup skipped', junkErr.message);
  else if (junk?.length) {
    const junkIds = junk.map((r: Any) => r.id as number);
    for (let i = 0; i < junkIds.length; i += 200) {
      await admin.from('appointments').delete().in('id', junkIds.slice(i, i + 200));
    }
    out.deleted += junkIds.length;
  }

  const { error } = await admin.from('google_calendar_feeds').update({
    ...(nextSyncToken ? { sync_token: nextSyncToken } : {}),
    ...(full ? { last_full_sync_at: iso(new Date()) } : {}),
    last_error: null,
  }).eq('account_id', account.id).eq('calendar_id', calendarId);
  // Migration 74 not applied here. The cursor still has to be kept somewhere,
  // or every run is a full read: put it back where it used to live. Only the
  // account's own calendar is read in that state, so one column still fits.
  if (error && nextSyncToken && calendarId === account.calendar_id) {
    await admin.from('google_accounts').update({ sync_token: nextSyncToken }).eq('id', account.id);
  }
}

/** Our push writes "who — address", the notes, and the CLOZR link into the description; only the notes belong back in the row. */
function stripOurFooter(description: unknown, fallback: string | null): string | null {
  if (typeof description !== 'string') return fallback;
  const parts = description.split(/\n\n+/).map((s) => s.trim()).filter((s) => s && !/\/clozr\/?$/.test(s));
  if (!parts.length) return null;
  // The first block is the seller line when it matches "Name — address"; the notes follow.
  const body = parts.length > 1 && / — /.test(parts[0]) ? parts.slice(1) : parts;
  return body.join('\n\n').slice(0, 4000) || null;
}

// ------------------------------------------------------------------- tasks
type Ev = { summary: string; description: string; start: string; end: string };
const enc = new TextEncoder();
async function fingerprint(o: unknown): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(o)));
  return Array.from(new Uint8Array(bits)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Open dated tasks from the last month forward, one-way, through
 * google_event_links exactly as before. Links left over from appointments
 * (which now carry their own event) are removed with their events, so a
 * calendar that held a copy of every rep's appointments is tidied up.
 */
export async function pushTasks(admin: SupabaseClient, account: Account, accessToken: string, origin: string): Promise<{ created: number; updated: number; removed: number }> {
  const calendarId = account.calendar_id;
  if (!calendarId) return { created: 0, updated: 0, removed: 0 };
  const ws = account.workspace_id;
  const since = iso(new Date(Date.now() - 30 * 24 * HOUR));
  const [{ data: tasks }, { data: links }] = await Promise.all([
    admin.from('tasks').select('id, title, task_type, due_at, done, seller_id').eq('workspace_id', ws).eq('done', false).not('due_at', 'is', null).gte('due_at', since),
    admin.from('google_event_links').select('id, source, source_id, event_id, pushed').eq('account_id', account.id),
  ]);
  // Only the sellers these tasks name. The whole workspace (13,000 rows) was
  // read on every calendar pass and PostgREST cut it at 1,000, so most task
  // events went out without the seller's name.
  const sellerIds = [...new Set(((tasks ?? []) as Any[]).map((t) => t.seller_id).filter((x) => x != null))];
  const { data: sellers } = sellerIds.length
    ? await admin.from('sellers').select('id, name, property_address').in('id', sellerIds)
    : { data: [] as Any[] };
  const who = new Map((sellers ?? []).map((s: Any) => [s.id, s]));
  const linkOf = new Map((links ?? []).map((l: Any) => [`${l.source}:${l.source_id}`, l]));

  const want = new Map<string, Ev>();
  for (const t of (tasks ?? []) as Any[]) {
    const s = t.seller_id ? who.get(t.seller_id) : null;
    want.set(`task:${t.id}`, {
      summary: `${t.task_type}: ${t.title}`,
      description: [s ? `${s.name}${s.property_address ? ' — ' + s.property_address : ''}` : 'CLOZR task', `${origin}/clozr/`].join('\n\n'),
      start: new Date(t.due_at).toISOString(),
      end: new Date(new Date(t.due_at).getTime() + 30 * 60_000).toISOString(),
    });
  }

  let created = 0, updated = 0, removed = 0;
  for (const [key, ev] of want) {
    const link = linkOf.get(key);
    const print = await fingerprint(ev);
    if (link && link.pushed === print) continue;
    const body = {
      summary: ev.summary, description: ev.description,
      start: { dateTime: ev.start }, end: { dateTime: ev.end },
      extendedProperties: { private: { clozr: '1', clozr_source: 'task', clozr_id: key.slice(5), clozr_ws: String(ws) } },
      source: { title: 'Open in CLOZR', url: `${origin}/clozr/` },
      status: 'confirmed',
    };
    try {
      if (link) {
        await api(accessToken, evUrl(calendarId, link.event_id), { method: 'PATCH', body: JSON.stringify(body) });
        await admin.from('google_event_links').update({ pushed: print }).eq('id', link.id);
        updated++;
      } else {
        const made = await api(accessToken, evUrl(calendarId), { method: 'POST', body: JSON.stringify(body) });
        await admin.from('google_event_links').insert({ account_id: account.id, source: 'task', source_id: Number(key.slice(5)), event_id: made.id, pushed: print });
        created++;
      }
    } catch (err) {
      if (err instanceof GoogleError && err.status === 404 && link) await admin.from('google_event_links').delete().eq('id', link.id);
      else console.error('task push failed', { key, err: String(err) });
    }
  }
  for (const [key, link] of linkOf) {
    if (want.has(key)) continue;
    await api(accessToken, evUrl(calendarId, link.event_id), { method: 'DELETE' }).catch(() => null);
    await admin.from('google_event_links').delete().eq('id', link.id);
    removed++;
  }
  return { created, updated, removed };
}
