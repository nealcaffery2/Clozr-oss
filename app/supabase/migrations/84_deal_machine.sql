-- 84 · Deal Machine becomes a CLOZR program, not a popup.
--
-- The Chrome extension keeps doing the one thing only a browser can do — open
-- InvestorLift, Facebook groups and RealEstateBees as a logged-in person and
-- read the page. Everything else it used to own moves here: its settings, its
-- list of Facebook groups, its buy-box criteria, the run it is on, the log it
-- writes, the buyers lists it opted into, and the button that starts it.
--
-- CLOZR is the source of truth. The extension pulls its configuration and its
-- pending commands from the `deal-machine` edge function every minute and
-- whenever a run starts, and pushes its heartbeat, run progress, log lines and
-- opt-ins back through the same door. A rep at a desk clicks RUN in CLOZR; the
-- extension in the office Chrome picks the command up and runs it.
--
-- Every table is workspace-scoped and RLS'd. Members read. The settings,
-- groups and commands are written from the browser by owner, admin,
-- acquisitions and dispositions (the roles that see the screen); runs, log,
-- devices and opt-ins are written only by the edge function with the service
-- role, because they are the extension's report of what it did.

-- ---- settings ---------------------------------------------------------------
-- One row per workspace. `settings` is the extension's own configuration
-- object (lib/deal-machine.ts DmSettings): deal criteria, target markets,
-- contact identity, bot switches. No secrets: Apify, Firecrawl and Sheets
-- tokens stay in the extension's local storage, where they always were.
create table if not exists public.dm_settings (
  workspace_id bigint primary key references public.workspaces(id) on delete cascade,
  settings     jsonb not null default '{}'::jsonb,
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);
alter table public.dm_settings enable row level security;
drop policy if exists dm_settings_select on public.dm_settings;
create policy dm_settings_select on public.dm_settings for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists dm_settings_write on public.dm_settings;
create policy dm_settings_write on public.dm_settings for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions'));
revoke all on public.dm_settings from anon, authenticated;
grant select, insert, update on public.dm_settings to authenticated;

-- Every save bumps the version, so the extension can ask "anything newer than
-- what I applied?" with one integer instead of diffing JSON.
create or replace function public.dm_settings_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
revoke all on function public.dm_settings_touch() from public, anon, authenticated;
drop trigger if exists dm_settings_touch on public.dm_settings;
create trigger dm_settings_touch before update on public.dm_settings
  for each row execute function public.dm_settings_touch();

-- ---- Facebook groups --------------------------------------------------------
-- The allowlist the scraper works from. Mirrors what the popup's FB Groups tab
-- held in chrome.storage.sync, with what the extension learned about each
-- group (member count, posts per day, the last scrape) written back.
create table if not exists public.dm_groups (
  id              bigint generated always as identity primary key,
  workspace_id    bigint not null references public.workspaces(id) on delete cascade,
  url             text not null,
  name            text,
  tags            text[] not null default '{}',
  active          boolean not null default true,
  members         integer,
  posts_per_day   numeric,
  last_scraped_at timestamptz,
  last_result     jsonb,
  source          text not null default 'clozr',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, url)
);
create index if not exists dm_groups_ws_idx on public.dm_groups (workspace_id, active);
alter table public.dm_groups enable row level security;
drop policy if exists dm_groups_select on public.dm_groups;
create policy dm_groups_select on public.dm_groups for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists dm_groups_write on public.dm_groups;
create policy dm_groups_write on public.dm_groups for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions'));
revoke all on public.dm_groups from anon, authenticated;
grant select, insert, update, delete on public.dm_groups to authenticated;

-- ---- devices ----------------------------------------------------------------
-- One row per extension install that has said hello. `last_seen_at` is the
-- honest answer to "is it on?": the extension heartbeats every minute while
-- Chrome is open, so a device quiet for five minutes is off.
create table if not exists public.dm_devices (
  id                  bigint generated always as identity primary key,
  workspace_id        bigint not null references public.workspaces(id) on delete cascade,
  device_id           text not null,
  label               text,
  version             text,
  run_state           text not null default 'idle',
  is_running          boolean not null default false,
  step                text,
  progress            jsonb,
  stats               jsonb,
  settings_version    integer,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  unique (workspace_id, device_id)
);
alter table public.dm_devices enable row level security;
drop policy if exists dm_devices_select on public.dm_devices;
create policy dm_devices_select on public.dm_devices for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.dm_devices from anon, authenticated;
grant select on public.dm_devices to authenticated;

-- ---- commands ---------------------------------------------------------------
-- CLOZR → extension. A row is a button press: run, scrape only, buyers list,
-- pause, resume, stop, force reset, and the group jobs. The extension acks a
-- command when it picks it up and finishes it with a result. Commands nobody
-- picked up within an hour expire, so a RUN pressed on Friday does not start
-- a scrape on Monday morning.
create table if not exists public.dm_commands (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  device_id     text,
  command       text not null,
  args          jsonb not null default '{}'::jsonb,
  status        text not null default 'pending',
  requested_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  acked_at      timestamptz,
  finished_at   timestamptz,
  result        jsonb,
  constraint dm_commands_command_chk check (command in (
    'run', 'scrape', 'buyers_list', 'blitz', 'pause', 'resume', 'stop', 'force_reset',
    'fb_discovery', 'join_groups', 'pull_groups', 'il_etl', 'retry_failed_optins')),
  constraint dm_commands_status_chk check (status in ('pending', 'acked', 'done', 'failed', 'expired', 'cancelled'))
);
create index if not exists dm_commands_pending_idx on public.dm_commands (workspace_id, status, created_at);
alter table public.dm_commands enable row level security;
drop policy if exists dm_commands_select on public.dm_commands;
create policy dm_commands_select on public.dm_commands for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists dm_commands_insert on public.dm_commands;
create policy dm_commands_insert on public.dm_commands for insert to authenticated
  with check (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions') and status = 'pending');
-- A member may cancel their own pending command; nothing else is editable from the browser.
drop policy if exists dm_commands_cancel on public.dm_commands;
create policy dm_commands_cancel on public.dm_commands for update to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions') and status = 'pending')
  with check (status = 'cancelled');
revoke all on public.dm_commands from anon, authenticated;
grant select, insert, update on public.dm_commands to authenticated;

-- ---- runs -------------------------------------------------------------------
-- One row per run the extension reports, keyed by the extension's own run key
-- so a retried report updates rather than duplicates.
create table if not exists public.dm_runs (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  device_id     text,
  run_key       text not null,
  kind          text not null default 'machine',
  trigger       text not null default 'manual',
  status        text not null default 'running',
  dry_run       boolean not null default false,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  step          text,
  counts        jsonb not null default '{}'::jsonb,
  diag          jsonb,
  error         text,
  command_id    bigint references public.dm_commands(id) on delete set null,
  unique (workspace_id, run_key),
  constraint dm_runs_status_chk check (status in ('running', 'paused', 'stopping', 'done', 'stopped', 'failed'))
);
create index if not exists dm_runs_ws_idx on public.dm_runs (workspace_id, started_at desc);
alter table public.dm_runs enable row level security;
drop policy if exists dm_runs_select on public.dm_runs;
create policy dm_runs_select on public.dm_runs for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.dm_runs from anon, authenticated;
grant select on public.dm_runs to authenticated;

-- ---- log --------------------------------------------------------------------
-- The extension's live log, shipped in batches. Pruned to 14 days by the
-- edge function on each batch so the table cannot grow without bound.
create table if not exists public.dm_run_log (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  run_id        bigint references public.dm_runs(id) on delete set null,
  device_id     text,
  ts            timestamptz not null default now(),
  level         text not null default 'info',
  tag           text,
  msg           text not null
);
create index if not exists dm_run_log_ws_idx on public.dm_run_log (workspace_id, ts desc);
alter table public.dm_run_log enable row level security;
drop policy if exists dm_run_log_select on public.dm_run_log;
create policy dm_run_log_select on public.dm_run_log for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.dm_run_log from anon, authenticated;
grant select on public.dm_run_log to authenticated;

-- ---- buyers-list opt-ins ----------------------------------------------------
-- One row per wholesaler domain the buyers-list bot has tried, with its latest
-- outcome. The buyer/wholesaler contacts themselves still arrive through
-- /ingest as buyers; this is the bot's own ledger of where it has been.
create table if not exists public.dm_optins (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  domain        text not null,
  url           text,
  status        text not null default 'opted_in',
  method        text,
  detail        text,
  attempts      integer not null default 1,
  run_id        bigint references public.dm_runs(id) on delete set null,
  device_id     text,
  first_at      timestamptz not null default now(),
  last_at       timestamptz not null default now(),
  unique (workspace_id, domain),
  constraint dm_optins_status_chk check (status in ('opted_in', 'no_form', 'failed', 'skipped', 'queued'))
);
create index if not exists dm_optins_ws_idx on public.dm_optins (workspace_id, last_at desc);
alter table public.dm_optins enable row level security;
drop policy if exists dm_optins_select on public.dm_optins;
create policy dm_optins_select on public.dm_optins for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.dm_optins from anon, authenticated;
grant select on public.dm_optins to authenticated;

-- ---- realtime ---------------------------------------------------------------
-- The screen subscribes to runs, devices and commands so RUN turns into
-- RUNNING without a refresh. The log is polled: a scrape writes hundreds of
-- lines a minute and a channel per line is the wrong shape for that.
do $$
declare t text;
begin
  foreach t in array array['dm_runs', 'dm_devices', 'dm_commands'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
