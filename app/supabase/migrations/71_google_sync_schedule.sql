-- 71: the calendar syncs itself.
--
-- Why this exists. supabase/functions/google-sync has always had a `sync_all`
-- path for the service role, and its header documents the cron job that drives
-- it — but nothing ever scheduled one. The snippet in that header is not even
-- valid cron ('every ten minutes, in cron syntax' was left as a placeholder),
-- so it was a note to a human that no human ran. Five other subsystems get a
-- pg_cron kicker in these migrations (webhook_tick, dispo_campaign_kick,
-- buyer_automations_apply, call_sync_kick, number_guard_kick); the calendar
-- was the one that did not.
--
-- What that cost. With no scheduled run, a pull from Google only happened when
-- a signed-in member opened the app (once per page load — app/app/page.tsx
-- keeps a module-level `synced` set) or wrote an appointment themselves
-- (nudgeGoogle). So an appointment moved on a phone, a time a seller changed
-- from the Google invitation, or an event created in Google Calendar directly
-- did not reach CLOZR until somebody reloaded the tab. The calendar was not
-- slow at rendering; it was never told. `appointments` is already in the
-- supabase_realtime publication (migration 35), so once a pull writes a row
-- the open calendar redraws on its own — the missing piece was only the pull.
--
-- Every five minutes, offset off the minute boundary so this does not queue
-- behind clozr-webhook-tick and clozr-dispo-campaign-kick, which both run at
-- :00. Each pass is idempotent (the function's own header): an appointment
-- already 'synced' is not touched and a pull with nothing new costs one list
-- call, so the steady-state cost of this schedule is one cheap request per
-- connected account.
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
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.google_sync_kick() from public, anon, authenticated;

select cron.unschedule('clozr-google-sync') where exists (select 1 from cron.job where jobname = 'clozr-google-sync');
select cron.schedule('clozr-google-sync', '2-57/5 * * * *', 'select public.google_sync_kick()');
