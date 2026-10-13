-- 35 — the calendar, two-way.
--
-- Migration 33 mapped an appointment to its Google event through
-- google_event_links, one link per connected account, and pushed every
-- appointment in the workspace into every connected calendar. That made a
-- change on Google's side ambiguous (which copy wins?) and left nowhere to
-- keep what Google knows that we do not: the attendees and their answers, the
-- etag, when Google last touched it.
--
-- An appointment now belongs to one Google event, on the calendar of the rep
-- it belongs to (assigned_to, else whoever created it, else the first
-- connected account in the workspace). The row itself carries the mapping:
--
--   google_event_id / google_calendar_id   which event, in which calendar
--   google_etag / google_updated_at        what Google last told us, so a pull
--                                          can tell "newer on Google" from
--                                          "the copy we just wrote"
--   attendees                              [{email, name, role, status}] —
--                                          who is invited and what they said;
--                                          Google sends the invitation emails
--                                          when the event is pushed
--   sync_state                             pending | synced | error. Any edit
--                                          that does not come from the sync
--                                          flips it back to pending (trigger
--                                          below), which is what the push
--                                          looks for.
--   deleted_at                             a soft delete: the row stays until
--                                          the sync has removed the Google
--                                          event, then it is purged. Deleting
--                                          the event on Google removes the row
--                                          here, so a delete goes both ways.
--   assigned_to                            whose calendar it is on, and whose
--                                          colour it gets
--   all_day / source / invites_requested_at bookkeeping for the same
--
-- Tasks keep using google_event_links: a due task is a reminder on the
-- calendar, not a meeting, and nobody is invited to it.

alter table public.appointments
  add column if not exists assigned_to          uuid references auth.users(id) on delete set null,
  add column if not exists attendees            jsonb not null default '[]'::jsonb,
  add column if not exists all_day              boolean not null default false,
  add column if not exists source               text not null default 'clozr' check (source in ('clozr','google')),
  add column if not exists google_event_id      text,
  add column if not exists google_calendar_id   text,
  add column if not exists google_etag          text,
  add column if not exists google_updated_at    timestamptz,
  add column if not exists sync_state           text not null default 'pending' check (sync_state in ('pending','synced','error')),
  add column if not exists sync_error           text,
  add column if not exists last_synced_at       timestamptz,
  add column if not exists invites_requested_at timestamptz,
  add column if not exists deleted_at           timestamptz;

-- Attendees are a list of objects and nothing else; the columns above are
-- plain text, so this is the one shape worth pinning.
alter table public.appointments drop constraint if exists appointments_attendees_is_array;
alter table public.appointments add constraint appointments_attendees_is_array
  check (jsonb_typeof(attendees) = 'array');

create index if not exists appointments_ws_starts_idx on public.appointments (workspace_id, starts_at);
create index if not exists appointments_ws_seller_idx on public.appointments (workspace_id, seller_id);
create index if not exists appointments_assigned_idx  on public.appointments (assigned_to);
-- One Google event maps to one row. Nulls are distinct, so unsynced rows are free.
create unique index if not exists appointments_google_event_idx
  on public.appointments (workspace_id, google_event_id);
-- What the push scans: everything not yet level with Google.
create index if not exists appointments_pending_idx
  on public.appointments (workspace_id) where sync_state <> 'synced' or deleted_at is not null;

-- ----------------------------------------------------- mark edits as pending
-- Every write to the columns Google cares about marks the row pending, unless
-- the write is the sync's own (it always stamps last_synced_at, and nothing
-- else does). This keeps the rule in one place: the app never has to remember
-- to set sync_state, and a row changed by hand in the dashboard syncs too.
create or replace function public.appointments_mark_pending()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_synced_at is not distinct from old.last_synced_at
     and (new.title, new.kind, new.starts_at, new.ends_at, new.location, new.notes,
          new.attendees, new.all_day, new.deleted_at, new.assigned_to, new.seller_id, new.buyer_id)
         is distinct from
         (old.title, old.kind, old.starts_at, old.ends_at, old.location, old.notes,
          old.attendees, old.all_day, old.deleted_at, old.assigned_to, old.seller_id, old.buyer_id)
  then
    new.sync_state := 'pending';
    new.sync_error := null;
  end if;
  return new;
end
$$;
revoke all on function public.appointments_mark_pending() from public, anon, authenticated;

drop trigger if exists appointments_mark_pending on public.appointments;
create trigger appointments_mark_pending before update on public.appointments
  for each row execute function public.appointments_mark_pending();

-- ------------------------------------------------ carry the old links over
-- Where an appointment already has an event on its owner's calendar, that
-- event becomes the row's own. Links to other accounts' copies are left for
-- the sync, which deletes an event it no longer wants and drops the link.
update public.appointments a
set google_event_id    = l.event_id,
    google_calendar_id = g.calendar_id,
    assigned_to        = coalesce(a.assigned_to, a.created_by)
from public.google_event_links l
join public.google_accounts g on g.id = l.account_id
where l.source = 'appointment'
  and l.source_id = a.id
  and g.workspace_id = a.workspace_id
  and g.user_id = coalesce(a.assigned_to, a.created_by)
  and a.google_event_id is null;

delete from public.google_event_links l
using public.appointments a
where l.source = 'appointment' and l.source_id = a.id and l.event_id = a.google_event_id;

-- ---------------------------------------------------------------- realtime
-- The calendar screen subscribes to changes on appointments and tasks so a
-- teammate's booking, or a pull from Google, appears without a reload. The
-- publication is Supabase's; it carries nothing until a table is added.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments') then
    alter publication supabase_realtime add table public.appointments;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end
$$;
-- Realtime filters on the row, so RLS still decides who sees a change; the
-- tables already have workspace-member policies.
alter table public.appointments replica identity full;
alter table public.tasks replica identity full;
