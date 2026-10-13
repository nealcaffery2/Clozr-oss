-- dispogenius-sync is in the repo now (app/supabase/functions/dispogenius-sync)
-- and accepts exactly the service key or this cron's vault key
-- (_shared/security.ts isServiceCaller). The static token the dashboard-only
-- version checked rode in this kick's body; it opens nothing any more and is
-- taken out, so it no longer sits in pg_proc. Same schedule, same gate, same
-- bearer as before.
create or replace function public.dispogenius_sync_kick()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_url text; v_key text;
begin
  if not exists (
    select 1 from public.deals
     where closed_on is null and not coalesce(terminated, false)
  ) then return; end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;

  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/dispogenius-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('action', 'sync'),
    timeout_milliseconds := 20000);
end $$;

revoke all on function public.dispogenius_sync_kick() from public, anon, authenticated;
