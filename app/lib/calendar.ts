// The calendar: appointments and due tasks for a workspace, read as one list
// of events, written back as appointments, and kept live.
//
// Appointments are the CRM's; Google is a mirror of them (lib/google.ts and
// the google-sync function). Everything written here lands in `appointments`
// with sync_state 'pending' — the trigger from migration 35 sees to that — and
// nudgeGoogle() asks the sync to push it now rather than on the next app open.
// Google's own side of the conversation (invitations, replies, edits made on a
// phone, deletes) comes back through the same sync and shows up here through
// the realtime channel in useCalendar.
'use client';

import { isFridayIso, localIsoDay } from './deal-close';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase';
import { nudgeGoogle } from './google';
import type { Appointment, Attendee, TaskRow } from './database.types';
import { listTeam, type Teammate } from './team';

// ------------------------------------------------------------------ types
/** The five things the filter bar can show or hide. */
export type EventType = 'appointment' | 'walkthrough' | 'closing' | 'call' | 'task';

export const EVENT_TYPES: { key: EventType; label: string; color: string; kind: string }[] = [
  { key: 'appointment', label: 'Appointment', color: '#16a34a', kind: 'Appointment' },
  { key: 'walkthrough', label: 'Walkthrough', color: '#0A8560', kind: 'Walkthrough' },
  { key: 'closing', label: 'Closing', color: '#d97706', kind: 'Closing' },
  { key: 'call', label: 'Call', color: '#2563eb', kind: 'Call' },
  { key: 'task', label: 'Task due', color: '#71717a', kind: 'Task' },
];

/** `appointments.kind` is free text (the quick-add offers a few); this is how it lands in a filter. */
export function typeOfKind(kind: string | null | undefined): EventType {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('walk') || k.includes('inspect') || k.includes('showing')) return 'walkthrough';
  if (k.includes('clos') || k.includes('sign')) return 'closing';
  if (k.includes('call') || k.includes('phone')) return 'call';
  if (k.includes('task')) return 'task';
  return 'appointment';
}

export const typeColor = (t: EventType) => EVENT_TYPES.find((e) => e.key === t)?.color ?? '#16a34a';

/** One colour per rep, stable for the life of the roster order. */
export const REP_COLORS = ['#0A8560', '#2563eb', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#ea580c', '#4f46e5', '#b45309'];

export type Rep = Teammate & { color: string; initials: string };

export type CalEvent = {
  /** 'a12' for appointment 12, 't5' for task 5 — the keys the grid renders by. */
  id: string;
  /** deal: a deal's own close date (deals.close_date), read-only here; it is edited on the deal sheet. */
  source: 'appointment' | 'task' | 'deal';
  dbId: number;
  title: string;
  type: EventType;
  kind: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Whose calendar it sits on: assigned_to, else created_by. */
  repId: string | null;
  sellerId: number | null;
  buyerId: number | null;
  sellerName: string | null;
  address: string | null;
  notes: string | null;
  attendees: Attendee[];
  syncState: Appointment['sync_state'] | null;
  googleEventId: string | null;
  fromGoogle: boolean;
  /** Which Google calendar it lives on, when it lives on one. */
  calendarId: string | null;
  /**
   * A mirror of one of the member's own calendars. CLOZR reads those and never
   * writes to them, so editing it here would be reverted by the next sync and
   * deleting it here would ask Google to cancel a real meeting and mail every
   * guest. Neither is offered.
   */
  readOnly: boolean;
  done?: boolean;
  /** A deal closing on a Friday, which the SOP does not allow without a reason. */
  friday?: boolean;
  /** The deal a closing belongs to. */
  dealId?: number;
};

export type EventDraft = {
  title: string;
  kind: string;
  starts_at: string;
  ends_at: string;
  all_day?: boolean;
  location?: string | null;
  notes?: string | null;
  seller_id?: number | null;
  buyer_id?: number | null;
  assigned_to?: string | null;
  attendees?: Attendee[];
};

export type WriteResult = { ok: true; id: number } | { ok: false; message: string };

// ------------------------------------------------------------------ dates
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
/** Weeks start on Sunday, as the rest of CLOZR's date strings assume. */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay());
export const startOfMonth = (d: Date) => { const x = startOfDay(d); x.setDate(1); return x; };
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isToday = (d: Date) => sameDay(d, new Date());

/** The six rows of a month grid, Sunday to Saturday, always 42 days. */
export function monthGrid(month: Date): Date[] {
  const first = startOfWeek(startOfMonth(month));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined }).replace(' ', '').toLowerCase();
export const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtMonth = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export function fmtSpan(ev: Pick<CalEvent, 'start' | 'end' | 'allDay'>): string {
  if (ev.allDay) return 'All day';
  return `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
}

/** yyyy-mm-ddThh:mm in local time, what <input type="datetime-local"> wants. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local time from a datetime-local value. */
export const fromLocalInput = (s: string) => new Date(s);

export const overlaps = (ev: Pick<CalEvent, 'start' | 'end'>, from: Date, to: Date) => ev.start < to && ev.end > from;

// ----------------------------------------------------------------- loaders
type SellerLite = { id: number; name: string; property_address: string | null; email: string | null; phone: string | null };

function fromAppointment(a: Appointment, sellers: Map<number, SellerLite>, ours: ReadonlySet<string>): CalEvent {
  const s = a.seller_id ? sellers.get(a.seller_id) : null;
  const start = new Date(a.starts_at);
  const end = a.ends_at ? new Date(a.ends_at) : new Date(start.getTime() + HOUR);
  return {
    id: `a${a.id}`, source: 'appointment', dbId: a.id,
    title: a.title, type: typeOfKind(a.kind), kind: a.kind,
    start, end: end > start ? end : new Date(start.getTime() + 30 * 60_000),
    allDay: !!a.all_day,
    repId: a.assigned_to ?? a.created_by ?? null,
    sellerId: a.seller_id, buyerId: a.buyer_id,
    sellerName: s?.name ?? null,
    address: a.location ?? s?.property_address ?? null,
    notes: a.notes,
    attendees: Array.isArray(a.attendees) ? a.attendees : [],
    syncState: a.sync_state ?? null,
    googleEventId: a.google_event_id ?? null,
    fromGoogle: a.source === 'google',
    calendarId: a.google_calendar_id ?? null,
    readOnly: !!a.google_calendar_id && !ours.has(a.google_calendar_id),
  };
}

function fromTask(t: TaskRow, sellers: Map<number, SellerLite>): CalEvent {
  const s = t.seller_id ? sellers.get(t.seller_id) : null;
  const start = new Date(t.due_at as string);
  return {
    id: `t${t.id}`, source: 'task', dbId: t.id,
    title: t.title, type: 'task', kind: t.task_type,
    start, end: new Date(start.getTime() + 30 * 60_000), allDay: false,
    repId: t.assigned_to ?? t.created_by ?? null,
    sellerId: t.seller_id, buyerId: null,
    sellerName: s?.name ?? null,
    address: s?.property_address ?? null,
    notes: t.notes, attendees: [], syncState: null, googleEventId: null, fromGoogle: false,
    calendarId: null, readOnly: false,
    done: t.done,
  };
}

type DealCloseRow = { id: number; seller_id: number | null; close_date: string; stage: string; owner_id: string | null; tc_rep_id: string | null; properties: { line1: string | null } | null };

/** A deal's close date as an all-day Closing on the calendar, on the TC's calendar (else the owner's). */
function fromDealClose(d: DealCloseRow, sellers: Map<number, SellerLite>): CalEvent {
  const s = d.seller_id ? sellers.get(d.seller_id) : null;
  const start = new Date(d.close_date.slice(0, 10) + 'T00:00:00');
  const address = d.properties?.line1 ?? s?.property_address ?? null;
  const friday = isFridayIso(d.close_date);
  return {
    id: `c${d.id}`, source: 'deal', dbId: d.id, dealId: d.id,
    title: `Closing · ${address ?? 'Deal ' + d.id}${friday ? ' · Friday' : ''}`, type: 'closing', kind: d.stage === 'Closed' ? 'Closed' : 'Scheduled close',
    start, end: addDays(start, 1), allDay: true,
    repId: d.tc_rep_id ?? d.owner_id ?? null,
    sellerId: d.seller_id, buyerId: null, sellerName: s?.name ?? null, address,
    notes: null,
    attendees: [], syncState: null, googleEventId: null, fromGoogle: false, calendarId: null, readOnly: false, friday,
  };
}

const APPT_COLS = 'id, workspace_id, seller_id, property_id, buyer_id, title, kind, starts_at, ends_at, location, notes, created_by, created_at, updated_at, assigned_to, attendees, all_day, source, google_event_id, google_calendar_id, google_etag, google_updated_at, sync_state, sync_error, last_synced_at, invites_requested_at, deleted_at';

/**
 * The calendars CLOZR writes to in this workspace: each connection's own, the
 * one `ensureCalendar` made inside that member's Google account.
 *
 * Everything else CLOZR shows from Google — the member's primary above all —
 * is a mirror it reads and never writes to (migration 74). Appointments
 * written before that split carry the literal `'primary'` here, which is not
 * in this set either, and correctly so: they point at real events on a real
 * calendar.
 */
export async function ownCalendars(workspaceId: number): Promise<Set<string>> {
  if (!supabase) return new Set<string>();
  const { data } = await supabase.from('google_accounts').select('calendar_id').eq('workspace_id', workspaceId);
  return new Set(((data ?? []) as { calendar_id: string | null }[]).map((r) => r.calendar_id).filter((c): c is string => !!c));
}

/** What the panel says instead of offering Edit and Delete. */
export const MIRROR_NOTE = 'This event lives on your own Google calendar. CLOZR shows it and never writes to it — change it in Google Calendar.';

async function sellersFor(workspaceId: number, ids: number[]): Promise<Map<number, SellerLite>> {
  const map = new Map<number, SellerLite>();
  if (!supabase || !ids.length) return map;
  const { data } = await supabase.from('sellers').select('id, name, property_address, email, phone').eq('workspace_id', workspaceId).in('id', Array.from(new Set(ids)));
  for (const s of (data ?? []) as SellerLite[]) map.set(s.id, s);
  return map;
}

/** Everything on the calendar between two instants, every rep. */
export async function loadCalendar(workspaceId: number, from: Date, to: Date): Promise<{ ok: boolean; events: CalEvent[]; message?: string }> {
  if (!supabase) return { ok: false, events: [], message: 'Supabase is not configured.' };
  const [a, t, dc] = await Promise.all([
    supabase.from('appointments').select(APPT_COLS).eq('workspace_id', workspaceId).is('deleted_at', null)
      .lt('starts_at', to.toISOString()).gte('starts_at', addDays(from, -1).toISOString()).order('starts_at'),
    supabase.from('tasks').select('id, workspace_id, seller_id, deal_id, title, task_type, priority, due_at, assigned_to, done, completed_at, created_by, created_at, updated_at, notes, enrollment_id, plan_step_id')
      .eq('workspace_id', workspaceId).not('due_at', 'is', null).gte('due_at', from.toISOString()).lt('due_at', to.toISOString()).order('due_at'),
    // Every live deal's scheduled close (and the closed ones in range), straight from deals.close_date:
    // a closing no longer needs an appointment whose kind says "clos" to show up.
    supabase.from('deals').select('id, seller_id, close_date, stage, owner_id, tc_rep_id, properties(line1)')
      .eq('workspace_id', workspaceId).is('archived_at', null).not('close_date', 'is', null).not('stage', 'in', '("Prospect","Terminated")')
      .gte('close_date', localIsoDay(addDays(from, -1))).lt('close_date', localIsoDay(addDays(to, 1))).order('close_date').limit(500),
  ]);
  if (a.error) return { ok: false, events: [], message: a.error.message };
  const appts = (a.data ?? []) as unknown as Appointment[];
  const tasks = (t.data ?? []) as unknown as TaskRow[];
  const closes = (dc.error ? [] : dc.data ?? []) as unknown as DealCloseRow[];
  const [sellers, ours] = await Promise.all([
    sellersFor(workspaceId, [...appts, ...tasks, ...closes].map((r) => r.seller_id).filter((x): x is number => x != null)),
    ownCalendars(workspaceId),
  ]);
  // A closing already booked as an appointment that day for the same seller is shown once, as the appointment.
  // Keyed by both the local day and the stored (UTC) date: an all-day appointment saved at UTC
  // midnight reads as the day before in US time, and either one is the same closing.
  const booked = new Set(appts.filter((r) => typeOfKind(r.kind) === 'closing' && r.seller_id != null)
    .flatMap((r) => [`${r.seller_id}:${localIsoDay(new Date(r.starts_at))}`, `${r.seller_id}:${String(r.starts_at).slice(0, 10)}`]));
  const unbooked = closes.filter((d) => d.seller_id == null || !booked.has(`${d.seller_id}:${d.close_date.slice(0, 10)}`));
  const events = [...appts.map((r) => fromAppointment(r, sellers, ours)), ...tasks.map((r) => fromTask(r, sellers)), ...unbooked.map((r) => fromDealClose(r, sellers))]
    .filter((ev) => overlaps(ev, from, to))
    .sort((x, y) => x.start.getTime() - y.start.getTime());
  return { ok: true, events };
}

/** One seller's appointments, past and future, newest future first. */
export async function loadSellerCalendar(workspaceId: number, sellerId: number): Promise<{ ok: boolean; events: CalEvent[]; message?: string }> {
  if (!supabase) return { ok: false, events: [], message: 'Supabase is not configured.' };
  const { data, error } = await supabase.from('appointments').select(APPT_COLS)
    .eq('workspace_id', workspaceId).eq('seller_id', sellerId).is('deleted_at', null).order('starts_at', { ascending: false }).limit(200);
  if (error) return { ok: false, events: [], message: error.message };
  const appts = (data ?? []) as unknown as Appointment[];
  const [sellers, ours] = await Promise.all([sellersFor(workspaceId, [sellerId]), ownCalendars(workspaceId)]);
  return { ok: true, events: appts.map((r) => fromAppointment(r, sellers, ours)) };
}

// ----------------------------------------------------------------- writers
const cleanAttendees = (list: Attendee[] | undefined): Attendee[] => {
  const seen = new Set<string>();
  const out: Attendee[] = [];
  for (const a of list ?? []) {
    const email = String(a.email ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: a.name?.trim() || null, role: a.role ?? 'other', status: a.status ?? 'needsAction' });
  }
  return out;
};

export async function createCalendarEvent(workspaceId: number, d: EventDraft, userId: string | null): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const attendees = cleanAttendees(d.attendees);
  const { data, error } = await supabase.from('appointments').insert({
    workspace_id: workspaceId,
    title: d.title.trim() || d.kind || 'Appointment',
    kind: d.kind || 'Appointment',
    starts_at: d.starts_at,
    ends_at: d.ends_at,
    all_day: !!d.all_day,
    location: d.location?.trim() || null,
    notes: d.notes?.trim() || null,
    seller_id: d.seller_id ?? null,
    buyer_id: d.buyer_id ?? null,
    assigned_to: d.assigned_to ?? userId,
    created_by: userId,
    attendees,
    invites_requested_at: attendees.length ? new Date().toISOString() : null,
    sync_state: 'pending',
  }).select('id').single();
  if (error) return { ok: false, message: error.message };
  nudgeGoogle(workspaceId);
  return { ok: true, id: data.id };
}

/**
 * Refuses a write to an event CLOZR only mirrors.
 *
 * The UI already hides Edit and Delete on those, so this is the second line:
 * a stale panel, a drag on the grid, or a keyboard shortcut all come through
 * here. Letting one past is not a cosmetic bug — the sync would either revert
 * the edit on the next read, or, for a delete, ask Google to cancel a meeting
 * on the member's own calendar and mail every guest about it.
 */
async function mirrored(workspaceId: number, id: number): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('appointments').select('google_calendar_id')
    .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
  const cal = (data as { google_calendar_id: string | null } | null)?.google_calendar_id ?? null;
  if (!cal) return null;
  return (await ownCalendars(workspaceId)).has(cal) ? null : MIRROR_NOTE;
}

export async function updateCalendarEvent(workspaceId: number, id: number, patch: Partial<EventDraft>): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const blocked = await mirrored(workspaceId, id);
  if (blocked) return { ok: false, message: blocked };
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title.trim() || 'Appointment';
  if (patch.kind !== undefined) body.kind = patch.kind || 'Appointment';
  if (patch.starts_at !== undefined) body.starts_at = patch.starts_at;
  if (patch.ends_at !== undefined) body.ends_at = patch.ends_at;
  if (patch.all_day !== undefined) body.all_day = !!patch.all_day;
  if (patch.location !== undefined) body.location = patch.location?.trim() || null;
  if (patch.notes !== undefined) body.notes = patch.notes?.trim() || null;
  if (patch.seller_id !== undefined) body.seller_id = patch.seller_id;
  if (patch.buyer_id !== undefined) body.buyer_id = patch.buyer_id;
  if (patch.assigned_to !== undefined) body.assigned_to = patch.assigned_to;
  if (patch.attendees !== undefined) body.attendees = cleanAttendees(patch.attendees);
  const { error } = await supabase.from('appointments').update(body as never).eq('id', id).eq('workspace_id', workspaceId);
  if (error) return { ok: false, message: error.message };
  nudgeGoogle(workspaceId);
  return { ok: true, id };
}

/** Hidden now; the row is purged once the sync has taken the Google event down. */
export async function deleteCalendarEvent(workspaceId: number, id: number): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const blocked = await mirrored(workspaceId, id);
  if (blocked) return { ok: false, message: blocked };
  const { error } = await supabase.from('appointments').update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('workspace_id', workspaceId);
  if (error) return { ok: false, message: error.message };
  nudgeGoogle(workspaceId);
  return { ok: true, id };
}

/**
 * Invite people. The list is saved on the row and the next push sends it to
 * Google with sendUpdates=all, which is what makes Google email each of them a
 * real invitation (with the Yes / No / Maybe buttons); their answers come back
 * on the next pull. Nothing here sends mail itself.
 */
export async function requestInvites(workspaceId: number, id: number, attendees: Attendee[]): Promise<WriteResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const list = cleanAttendees(attendees);
  if (!list.length) return { ok: false, message: 'Add at least one email address.' };
  const blocked = await mirrored(workspaceId, id);
  if (blocked) return { ok: false, message: blocked };
  const { error } = await supabase.from('appointments').update({ attendees: list, invites_requested_at: new Date().toISOString() }).eq('id', id).eq('workspace_id', workspaceId);
  if (error) return { ok: false, message: error.message };
  nudgeGoogle(workspaceId);
  return { ok: true, id };
}

/** Move an event by dragging or from the panel — same write, named for the grid. */
export const moveCalendarEvent = (workspaceId: number, id: number, start: Date, end: Date) =>
  updateCalendarEvent(workspaceId, id, { starts_at: start.toISOString(), ends_at: end.toISOString() });

// -------------------------------------------------------------------- team
export const initialsOf = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2)).toUpperCase();
};

/** The roster with a colour each, the signed-in member first. */
export function useTeam(workspaceId: number | null, me: string | null): Rep[] {
  const [rows, setRows] = useState<{ key: number | null; team: Teammate[] }>({ key: null, team: [] });
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void listTeam(workspaceId).then((team) => { if (live) setRows({ key: workspaceId, team }); });
    return () => { live = false; };
  }, [workspaceId]);
  return useMemo(() => {
    const team = rows.key === workspaceId ? rows.team : [];
    const sorted = [...team].sort((a, b) => (a.user_id === me ? -1 : b.user_id === me ? 1 : 0));
    return sorted.map((t, i) => {
      const name = t.full_name || t.email?.split('@')[0] || 'Teammate';
      return { ...t, full_name: name, color: REP_COLORS[i % REP_COLORS.length], initials: initialsOf(name) };
    });
  }, [rows, workspaceId, me]);
}

// ---------------------------------------------------------------- the hook
/**
 * Events in a range, kept current. Realtime on `appointments` and `tasks`
 * for the workspace, debounced, so a teammate's booking, a Google pull or a
 * quick-add elsewhere in the app arrives without a reload. The range is
 * inclusive of `from` and exclusive of `to`.
 */
export function useCalendar(workspaceId: number | null, from: Date, to: Date, opts: { sellerId?: number | null } = {}) {
  const [state, setState] = useState<{ key: string; events: CalEvent[]; ok: boolean; loading: boolean; message?: string }>({ key: '', events: [], ok: true, loading: true });
  const [tick, setTick] = useState(0);
  const timer = useRef<number | null>(null);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const sellerId = opts.sellerId ?? null;
  const key = `${workspaceId}:${sellerId ?? ''}:${fromMs}:${toMs}`;

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const run = sellerId != null
      ? loadSellerCalendar(workspaceId, sellerId)
      : loadCalendar(workspaceId, new Date(fromMs), new Date(toMs));
    void run.then((r) => { if (live) setState({ key, events: r.events, ok: r.ok, loading: false, message: r.message }); });
    return () => { live = false; };
  }, [workspaceId, sellerId, fromMs, toMs, key, tick]);

  useEffect(() => {
    if (!workspaceId || !supabase) return;
    const bump = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setTick((n) => n + 1), 350);
    };
    const ch = supabase.channel(`calendar:${workspaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `workspace_id=eq.${workspaceId}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspaceId}` }, bump)
      .subscribe();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      void supabase?.removeChannel(ch);
    };
  }, [workspaceId]);

  // No workspace (the demo) is an empty, settled calendar — not a loading one.
  if (!workspaceId) return { events: [] as CalEvent[], loading: false, ok: true, message: undefined, reload };
  const stale = state.key !== key;
  return { events: stale ? [] : state.events, loading: stale || state.loading, ok: state.ok, message: state.message, reload };
}
