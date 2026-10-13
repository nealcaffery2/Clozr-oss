-- 187 · Deal Machine runs in CLOZR, not only in a Chrome.
--
-- Migration 84 made CLOZR the control panel and left the work in the Chrome
-- extension, so nothing was found unless one office Chrome was open, awake and
-- logged in. The `deal-machine-cloud` function now does the deal job itself:
-- InvestorLift and the workspace's Facebook groups are pulled through Apify on
-- a server, every find is judged against the fund buy box and the MAO, and what
-- passes lands as a property, a contact and a deal. It reports through the same
-- dm_* tables as a device named 'clozr-cloud', so the Deal Machine screen shows
-- its runs, counts and log like any extension's.
--
-- The switch and its knobs live in dm_settings.settings.cloud (no schema).
-- This adds what the function needs around it:
--   • the workspace's Apify token, write-only (like the InvestorBase key, 92)
--   • a lease and a state column on dm_runs, because one run spans many ticks
--   • pg_cron every two minutes, plus a kick the moment RUN is pressed for the
--     cloud, so a rep is not left waiting for the next tick.

-- ---- the Apify token --------------------------------------------------------
alter table public.workspace_integration_secrets add column if not exists apify_token text;

create or replace function public.set_dm_apify_token(p_workspace_id bigint, p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v text := nullif(btrim(coalesce(p_token, '')), '');
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can save the Apify token' using errcode = '42501';
  end if;
  if v is not null and (length(v) < 20 or length(v) > 200 or v ~ '\s') then
    raise exception 'that does not look like an Apify API token' using errcode = '22023';
  end if;
  insert into public.workspace_integration_secrets (workspace_id, apify_token)
  values (p_workspace_id, v)
  on conflict (workspace_id) do update
    set apify_token = excluded.apify_token, updated_at = now();
  perform public.audit_event(p_workspace_id, 'deal_machine.apify_token', jsonb_build_object('connected', v is not null));
end $$;
revoke all on function public.set_dm_apify_token(bigint, text) from public, anon;
grant execute on function public.set_dm_apify_token(bigint, text) to authenticated;

create or replace function public.dm_apify_connected(p_workspace_id bigint)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of that workspace' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.workspace_integration_secrets
     where workspace_id = p_workspace_id and length(coalesce(apify_token, '')) >= 20
  );
end $$;
revoke all on function public.dm_apify_connected(bigint) from public, anon;
grant execute on function public.dm_apify_connected(bigint) to authenticated;

-- ---- runs that span ticks -----------------------------------------------------
-- `cloud` is the run's own state (each source's Apify run, dataset offset and
-- tallies); `lease_until` keeps two overlapping ticks off the same run.
alter table public.dm_runs add column if not exists cloud jsonb;
alter table public.dm_runs add column if not exists lease_until timestamptz;
create index if not exists dm_runs_cloud_active_idx on public.dm_runs (workspace_id, status) where device_id = 'clozr-cloud';

-- ---- the kick -------------------------------------------------------------------
-- Only calls out when there is something to do: a workspace with cloud runs
-- on (it heartbeats and may be due a scheduled run), a command waiting for the
-- cloud, or a cloud run still going.
create or replace function public.dm_cloud_kick()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.dm_settings where settings->'cloud'->>'enabled' = 'true')
     and not exists (select 1 from public.dm_commands where device_id = 'clozr-cloud' and status = 'pending')
     and not exists (select 1 from public.dm_runs where device_id = 'clozr-cloud' and status in ('running', 'paused', 'stopping')) then
    return 0;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return 0; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/deal-machine-cloud',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 150000);
  return 1;
end $$;
revoke execute on function public.dm_cloud_kick() from public, anon, authenticated;

-- RUN pressed for the cloud starts now. pg_net is asynchronous, so the insert
-- is not held up, and a failed kick never fails the insert: the cron catches it.
create or replace function public.dm_commands_cloud_kick()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public.dm_cloud_kick();
  exception when others then
    raise warning 'dm_cloud_kick: %', sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.dm_commands_cloud_kick() from public, anon, authenticated;
drop trigger if exists dm_commands_cloud_kick on public.dm_commands;
create trigger dm_commands_cloud_kick after insert on public.dm_commands
  for each row when (new.device_id = 'clozr-cloud') execute function public.dm_commands_cloud_kick();

select cron.unschedule('clozr-dm-cloud') where exists (select 1 from cron.job where jobname = 'clozr-dm-cloud');
select cron.schedule('clozr-dm-cloud', '*/2 * * * *', 'select public.dm_cloud_kick()');
