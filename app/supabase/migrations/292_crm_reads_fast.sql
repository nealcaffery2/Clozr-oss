-- 292 · The three big CRM reads under a second, and off the statement timeout.
--
-- Measured as the owner of a large workspace (tens of thousands of sellers
-- and buyers), each call on its own:
--
--   crm_sellers   2,469 ms  (12 MB)   temp spill 1,509 blocks
--   crm_buyers  + crm_deals together 3,856 ms, temp spill 4,190 blocks
--
-- In production over seven days (pg_stat_statements): crm_sellers mean
-- 1,602 ms, max 7,832; crm_buyers mean 1,275, max 7,929; crm_deals mean
-- 1,130, max 7,399. The authenticated role's statement_timeout is 8 s, so
-- the slow tail timed out (23 "canceling statement due to statement timeout"
-- in a day, every one a crm_sellers or crm_buyers call). lib/crm.ts then
-- retried twice with backoff and fell back to paging the table: a cold open
-- that should take two seconds took thirty, and the page storm (eight reads
-- in flight per tab) is what every other tab felt.
--
-- Where the time went, by removing one thing at a time:
--
--   crm_seller_list_notes(notes) per row (two regexp_matches scans)   ~770 ms
--   crm_buy_box_slim(criteria) per row (nested jsonb_each)           ~1,130 ms
--   properties as a correlated subquery per seller / deal              ~300 ms
--   jsonb_agg + jsonb_strip_nulls + `-`/`||` per row vs json_agg       ~600 ms
--
-- So:
--
--   sellers.notes_list    generated, stored: crm_seller_list_notes(notes).
--                         The function is immutable (286), so Postgres keeps
--                         it. One table rewrite.
--   buyers.criteria_slim  kept by trigger buyers_sync_criteria_slim (fires
--                         after buyers_sync_criteria, which sets criteria),
--                         backfilled here for the rows the shell reads (not
--                         the free-agent corpus). A generated column
--                         would rewrite the whole table under an exclusive
--                         lock; a trigger does not. A row not backfilled yet
--                         falls back to the function.
--   crm_sellers / crm_buyers / crm_deals
--                         return json (not jsonb): json_agg appends text,
--                         jsonb_agg builds a tree and re-sorts keys; the wire
--                         format is the same. row_to_json + json_strip_nulls
--                         once per row. The house joins (left join, memoized
--                         by the planner) instead of a subquery per row.
--                         Rows come out in index order (sellers_workspace_
--                         live_created_idx, buyers_workspace_shell_idx,
--                         deals_ws_id_idx), so there is no sort to spill.
--                         crm_deals also strips null keys (it never did:
--                         11 MB → ~6 MB). work_mem 32 MB on each for the
--                         ids aggregate on a delta read.
--
-- Same keys, same values, same order as 280/282/283/286 send, so lib/crm.ts
-- (tableRpc, cachedRead, mapPerson, mapBuyer, mapDeal) does not change.
-- A missing key is null to every mapper (286).
--
-- Measured after, same owner, same workspace, in one rolled-back transaction
-- against the old functions (backfill applied):
--
--   crm_sellers  2,720 ms → 657 ms   11 MB → 10 MB   rows identical
--   crm_buyers   2,123 ms → 316 ms    8 MB → 5 MB    identical once the old
--                                                      rows' nulls are stripped
--   crm_deals      902 ms → 395 ms   11 MB → 6.3 MB  same
--   delta reads (since one hour ago): sellers 47 ms, buyers 297 ms.
--
-- The backfill updates buyers rows, so buyers_touch bumps their updated_at
-- and every open tab's next delta read takes those rows once. Expected.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- sellers.notes_list
-- ---------------------------------------------------------------------------

alter table public.sellers
  add column if not exists notes_list text
  generated always as (public.crm_seller_list_notes(notes)) stored;

-- ---------------------------------------------------------------------------
-- buyers.criteria_slim
-- ---------------------------------------------------------------------------

alter table public.buyers add column if not exists criteria_slim jsonb;

create or replace function public.buyers_sync_criteria_slim()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.criteria_slim is null or new.criteria is distinct from old.criteria then
    new.criteria_slim := public.crm_buy_box_slim(new.criteria);
  end if;
  return new;
end $$;

-- BEFORE triggers fire in name order; this one must follow buyers_sync_criteria.
drop trigger if exists buyers_sync_criteria_slim on public.buyers;
create trigger buyers_sync_criteria_slim
  before insert or update on public.buyers
  for each row execute function public.buyers_sync_criteria_slim();

-- Backfill the rows the shell reads, 2,000 ids at a time (each statement well
-- under a second; the corpus rows stay null and are never selected).
do $$
declare
  lo bigint;
  hi bigint;
  step constant bigint := 2000;
begin
  select min(id), max(id) into lo, hi from public.buyers
   where source is distinct from 'dispogenius-free-agents' and criteria_slim is null;
  if lo is null then return; end if;
  while lo <= hi loop
    update public.buyers
       set criteria_slim = public.crm_buy_box_slim(criteria)
     where id >= lo and id < lo + step
       and source is distinct from 'dispogenius-free-agents'
       and criteria_slim is null;
    lo := lo + step;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- crm_sellers
-- ---------------------------------------------------------------------------

drop function if exists public.crm_sellers(bigint, timestamptz);

create function public.crm_sellers(p_ws bigint, p_since timestamptz default null)
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
      'rows', coalesce((
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
               and (p_since is null or s.updated_at >= p_since
                    or (p.id is not null and p.updated_at >= p_since))
          ) x), '[]'::json))
    else null
  end;
$$;

revoke all on function public.crm_sellers(bigint, timestamptz) from public, anon;
grant execute on function public.crm_sellers(bigint, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- crm_buyers
-- ---------------------------------------------------------------------------

drop function if exists public.crm_buyers(bigint, timestamptz);

create function public.crm_buyers(p_ws bigint, p_since timestamptz default null)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
set work_mem = '32MB'
as $$
  select case
    when p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member')) then json_build_object(
      'ids', case when p_since is null then null else coalesce((
        select json_agg(b.id order by b.id)
          from public.buyers b
         where b.workspace_id = p_ws and b.source is distinct from 'dispogenius-free-agents'), '[]'::json) end,
      'rows', coalesce((
        select json_agg(json_strip_nulls(row_to_json(x)) order by x.name, x.id)
          from (
            select b.id, b.name, b.company, b.email, b.phone, b.markets, b.max_purchase_price, b.buy_box, b.status,
                   b.notes, b.source, b.buyer_type, b.entity_type,
                   coalesce(b.criteria_slim, public.crm_buy_box_slim(b.criteria)) as criteria,
                   b.vetted_at, b.vip, b.blacklisted_at,
                   b.preferred_channel, b.created_at, b.created_by, b.last_activity_at, b.tags, b.updated_at,
                   b.assigned_to, b.archived_at
              from public.buyers b
             where b.workspace_id = p_ws and b.source is distinct from 'dispogenius-free-agents'
               and (p_since is null or b.updated_at >= p_since)
          ) x), '[]'::json))
    else null
  end;
$$;

revoke all on function public.crm_buyers(bigint, timestamptz) from public, anon;
grant execute on function public.crm_buyers(bigint, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- crm_deals
-- ---------------------------------------------------------------------------

drop function if exists public.crm_deals(bigint, timestamptz);

create function public.crm_deals(p_ws bigint, p_since timestamptz default null)
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
      'rows', coalesce((
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
               and (p_since is null or d.updated_at >= p_since
                    or (p.id is not null and p.updated_at >= p_since))
          ) x), '[]'::json),
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

revoke all on function public.crm_deals(bigint, timestamptz) from public, anon;
grant execute on function public.crm_deals(bigint, timestamptz) to authenticated, service_role;

analyze public.sellers;
analyze public.buyers;
