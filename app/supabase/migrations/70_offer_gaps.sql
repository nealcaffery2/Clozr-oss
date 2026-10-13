-- 70: offer gaps — how close our offer came to what the wholesaler asked.
--
-- Two read-only views, no table changes. The unit of the first is a deal we
-- actually made an offer on; the unit of the second is the person to call back.
--
-- Gap is measured two ways, because they answer different questions:
--   gap_to_offer — ask minus the number we actually sent. What the seller saw.
--   gap_to_high  — ask minus our underwriting ceiling (deals.mao). What we
--                  could have sent. Often the wider of the two: 7627 Rudder
--                  underwrote to 276k and we offered 240k, so the ask sat 37k
--                  above the offer and closer to the ceiling.
-- closest_gap keeps the smaller absolute of the two, so one sort finds every
-- deal that was within striking distance on either basis.
--
-- A deal can carry more than one wholesaler party (two do today), so the
-- party is picked deterministically by lowest id rather than joined straight,
-- which would double-count those deals.
--
-- security_invoker means both views read the base tables as the caller, so
-- workspace isolation is the deals/vendors/sellers policies and there is
-- nothing new to keep in sync.

create or replace view public.offer_gaps with (security_invoker = true) as
select
  d.id                                             as deal_id,
  d.workspace_id,
  d.lead_stage,
  d.stage,
  d.market,
  d.seller_id,
  wp.vendor_id,
  coalesce(wp.company, v.business_name)            as company,
  coalesce(wp.name, v.contact_name)                as contact,
  coalesce(wp.email, v.email)                      as email,
  coalesce(wp.phone, v.phone)                      as phone,
  p.line1                                          as address,
  p.city,
  p.state,
  d.asking_price,
  d.offer_amount,
  d.mao                                            as uw_high,
  d.asking_price - d.offer_amount                   as gap_to_offer,
  d.asking_price - d.mao                            as gap_to_high,
  least(
    abs(d.asking_price - d.offer_amount),
    coalesce(abs(d.asking_price - d.mao), abs(d.asking_price - d.offer_amount))
  )                                                as closest_gap,
  d.submitted_at,
  d.updated_at
from public.deals d
left join lateral (
  select dp.vendor_id, dp.company, dp.name, dp.email, dp.phone
  from public.deal_parties dp
  where dp.deal_id = d.id and dp.role = 'wholesaler'
  order by dp.id
  limit 1
) wp on true
left join public.vendors v on v.id = wp.vendor_id
left join public.properties p on p.id = d.property_id
where d.offer_amount > 0 and d.asking_price > 0;

comment on view public.offer_gaps is
  'One row per deal we offered on: the ask, the offer we sent, the underwriting ceiling, and the gap on each basis.';

-- Per-person rollup. Two kinds of person sit on an offered deal: the
-- wholesaler contact (a vendor) and, when we have one, the seller. They share
-- a shape so the People list can filter and sort both the same way, keyed by
-- (party_kind, party_id).
--
-- close_calls counts deals within 20k on either basis, the threshold the call
-- list is built on. There is no 'Offer Accepted' lead stage — a deal we won
-- moves to 'Under Contract - Buyer' or 'Closed' — so `won` reads those and
-- `terminated` is kept apart rather than folded into either side.

create or replace view public.offer_gap_people with (security_invoker = true) as
with rolled as (
  select
    'vendor'::text        as party_kind,
    g.vendor_id           as party_id,
    g.workspace_id,
    g.company,
    g.contact,
    g.email,
    g.phone,
    g.lead_stage,
    g.gap_to_offer,
    g.gap_to_high,
    g.closest_gap,
    g.updated_at
  from public.offer_gaps g
  where g.vendor_id is not null
  union all
  select
    'seller'::text,
    g.seller_id,
    g.workspace_id,
    null::text,
    s.name,
    s.email,
    s.phone,
    g.lead_stage,
    g.gap_to_offer,
    g.gap_to_high,
    g.closest_gap,
    g.updated_at
  from public.offer_gaps g
  join public.sellers s on s.id = g.seller_id
  where s.archived_at is null
)
select
  party_kind,
  party_id,
  workspace_id,
  max(company)                                          as company,
  max(contact)                                          as contact,
  max(email)                                            as email,
  max(phone)                                            as phone,
  count(*)                                              as offers,
  count(*) filter (
    where abs(gap_to_offer) <= 20000
       or abs(gap_to_high)  <= 20000
  )                                                     as close_calls,
  min(closest_gap)                                      as closest_gap,
  min(abs(gap_to_offer))                                as closest_gap_to_offer,
  min(abs(gap_to_high))                                 as closest_gap_to_high,
  count(*) filter (where lead_stage = 'Offer Declined')  as declined,
  count(*) filter (where lead_stage in ('Under Contract - Buyer', 'Closed')) as won,
  count(*) filter (where lead_stage = 'Terminated')      as terminated,
  max(updated_at)                                       as last_offer_at
from rolled
group by party_kind, party_id, workspace_id;

comment on view public.offer_gap_people is
  'Offered deals rolled up to the person to call back — wholesaler contact or seller — with how many times they came within 20k.';

grant select on public.offer_gaps, public.offer_gap_people to authenticated;
