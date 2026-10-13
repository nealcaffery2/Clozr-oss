-- 168: the five-minute Google sync can finish one mailbox.
--
-- google_sync_kick posted to google-sync with a 5 second HTTP timeout.
-- A Gmail pass that actually reads mail takes longer than that, so the
-- scheduled call gave up while the function was still working — and the
-- function was already being killed with CPU Time exceeded (HTTP 546)
-- because one invoke pulled every mailbox. The function now reads mail
-- for the one account furthest behind and keeps that cursor before the
-- history crawl. This gives the HTTP call long enough to hear the result.
-- 150 seconds matches the other long kicks (drive, compr photos).

create or replace function public.google_sync_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/google-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"sync_all"}'::jsonb,
    timeout_milliseconds := 150000);
end $$;

revoke execute on function public.google_sync_kick() from public, anon, authenticated;
