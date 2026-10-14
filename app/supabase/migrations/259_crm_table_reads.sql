-- 259 · The CRM's big tables as one call each, full or delta.
--
-- Opening CLOZR, and every full reload after a save, paged each big table a
-- thousand rows at a time through PostgREST, plus one more read per side
-- column (underwriter, buyer owner, archived buyers, offer bands). The delta
-- reload (lib/delta-rows.ts) still paged every id of sellers and buyers to
-- see deletes, one page after the other.
--
-- Each function here answers with one jsonb value, like seller_last_touch
-- (167). With p_since null: every row of the table. With p_since: every live
-- id plus the rows changed since (a seller or deal whose house changed counts
-- as changed), which lib/crm.ts cachedRead merges over its cache. The side
-- columns ride on the row. A database without these functions pages as before
-- (lib/crm.ts tableRpc answers null and the caller keeps its PostgREST read).
--
-- Security definer with the same membership checks the row policies make:
-- my_workspace_ids() for sellers, deals, podio_items, stage_events and
-- deal_files; the buyer roles (owner, admin, dispositions, sdr, tc, member)
-- for buyers and deal_buyer_matches, as buyers_select and
-- deal_buyer_matches_select do. Anyone else gets null, and the app pages the
-- table, where RLS answers them as it always has. A house is joined only from
-- the same workspace (properties_select's rule): property_id is an id-only
-- foreign key, so a seller or deal pointed at another workspace's house must
-- not carry its address. crm_offer_gaps is security
-- invoker: the two views lean on offers' own policy (an acquisitions rep sees
-- inbound offers only), so the views keep deciding.
--
-- deals.updated_at is kept by a trigger, as sellers, buyers, vendors and
-- properties already do (touch_updated_at), so crm_deals' delta sees every
-- write, including the ones triggers and edge functions make without
-- setting the column. Safe to re-run.

drop trigger if exists deals_touch on public.deals;
create trigger deals_touch
  before update on public.deals
  for each row execute function public.touch_updated_at();

create or replace function public.crm_sellers(p_ws bigint, p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then jsonb_build_object(
      'ids', case when p_since is null then null else coalesce((
        select jsonb_agg(s.id order by s.id)
          from public.sellers s
         where s.workspace_id = p_ws and s.archived_at is null), '[]'::jsonb) end,
      'rows', coalesce((
        select jsonb_agg(to_jsonb(x) || jsonb_build_object('properties', (
                 select jsonb_build_object(
                   'id', p.id, 'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip,
                   'beds', p.beds, 'baths', p.baths, 'sqft', p.sqft, 'year_built', p.year_built,
                   'property_type', p.property_type, 'apn', p.apn, 'lat', p.lat, 'lng', p.lng)
                   from public.properties p where p.id = x.property_id and p.workspace_id = p_ws))
               order by x.created_at desc, x.id desc)
          from (
            select s.id, s.name, s.email, s.phone, s.property_address, s.asking_price, s.motivation, s.timeline,
                   s.condition, s.occupancy, s.mortgage, s.desired_close, s.decision_makers, s.intake, s.lead_stage,
                   s.stage_entered_at, s.notes, s.source, s.created_at, s.created_by, s.property_id, s.assigned_to,
                   s.tags, s.updated_at, s.underwriter_id
              from public.sellers s
             where s.workspace_id = p_ws and s.archived_at is null
               and (p_since is null or s.updated_at >= p_since
                    or exists (select 1 from public.properties p
                                where p.id = s.property_id and p.workspace_id = p_ws and p.updated_at >= p_since))
          ) x), '[]'::jsonb))
    else null
  end;
$$;

create or replace function public.crm_buyers(p_ws bigint, p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member')) then jsonb_build_object(
      'ids', case when p_since is null then null else coalesce((
        select jsonb_agg(b.id order by b.id)
          from public.buyers b
         where b.workspace_id = p_ws and b.source is distinct from 'dispogenius-free-agents'), '[]'::jsonb) end,
      'rows', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.name, x.id)
          from (
            select b.id, b.name, b.company, b.email, b.phone, b.markets, b.max_purchase_price, b.buy_box, b.status,
                   b.notes, b.source, b.buyer_type, b.entity_type, b.criteria, b.vetted_at, b.vip, b.blacklisted_at,
                   b.preferred_channel, b.created_at, b.created_by, b.last_activity_at, b.tags, b.updated_at,
                   b.assigned_to, b.archived_at
              from public.buyers b
             where b.workspace_id = p_ws and b.source is distinct from 'dispogenius-free-agents'
               and (p_since is null or b.updated_at >= p_since)
          ) x), '[]'::jsonb))
    else null
  end;
$$;

-- Deals, with the Podio Submissions ledger (132) and the submission stage
-- moves a person made (125) that the Submissions counts need, every time.
create or replace function public.crm_deals(p_ws bigint, p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then jsonb_build_object(
      'ids', case when p_since is null then null else coalesce((
        select jsonb_agg(d.id order by d.id) from public.deals d where d.workspace_id = p_ws), '[]'::jsonb) end,
      'rows', coalesce((
        select jsonb_agg(to_jsonb(x) || jsonb_build_object('properties', (
                 select jsonb_build_object('line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip, 'lat', p.lat, 'lng', p.lng)
                   from public.properties p where p.id = x.property_id and p.workspace_id = p_ws))
               order by x.id)
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
                   d.underwriter_id, d.offer_low_set_at, d.offer_high_set_at
              from public.deals d
             where d.workspace_id = p_ws
               and (p_since is null or d.updated_at >= p_since
                    or exists (select 1 from public.properties p
                                where p.id = d.property_id and p.workspace_id = p_ws and p.updated_at >= p_since))
          ) x), '[]'::jsonb),
      'podio', coalesce((
        select jsonb_agg(jsonb_build_object('item_id', i.item_id, 'deal_id', i.deal_id, 'podio_stage', i.podio_stage,
                                            'created_on', i.created_on, 'note', i.note) order by i.item_id)
          from public.podio_items i
         where i.workspace_id = p_ws and i.app_key = 'submissions'), '[]'::jsonb),
      'moves', coalesce((
        select jsonb_agg(jsonb_build_object('id', e.id, 'entity_id', e.entity_id, 'to_stage', e.to_stage, 'changed_at', e.changed_at)
                         order by e.changed_at, e.id)
          from public.stage_events e
         where e.workspace_id = p_ws and e.entity_type = 'deal' and e.field = 'lead_stage' and e.changed_by is not null), '[]'::jsonb))
    else null
  end;
$$;

create or replace function public.crm_matches(p_ws bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member')) then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'deal_id', m.deal_id, 'buyer_id', m.buyer_id, 'score', m.score, 'reasons', m.reasons,
               'status', m.status, 'sent_at', m.sent_at, 'viewed_at', m.viewed_at, 'replied_at', m.replied_at,
               'updated_at', m.updated_at)
             order by m.score desc, m.id)
        from public.deal_buyer_matches m
       where m.workspace_id = p_ws), '[]'::jsonb)
    else null
  end;
$$;

-- Source photo links (Podio Photos, a Drive folder, a listing) for the Photos button.
create or replace function public.crm_photo_links(p_ws bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then coalesce((
      select jsonb_agg(jsonb_build_object('deal_id', f.deal_id, 'url', f.url, 'category', f.category, 'name', f.name) order by f.id)
        from public.deal_files f
       where f.workspace_id = p_ws and f.kind = 'link' and f.url is not null
         and (f.category = 'photos' or f.name ilike 'photos')), '[]'::jsonb)
    else null
  end;
$$;

-- Reporting's offer gaps: both views in one call, under the caller's own policies.
create or replace function public.crm_offer_gaps(p_ws bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'gaps', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.closest_gap, g.deal_id)
        from (
          select deal_id, seller_id, vendor_id, company, contact, address, lead_stage, asking_price, offer_amount,
                 uw_high, gap_to_offer, gap_to_high, closest_gap, updated_at
            from public.offer_gaps where workspace_id = p_ws
        ) g), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.close_calls desc, g.party_id)
        from (
          select party_kind, party_id, company, contact, email, phone, offers, close_calls, closest_gap,
                 closest_gap_to_offer, closest_gap_to_high, declined, won, last_offer_at
            from public.offer_gap_people where workspace_id = p_ws
        ) g), '[]'::jsonb));
$$;

revoke all on function public.crm_sellers(bigint, timestamptz) from public, anon;
revoke all on function public.crm_buyers(bigint, timestamptz) from public, anon;
revoke all on function public.crm_deals(bigint, timestamptz) from public, anon;
revoke all on function public.crm_matches(bigint) from public, anon;
revoke all on function public.crm_photo_links(bigint) from public, anon;
revoke all on function public.crm_offer_gaps(bigint) from public, anon;
grant execute on function public.crm_sellers(bigint, timestamptz) to authenticated, service_role;
grant execute on function public.crm_buyers(bigint, timestamptz) to authenticated, service_role;
grant execute on function public.crm_deals(bigint, timestamptz) to authenticated, service_role;
grant execute on function public.crm_matches(bigint) to authenticated, service_role;
grant execute on function public.crm_photo_links(bigint) to authenticated, service_role;
grant execute on function public.crm_offer_gaps(bigint) to authenticated, service_role;
