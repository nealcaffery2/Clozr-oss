-- Lane's 9am check-in and fire alarms (supabase/functions/lane-checkin).
--
-- lane_checkins: one row per workspace per Central day, the note Lane posted
--   and a snapshot of which checklist lines were ticked, so tomorrow's note
--   can tip a hat to what got done since.
-- lane_pings: which critical checklist lines ("<transaction id>:<line id>")
--   Lane has already pinged the TC about as late, so each one pings once.
-- The function runs hourly (it decides 9am Central itself, DST included).

create table if not exists public.lane_checkins (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  day          date not null,
  message      text not null,
  snapshot     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, day)
);
alter table public.lane_checkins enable row level security;
drop policy if exists lane_checkins_read on public.lane_checkins;
create policy lane_checkins_read on public.lane_checkins for select
  using (workspace_id in (select public.my_workspace_ids()));

create table if not exists public.lane_pings (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  item_key     text not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, item_key)
);
alter table public.lane_pings enable row level security;
drop policy if exists lane_pings_read on public.lane_pings;
create policy lane_pings_read on public.lane_pings for select
  using (workspace_id in (select public.my_workspace_ids()));

create or replace function public.lane_checkin_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/lane-checkin',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.lane_checkin_kick() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('clozr-lane-checkin') where exists (select 1 from cron.job where jobname = 'clozr-lane-checkin');
    perform cron.schedule('clozr-lane-checkin', '2 * * * *', 'select public.lane_checkin_kick()');
  end if;
end $$;
