-- Source photo links the Photos button can open.
--
-- A submission's photo folder (Drive, Dropbox, Zillow, CompanyCam, a listing)
-- lived on deals.photos_url, a "Photos:" line in the notes, or the seller's
-- intake, and the Photos button only opened kind=photo rows. This files every
-- such URL as kind=link, category=photos. A real image the import stored as
-- kind=photo is left as it is. Underwriting provider URLs are the provider's own set.
--
-- A seller's intake or notes speak only for the deal on that seller's property,
-- or their only deal: a partner contact holds many houses.
--
-- New "Photos" link rows (ingest writes the name and leaves category empty)
-- get category photos on the way in.

alter table public.deal_files
  add column if not exists category text;

create or replace function public.deal_files_label_photo_link()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'link'
     and new.category is null
     and new.url is not null
     and new.name ~* '^(podio )?photos$' then
    new.category := 'photos';
  end if;
  return new;
end $$;

revoke all on function public.deal_files_label_photo_link() from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'deal_files_label_photo_link') then
    create trigger deal_files_label_photo_link
      before insert or update of name, kind, category, url
      on public.deal_files
      for each row execute function public.deal_files_label_photo_link();
  end if;
end $$;

-- Jotform rows named Photos that landed with no category.
update public.deal_files
   set category = 'photos'
 where kind = 'link'
   and category is null
   and url is not null
   and name ~* '^(podio )?photos$';

-- Every source URL that is not already a row on that deal.
insert into public.deal_files (workspace_id, deal_id, kind, name, url, source, category)
select r.workspace_id, r.deal_id, 'link', 'Photos', r.url, r.source, 'photos'
  from (
    select raw.workspace_id, raw.deal_id, min(raw.source) as source, rtrim(u[1], '.;)') as url
      from (
        select d.workspace_id, d.id as deal_id, coalesce(nullif(d.source, ''), 'source') as source, d.photos_url as txt
          from public.deals d
         where d.photos_url ~* 'https?://'
        union all
        select d.workspace_id, d.id, coalesce(nullif(d.source, ''), 'source'), m[1]
          from public.deals d,
               regexp_matches(d.notes, 'Photos:([^\n]*)', 'gi') m
         where d.notes ~* 'Photos:'
        union all
        select d.workspace_id, d.id, coalesce(nullif(d.source, ''), 'source'), s.intake->>'photos'
          from public.deals d
          join public.sellers s on s.id = d.seller_id
          left join (
            select seller_id from public.deals where seller_id is not null group by seller_id having count(*) = 1
          ) one on one.seller_id = s.id
         where coalesce(s.intake->>'photos', '') ~* 'https?://'
           and ((s.property_id is not null and s.property_id = d.property_id) or one.seller_id is not null)
        union all
        select d.workspace_id, d.id, coalesce(nullif(d.source, ''), 'source'), m[1]
          from public.deals d
          join public.sellers s on s.id = d.seller_id
          left join (
            select seller_id from public.deals where seller_id is not null group by seller_id having count(*) = 1
          ) one on one.seller_id = s.id
          cross join lateral regexp_matches(s.notes, 'Photos:([^\n]*)', 'gi') m
         where s.notes ~* 'Photos:'
           and ((s.property_id is not null and s.property_id = d.property_id) or one.seller_id is not null)
      ) raw,
      regexp_matches(coalesce(raw.txt, ''), 'https?://[^[:space:],<>"'']+', 'gi') u
     group by raw.workspace_id, raw.deal_id, rtrim(u[1], '.;)')
  ) r
 where r.url !~* 'underwriting\.example\.com'
   and not exists (
     select 1 from public.deal_files f where f.deal_id = r.deal_id and f.url = r.url
   );
