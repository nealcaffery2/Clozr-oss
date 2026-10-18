-- 365 · How fast CLOZR is for the people using it.
--
-- The app (lib/vitals.ts, mounted in app/app/page.tsx) sends what the browser
-- measured: per view (one address in the hash) its 15 worst interactions over
-- 40 ms and 5 worst frames over 200 ms, and per page load the largest paint,
-- the shell's first screen and the load event. One POST a minute and when the
-- tab hides. Nothing during a View-as preview, nothing signed out.
--
--   kind             inp | long_frame | lcp | first_screen | load
--   screen           the screen in the hash (never the record id)
--   value_ms         inp: the interaction's duration; others: the time
--   input_delay_ms, processing_ms, presentation_ms   inp only
--   target           tag, first class name, role, nearest data-testid with
--                    id parts dropped (`click button.lift-row today-row`);
--                    long_frame: the longest script's kind and chunk;
--                    load: the navigation type. Never text, labels or ids.
--   release          the entry chunk's hash (or the commit when Vercel gives it)
--   user_agent       `Chrome 141 Windows 8c`
--
-- Signed-in members insert their own rows into their own workspace; owners
-- and admins read their workspace's rows. Lengths and values are capped so the
-- publishable key cannot park blobs. Read it from the SQL editor or the MCP,
-- for example INP per screen over the last day:
--
--   select screen, count(*) n,
--          percentile_disc(0.75) within group (order by value_ms) p75, max(value_ms) worst
--   from client_vitals where kind = 'inp' and created_at > now() - interval '24 hours'
--   group by 1 order by p75 desc;
--
-- Retention: no nightly job fits (the nightly ones are each about one
-- feature). Delete by hand when it grows, or add it to a cleanup job:
--   delete from public.client_vitals where created_at < now() - interval '30 days';
--
-- Additive, safe to re-run.

create table if not exists public.client_vitals (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  user_id         uuid not null default auth.uid(),
  workspace_id    bigint not null references public.workspaces(id) on delete cascade,
  kind            text not null check (kind in ('inp', 'long_frame', 'lcp', 'first_screen', 'load')),
  screen          text check (length(screen) <= 40),
  value_ms        integer not null check (value_ms between 0 and 3600000),
  input_delay_ms  integer check (input_delay_ms between 0 and 3600000),
  processing_ms   integer check (processing_ms between 0 and 3600000),
  presentation_ms integer check (presentation_ms between 0 and 3600000),
  target          text check (length(target) <= 120),
  release         text check (length(release) <= 40),
  user_agent      text check (length(user_agent) <= 80)
);

create index if not exists client_vitals_ws_created on public.client_vitals (workspace_id, created_at desc);

alter table public.client_vitals enable row level security;

drop policy if exists client_vitals_insert_own on public.client_vitals;
create policy client_vitals_insert_own on public.client_vitals
  for insert to authenticated
  with check (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

drop policy if exists client_vitals_select_admin on public.client_vitals;
create policy client_vitals_select_admin on public.client_vitals
  for select to authenticated
  using (workspace_id in (select public.my_role_workspace_ids(variadic array['owner', 'admin'])));

revoke all on public.client_vitals from anon, authenticated;
grant select, insert on public.client_vitals to authenticated;

notify pgrst, 'reload schema';
