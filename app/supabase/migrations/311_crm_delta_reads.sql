-- 311 · crm_sellers and crm_deals answer a delta read from indexes.
--
-- A delta read (p_since set) returns the rows changed since then: the row
-- itself, or its house (properties). 292 wrote that as one filter across the
-- join, `s.updated_at >= p_since or p.updated_at >= p_since`, which no index
-- can answer, so every reload read every live seller
-- or deal and hashed every house to return a few dozen rows.
--
-- The changed ids are now a UNION of two indexed branches: rows changed since
-- (sellers_workspace_idx, deals_ws_updated_idx from 310) and rows whose house
-- changed since (properties_ws_updated_idx, then sellers_property_idx or
-- deals_property_id_idx). The rows are read by those ids on the primary key.
-- A full read (p_since null) keeps 292's plan; the two branches of `rows`
-- select the same columns and must stay in step.
--
-- Same keys, same values, same order as 292. podio and moves are unchanged:
-- lib/crm.ts takes them whole from every call, so a delta that left out
-- unchanged items would drop them on the client.
--
-- Every branch reads only p_ws rows (c, h and p all filter on workspace_id),
-- so a seller or deal pointed at another workspace's house carries nothing
-- from it, as in 292.
--
-- Measured on a large workspace as the owner, the new bodies as
-- prepared statements with generic plans (how a SQL function runs), since one
-- hour back, before 310's index:
--
--   crm_sellers delta   67 ms -> 29 ms  (24 ms of it is the unchanged ids list)
--   crm_deals delta     79 ms -> 46 ms  (the rest is podio + moves, and the
--                                        deals scan 310's index removes)
--   full reads          same plan as 292 (crm_sellers 765 ms -> 620 ms)
--
-- Output md5 identical to the live functions for since = null, 1 hour, 1 day,
-- 7 days and 30 days back, both functions.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- crm_sellers
-- ---------------------------------------------------------------------------

create or replace function public.crm_sellers(p_ws bigint, p_since timestamptz default null)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
set work_mem = '32MB'
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then json_build_object(
      'ids', case when p_since is null then null else coalesce((
        select json_agg(s.id order by s.id)
          from public.sellers s
         where s.workspace_id = p_ws and s.archived_at is null), '[]'::json) end,
      'rows', coalesce(case when p_since is null then (
        select json_agg(json_strip_nulls(row_to_json(x)) order by x.created_at desc, x.id desc)
          from (
            select s.id, s.name, s.email, s.phone, s.property_address, s.asking_price, s.motivation, s.timeline,
                   s.condition, s.occupancy, s.mortgage, s.desired_close, s.decision_makers, s.intake, s.lead_stage,
                   s.stage_entered_at, s.notes_list as notes, s.source, s.created_at, s.created_by, s.property_id,
                   s.assigned_to, s.tags, s.updated_at, s.underwriter_id, s.last_touch_at, s.last_touch_channel,
                   case when p.id is null then null else json_strip_nulls(json_build_object(
                     'id', p.id, 'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip,
                     'beds', p.beds, 'baths', p.baths, 'sqft', p.sqft, 'year_built', p.year_built,
                     'property_type', p.property_type, 'apn', p.apn, 'lat', p.lat, 'lng', p.lng)) end as properties
              from public.sellers s
              left join public.properties p on p.id = s.property_id and p.workspace_id = p_ws
             where s.workspace_id = p_ws and s.archived_at is null
          ) x)
      else (
        select json_agg(json_strip_nulls(row_to_json(x)) order by x.created_at desc, x.id desc)
          from (
            select s.id, s.name, s.email, s.phone, s.property_address, s.asking_price, s.motivation, s.timeline,
                   s.condition, s.occupancy, s.mortgage, s.desired_close, s.decision_makers, s.intake, s.lead_stage,
                   s.stage_entered_at, s.notes_list as notes, s.source, s.created_at, s.created_by, s.property_id,
                   s.assigned_to, s.tags, s.updated_at, s.underwriter_id, s.last_touch_at, s.last_touch_channel,
                   case when p.id is null then null else json_strip_nulls(json_build_object(
                     'id', p.id, 'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip,
                     'beds', p.beds, 'baths', p.baths, 'sqft', p.sqft, 'year_built', p.year_built,
                     'property_type', p.property_type, 'apn', p.apn, 'lat', p.lat, 'lng', p.lng)) end as properties
              from public.sellers s
              left join public.properties p on p.id = s.property_id and p.workspace_id = p_ws
             where s.workspace_id = p_ws and s.archived_at is null
               and s.id = any (array(
                 select c.id from public.sellers c where c.workspace_id = p_ws and c.updated_at >= p_since
                 union
                 select c.id from public.sellers c
                  where c.workspace_id = p_ws and c.property_id = any (array(
                    select h.id from public.properties h where h.workspace_id = p_ws and h.updated_at >= p_since))))
          ) x) end, '[]'::json))
    else null
  end;
$$;

-- ---------------------------------------------------------------------------
-- crm_deals
-- ---------------------------------------------------------------------------

create or replace function public.crm_deals(p_ws bigint, p_since timestamptz default null)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
set work_mem = '32MB'
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then json_build_object(
      'ids', case when p_since is null then null else coalesce((
        select json_agg(d.id order by d.id) from public.deals d where d.workspace_id = p_ws), '[]'::json) end,
      'rows', coalesce(case when p_since is null then (
        select json_agg(json_strip_nulls(row_to_json(x)) order by x.id)
          from (
            select d.id, d.seller_id, d.property_id, d.lead_stage, d.asking_price, d.submitted_at, d.target_assignment,
                   d.marketing_headline, d.marketing_description, d.marketing_url, d.garage_spaces, d.stage, d.stage_entered_at,
                   d.offer_amount, d.arv, d.rehab, d.mao, d.wholesale_offer, d.institutional_offer, d.assignment_fee,
                   d.hero_image_url, d.photos_url, d.buyer_report_url, d.compr_cma_url, d.contract_date, d.close_date,
                   d.option_ends_on, d.buyer_option_ends_on, d.owner_id, d.market, d.updated_at, d.buyer_id,
                   d.underwriting_url, d.compr_report_url, d.title_vendor_id, d.title_contact, d.title_email, d.title_phone,
                   d.earnest_money, d.condition_notes, d.occupancy_notes, d.dispo_rep_id, d.tc_rep_id, d.marketing_started_on,
                   d.tracker_no, d.closed_on, d.sold_price, d.price_drop, d.marketed_price, d.marketed_fee, d.dispo_upsell,
                   d.dispo_fee, d.transaction_type, d.contract_status, d.lead_source, d.acq_agent, d.dispo_agent, d.lead_manager,
                   d.coordinator, d.created_at, d.archived_at, d.archived_reason,
                   d.underwriter_id, d.offer_low_set_at, d.offer_high_set_at,
                   case when p.id is null then null else json_build_object(
                     'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip, 'lat', p.lat, 'lng', p.lng) end as properties
              from public.deals d
              left join public.properties p on p.id = d.property_id and p.workspace_id = p_ws
             where d.workspace_id = p_ws
          ) x)
      else (
        select json_agg(json_strip_nulls(row_to_json(x)) order by x.id)
          from (
            select d.id, d.seller_id, d.property_id, d.lead_stage, d.asking_price, d.submitted_at, d.target_assignment,
                   d.marketing_headline, d.marketing_description, d.marketing_url, d.garage_spaces, d.stage, d.stage_entered_at,
                   d.offer_amount, d.arv, d.rehab, d.mao, d.wholesale_offer, d.institutional_offer, d.assignment_fee,
                   d.hero_image_url, d.photos_url, d.buyer_report_url, d.compr_cma_url, d.contract_date, d.close_date,
                   d.option_ends_on, d.buyer_option_ends_on, d.owner_id, d.market, d.updated_at, d.buyer_id,
                   d.underwriting_url, d.compr_report_url, d.title_vendor_id, d.title_contact, d.title_email, d.title_phone,
                   d.earnest_money, d.condition_notes, d.occupancy_notes, d.dispo_rep_id, d.tc_rep_id, d.marketing_started_on,
                   d.tracker_no, d.closed_on, d.sold_price, d.price_drop, d.marketed_price, d.marketed_fee, d.dispo_upsell,
                   d.dispo_fee, d.transaction_type, d.contract_status, d.lead_source, d.acq_agent, d.dispo_agent, d.lead_manager,
                   d.coordinator, d.created_at, d.archived_at, d.archived_reason,
                   d.underwriter_id, d.offer_low_set_at, d.offer_high_set_at,
                   case when p.id is null then null else json_build_object(
                     'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip, 'lat', p.lat, 'lng', p.lng) end as properties
              from public.deals d
              left join public.properties p on p.id = d.property_id and p.workspace_id = p_ws
             where d.workspace_id = p_ws
               and d.id = any (array(
                 select c.id from public.deals c where c.workspace_id = p_ws and c.updated_at >= p_since
                 union
                 select c.id from public.deals c
                  where c.workspace_id = p_ws and c.property_id = any (array(
                    select h.id from public.properties h where h.workspace_id = p_ws and h.updated_at >= p_since))))
          ) x) end, '[]'::json),
      'podio', coalesce((
        select json_agg(json_build_object('item_id', i.item_id, 'deal_id', i.deal_id, 'podio_stage', i.podio_stage,
                                          'created_on', i.created_on, 'note', i.note) order by i.item_id)
          from public.podio_items i
         where i.workspace_id = p_ws and i.app_key = 'submissions'), '[]'::json),
      'moves', coalesce((
        select json_agg(json_build_object('id', e.id, 'entity_id', e.entity_id, 'to_stage', e.to_stage, 'changed_at', e.changed_at)
                        order by e.changed_at, e.id)
          from public.stage_events e
         where e.workspace_id = p_ws and e.entity_type = 'deal' and e.field = 'lead_stage' and e.changed_by is not null), '[]'::json))
    else null
  end;
$$;
