-- Bell rows a member dismissed, kept on the server so they follow them.
--
-- Missed calls and texts in the bell are built from communications
-- (lib/bell-events.ts) and have no notifications row to set read_at on, so a
-- "Mark read" lived in the browser's localStorage: the row came back on the
-- phone, on another computer, and after clearing site data. This keeps those
-- dismissals per member, keyed by the bell row's id:
--   bell-call-<communication>   a missed call or voicemail (the newest one per person)
--   bell-sms-<communication>    an inbound text (the newest one per person)
--   <gap id>:<day>              a deal sheet section reminder (lib/section-gaps)
-- A real notification is still marked read on its own row (notifications.read_at).
--
-- Until this is applied the app keeps dismissals in localStorage as before
-- (lib/bell-dismissals.ts reads a missing table as "not yet"), so nothing
-- breaks between deploy and migration. Membership is checked the way 188
-- left every policy: workspace_id in my_workspace_ids(), once per query.

create table if not exists public.bell_dismissals (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id      uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  item_id      text   not null check (length(item_id) between 1 and 200),
  dismissed_at timestamptz not null default now(),
  primary key (workspace_id, user_id, item_id)
);

create index if not exists bell_dismissals_recent on public.bell_dismissals (workspace_id, user_id, dismissed_at desc);

alter table public.bell_dismissals enable row level security;

drop policy if exists bell_dismissals_read on public.bell_dismissals;
create policy bell_dismissals_read on public.bell_dismissals for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

drop policy if exists bell_dismissals_insert on public.bell_dismissals;
create policy bell_dismissals_insert on public.bell_dismissals for insert to authenticated
  with check (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

drop policy if exists bell_dismissals_update on public.bell_dismissals;
create policy bell_dismissals_update on public.bell_dismissals for update to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

drop policy if exists bell_dismissals_delete on public.bell_dismissals;
create policy bell_dismissals_delete on public.bell_dismissals for delete to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

grant select, insert, update, delete on public.bell_dismissals to authenticated;
