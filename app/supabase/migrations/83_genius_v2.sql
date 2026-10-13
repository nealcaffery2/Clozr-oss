-- 83 · Genius Mode v2: saved searches, a pay-once cache, and a credit ledger.
--
-- discover_runs becomes a real saved search. A run can start from an address
-- typed on the Genius page (no deal), carries the filters it ran with, how many
-- properties it scanned, how many buyers it kept and its best score, so the
-- Past searches rail lists runs without unpacking the candidates blob. status
-- lets a run be written first and finished later; a run that errored says so.
--
-- genius_property_cache and genius_skip_cache are the "pay once" rule: every
-- PropertyDetail answer is kept per RealEstateAPI property id, every SkipTrace
-- answer per owner, and genius-discover reads them before it spends. A property
-- is re-pulled after 30 days, an owner after 90.
--
-- genius_credit_log is one row per paid call batch, so a run shows what it cost
-- and a workspace can cap its month (workspaces.settings.genius_monthly_credit_cap).
--
-- All three new tables are written only by the edge function with the service
-- role. Members of the workspace read; nobody else sees a row.

alter table public.discover_runs
  add column if not exists address            text,
  add column if not exists filters            jsonb not null default '{}'::jsonb,
  add column if not exists status             text not null default 'done',
  add column if not exists error              text,
  add column if not exists properties_scanned integer,
  add column if not exists buyer_count        integer,
  add column if not exists top_score          smallint,
  add column if not exists credits            jsonb not null default '{}'::jsonb,
  add column if not exists finished_at        timestamptz;

do $$ begin
  alter table public.discover_runs add constraint discover_runs_status_chk check (status in ('running','done','error'));
exception when duplicate_object then null; end $$;

create index if not exists discover_runs_ws_idx on public.discover_runs (workspace_id, created_at desc);

-- Runs from before v2 get their counts so they list in Past searches.
update public.discover_runs
   set buyer_count = coalesce(buyer_count, jsonb_array_length(candidates)),
       address     = coalesce(address, subject->>'address'),
       top_score   = coalesce(top_score, (select max((c->>'likelihood')::int) from jsonb_array_elements(candidates) c)::smallint)
 where buyer_count is null or address is null;

-- ---- PropertyDetail cache -----------------------------------------------------
create table if not exists public.genius_property_cache (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  reapi_id     text   not null,
  detail       jsonb  not null,
  fetched_at   timestamptz not null default now(),
  primary key (workspace_id, reapi_id)
);
alter table public.genius_property_cache enable row level security;
drop policy if exists genius_property_cache_select on public.genius_property_cache;
create policy genius_property_cache_select on public.genius_property_cache for select to authenticated
  using (public.has_role(workspace_id, 'owner','admin','dispositions','tc','member'));
revoke all on public.genius_property_cache from anon, authenticated;
grant select on public.genius_property_cache to authenticated;

-- ---- SkipTrace cache ------------------------------------------------------------
-- owner_key is the normalized owner name plus the normalized address traced,
-- so the same LLC traced at the same mailing address is one row.
create table if not exists public.genius_skip_cache (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  owner_key    text   not null,
  owner_name   text,
  hits         jsonb  not null default '[]'::jsonb,
  fetched_at   timestamptz not null default now(),
  fetched_by   uuid references auth.users(id) on delete set null,
  unique (workspace_id, owner_key)
);
alter table public.genius_skip_cache enable row level security;
drop policy if exists genius_skip_cache_select on public.genius_skip_cache;
create policy genius_skip_cache_select on public.genius_skip_cache for select to authenticated
  using (public.has_role(workspace_id, 'owner','admin','dispositions','tc','member'));
revoke all on public.genius_skip_cache from anon, authenticated;
grant select on public.genius_skip_cache to authenticated;

-- ---- credit ledger ----------------------------------------------------------------
create table if not exists public.genius_credit_log (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  run_id       bigint references public.discover_runs(id) on delete set null,
  kind         text   not null check (kind in ('search','detail','skiptrace','count')),
  units        integer not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists genius_credit_log_ws_idx on public.genius_credit_log (workspace_id, created_at desc);
create index if not exists genius_credit_log_run_idx on public.genius_credit_log (run_id);
alter table public.genius_credit_log enable row level security;
drop policy if exists genius_credit_log_select on public.genius_credit_log;
create policy genius_credit_log_select on public.genius_credit_log for select to authenticated
  using (public.has_role(workspace_id, 'owner','admin','dispositions'));
revoke all on public.genius_credit_log from anon, authenticated;
grant select on public.genius_credit_log to authenticated;
