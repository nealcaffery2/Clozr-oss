-- Skip trace and import history (Settings → History).
--
-- One row per run: who ran it, what it touched and how it went. Skip traces
-- also leave their per-record trail (a "Skip trace" activity note and the
-- `skiptrace completed` tag) and their credits in genius_credit_log; this is
-- the run-level view of both, plus every import.

create table if not exists public.data_runs (
  id            bigint generated always as identity primary key,
  -- No foreign keys: adding one locks workspaces / auth.users, which the live
  -- project could not take in time. A history row outliving its workspace is harmless.
  workspace_id  bigint not null,
  kind          text not null,
  entity        text,
  label         text,
  total         integer not null default 0,
  succeeded     integer not null default 0,
  failed        integer not null default 0,
  credits       integer not null default 0,
  detail        jsonb not null default '{}'::jsonb,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  constraint data_runs_kind_chk check (kind in ('skiptrace', 'import')),
  constraint data_runs_entity_chk check (entity is null or entity in ('seller', 'buyer', 'vendor'))
);

create index if not exists data_runs_ws_idx on public.data_runs (workspace_id, created_at desc);

alter table public.data_runs enable row level security;

-- Any member reads the history and logs their own runs; nobody edits or deletes it.
drop policy if exists data_runs_select on public.data_runs;
create policy data_runs_select on public.data_runs for select using (public.is_workspace_member(workspace_id));
drop policy if exists data_runs_insert on public.data_runs;
create policy data_runs_insert on public.data_runs for insert
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
