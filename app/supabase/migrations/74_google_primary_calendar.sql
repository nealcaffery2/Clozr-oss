-- The calendar CLOZR reads is not the calendar CLOZR writes.
--
-- Migration 33 gave a connection one `calendar_id` and one `sync_token`, and
-- both directions used them. `ensureCalendar` (_shared/google.ts) creates a
-- calendar called "<Workspace> · CLOZR" inside the member's account and stores
-- its id there, for a good reason it still holds: CLOZR's own events can be
-- hidden, recoloured or unsubscribed without touching anything the member put
-- in their own calendar, and "delete the CLOZR calendar" is a clean way out.
--
-- The cost was invisible and total. Because one column served both directions,
-- pointing writes at the CLOZR calendar pointed reads there too — so from the
-- moment that calendar was created, CLOZR read a calendar that contained
-- nothing but what CLOZR had put there. The member's actual meetings, in their
-- actual calendar, were not read at all. The app showed an empty week and the
-- sync reported success, because it had in fact synced everything on the
-- calendar it was looking at.
--
-- This splits the two. A connection now has a list of calendars it READS
-- (`google_calendar_feeds`), each with its own cursor, while writes still go
-- to the one calendar CLOZR owns. The member's primary calendar is seeded as a
-- feed, read-only: CLOZR mirrors it and never creates, edits or deletes
-- anything on it.
--
-- `writable` is not decoration. pushAppointments deletes a Google event with
-- sendUpdates=all when a CLOZR row is deleted — on a calendar of the member's
-- own, that is a real meeting cancelled and every attendee emailed, from a
-- click in a CRM. The push consults this flag before any write, and a feed it
-- does not own is read-only in the app too.

-- ---------------------------------------------------------------- the feeds
create table if not exists public.google_calendar_feeds (
  account_id        bigint  not null references public.google_accounts(id) on delete cascade,
  -- A real calendar id (usually an address), never the alias 'primary'. The
  -- alias resolves per-account, so storing it would make a row ambiguous about
  -- which calendar it came from — which is exactly the state the appointments
  -- written before this migration are in.
  calendar_id       text    not null,
  -- What the member calls it, for the connection card.
  summary           text,
  -- True only for a calendar CLOZR created and therefore owns. Nothing grants
  -- itself this: ensureCalendar sets it on the calendar it made.
  writable          boolean not null default false,
  enabled           boolean not null default true,
  -- Google's incremental cursor, per calendar. One token cannot serve two.
  sync_token        text,
  last_full_sync_at timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (account_id, calendar_id)
);
create index if not exists google_calendar_feeds_account_idx
  on public.google_calendar_feeds (account_id) where enabled;

alter table public.google_calendar_feeds enable row level security;

-- Visible to the workspace, like the connection it hangs off.
drop policy if exists google_calendar_feeds_select on public.google_calendar_feeds;
create policy google_calendar_feeds_select on public.google_calendar_feeds for select
  using (exists (
    select 1 from public.google_accounts a
    where a.id = account_id and public.is_workspace_member(a.workspace_id)));

-- The member owns their own connection: they can stop CLOZR reading a calendar.
drop policy if exists google_calendar_feeds_own_update on public.google_calendar_feeds;
create policy google_calendar_feeds_own_update on public.google_calendar_feeds for update
  using (exists (
    select 1 from public.google_accounts a
    where a.id = account_id and a.user_id = (select auth.uid())
      and public.is_workspace_member(a.workspace_id)))
  with check (exists (
    select 1 from public.google_accounts a
    where a.id = account_id and a.user_id = (select auth.uid())
      and public.is_workspace_member(a.workspace_id)));

revoke all on public.google_calendar_feeds from anon, authenticated;
-- sync_token is withheld exactly as it is on google_accounts: it is Google's
-- cursor, it is not the browser's business, and handing it out lets a client
-- desynchronise the account's reads.
grant select (account_id, calendar_id, summary, writable, enabled,
              last_full_sync_at, last_error, created_at, updated_at)
  on public.google_calendar_feeds to authenticated;
grant update (enabled) on public.google_calendar_feeds to authenticated;

drop trigger if exists google_calendar_feeds_touch on public.google_calendar_feeds;
create trigger google_calendar_feeds_touch before update on public.google_calendar_feeds
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------- seed what is known
-- The CLOZR calendar each connection already has is a writable feed. The
-- primary calendar is not seeded here: its real id has to be asked of Google
-- (GET /calendars/primary), which SQL cannot do. google-sync adds it on the
-- first run after this deploys, which is also when it learns the summary.
insert into public.google_calendar_feeds (account_id, calendar_id, writable, sync_token)
select a.id, a.calendar_id, true, a.sync_token
from public.google_accounts a
where a.calendar_id is not null
on conflict (account_id, calendar_id) do nothing;

-- --------------------------------------------------------- drop the cursor
-- Every stored token is scoped by Google to the calendar AND the window it was
-- issued for, and both are wrong now: the calendar because reads are moving,
-- the window because the token that produced the 1,349 phantom rows was issued
-- for an unbounded read (migration 71's note, and the timeMax fix beside it).
-- Nulling it costs one full read per calendar and is the only way to be sure
-- the next read is the bounded one.
update public.google_accounts set sync_token = null where sync_token is not null;
update public.google_calendar_feeds set sync_token = null where sync_token is not null;

comment on table public.google_calendar_feeds is
  'Calendars a Google connection READS, one cursor each. Writes go to the single calendar CLOZR owns (google_accounts.calendar_id); writable marks it.';
