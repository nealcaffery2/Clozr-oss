-- Podio history before CLOZR.
--
-- 1. podio-import's history pass (docs/podio.md): every synced Podio item's
--    past stage moves, offer amounts and comments onto its record's timeline,
--    dated when they happened in Podio. podio_connections gains
--    history_cursor (per app: offset, total, done_at) and history_notes (the
--    last run's counts and errors); podio_history_kick() POSTs
--    {"action":"history"} with the vault secrets from 110, pg_cron
--    `clozr-podio-history` every ten minutes, five minutes after the live sync.
--    Once every app is done the function answers "History is done." and the
--    cron costs nothing.
--
-- (In the hosted product this file also archived a few test rows in one
-- production workspace; that cleanup is not part of the open-source release.
-- The intake now treats a value with no letter or digit as empty
-- (_shared/flat.ts).)

alter table public.podio_connections
  add column if not exists history_cursor jsonb not null default '{}'::jsonb,
  add column if not exists history_notes jsonb;

create or replace function public.podio_history_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (
    select 1 from public.podio_connections c
     where c.sync_enabled and coalesce(c.client_id, '') <> '' and coalesce(c.client_secret, '') <> ''
       and exists (select 1 from jsonb_array_elements(c.apps) a
                    where a->>'key' in ('submissions', 'acquisitions', 'deals') and coalesce(a->>'app_token', '') <> ''
                      and c.history_cursor -> (a->>'key') ->> 'done_at' is null)
  ) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/podio-import',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"history"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.podio_history_kick() from public, anon, authenticated;

select cron.unschedule('clozr-podio-history') where exists (select 1 from cron.job where jobname = 'clozr-podio-history');
select cron.schedule('clozr-podio-history', '8-58/10 * * * *', 'select public.podio_history_kick()');
