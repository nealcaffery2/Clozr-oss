-- 270 · Meeting invites with Google Meet, and calendar push notifications.
--
-- A rep sends a seller, buyer or
-- prospect a meeting from the record or mid-call: a meeting type, a time, and
-- the meeting-invite function creates the Google event on the rep's CLOZR
-- calendar with a Meet conference, then mails a designed invite from the rep's
-- Gmail and texts the time and link through Talkr.
--
-- appointments
--   meet            the event should carry a Google Meet conference. The push
--                   asks Google for one (conferenceData.createRequest) when the
--                   event has none yet.
--   meet_link       Google's hangoutLink. Written by the push and the pull; the
--                   pull keeps the stored link when Google's copy has none, so
--                   a sync never wipes it.
--   meeting_type    the meeting_types.key it was booked as.
--   invite_sent_at  when our own email / text went out (Google's invitation is
--                   separate and goes with sendUpdates=all).
--   The pending trigger (migration 35) now also watches `meet`, so turning Meet
--   on for an existing appointment pushes it.
--
-- meeting_types   per workspace, seeded with five defaults below; editable.
--
-- google_calendar_feeds.watch_*  one Google push channel per feed
--   (events.watch). google-calendar-push validates the channel id + token and
--   runs that account's calendar sync at once instead of waiting for the
--   14-minute gate. The sync renews a channel within a day of expiry.
-- google_accounts.calendar_push_at  the last push Google sent; sync_all treats
--   a push newer than the last calendar sync as due, whatever the gate says.
--
-- Additive and safe to re-run.

alter table public.appointments
  add column if not exists meet           boolean not null default false,
  add column if not exists meet_link      text,
  add column if not exists meeting_type   text,
  add column if not exists invite_sent_at timestamptz;

create or replace function public.appointments_mark_pending()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_synced_at is not distinct from old.last_synced_at
     and (new.title, new.kind, new.starts_at, new.ends_at, new.location, new.notes,
          new.attendees, new.all_day, new.deleted_at, new.assigned_to, new.seller_id, new.buyer_id, new.meet)
         is distinct from
         (old.title, old.kind, old.starts_at, old.ends_at, old.location, old.notes,
          old.attendees, old.all_day, old.deleted_at, old.assigned_to, old.seller_id, old.buyer_id, old.meet)
  then
    new.sync_state := 'pending';
    new.sync_error := null;
  end if;
  return new;
end
$$;
revoke all on function public.appointments_mark_pending() from public, anon, authenticated;

create table if not exists public.meeting_types (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  key           text not null,
  name          text not null,
  minutes       integer not null default 30 check (minutes between 5 and 480),
  title_pattern text not null default '{type} with {first_name}',
  description   text not null default '',
  sort          integer not null default 100,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, key)
);

alter table public.meeting_types enable row level security;
drop policy if exists meeting_types_select on public.meeting_types;
create policy meeting_types_select on public.meeting_types for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));
drop policy if exists meeting_types_insert on public.meeting_types;
create policy meeting_types_insert on public.meeting_types for insert to authenticated
  with check ((select public.is_workspace_member(workspace_id)));
drop policy if exists meeting_types_update on public.meeting_types;
create policy meeting_types_update on public.meeting_types for update to authenticated
  using ((select public.is_workspace_member(workspace_id)))
  with check ((select public.is_workspace_member(workspace_id)));
grant select, insert, update on public.meeting_types to authenticated;

-- The five defaults, in every workspace. Same text as DEFAULT_MEETING_TYPES in
-- supabase/functions/_shared/meeting-invite.ts. An edited row is left alone.
insert into public.meeting_types (workspace_id, key, name, minutes, title_pattern, description, sort)
select w.id, d.key, d.name, d.minutes, d.title_pattern, d.description, d.sort
from public.workspaces w
cross join (values
  ('demo', 'Demo', 30, '{company} demo with {first_name}', 'A screen share of {company}. Bring a property you are working on and we will run it together.', 10),
  ('walkthrough', 'Walkthrough', 45, 'Walkthrough of {address}', 'We go through the property together: condition, repairs and what happens next.', 20),
  ('comp_analysis', 'Comp analysis', 30, 'Comp analysis for {address}', 'We look at recent sales near the property and what they mean for the price.', 30),
  ('onboarding', 'Onboarding', 45, '{company} onboarding with {first_name}', 'We set up your account with you and get your first deal running.', 40),
  ('check_in', 'Check-in', 15, 'Check-in with {first_name}', 'A short call to see how things are going and answer your questions.', 50)
) as d(key, name, minutes, title_pattern, description, sort)
on conflict (workspace_id, key) do nothing;

alter table public.google_calendar_feeds
  add column if not exists watch_channel_id  text,
  add column if not exists watch_resource_id text,
  add column if not exists watch_token       text,
  add column if not exists watch_expires_at  timestamptz;
create unique index if not exists google_calendar_feeds_watch_channel_idx
  on public.google_calendar_feeds (watch_channel_id) where watch_channel_id is not null;

alter table public.google_accounts
  add column if not exists calendar_push_at timestamptz;
