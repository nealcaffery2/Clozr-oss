-- Provider photos on every deal that has a provider report, with the front of the
-- house as the cover.
--
-- compr-underwrite writes the photo set (deal_files, source compr) and the
-- hero (deals.hero_image_url) only when a run completes or someone asks for
-- assets. Deals linked before that path existed kept a hero and no photo set.
-- This kicks compr-underwrite's sync_photos action nightly for each workspace
-- with a provider-linked deal: pointers to the provider's photo proxy, nothing billed,
-- and a front that was already picked stays the front.
--
-- A provider photo set also makes the front the only cover on the deal.

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

-- One cover per deal: setting a photo as the front clears the others.
create or replace function public.deal_files_one_cover()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.is_cover and new.kind = 'photo' then
    update public.deal_files set is_cover = false
    where deal_id = new.deal_id and kind = 'photo' and is_cover and id <> new.id;
  end if;
  return new;
end $$;
drop trigger if exists deal_files_one_cover on public.deal_files;
create trigger deal_files_one_cover after insert or update of is_cover on public.deal_files
  for each row when (new.is_cover) execute function public.deal_files_one_cover();

-- 10:37 UTC nightly, before the 10:47 dispo match refresh.
select cron.unschedule('clozr-compr-photo-sync') where exists (select 1 from cron.job where jobname = 'clozr-compr-photo-sync');
select cron.schedule('clozr-compr-photo-sync', '37 10 * * *', 'select public.compr_photo_sync_kick()');
