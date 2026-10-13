-- 176 · Send photo-less deals to the provider every hour, a few at a time.
--
-- A partner's photo page can need a portal login, which the provider holds, and a
-- vendor sheet can arrive with only addresses. Those
-- deals had no photos and nothing ever sent them to the provider. compr-underwrite's
-- photo_sweep picks deals with no photos and no provider report (a photo link,
-- or a New Submission / Underwriting house; never a declined or dead one),
-- houses in underwriting first, up to 15 per run, each at most once a day,
-- and round-trips them: an underwrite with every photo link, then
-- The provider's photo set written back. Each one is a provider run, which is why the
-- batch stays under the 20-an-hour ingest budget.

-- The deals one sweep sends.
create or replace function public.compr_photo_sweep_candidates(p_workspace_id bigint, p_limit integer default 15)
returns table (deal_id bigint, seller_id bigint) language sql stable security definer set search_path = public as $$
  select d.id, d.seller_id
  from public.deals d
  where d.workspace_id = p_workspace_id
    and d.archived_at is null and d.seller_id is not null and d.property_id is not null
    and (d.photos_url is not null or d.lead_stage in ('New Submission', 'Underwriting'))
    -- A declined or dead house is not worth a run.
    and coalesce(d.lead_stage, '') not in ('Offer Declined', 'Underwrite Declined', 'Dead')
    and coalesce(d.underwriting_url, '') not ilike '%underwriting.example.com%'
    and coalesce(d.compr_report_url, '') not ilike '%underwriting.example.com%'
    and (d.compr_photos_synced_at is null or d.compr_photos_synced_at < now() - interval '1 day')
    and not exists (select 1 from public.deal_files f where f.deal_id = d.id and f.kind = 'photo')
  -- Houses being underwritten now first, then accepted, then offers out.
  order by case
      when d.lead_stage in ('New Submission', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete') then 0
      when d.lead_stage = 'Offer Accepted' then 1
      else 2 end,
    d.submitted_at desc nulls last, d.id desc
  limit greatest(1, least(coalesce(p_limit, 15), 15))
$$;
revoke execute on function public.compr_photo_sweep_candidates(bigint, integer) from public, anon, authenticated;
grant execute on function public.compr_photo_sweep_candidates(bigint, integer) to service_role;

create or replace function public.compr_photo_sweep_kick(p_workspace_id bigint default null)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text; w record; n integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return 0; end if;
  for w in
    select ws.id as workspace_id from public.workspaces ws
    where (p_workspace_id is null or ws.id = p_workspace_id)
      and exists (select 1 from public.compr_photo_sweep_candidates(ws.id, 1))
  loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/compr-underwrite',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('action', 'photo_sweep', 'workspace_id', w.workspace_id, 'limit', 15),
      timeout_milliseconds := 60000);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.compr_photo_sweep_kick(bigint) from public, anon, authenticated;

select cron.unschedule('clozr-compr-photo-sweep') where exists (select 1 from cron.job where jobname = 'clozr-compr-photo-sweep');
select cron.schedule('clozr-compr-photo-sweep', '7 * * * *', 'select public.compr_photo_sweep_kick()');
