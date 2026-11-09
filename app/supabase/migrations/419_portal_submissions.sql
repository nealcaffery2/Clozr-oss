-- 419: Chris's partner submissions, imported every weekday at 8 AM Central.
--
-- portal_runs: one row per source per run of the portal-submissions function
-- (found, new, already in CLOZR, deduped, failed, error, dry run, and the
-- per-address lines in details). Members of the workspace read; only the
-- service role writes.
--
-- portal_submissions_kick(): POSTs {} to portal-submissions with the vault's
-- service key (same pattern as jotform_sync_kick in 121). Scheduled at 13:00
-- and 14:00 UTC Monday to Friday; the function runs only the one that is
-- 8 AM in America/Chicago, so DST needs no second schedule. The function is a
-- dry run unless its secret INGEST_LIVE is 1. Safe to re-run.

create table if not exists public.portal_runs (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  started_at   timestamptz not null default now(),
  source       text not null,
  found        integer not null default 0,
  new          integer not null default 0,
  existing     integer not null default 0,
  deduped      integer not null default 0,
  failed       integer not null default 0,
  error        text,
  dry_run      boolean not null default true,
  details      jsonb not null default '{}'::jsonb
);
create index if not exists portal_runs_ws_started_idx on public.portal_runs (workspace_id, started_at desc);

alter table public.portal_runs enable row level security;
drop policy if exists portal_runs_select on public.portal_runs;
create policy portal_runs_select on public.portal_runs
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.portal_runs from anon, authenticated;
grant select on public.portal_runs to authenticated;

create or replace function public.portal_submissions_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/portal-submissions',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.portal_submissions_kick() from public, anon, authenticated;

select cron.unschedule('clozr-portal-submissions') where exists (select 1 from cron.job where jobname = 'clozr-portal-submissions');
select cron.schedule('clozr-portal-submissions', '0 13,14 * * 1-5', 'select public.portal_submissions_kick()');
