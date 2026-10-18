-- 273: new Gmail lands within about a minute.
--
-- Mail came in only on the five-minute clozr-google-sync tick (71), and that
-- same pass also ran the relink with its AI calls, the backfill, attachments
-- and HTML hydrate. An inbound email reached CLOZR
-- about three minutes after it arrived, and up to five or more.
--
-- google-sync now splits Gmail into two lanes (_shared/gmail-lanes.ts):
--   fast  this job, every minute: one invoke checks every mailbox (profile
--         historyId, then history.list for added messages) and hands only the
--         mailboxes with new mail to an isolate of their own to read it.
--   slow  clozr-google-sync, every five minutes as before: the upkeep.
--
-- gmail_upkeep_history_id: the gmail_history_id (what the fast lane has
-- stored through) when the slow lane last ran its upkeep. Unchanged means
-- upkeep waits for its hourly run, the way an idle mailbox did before. Null runs upkeep, so the function works before
-- this column exists.

alter table public.google_accounts add column if not exists gmail_upkeep_history_id text;

create or replace function public.gmail_fast_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  -- Nothing to do on a project with no mailbox reading mail.
  if not exists (select 1 from public.google_accounts where status = 'active' and gmail_read) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/google-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"sync_all","lane":"fast"}'::jsonb,
    timeout_milliseconds := 30000);
end $$;

revoke execute on function public.gmail_fast_kick() from public, anon, authenticated;

select cron.unschedule('clozr-gmail-fast') where exists (select 1 from cron.job where jobname = 'clozr-gmail-fast');
select cron.schedule('clozr-gmail-fast', '* * * * *', 'select public.gmail_fast_kick()');
