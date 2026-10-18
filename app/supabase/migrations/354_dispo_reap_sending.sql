-- 354: a dispo message stuck in 'sending' is marked failed, never sent again.
--
-- A message is claimed (queued -> sending) right before its send. When the
-- send throws after the provider may have taken it (dispo-campaign-tick
-- pool.ts leaves it claimed on purpose), or the run that claimed it dies (the
-- edge runtime's wall clock, a tab closed during "Send due texts now"), the
-- row stayed 'sending' forever: no rep was told, and dispo_campaign_finish
-- never marked the campaign done. Putting it back to 'queued' could text or
-- email a buyer twice, so the kick marks it failed with last_error
-- 'send outcome unknown; not retried' and asks dispo_campaign_finish about
-- each campaign it touched.
--
-- 30 minutes: a claim lives only as long as the run that took it. The tick
-- stops claiming at 100 s and its edge function is killed at the runtime's
-- 400 s wall clock (150 s on the free plan); the browser path makes one Talkr
-- call per claim, which the browser gives up on within minutes. Every update
-- bumps updated_at (dispo_campaign_messages_touch), so for a 'sending' row it
-- is the claim time. 30 minutes is over four times the longest a claiming run
-- can live.
--
-- The reap runs before the "anything due?" check, so a campaign whose last
-- message is stuck is reaped with nothing else queued. The rest is the live
-- body (53). Safe to re-run.

create or replace function public.dispo_campaign_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text; v_campaigns bigint[];
begin
  -- ponytail: no index has status = 'sending', so this scans the table (few rows); add a concurrent partial index on (updated_at) where status = 'sending' when it is large.
  with reaped as (
    update public.dispo_campaign_messages set status = 'failed', last_error = 'send outcome unknown; not retried'
     where status = 'sending' and updated_at < now() - interval '30 minutes'
    returning campaign_id)
  select array_agg(distinct campaign_id) into v_campaigns from reaped;
  perform public.dispo_campaign_finish(c) from unnest(v_campaigns) c;

  if not exists (select 1 from public.dispo_campaign_messages where status = 'queued' and send_at <= now())
     and not (extract(minute from now())::int % 5 = 0
              and exists (select 1 from public.dispo_campaign_recipients where status in ('active', 'replied') and talkr_conversation_id is not null and created_at > now() - interval '14 days'))
  then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/dispo-campaign-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.dispo_campaign_kick() from public, anon, authenticated;
