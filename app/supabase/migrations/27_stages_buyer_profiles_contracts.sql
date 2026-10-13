-- Seller stages, deal stages, buyer profiles, matching, contracts, discovery.
--
-- Stages. sellers.lead_stage carries the acquisitions stage list the team
-- runs (44 stages, grouped). deals.stage carries the seven stages a deal moves
-- through — Under Contract Seller → Ready To Market → Buyer Under Contract →
-- In Escrow → Closed, plus Terminated and Realtor Referral — and 'Prospect',
-- the pre-contract placeholder a deal sheet opened on a lead sits at (it is
-- never a pipeline column). Triggers keep the two in step from whichever side
-- changes: a seller moved to Under Contract - Seller gets a deal created in
-- active dispo inventory; a deal moved to Buyer Under Contract writes the
-- seller to Under Contract - Buyer; and so on. Legacy labels ('New Lead',
-- 'Dispo', 'Assigned'…) are normalised on write so older clients keep working.
--
-- Buyers. `criteria` (jsonb) is the Genius-profile buy box: location rows with
-- a Restricted flag, strategy, property types, price/sqft/year ranges, bed and
-- bath minimums, restricted rehab levels and specialty rehabs, strict criteria,
-- property restrictions/requirements and deal economics. `markets` and
-- `max_purchase_price` stay in step for the older screens.
--
-- deal_buyer_matches is the deal ↔ buyer join the matcher writes; contracts
-- and contract_events are PandaDoc documents; discover_runs caches Genius
-- Mode (nearby cash-buyer discovery) per deal.

-- ---- reference: stages ----------------------------------------------------
create table if not exists public.seller_stages (
  label      text primary key,
  sort       integer not null,
  grp        text not null check (grp in ('lead','working','offer','contract','closed','dead','refund','referral','other')),
  deal_stage text
);
create table if not exists public.deal_stages (
  label            text primary key,
  sort             integer not null,
  active_inventory boolean not null default false,
  hidden           boolean not null default false
);

insert into public.deal_stages (label, sort, active_inventory, hidden) values
  ('Prospect',              0, false, true),
  ('Under Contract Seller', 10, true, false),
  ('Ready To Market',       20, true, false),
  ('Buyer Under Contract',  30, true, false),
  ('In Escrow',             40, true, false),
  ('Closed',                50, false, false),
  ('Terminated',            60, false, false),
  ('Realtor Referral',      70, false, false)
on conflict (label) do update set sort = excluded.sort, active_inventory = excluded.active_inventory, hidden = excluded.hidden;

insert into public.seller_stages (label, sort, grp, deal_stage) values
  ('None',                                  10, 'lead',     null),
  ('Self Generated',                        20, 'lead',     null),
  ('Lead',                                  30, 'lead',     null),
  ('Lead - No Contact',                     40, 'lead',     null),
  ('Lead - No Contact (Long Term)',         50, 'lead',     null),
  ('Contacted - Follow Up Needed',          60, 'working',  null),
  ('Appointment Set',                       70, 'working',  null),
  ('Appointment Missed',                    80, 'working',  null),
  ('Nurture - Short Term (Under 3 Months)', 90, 'working',  null),
  ('Nurture - Long Term (3+ Months)',      100, 'working',  null),
  ('Underwriting',                         110, 'offer',    null),
  ('Make Offer',                           120, 'offer',    null),
  ('Offer Made',                           130, 'offer',    null),
  ('Offer Made - Follow Up',               140, 'offer',    null),
  ('Offer Made - Retail',                  150, 'offer',    null),
  ('Contract Sent to Seller',              160, 'contract', null),
  ('Under Contract - Seller',              170, 'contract', 'Under Contract Seller'),
  ('Under Contract - Buyer',               180, 'contract', 'Buyer Under Contract'),
  ('Memo Filed / Legal',                   190, 'contract', null),
  ('Closed',                               200, 'closed',   'Closed'),
  ('Referred to Realtor',                  210, 'referral', 'Realtor Referral'),
  ('Realtor',                              220, 'referral', 'Realtor Referral'),
  ('Terminated',                           230, 'dead',     'Terminated'),
  ('Terminated - Price Drop',              240, 'dead',     'Terminated'),
  ('Under Contract with Other Investor',   250, 'dead',     null),
  ('Duplicate Lead',                       260, 'dead',     null),
  ('Asking Retail / Not Motivated',        270, 'dead',     null),
  ('Not Selling',                          280, 'dead',     null),
  ('Listed on MLS - Dead',                 290, 'dead',     null),
  ('Negative Equity',                      300, 'dead',     null),
  ('Ghosted',                              310, 'dead',     null),
  ('Sold Elsewhere',                       320, 'dead',     null),
  ('Unresponsive',                         330, 'dead',     null),
  ('Bad Location',                         340, 'dead',     null),
  ('Dead',                                 350, 'dead',     null),
  ('Dead - Wrong Info',                    360, 'dead',     null),
  ('Refund - Wrong Info',                  370, 'refund',   null),
  ('Refund - Listed',                      380, 'refund',   null),
  ('Refund - Not Selling',                 390, 'refund',   null),
  ('Refund - Wrong Info / Other',          400, 'refund',   null),
  ('Wholesaler',                           410, 'other',    null),
  ('Buyer',                                420, 'other',    null),
  ('Buyer Prospect',                       430, 'other',    null),
  ('Land',                                 440, 'other',    null)
on conflict (label) do update set sort = excluded.sort, grp = excluded.grp, deal_stage = excluded.deal_stage;

alter table public.seller_stages enable row level security;
alter table public.deal_stages enable row level security;
drop policy if exists seller_stages_read on public.seller_stages;
create policy seller_stages_read on public.seller_stages for select to authenticated using (true);
drop policy if exists deal_stages_read on public.deal_stages;
create policy deal_stages_read on public.deal_stages for select to authenticated using (true);

-- ---- normalisation: any label an older client still sends -----------------
create or replace function public.normalize_seller_stage(p text)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select label from public.seller_stages where lower(label) = lower(trim(coalesce(p, ''))) limit 1),
    case lower(trim(coalesce(p, '')))
      when 'new lead' then 'Lead'
      when 'contacted' then 'Contacted - Follow Up Needed'
      when 'qualified' then 'Underwriting'
      when 'appointment' then 'Appointment Set'
      when 'offer sent' then 'Offer Made'
      when 'negotiation' then 'Offer Made - Follow Up'
      when 'under contract' then 'Under Contract - Seller'
      when 'under contract seller' then 'Under Contract - Seller'
      when 'dispo' then 'Under Contract - Seller'
      when 'ready to market' then 'Under Contract - Seller'
      when 'assigned' then 'Under Contract - Buyer'
      when 'buyer under contract' then 'Under Contract - Buyer'
      when 'closing' then 'Under Contract - Buyer'
      when 'in escrow' then 'Under Contract - Buyer'
      when 'lost' then 'Dead'
      when 'realtor referral' then 'Referred to Realtor'
      else 'Lead'
    end)
$$;

create or replace function public.normalize_deal_stage(p text)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select label from public.deal_stages where lower(label) = lower(trim(coalesce(p, ''))) limit 1),
    case lower(trim(coalesce(p, '')))
      when 'under contract' then 'Under Contract Seller'
      when 'under contract - seller' then 'Under Contract Seller'
      when 'dispo' then 'Ready To Market'
      when 'assigned' then 'Buyer Under Contract'
      when 'under contract - buyer' then 'Buyer Under Contract'
      when 'closing' then 'In Escrow'
      when 'lost' then 'Terminated'
      when 'referred to realtor' then 'Realtor Referral'
      else 'Prospect'
    end)
$$;

-- ---- columns ----------------------------------------------------------------
alter table public.sellers add column if not exists stage_entered_at timestamptz not null default now();
alter table public.deals   add column if not exists stage_entered_at timestamptz not null default now();
alter table public.properties
  add column if not exists county     text,
  add column if not exists condition  text check (condition in ('move_in','cosmetic','medium','heavy','gut')),
  add column if not exists attributes text[] not null default '{}',
  add column if not exists lot_sqft   integer,
  add column if not exists lat        double precision,
  add column if not exists lng        double precision;

update public.sellers set lead_stage = public.normalize_seller_stage(lead_stage)
  where lead_stage is distinct from public.normalize_seller_stage(lead_stage);
update public.deals set stage = public.normalize_deal_stage(stage)
  where stage is distinct from public.normalize_deal_stage(stage);

alter table public.sellers alter column lead_stage set default 'Lead';
alter table public.deals   alter column stage set default 'Prospect';

-- ---- deals: normalise, timestamps, and write the seller back ---------------
create or replace function public.deals_stage_before()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.stage := public.normalize_deal_stage(new.stage);
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    if tg_op = 'UPDATE' then new.stage_entered_at := now(); end if;
    if new.stage = 'Under Contract Seller' and new.contract_date is null then new.contract_date := current_date; end if;
    if new.stage = 'Ready To Market' and new.marketing_started_on is null then new.marketing_started_on := current_date; end if;
    if new.stage = 'Closed' and new.closed_on is null then new.closed_on := current_date; end if;
    if new.stage = 'Terminated' then
      new.terminated := true;
      if new.terminated_on is null then new.terminated_on := current_date; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists deals_stage_before on public.deals;
create trigger deals_stage_before before insert or update on public.deals
  for each row execute function public.deals_stage_before();

create or replace function public.deals_stage_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare target text;
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then return new; end if;
  -- A change the seller trigger made (depth 2) must not write the seller again.
  if pg_trigger_depth() > 1 or new.seller_id is null then return new; end if;
  target := case new.stage
    when 'Under Contract Seller' then 'Under Contract - Seller'
    when 'Ready To Market'       then 'Under Contract - Seller'
    when 'Buyer Under Contract'  then 'Under Contract - Buyer'
    when 'In Escrow'             then 'Under Contract - Buyer'
    when 'Closed'                then 'Closed'
    when 'Terminated'            then 'Terminated'
    when 'Realtor Referral'      then 'Referred to Realtor'
  end;
  if target is null then return new; end if;
  update public.sellers s set lead_stage = target
  where s.id = new.seller_id
    and s.lead_stage is distinct from target
    -- Stages that only restate "still under contract" never pull a seller backwards.
    and not (new.stage = 'Ready To Market' and s.lead_stage in ('Under Contract - Seller','Memo Filed / Legal','Under Contract - Buyer','Closed'))
    and not (new.stage = 'In Escrow' and s.lead_stage in ('Under Contract - Buyer','Closed'));
  if found then
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
    values (new.workspace_id, 'seller', new.seller_id, 'stage', 'Stage → ' || target, 'Followed the deal moving to ' || new.stage);
  end if;
  return new;
end $$;
revoke execute on function public.deals_stage_after() from public, anon, authenticated;
drop trigger if exists deals_stage_after on public.deals;
create trigger deals_stage_after after insert or update of stage on public.deals
  for each row execute function public.deals_stage_after();

-- ---- sellers: normalise, and create or move the deal -----------------------
create or replace function public.sellers_stage_before()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.lead_stage := public.normalize_seller_stage(new.lead_stage);
  if tg_op = 'UPDATE' and new.lead_stage is distinct from old.lead_stage then new.stage_entered_at := now(); end if;
  return new;
end $$;
drop trigger if exists sellers_stage_before on public.sellers;
create trigger sellers_stage_before before insert or update on public.sellers
  for each row execute function public.sellers_stage_before();

create or replace function public.sellers_stage_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target text;
  d record;
  new_deal_id bigint;
begin
  if tg_op = 'UPDATE' and new.lead_stage is not distinct from old.lead_stage then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if;
  select deal_stage into target from public.seller_stages where label = new.lead_stage;
  if target is null then return new; end if;

  -- The seller's live deal, else the most recent one.
  select id, stage into d from public.deals
  where seller_id = new.id
  order by (stage in ('Closed','Terminated','Realtor Referral')) asc, created_at desc
  limit 1;

  if d.id is null or (d.stage in ('Closed','Terminated','Realtor Referral') and target in ('Under Contract Seller','Buyer Under Contract')) then
    if target in ('Under Contract Seller','Buyer Under Contract') then
      -- Seller under contract ⇒ a deal exists in active dispo inventory.
      insert into public.deals (workspace_id, seller_id, property_id, stage, offer_amount, owner_id, created_by, source, contract_date)
      values (new.workspace_id, new.id, new.property_id, target, new.asking_price, new.assigned_to, new.assigned_to, 'stage', current_date)
      returning id into new_deal_id;
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (new.workspace_id, 'deal', new_deal_id, 'stage', 'Deal opened · ' || target, 'Created when the seller moved to ' || new.lead_stage);
    end if;
  elsif d.stage is distinct from target then
    update public.deals set stage = target where id = d.id;
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
    values (new.workspace_id, 'deal', d.id, 'stage', 'Deal → ' || target, 'Followed the seller moving to ' || new.lead_stage);
  end if;
  return new;
end $$;
revoke execute on function public.sellers_stage_after() from public, anon, authenticated;
drop trigger if exists sellers_stage_after on public.sellers;
create trigger sellers_stage_after after insert or update of lead_stage on public.sellers
  for each row execute function public.sellers_stage_after();

-- ---- buyers: the profile ---------------------------------------------------
alter table public.buyers
  add column if not exists buyer_type         text,
  add column if not exists entity_type        text,
  add column if not exists criteria           jsonb not null default '{}'::jsonb,
  add column if not exists min_purchase_price numeric,
  add column if not exists vetted_at          timestamptz,
  add column if not exists vip                boolean not null default false,
  add column if not exists blacklisted_at     timestamptz,
  add column if not exists preferred_channel  text not null default 'email_and_sms',
  add column if not exists wants_calls        boolean not null default true,
  add column if not exists wants_follow_ups   boolean not null default true,
  add column if not exists wants_sold_alerts  boolean not null default false,
  add column if not exists pof_url            text,
  add column if not exists pof_verified_at    timestamptz,
  add column if not exists website            text,
  add column if not exists tags               text[] not null default '{}',
  add column if not exists last_activity_at   timestamptz;
create index if not exists buyers_criteria_idx on public.buyers using gin (criteria);

-- ---- matching ---------------------------------------------------------------
create table if not exists public.deal_buyer_matches (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  deal_id      bigint not null references public.deals(id) on delete cascade,
  buyer_id     bigint not null references public.buyers(id) on delete cascade,
  score        integer not null default 0 check (score between 0 and 100),
  reasons      text[] not null default '{}',
  status       text not null default 'matched'
    check (status in ('matched','sent','viewed','interested','not_interested','offered','under_contract','closed')),
  sent_at      timestamptz,
  viewed_at    timestamptz,
  replied_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (deal_id, buyer_id)
);
create index if not exists deal_buyer_matches_deal_idx on public.deal_buyer_matches (deal_id, score desc);
create index if not exists deal_buyer_matches_buyer_idx on public.deal_buyer_matches (buyer_id);
alter table public.deal_buyer_matches enable row level security;
drop policy if exists deal_buyer_matches_select on public.deal_buyer_matches;
create policy deal_buyer_matches_select on public.deal_buyer_matches for select
  using (public.has_role(workspace_id, 'owner','admin','dispositions','tc','member'));
drop policy if exists deal_buyer_matches_write on public.deal_buyer_matches;
create policy deal_buyer_matches_write on public.deal_buyer_matches for all
  using (public.has_role(workspace_id, 'owner','admin','dispositions'))
  with check (public.has_role(workspace_id, 'owner','admin','dispositions'));
drop trigger if exists deal_buyer_matches_touch on public.deal_buyer_matches;
create trigger deal_buyer_matches_touch before update on public.deal_buyer_matches
  for each row execute function public.touch_updated_at();

/**
 * Score one buyer's criteria against one deal. 0–100 with the reasons a rep
 * sees. Restricted locations, restricted rehab, property restrictions, max %
 * of ARV and strict criteria are hard stops; sqft / year out of range and
 * missing requirements cost points.
 */
create or replace function public.score_buyer_deal(
  c jsonb, p_price numeric, p_arv numeric,
  p_city text, p_state text, p_zip text, p_county text,
  p_beds numeric, p_baths numeric, p_sqft integer, p_year integer, p_type text, p_condition text, p_attrs text[]
) returns table (score integer, reasons text[])
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  loc jsonb := coalesce(c->'locations', '{}'::jsonb);
  rloc jsonb := coalesce(c->'restricted', '{}'::jsonb);
  econ jsonb := coalesce(c->'economics', '{}'::jsonb);
  strict_on jsonb := coalesce(c->'strict', '[]'::jsonb);
  geo int := 0; price_fit int := 0; type_fit int := 0; size_fit int := 0;
  sqft_ok boolean := true; year_ok boolean := true; broken boolean := false; restricted boolean := false;
  missing_req boolean := false; econ_ok boolean := false; dead boolean := false;
  rehab_rank int; max_rank int;
  r text[] := '{}';
  has_loc boolean := jsonb_typeof(c->'locations') is not null and loc <> '{}'::jsonb;
  types jsonb := coalesce(c->'property_types', '[]'::jsonb);
  arr_restrict text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'restrictions','[]'::jsonb)) x), '{}');
  arr_require text[]  := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'requirements','[]'::jsonb)) x), '{}');
  arr_rehab text[]    := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'rehab'->'avoided','[]'::jsonb)) x), '{}');
  arr_spec text[]     := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'specialty_avoid','[]'::jsonb)) x), '{}');
  pmin numeric := (c->'price'->>'min')::numeric; pmax numeric := (c->'price'->>'max')::numeric;
begin
  -- Geography (0–40)
  if p_zip is not null and loc->'zips' ? p_zip then geo := 40;
  elsif p_city is not null and exists (select 1 from jsonb_array_elements_text(coalesce(loc->'cities','[]'::jsonb)) x where lower(x) = lower(p_city)) then geo := 34;
  elsif p_county is not null and exists (select 1 from jsonb_array_elements_text(coalesce(loc->'counties','[]'::jsonb)) x where lower(x) = lower(p_county)) then geo := 34;
  elsif p_state is not null and exists (select 1 from jsonb_array_elements_text(coalesce(loc->'states','[]'::jsonb)) x where upper(x) = upper(p_state)) then geo := 18;
  elsif not has_loc then geo := 10;
  end if;
  restricted := (p_zip is not null and rloc->'zips' ? p_zip)
    or (p_city is not null and exists (select 1 from jsonb_array_elements_text(coalesce(rloc->'cities','[]'::jsonb)) x where lower(x) = lower(p_city)))
    or (p_county is not null and exists (select 1 from jsonb_array_elements_text(coalesce(rloc->'counties','[]'::jsonb)) x where lower(x) = lower(p_county)))
    or (p_state is not null and exists (select 1 from jsonb_array_elements_text(coalesce(rloc->'states','[]'::jsonb)) x where upper(x) = upper(p_state)));
  -- Price band (0–25)
  if pmin is null and pmax is null then price_fit := 8;
  elsif p_price is null then price_fit := 8;
  elsif p_price between coalesce(pmin, 0) and coalesce(pmax, 1e12) then price_fit := 25;
  elsif p_price <= coalesce(pmax, 1e12) * 1.1 then price_fit := 12;
  end if;
  -- Property type (0–15)
  if p_type is null or jsonb_array_length(types) = 0 then type_fit := 8;
  elsif exists (select 1 from jsonb_array_elements_text(types) x where lower(replace(x,'_',' ')) = lower(replace(p_type,'_',' '))
                  or (x = 'single_family' and lower(p_type) in ('sfr','single family','single family residential','single_family'))) then type_fit := 15;
  end if;
  -- Beds / baths (0–10)
  if p_beds is null or c->'beds'->>'min' is null then size_fit := 5;
  elsif p_beds >= (c->'beds'->>'min')::numeric and (c->'baths'->>'min' is null or p_baths is null or p_baths >= (c->'baths'->>'min')::numeric) then size_fit := 10;
  end if;
  sqft_ok := p_sqft is null or ((c->'sqft'->>'min' is null or p_sqft >= (c->'sqft'->>'min')::numeric) and (c->'sqft'->>'max' is null or p_sqft <= (c->'sqft'->>'max')::numeric));
  year_ok := p_year is null or ((c->'year_built'->>'min' is null or p_year >= (c->'year_built'->>'min')::int) and (c->'year_built'->>'max' is null or p_year <= (c->'year_built'->>'max')::int));
  rehab_rank := case p_condition when 'move_in' then 0 when 'cosmetic' then 1 when 'medium' then 2 when 'heavy' then 3 when 'gut' then 4 end;
  max_rank := case econ->>'max_rehab_level' when 'move_in' then 0 when 'cosmetic' then 1 when 'medium' then 2 when 'heavy' then 3 when 'gut' then 4 end;
  broken := (p_condition is not null and p_condition = any(arr_rehab))
    or (rehab_rank is not null and max_rank is not null and rehab_rank > max_rank)
    or (p_attrs && arr_spec) or (p_attrs && arr_restrict)
    or (p_arv is not null and p_arv > 0 and p_price is not null and econ->>'max_arv_pct' is not null and p_price > p_arv * (econ->>'max_arv_pct')::numeric / 100);
  econ_ok := p_arv is not null and p_arv > 0 and p_price is not null and econ->>'max_arv_pct' is not null and p_price <= p_arv * (econ->>'max_arv_pct')::numeric / 100;
  missing_req := cardinality(arr_require) > 0 and not (p_attrs @> arr_require);
  dead := broken or restricted
    or ((strict_on ? 'all' or strict_on ? 'locations')  and geo = 0)
    or ((strict_on ? 'all' or strict_on ? 'pricing')    and price_fit < 25 and price_fit <> 8)
    or ((strict_on ? 'all' or strict_on ? 'beds_baths') and size_fit = 0)
    or ((strict_on ? 'all' or strict_on ? 'sqft')       and not sqft_ok)
    or ((strict_on ? 'all' or strict_on ? 'year_built') and not year_ok);

  if geo >= 34 then r := array_append(r, 'in market'); elsif geo = 18 then r := array_append(r, 'in state'); end if;
  if restricted then r := array_append(r, 'restricted location'); end if;
  if price_fit = 25 then r := array_append(r, 'price in band'); elsif price_fit = 12 then r := array_append(r, 'price near band'); end if;
  if type_fit = 15 then r := array_append(r, 'property type match'); end if;
  if size_fit = 10 then r := array_append(r, 'beds/baths ok'); end if;
  if not sqft_ok then r := array_append(r, 'sqft out of range'); end if;
  if not year_ok then r := array_append(r, 'year built out of range'); end if;
  if missing_req then r := array_append(r, 'missing a requirement'); end if;
  if econ_ok then r := array_append(r, 'under max % of ARV'); end if;
  if broken then r := array_append(r, 'deal breaker'); elsif dead then r := array_append(r, 'strict criteria'); end if;

  score := case when dead then 0 else greatest(0, least(100,
    geo + price_fit + type_fit + size_fit + 10
    - (case when sqft_ok then 0 else 10 end) - (case when year_ok then 0 else 10 end) - (case when missing_req then 15 else 0 end))) end;
  reasons := r;
  return next;
end $$;

/** Every eligible buyer in the deal's workspace against the deal. Returns rows written. */
create or replace function public.match_deal(p_deal_id bigint, p_min integer default 55)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  d record; b record; sc record; n integer := 0; price numeric;
begin
  select dl.id, dl.workspace_id, dl.arv, dl.offer_amount, dl.assignment_fee, dl.sold_price,
         p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft, p.year_built, p.property_type, p.condition, p.attributes
  into d
  from public.deals dl left join public.properties p on p.id = dl.property_id
  where dl.id = p_deal_id;
  if d.id is null then return 0; end if;
  price := coalesce(d.sold_price, d.offer_amount + coalesce(d.assignment_fee, 0), d.offer_amount);
  for b in select id, criteria, vetted_at from public.buyers
           where workspace_id = d.workspace_id and blacklisted_at is null and lower(coalesce(status,'')) <> 'inactive'
  loop
    select * into sc from public.score_buyer_deal(b.criteria, price, d.arv, d.city, d.state, d.zip, d.county, d.beds, d.baths, d.sqft, d.year_built, d.property_type, d.condition, coalesce(d.attributes, '{}'));
    if sc.score >= p_min then
      insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons)
      values (d.workspace_id, d.id, b.id, sc.score, sc.reasons)
      on conflict (deal_id, buyer_id) do update set score = excluded.score, reasons = excluded.reasons, updated_at = now();
      n := n + 1;
    else
      delete from public.deal_buyer_matches where deal_id = d.id and buyer_id = b.id and status = 'matched';
    end if;
  end loop;
  return n;
end $$;

/** One buyer against every deal in active inventory in their workspace. Returns rows written. */
create or replace function public.match_buyer(p_buyer_id bigint, p_min integer default 55)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  b record; d record; sc record; n integer := 0; price numeric;
begin
  select id, workspace_id, criteria, blacklisted_at into b from public.buyers where id = p_buyer_id;
  if b.id is null or b.blacklisted_at is not null then return 0; end if;
  for d in select dl.id, dl.arv, dl.offer_amount, dl.assignment_fee, dl.sold_price,
                  p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft, p.year_built, p.property_type, p.condition, p.attributes
           from public.deals dl join public.deal_stages st on st.label = dl.stage
           left join public.properties p on p.id = dl.property_id
           where dl.workspace_id = b.workspace_id and st.active_inventory
           order by dl.created_at desc limit 200
  loop
    price := coalesce(d.sold_price, d.offer_amount + coalesce(d.assignment_fee, 0), d.offer_amount);
    select * into sc from public.score_buyer_deal(b.criteria, price, d.arv, d.city, d.state, d.zip, d.county, d.beds, d.baths, d.sqft, d.year_built, d.property_type, d.condition, coalesce(d.attributes, '{}'));
    if sc.score >= p_min then
      insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons)
      values (b.workspace_id, d.id, b.id, sc.score, sc.reasons)
      on conflict (deal_id, buyer_id) do update set score = excluded.score, reasons = excluded.reasons, updated_at = now();
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---- contracts (PandaDoc) ---------------------------------------------------
create table if not exists public.contracts (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  deal_id       bigint references public.deals(id) on delete set null,
  seller_id     bigint references public.sellers(id) on delete set null,
  buyer_id      bigint references public.buyers(id) on delete set null,
  kind          text not null default 'other'
    check (kind in ('psa','assignment','amendment','termination','option','novation','jv','disclosure','addendum','other')),
  template_id   text,
  template_name text,
  pandadoc_id   text unique,
  name          text not null,
  status        text not null default 'draft',
  recipients    jsonb not null default '[]'::jsonb,
  tokens        jsonb not null default '[]'::jsonb,
  sent_at       timestamptz,
  viewed_at     timestamptz,
  completed_at  timestamptz,
  last_event    jsonb,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists contracts_workspace_idx on public.contracts (workspace_id, created_at desc);
create index if not exists contracts_deal_idx on public.contracts (deal_id);
create index if not exists contracts_seller_idx on public.contracts (seller_id);
create table if not exists public.contract_events (
  id          bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  contract_id bigint not null references public.contracts(id) on delete cascade,
  event       text not null,
  payload     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists contract_events_contract_idx on public.contract_events (contract_id, created_at desc);
alter table public.contracts enable row level security;
alter table public.contract_events enable row level security;
drop policy if exists contracts_select on public.contracts;
create policy contracts_select on public.contracts for select using (public.is_workspace_member(workspace_id));
drop policy if exists contracts_write on public.contracts;
create policy contracts_write on public.contracts for all
  using (public.has_role(workspace_id, 'owner','admin','acquisitions','dispositions','tc'))
  with check (public.has_role(workspace_id, 'owner','admin','acquisitions','dispositions','tc'));
drop policy if exists contract_events_select on public.contract_events;
create policy contract_events_select on public.contract_events for select using (public.is_workspace_member(workspace_id));
drop trigger if exists contracts_touch on public.contracts;
create trigger contracts_touch before update on public.contracts for each row execute function public.touch_updated_at();

-- ---- Genius Mode runs ---------------------------------------------------------
create table if not exists public.discover_runs (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  deal_id       bigint references public.deals(id) on delete cascade,
  seller_id     bigint references public.sellers(id) on delete cascade,
  radius_mi     numeric(4,2) not null,
  months        integer not null,
  kinds         text[],
  subject       jsonb not null default '{}'::jsonb,
  sales_scanned integer not null default 0,
  candidates    jsonb not null default '[]'::jsonb,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists discover_runs_deal_idx on public.discover_runs (deal_id, created_at desc);
create index if not exists discover_runs_seller_idx on public.discover_runs (seller_id, created_at desc);
alter table public.discover_runs enable row level security;
drop policy if exists discover_runs_select on public.discover_runs;
create policy discover_runs_select on public.discover_runs for select
  using (public.has_role(workspace_id, 'owner','admin','dispositions','tc','member'));
drop policy if exists discover_runs_write on public.discover_runs;
create policy discover_runs_write on public.discover_runs for all
  using (public.has_role(workspace_id, 'owner','admin','dispositions'))
  with check (public.has_role(workspace_id, 'owner','admin','dispositions'));
