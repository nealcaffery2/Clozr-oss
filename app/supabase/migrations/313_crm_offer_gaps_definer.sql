-- 313 · crm_offer_gaps as one security definer read.
--
-- 280 made it security invoker over the offer_gaps and offer_gap_people
-- views (70), so every row of deals, deal_parties, vendors, properties and
-- sellers ran its row policy, and offer_gaps found each deal's wholesaler
-- with a LATERAL probe per deal. Mean about 580 ms in production; 321 ms
-- for an owner run on its own.
--
-- Now: the membership check once (my_workspace_ids()), the views' logic
-- inline, and each deal's first wholesaler party (by id, as the LATERAL
-- picked it) from one DISTINCT ON pass. The row rules the policies applied
-- for the caller are kept, written once:
--
--   deals, sellers, properties, vendors   the workspace's own rows only. A
--                                         joined row (house, vendor, seller)
--                                         must be in p_ws too, so a row
--                                         pointed at another workspace's id
--                                         carries nothing from it.
--   deal_parties                          deal_parties_select: a party with
--                                         a buyer on it only for the buyer
--                                         roles (owner, admin, dispositions,
--                                         sdr, tc, member). A wholesaler
--                                         party is never role 'buyer'.
--
-- Not a member: {"gaps": [], "people": []}, what the policies answered
-- before. Same keys, values and order as 280 sends, so lib/crm.ts
-- (enrichWorkspace, mapOfferGaps, mapOfferGapPeople) does not change. One
-- numeric can print with a different scale when equal values tie in a
-- min() (10000 vs 10000.0); JSON.parse reads both as 10000.
--
-- Measured on a large workspace, as the
-- owner, an acquisitions rep and a partnerships rep: output identical to the
-- old function for each (gaps md5, people as a set and in order); 321 ms ->
-- 125 ms (generic plan, as the function runs), about a third of the buffers.
--
-- The return type changes (jsonb -> json), so the function is dropped and
-- created again. The views stay for lib/crm.ts' paged fallback. Safe to
-- re-run.

drop function if exists public.crm_offer_gaps(bigint);

create function public.crm_offer_gaps(p_ws bigint)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with wp as (
    select distinct on (dp.deal_id) dp.deal_id, dp.vendor_id, dp.company, dp.name, dp.email, dp.phone
      from public.deal_parties dp
     where dp.workspace_id = p_ws and dp.role = 'wholesaler'
       and (dp.buyer_id is null
            or p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member')))
     order by dp.deal_id, dp.id
  ), g as (
    select d.id as deal_id, d.seller_id, wp.vendor_id,
           coalesce(wp.company, v.business_name) as company, coalesce(wp.name, v.contact_name) as contact,
           coalesce(wp.email, v.email) as email, coalesce(wp.phone, v.phone) as phone,
           p.line1 as address, d.lead_stage, d.asking_price, d.offer_amount, d.mao as uw_high,
           d.asking_price - d.offer_amount as gap_to_offer, d.asking_price - d.mao as gap_to_high,
           least(abs(d.asking_price - d.offer_amount), coalesce(abs(d.asking_price - d.mao), abs(d.asking_price - d.offer_amount))) as closest_gap,
           d.updated_at
      from public.deals d
      left join wp on wp.deal_id = d.id
      left join public.vendors v on v.id = wp.vendor_id and v.workspace_id = p_ws
      left join public.properties p on p.id = d.property_id and p.workspace_id = p_ws
     where d.workspace_id = p_ws and d.offer_amount > 0 and d.asking_price > 0
  ), rolled as (
    select 'vendor'::text as party_kind, g.vendor_id as party_id, g.company, g.contact, g.email, g.phone,
           g.lead_stage, g.gap_to_offer, g.gap_to_high, g.closest_gap, g.updated_at
      from g
     where g.vendor_id is not null
    union all
    select 'seller'::text, g.seller_id, null::text, s.name, s.email, s.phone,
           g.lead_stage, g.gap_to_offer, g.gap_to_high, g.closest_gap, g.updated_at
      from g
      join public.sellers s on s.id = g.seller_id and s.workspace_id = p_ws
     where s.archived_at is null
  )
  select case
    when p_ws in (select public.my_workspace_ids()) then json_build_object(
      'gaps', coalesce((
        select json_agg(row_to_json(x) order by x.closest_gap, x.deal_id)
          from (
            select deal_id, seller_id, vendor_id, company, contact, address, lead_stage, asking_price, offer_amount,
                   uw_high, gap_to_offer, gap_to_high, closest_gap, updated_at
              from g
          ) x), '[]'::json),
      'people', coalesce((
        select json_agg(row_to_json(x) order by x.close_calls desc, x.party_id)
          from (
            select party_kind, party_id, max(company) as company, max(contact) as contact, max(email) as email,
                   max(phone) as phone, count(*) as offers,
                   count(*) filter (where abs(gap_to_offer) <= 20000::numeric or abs(gap_to_high) <= 20000::numeric) as close_calls,
                   min(closest_gap) as closest_gap, min(abs(gap_to_offer)) as closest_gap_to_offer,
                   min(abs(gap_to_high)) as closest_gap_to_high,
                   count(*) filter (where lead_stage = 'Offer Declined') as declined,
                   count(*) filter (where lead_stage = any (array['Under Contract - Buyer', 'Closed'])) as won,
                   max(updated_at) as last_offer_at
              from rolled
             group by party_kind, party_id
          ) x), '[]'::json))
    else json_build_object('gaps', '[]'::json, 'people', '[]'::json)
  end;
$$;

revoke all on function public.crm_offer_gaps(bigint) from public, anon;
grant execute on function public.crm_offer_gaps(bigint) to authenticated;
