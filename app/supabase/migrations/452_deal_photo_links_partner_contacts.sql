-- deal_photo_links: a partner contact's old photo links no longer ride on their newest deal.
--
-- Migration 120 read the seller's "Photos:" note line and Jotform intake photos
-- into a deal's links when the deal sat on the seller's own property. For a
-- partner contact (one seller row, dozens of deals) sellers.property_id is
-- whatever their latest submission set, so the newest deal always matched and
-- picked up albums from the partner's earlier houses. Deal 5701 (414 Old
-- Cedartown Rd, Rockmart GA) went to COMPR on 2026-10-29 with its own album plus
-- 200 Derby Dr (the seller note) and 4762 Kestrel Dr (the intake), and the report
-- graded 64 photos of three houses.
--
-- The seller's own notes and intake count only when every deal of theirs is on
-- one property. A homeowner with a re-submitted deal still qualifies; a partner
-- with many houses never does. Safe to re-run.

create or replace function public.deal_photo_links(p_deal_id bigint)
returns text[] language sql stable security definer set search_path = public, pg_temp as $$
  with d as (
    select id, seller_id, property_id, photos_url, notes from public.deals where id = p_deal_id
  ), s as (
    select s.notes, s.intake from public.sellers s join d on s.id = d.seller_id
     where (select count(distinct x.property_id) from public.deals x where x.seller_id = s.id) = 1
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
