-- Buyer matching: archived buyers (migration 131) no longer match, and a
-- buyer is scored against every active-inventory deal, not the 200 newest.
-- Same bodies as migration 98 otherwise.

create or replace function public.match_deal(p_deal_id bigint, p_min integer default 55)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  d record; n integer := 0; price numeric;
begin
  select dl.id, dl.workspace_id, dl.arv, dl.offer_amount, dl.assignment_fee, dl.sold_price, dl.marketed_price,
         p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft, p.year_built, p.property_type, p.condition, p.attributes
  into d
  from public.deals dl left join public.properties p on p.id = dl.property_id
  where dl.id = p_deal_id;
  if d.id is null then return 0; end if;
  price := public.deal_buyer_price(d.sold_price, d.marketed_price, d.offer_amount, d.assignment_fee);

  with scored as (
    select b.id as buyer_id, s.score, s.reasons
    from public.buyers b
    cross join lateral public.score_buyer_deal(b.criteria, price, d.arv, d.city, d.state, d.zip, d.county, d.beds, d.baths, d.sqft, d.year_built, d.property_type, d.condition, coalesce(d.attributes, '{}')) s
    where b.workspace_id = d.workspace_id
      and b.source is distinct from 'dispogenius-free-agents'
      and b.blacklisted_at is null
      and b.archived_at is null
      and lower(coalesce(b.status, '')) not in ('inactive', 'prospect')
  ), up as (
    insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons)
    select d.workspace_id, d.id, buyer_id, score, reasons from scored where score >= p_min
    on conflict (deal_id, buyer_id) do update set score = excluded.score, reasons = excluded.reasons, updated_at = now()
    returning buyer_id
  ), gone as (
    delete from public.deal_buyer_matches m
    where m.deal_id = d.id and m.status = 'matched'
      and not exists (select 1 from up where up.buyer_id = m.buyer_id)
    returning 1
  )
  select count(*) into n from up;
  return n;
end $function$;

create or replace function public.match_buyer(p_buyer_id bigint, p_min integer default 55)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  b record; n integer := 0;
begin
  select id, workspace_id, criteria, blacklisted_at, archived_at, status, source into b from public.buyers where id = p_buyer_id;
  if b.id is null then return 0; end if;
  if b.blacklisted_at is not null or b.archived_at is not null or lower(coalesce(b.status, '')) in ('inactive', 'prospect')
     or b.source = 'dispogenius-free-agents' then
    delete from public.deal_buyer_matches where buyer_id = b.id and status = 'matched';
    return 0;
  end if;

  with inv as (
    select dl.id, dl.arv, public.deal_buyer_price(dl.sold_price, dl.marketed_price, dl.offer_amount, dl.assignment_fee) as price,
           p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft, p.year_built, p.property_type, p.condition, p.attributes
    from public.deals dl join public.deal_stages st on st.label = dl.stage
    left join public.properties p on p.id = dl.property_id
    where dl.workspace_id = b.workspace_id and st.active_inventory
  ), scored as (
    select inv.id as deal_id, s.score, s.reasons
    from inv cross join lateral public.score_buyer_deal(b.criteria, inv.price, inv.arv, inv.city, inv.state, inv.zip, inv.county, inv.beds, inv.baths, inv.sqft, inv.year_built, inv.property_type, inv.condition, coalesce(inv.attributes, '{}')) s
  ), up as (
    insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons)
    select b.workspace_id, deal_id, b.id, score, reasons from scored where score >= p_min
    on conflict (deal_id, buyer_id) do update set score = excluded.score, reasons = excluded.reasons, updated_at = now()
    returning deal_id
  ), gone as (
    delete from public.deal_buyer_matches m
    using scored
    where m.buyer_id = b.id and m.deal_id = scored.deal_id and m.status = 'matched' and scored.score < p_min
    returning 1
  )
  select count(*) into n from up;
  return n;
end $function$;

-- Archived buyers' untouched matches go now; sent / interested rows stay as history.
delete from public.deal_buyer_matches m
using public.buyers b
where b.id = m.buyer_id and b.archived_at is not null and m.status = 'matched';
