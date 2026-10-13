-- Google Drive photo folders become photos on the deal.
--
-- 784 deals carry a Podio photos folder as a link row, 314 more only as a
-- "Photos:" line in the seller's notes, and nothing ever opened one: the
-- record drew Street View for a house with forty photos in Drive. The
-- drive-photos function reads each folder, subfolders included, the way
-- The provider's resolver does (_shared/drive-photos.ts) and writes one photo row
-- per image, source 'drive', pointing at Google's image server. Nothing is
-- copied, and the folder stays the source: a re-read replaces the rows.
--
-- A deal with provider photos is left alone. canonicalPhotos shows the provider's set
-- when there is one, so a second copy of the same shoot would only be noise.

alter table public.deals
  add column if not exists photos_url text,
  add column if not exists drive_photos_synced_at timestamptz;

-- deal_files.category is 175's column; these functions read it, so a fresh
-- database (where 175 has not run yet) needs it here first.
alter table public.deal_files
  add column if not exists category text;

-- Every photo link a deal has, wherever it was written down: the Files rows
-- (Podio's "Podio photos folder", Jotform's "Photos", pasted photo links),
-- deals.photos_url, and the "Photos:" lines the Podio import left in the
-- deal's and the seller's notes. A seller's own notes only speak for the deal
-- on the seller's own property (or their only deal): a partner contact holds
-- many deals, and their notes describe one house.
create or replace function public.deal_photo_links(p_deal_id bigint)
returns text[] language sql stable security definer set search_path = public, pg_temp as $$
  with d as (
    select id, seller_id, property_id, photos_url, notes from public.deals where id = p_deal_id
  ), s as (
    select s.notes, s.intake from public.sellers s join d on s.id = d.seller_id
     where s.property_id = d.property_id
        or (select count(*) from public.deals x where x.seller_id = s.id) = 1
  ), raw(o, txt) as (
    select 1, f.url from public.deal_files f
     where f.deal_id = p_deal_id and f.url is not null
       and ((f.kind = 'link' and (f.category = 'photos' or f.name ~* '^(podio )?photos'))
         or (f.kind = 'photo' and f.storage_path is null and coalesce(f.source, '') not in ('compr', 'drive')))
    union all select 2, d.photos_url from d
    union all select 3, m[1] from d, regexp_matches(coalesce(d.notes, ''), 'Photos:([^\n]*)', 'g') m
    union all select 4, m[1] from s, regexp_matches(coalesce(s.notes, ''), 'Photos:([^\n]*)', 'g') m
    union all select 5, s.intake->>'photos' from s
  ), urls as (
    select o, rtrim(u[1], '.;)') as url
      from raw, regexp_matches(coalesce(raw.txt, ''), 'https?://[^[:space:],<>"'']+', 'g') u
  )
  select coalesce(array_agg(url order by o, url), '{}')
    from (select url, min(o) as o from urls group by url) x;
$$;

-- Deals the cron should read: a Drive link, no provider set, not read this week.
-- The same places deal_photo_links reads, as one set query: 0.3s over 4,200
-- deals against 1.2s calling that function per deal, and both found the same
-- 865 deals when written. A new place to read goes in both.
create or replace function public.drive_photo_queue(p_limit integer default 20)
returns table (deal_id bigint, workspace_id bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with drive(id) as (
    select f.deal_id from public.deal_files f
     where f.url ~* '^https?://drive\.google\.com/'
       and ((f.kind = 'link' and (f.category = 'photos' or f.name ~* '^(podio )?photos'))
         or (f.kind = 'photo' and f.storage_path is null and coalesce(f.source, '') not in ('compr', 'drive')))
    union
    select d.id from public.deals d
     where d.photos_url ~* 'drive\.google\.com/' or d.notes ~* 'Photos:[^\n]*drive\.google\.com/'
    union
    select d.id from public.deals d join public.sellers s on s.id = d.seller_id
     where (s.notes ~* 'Photos:[^\n]*drive\.google\.com/' or s.intake->>'photos' ~* 'drive\.google\.com/')
       and (s.property_id = d.property_id or not exists (select 1 from public.deals x where x.seller_id = s.id and x.id <> d.id))
  )
  select d.id, d.workspace_id
    from public.deals d join drive using (id)
   where (d.drive_photos_synced_at is null or d.drive_photos_synced_at < now() - interval '7 days')
     and not exists (select 1 from public.deal_files f where f.deal_id = d.id and f.kind = 'photo' and f.source = 'compr')
   order by d.drive_photos_synced_at nulls first, d.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- One deal's Drive photos, replaced in one transaction. The deal row lock
-- serialises the cron and a record open reading the same folder at once.
-- A front someone picked stays the front; otherwise the folder's first photo
-- leads, unless the deal already has a front of another kind. The hero is
-- set too, because the record and the Deals cards lead with it: the app's
-- boot read holds one page of photo rows, not every deal's.
create or replace function public.drive_photos_apply(p_deal_id bigint, p_photos jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws bigint;
  v_prev text;
  v_cover text;
  v_taken boolean;
  v_n integer := 0;
begin
  select workspace_id into v_ws from public.deals where id = p_deal_id for update;
  if v_ws is null then return jsonb_build_object('ok', false, 'error', 'deal not found'); end if;

  select url into v_prev from public.deal_files
   where deal_id = p_deal_id and kind = 'photo' and source = 'drive' and is_cover limit 1;
  delete from public.deal_files where deal_id = p_deal_id and kind = 'photo' and source = 'drive';
  select exists (select 1 from public.deal_files where deal_id = p_deal_id and kind = 'photo' and is_cover) into v_taken;
  if not v_taken then
    select coalesce(max(e->>'url') filter (where e->>'url' = v_prev), min(e->>'url') filter (where o = 1))
      into v_cover from jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) with ordinality t(e, o);
  end if;

  insert into public.deal_files (workspace_id, deal_id, kind, name, url, source, source_id, visible_to_buyers, position, is_cover)
  select v_ws, p_deal_id, 'photo', left(coalesce(nullif(e->>'name', ''), 'Drive photo ' || o), 200), e->>'url',
         'drive', 'drive:' || (e->>'id'), true, (o - 1)::integer, coalesce(e->>'url' = v_cover, false)
    from jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) with ordinality t(e, o)
   where coalesce(e->>'url', '') like 'https://%' and coalesce(e->>'id', '') <> ''
  on conflict do nothing;
  get diagnostics v_n = row_count;

  -- The cover row can lose its insert to a link pasted with the same URL.
  select url into v_cover from public.deal_files
   where deal_id = p_deal_id and kind = 'photo' and source = 'drive' and is_cover limit 1;
  if not v_taken then
    update public.deals set hero_image_url = v_cover
     where id = p_deal_id and hero_image_url is distinct from v_cover
       and (hero_image_url is null or hero_image_url like 'https://lh3.googleusercontent.com/d/%');
  end if;
  update public.deals set drive_photos_synced_at = now() where id = p_deal_id;
  return jsonb_build_object('ok', true, 'photos', v_n, 'hero_url', v_cover);
end $$;

-- 25 deals a call every ten minutes clears the ~530-deal backlog in about
-- four hours; after that a tick finds nothing and posts nothing.
create or replace function public.drive_photo_sync_kick()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.drive_photo_queue(1)) then return 0; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return 0; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/drive-photos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('action', 'sync', 'limit', 25),
    timeout_milliseconds := 150000);
  return 1;
end $$;

revoke execute on function public.deal_photo_links(bigint) from public, anon, authenticated;
revoke execute on function public.drive_photo_queue(integer) from public, anon, authenticated;
revoke execute on function public.drive_photos_apply(bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.drive_photo_sync_kick() from public, anon, authenticated;

select cron.unschedule('clozr-drive-photo-sync') where exists (select 1 from cron.job where jobname = 'clozr-drive-photo-sync');
select cron.schedule('clozr-drive-photo-sync', '3-59/10 * * * *', 'select public.drive_photo_sync_kick()');
