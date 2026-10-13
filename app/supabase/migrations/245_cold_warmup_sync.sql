-- Cold pool warmup becomes real: the Instantly reading lives on the mailbox
-- row, a daily cron syncs it, and InboxKit imports remember their workspace.
--
--   cold_mailboxes.warmup_started_at   when warming began (set on import, or
--                                      from Instantly's timestamp when it
--                                      lists the inbox as warming)
--   cold_mailboxes.warmup_score        Instantly health score, 0 to 100
--   cold_mailboxes.warmup_checked_at   last successful sync for this row
--   cold_mailboxes.warmup_sent_14d     warmup mail sent in the last 14 days
--   cold_mailboxes.warmup_spam_14d     of those, landed in Spam
--   cold_workspace_settings.inboxkit_workspace_uid  the InboxKit workspace
--                                      import_inboxkit reads from
--   cold_workspace_settings.warmup_synced_at / warmup_sync_error
--
-- The gate (cold-campaign.ts warmupGate): while warmup_provider is
-- 'instantly', a warming mailbox sends no cold mail until it has warmed 14
-- days and its score is 90 or more; the sync then sets status active and
-- restarts ramp_started_on at today. Spam over 3% of warmup mail auto-pauses
-- the mailbox. A workspace on the stub provider ramps exactly as before.
--
-- cold_warmup_kick() posts {"action":"warmup_sync"} to cold-campaign-tick
-- once a day, only when some workspace warms through Instantly. Same vault
-- key pattern as rvm_kick (101) and cold_campaign_kick (166).

alter table public.cold_mailboxes
  add column if not exists warmup_started_at timestamptz,
  add column if not exists warmup_score      integer check (warmup_score is null or warmup_score between 0 and 100),
  add column if not exists warmup_checked_at timestamptz,
  add column if not exists warmup_sent_14d   integer check (warmup_sent_14d is null or warmup_sent_14d >= 0),
  add column if not exists warmup_spam_14d   integer check (warmup_spam_14d is null or warmup_spam_14d >= 0);

alter table public.cold_workspace_settings
  add column if not exists inboxkit_workspace_uid text check (inboxkit_workspace_uid is null or char_length(btrim(inboxkit_workspace_uid)) between 8 and 80),
  add column if not exists warmup_synced_at       timestamptz,
  add column if not exists warmup_sync_error      text;

-- A mailbox that was already warming started when it was connected.
update public.cold_mailboxes
   set warmup_started_at = coalesce(connected_at, created_at)
 where warmup_started_at is null and status = 'warming';

create or replace function public.cold_warmup_kick()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.cold_workspace_settings where warmup_provider = 'instantly') then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/cold-campaign-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"warmup_sync"}'::jsonb,
    timeout_milliseconds := 8000);
end $$;
revoke execute on function public.cold_warmup_kick() from public, anon, authenticated;

select cron.unschedule('clozr-cold-warmup-sync') where exists (select 1 from cron.job where jobname = 'clozr-cold-warmup-sync');
select cron.schedule('clozr-cold-warmup-sync', '10 6 * * *', 'select public.cold_warmup_kick()');

notify pgrst, 'reload schema';
