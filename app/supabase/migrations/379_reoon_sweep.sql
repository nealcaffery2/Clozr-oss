-- 379: Reoon ahead of the send.
--
-- Send-time verification (370) checks an address only when a send reaches
-- it. 10,800 of Compr's buyers had never been checked, so a drip or a
-- campaign spent its first sends on Reoon and parked bad addresses only once
-- they were due. The deliverability function's `verify_sweep` action
-- (_shared/reoon-sweep.ts) checks them ahead of time: buyers on an active
-- plan first, then the most recently active, 200 a run, in every workspace
-- with settings.buyer_profile = 'compr' or settings.reoon_sweep = true.
--
-- cold_workspace_settings.reoon_sweep_task holds a Reoon task still running
-- when a run ends, so the next run reads it instead of paying twice.
-- reoon_sweep_kick() fires every five minutes while any such workspace has an
-- unchecked address or a task outstanding.
--
-- Idempotent; safe to re-run.

alter table public.cold_workspace_settings add column if not exists reoon_sweep_task jsonb;

create or replace function public.reoon_sweep_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (
    select 1 from public.workspaces w
     where coalesce(w.settings->>'reoon_sweep', '') <> 'false'
       and (w.settings->>'buyer_profile' = 'compr' or w.settings->>'reoon_sweep' = 'true')
       and (exists (select 1 from public.buyers b
                     where b.workspace_id = w.id and b.archived_at is null and b.email_verified_at is null
                       and coalesce(b.email, '') <> '')
            or exists (select 1 from public.cold_workspace_settings c where c.workspace_id = w.id and c.reoon_sweep_task is not null))
  ) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/deliverability',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"verify_sweep"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.reoon_sweep_kick() from public, anon, authenticated;

select cron.unschedule('clozr-reoon-sweep') where exists (select 1 from cron.job where jobname = 'clozr-reoon-sweep');
select cron.schedule('clozr-reoon-sweep', '*/5 * * * *', 'select public.reoon_sweep_kick()');
