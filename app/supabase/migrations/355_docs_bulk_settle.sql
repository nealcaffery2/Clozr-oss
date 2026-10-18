-- 355: a bulk send batch is settled from its rows even when the run that
-- claimed its last rows died.
--
-- docs-plus bulkTick claims each row (queued -> failed 'send outcome unknown;
-- not retried', then sent, skipped or failed) and recounts the batch at the
-- end of the run. A run killed after claiming the last queued rows never
-- recounts, and this kick only calls bulk_tick while a row is queued, so the
-- batch stayed 'running' with stale sent/failed counts.
--
-- Now every kick first recounts each batch that has rows and none queued,
-- and writes sent, failed and status ('failed' when nothing sent and
-- something failed, else 'done', the tick's rule) where they differ. It
-- touches bulk_sends only: no row changes status, nothing is sent.
--
-- Which batches: queued or running ones, and ones finished in the last 15
-- minutes. A row is written last at most 400 s after its claim (the edge
-- runtime's wall clock), and no row is claimed once none is queued, which
-- is before any settle. So a settle that ran while a claim was still in
-- flight is corrected by a kick (every 2 minutes, 348) inside the window.
-- finished_at keeps the first settle's time. Cancelled batches are left as
-- they are. Rest of the kick is the live body (179). Safe to
-- re-run.

create or replace function public.docs_bulk_kick() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  update public.bulk_sends b
     set sent = x.sent, failed = x.failed, status = x.status, finished_at = coalesce(b.finished_at, now())
    from (select i.bulk_send_id,
                 count(*) filter (where i.status = 'sent')::int sent,
                 count(*) filter (where i.status = 'failed')::int failed,
                 case when count(*) filter (where i.status = 'failed') > 0 and count(*) filter (where i.status = 'sent') = 0 then 'failed' else 'done' end status
            from public.bulk_send_items i
           where i.bulk_send_id in (select id from public.bulk_sends where status in ('queued', 'running') or finished_at > now() - interval '15 minutes')
           group by i.bulk_send_id
          having count(*) filter (where i.status = 'queued') = 0) x
   where b.id = x.bulk_send_id and b.status <> 'cancelled'
     and (b.sent, b.failed, b.status) is distinct from (x.sent, x.failed, x.status);

  if not exists (select 1 from public.bulk_send_items where status = 'queued') then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/docs-plus',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"bulk_tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.docs_bulk_kick() from public, anon, authenticated;
