-- Saved views: a named look at the Deals, People or Buyers table.
--
-- The way Podio does it. A view is the columns you picked, their order, the
-- filters that were set and, on Deals, whether it opens as the table or the
-- board (and which stages and card fields the board shows). The rep saves one
-- under a name and picks it from the Views menu later, instead of rebuilding
-- the same field set every morning.
--
-- A view belongs to whoever saved it. `shared` puts it in every workspace
-- member's menu too, read-only for them: only the owner can rename, update or
-- delete it, so one rep tidying their own list cannot rewrite someone else's.
--
-- `config` is the screen's own shape (app/clozr/screens/*.tsx), kept as jsonb
-- so a new column on a screen does not need a migration. The app reads it
-- defensively: an unknown column key is dropped, a missing one falls back to
-- the screen's default.
--
-- Until this is applied the screens keep views in the browser's localStorage
-- (lib/saved-views.ts), so nothing breaks in the window between deploy and
-- migration; they just are not shared or carried across devices.

create table if not exists public.saved_views (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id      uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  screen       text   not null check (screen in ('deals', 'people', 'buyers')),
  name         text   not null check (length(btrim(name)) between 1 and 80),
  config       jsonb  not null default '{}'::jsonb,
  shared       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists saved_views_ws_screen on public.saved_views (workspace_id, screen);

alter table public.saved_views enable row level security;

drop policy if exists saved_views_read on public.saved_views;
create policy saved_views_read on public.saved_views for select to authenticated
  using (public.is_workspace_member(workspace_id) and (user_id = (select auth.uid()) or shared));

drop policy if exists saved_views_insert on public.saved_views;
create policy saved_views_insert on public.saved_views for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists saved_views_update on public.saved_views;
create policy saved_views_update on public.saved_views for update to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists saved_views_delete on public.saved_views;
create policy saved_views_delete on public.saved_views for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.saved_views to authenticated;

drop trigger if exists saved_views_touch on public.saved_views;
create trigger saved_views_touch before update on public.saved_views
  for each row execute function public.touch_updated_at();
