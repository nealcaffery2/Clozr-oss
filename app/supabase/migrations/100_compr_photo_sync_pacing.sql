-- Walk every provider-linked deal instead of re-reading the newest 60.
--
-- A workspace can have well over a thousand deals linked to a provider report. sync_photos took
-- the 60 most recently updated, and writing the photos bumps updated_at, so
-- the nightly run kept re-reading the same 60. Each deal now carries when its
-- photos were last pulled; sync_photos takes never-synced deals first, then
-- any older than a week, and the job runs every 10 minutes. Once the list is
-- caught up a run finds nothing due and does no provider calls.

alter table public.deals add column if not exists compr_photos_synced_at timestamptz;

update public.deals d set compr_photos_synced_at = now()
where d.compr_photos_synced_at is null
  and exists (select 1 from public.deal_files f where f.deal_id = d.id and f.source = 'compr' and f.kind = 'photo');

create or replace function public.compr_photo_sync_kick(p_workspace_id bigint default null)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text; w record; n integer := 0;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return 0; end if;
  for w in
    select distinct d.workspace_id
    from public.deals d
    where (p_workspace_id is null or d.workspace_id = p_workspace_id)
      and (d.underwriting_url ilike '%underwriting.example.com/r/%' or d.hero_image_url ilike '%underwriting.example.com/api/photo%')
      and (d.compr_photos_synced_at is null or d.compr_photos_synced_at < now() - interval '7 days')
  loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/compr-underwrite',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('action', 'sync_photos', 'workspace_id', w.workspace_id, 'limit', 60),
      timeout_milliseconds := 150000);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.compr_photo_sync_kick(bigint) from public, anon, authenticated;

select cron.unschedule('clozr-compr-photo-sync') where exists (select 1 from cron.job where jobname = 'clozr-compr-photo-sync');
select cron.schedule('clozr-compr-photo-sync', '*/10 * * * *', 'select public.compr_photo_sync_kick()');
