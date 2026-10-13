-- Buyer matching: a buyer's known states are a hard filter.
--
-- score_buyer_deal (migration 27) treated city names as national and still
-- awarded 60 points for price + type + beds when geography was 0. That put
-- Missouri / Georgia / Texas buyers on every Oklahoma deal. This rewrite:
--   * collects buy-area states from location_prefs (state field + type=state)
--     and locations.states
--   * scores 0 with reason "wrong state" when the deal is in another state
--   * matches city / county / zip only when the pref's state agrees
--   * treats any buy-area as implicit-strict: geo 0 is a miss, not 60 points
--   * awards "in state" (18) only for an explicit state-level pref
-- match_buyer now drops stale matched rows the same way match_deal does.

create or replace function public.buyer_state_code(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p is null or btrim(p) = '' then null
    when length(btrim(p)) = 2 then upper(btrim(p))
    else '{
      "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
      "connecticut":"CT","delaware":"DE","district of columbia":"DC","florida":"FL","georgia":"GA",
      "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY",
      "louisiana":"LA","maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
      "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH",
      "new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",
      "ohio":"OH","oklahoma":"OK","oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
      "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
      "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
    }'::jsonb ->> lower(btrim(p))
  end;
$$;

create or replace function public.score_buyer_deal(
  c jsonb, p_price numeric, p_arv numeric,
  p_city text, p_state text, p_zip text, p_county text,
  p_beds numeric, p_baths numeric, p_sqft integer, p_year integer, p_type text, p_condition text, p_attrs text[]
) returns table (score integer, reasons text[])
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  loc jsonb := coalesce(c->'locations', '{}'::jsonb);
  rloc jsonb := coalesce(c->'restricted', '{}'::jsonb);
  prefs jsonb := case when jsonb_typeof(c->'location_prefs') = 'array' then c->'location_prefs' else '[]'::jsonb end;
  econ jsonb := coalesce(c->'economics', '{}'::jsonb);
  strict_on jsonb := coalesce(c->'strict', '[]'::jsonb);
  geo int := 0; price_fit int := 0; type_fit int := 0; size_fit int := 0;
  sqft_ok boolean := true; year_ok boolean := true; broken boolean := false; restricted boolean := false;
  missing_req boolean := false; econ_ok boolean := false; dead boolean := false;
  wrong_state boolean := false; has_loc boolean := false; city_county_zip boolean := false;
  rehab_rank int; max_rank int;
  r text[] := '{}';
  filter_states text[] := '{}';
  explicit_states text[] := '{}';
  deal_st text := public.buyer_state_code(p_state);
  types jsonb := coalesce(c->'property_types', '[]'::jsonb);
  arr_restrict text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'restrictions','[]'::jsonb)) x), '{}');
  arr_require text[]  := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'requirements','[]'::jsonb)) x), '{}');
  arr_rehab text[]    := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'rehab'->'avoided','[]'::jsonb)) x), '{}');
  arr_spec text[]     := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(c->'specialty_avoid','[]'::jsonb)) x), '{}');
  pmin numeric := (c->'price'->>'min')::numeric; pmax numeric := (c->'price'->>'max')::numeric;
begin
  select coalesce(array_agg(distinct s), '{}') into filter_states
  from (
    select public.buyer_state_code(x) s from jsonb_array_elements_text(coalesce(loc->'states','[]'::jsonb)) x
    union
    select public.buyer_state_code(p->>'state') from jsonb_array_elements(prefs) p
      where coalesce(p->>'restricted','false') not in ('true')
    union
    select public.buyer_state_code(p->>'name') from jsonb_array_elements(prefs) p
      where p->>'type' = 'state' and coalesce(p->>'restricted','false') not in ('true')
  ) z where s is not null;

  select coalesce(array_agg(distinct s), '{}') into explicit_states
  from (
    select public.buyer_state_code(p->>'name') s from jsonb_array_elements(prefs) p
      where p->>'type' = 'state' and coalesce(p->>'restricted','false') not in ('true')
  ) z where s is not null;

  city_county_zip := exists (
    select 1 from jsonb_array_elements(prefs) p
    where p->>'type' in ('city','county','zip') and coalesce(p->>'restricted','false') not in ('true') and nullif(p->>'name','') is not null
  );
  if not city_county_zip then
    select coalesce(array_cat(explicit_states, array_agg(distinct public.buyer_state_code(x))), explicit_states) into explicit_states
    from jsonb_array_elements_text(coalesce(loc->'states','[]'::jsonb)) x
    where public.buyer_state_code(x) is not null;
    explicit_states := (select coalesce(array_agg(distinct s), '{}') from unnest(explicit_states) s where s is not null);
  end if;

  has_loc := coalesce(jsonb_array_length(loc->'cities'), 0) > 0
    or coalesce(jsonb_array_length(loc->'counties'), 0) > 0
    or coalesce(jsonb_array_length(loc->'states'), 0) > 0
    or coalesce(jsonb_array_length(loc->'zips'), 0) > 0
    or exists (
      select 1 from jsonb_array_elements(prefs) p
      where coalesce(p->>'restricted','false') not in ('true') and nullif(p->>'name','') is not null
    );
  wrong_state := deal_st is not null and cardinality(filter_states) > 0 and not (deal_st = any(filter_states));

  if not wrong_state then
    if p_zip is not null and (
         exists (
           select 1 from jsonb_array_elements(prefs) p
           where p->>'type' = 'zip' and p->>'name' = p_zip and coalesce(p->>'restricted','false') not in ('true')
             and (p->>'state' is null or deal_st is null or public.buyer_state_code(p->>'state') = deal_st)
         )
         or (
           loc->'zips' ? p_zip
           and not exists (
             select 1 from jsonb_array_elements(prefs) p
             where p->>'type' = 'zip' and p->>'name' = p_zip and coalesce(p->>'restricted','false') not in ('true')
               and p->>'state' is not null and deal_st is not null and public.buyer_state_code(p->>'state') is distinct from deal_st
           )
         )
       ) then geo := 40;
    elsif p_city is not null and (
         exists (
           select 1 from jsonb_array_elements(prefs) p
           where p->>'type' = 'city' and lower(p->>'name') = lower(p_city) and coalesce(p->>'restricted','false') not in ('true')
             and (p->>'state' is null or deal_st is null or public.buyer_state_code(p->>'state') = deal_st)
         )
         or (
           exists (select 1 from jsonb_array_elements_text(coalesce(loc->'cities','[]'::jsonb)) x where lower(x) = lower(p_city))
           and not exists (
             select 1 from jsonb_array_elements(prefs) p
             where p->>'type' = 'city' and lower(p->>'name') = lower(p_city) and coalesce(p->>'restricted','false') not in ('true')
               and p->>'state' is not null and deal_st is not null and public.buyer_state_code(p->>'state') is distinct from deal_st
           )
         )
       ) then geo := 34;
    elsif p_county is not null and (
         exists (
           select 1 from jsonb_array_elements(prefs) p
           where p->>'type' = 'county' and lower(p->>'name') = lower(p_county) and coalesce(p->>'restricted','false') not in ('true')
             and (p->>'state' is null or deal_st is null or public.buyer_state_code(p->>'state') = deal_st)
         )
         or (
           exists (select 1 from jsonb_array_elements_text(coalesce(loc->'counties','[]'::jsonb)) x where lower(x) = lower(p_county))
           and not exists (
             select 1 from jsonb_array_elements(prefs) p
             where p->>'type' = 'county' and lower(p->>'name') = lower(p_county) and coalesce(p->>'restricted','false') not in ('true')
               and p->>'state' is not null and deal_st is not null and public.buyer_state_code(p->>'state') is distinct from deal_st
           )
         )
       ) then geo := 34;
    elsif deal_st is not null and deal_st = any(explicit_states) then geo := 18;
    elsif not has_loc then geo := 10;
    end if;
  end if;

  restricted := (p_zip is not null and rloc->'zips' ? p_zip)
    or (p_city is not null and exists (select 1 from jsonb_array_elements_text(coalesce(rloc->'cities','[]'::jsonb)) x where lower(x) = lower(p_city)))
    or (p_county is not null and exists (select 1 from jsonb_array_elements_text(coalesce(rloc->'counties','[]'::jsonb)) x where lower(x) = lower(p_county)))
    or (deal_st is not null and exists (select 1 from jsonb_array_elements_text(coalesce(rloc->'states','[]'::jsonb)) x where public.buyer_state_code(x) = deal_st));

  if pmin is null and pmax is null then price_fit := 8;
  elsif p_price is null then price_fit := 8;
  elsif p_price between coalesce(pmin, 0) and coalesce(pmax, 1e12) then price_fit := 25;
  elsif p_price <= coalesce(pmax, 1e12) * 1.1 then price_fit := 12;
  end if;
  if p_type is null or jsonb_array_length(types) = 0 then type_fit := 8;
  elsif exists (select 1 from jsonb_array_elements_text(types) x where lower(replace(x,'_',' ')) = lower(replace(p_type,'_',' '))
                  or (x = 'single_family' and lower(p_type) in ('sfr','single family','single family residential','single_family'))) then type_fit := 15;
  end if;
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
  dead := broken or restricted or wrong_state or (has_loc and geo = 0)
    or ((strict_on ? 'all' or strict_on ? 'locations')  and geo = 0)
    or ((strict_on ? 'all' or strict_on ? 'pricing')    and price_fit < 25 and price_fit <> 8)
    or ((strict_on ? 'all' or strict_on ? 'beds_baths') and size_fit = 0)
    or ((strict_on ? 'all' or strict_on ? 'sqft')       and not sqft_ok)
    or ((strict_on ? 'all' or strict_on ? 'year_built') and not year_ok);

  if geo >= 34 then r := array_append(r, 'in market'); elsif geo = 18 then r := array_append(r, 'in state'); end if;
  if wrong_state then r := array_append(r, 'wrong state');
  elsif has_loc and geo = 0 then r := array_append(r, 'outside buy area'); end if;
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
  delete from public.deal_buyer_matches dbm
  where dbm.deal_id = d.id and dbm.status = 'matched'
    and not exists (
      select 1 from public.buyers bb
      where bb.id = dbm.buyer_id and bb.workspace_id = d.workspace_id
        and bb.blacklisted_at is null and lower(coalesce(bb.status,'')) <> 'inactive'
    );
  return n;
end $$;

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
    else
      delete from public.deal_buyer_matches where deal_id = d.id and buyer_id = b.id and status = 'matched';
    end if;
  end loop;
  return n;
end $$;

create or replace function public.rematch_workspace(p_workspace_id bigint, p_min integer default 55)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare n integer := 0; d record;
begin
  -- Active inventory plus anything already on the Matches tab. Closed files
  -- without a match row are left alone so a 3k+ deal workspace does not
  -- rescore every historic row.
  for d in
    select dl.id
    from public.deals dl
    left join public.deal_stages st on st.label = dl.stage
    where dl.workspace_id = p_workspace_id
      and (
        coalesce(st.active_inventory, false)
        or exists (select 1 from public.deal_buyer_matches m where m.deal_id = dl.id)
      )
  loop
    n := n + public.match_deal(d.id, p_min);
  end loop;
  return n;
end $$;

grant execute on function public.buyer_state_code(text) to authenticated, service_role;
grant execute on function public.score_buyer_deal(jsonb, numeric, numeric, text, text, text, text, numeric, numeric, integer, integer, text, text, text[]) to authenticated, service_role;
grant execute on function public.match_deal(bigint, integer) to authenticated, service_role;
grant execute on function public.match_buyer(bigint, integer) to authenticated, service_role;
grant execute on function public.rematch_workspace(bigint, integer) to authenticated, service_role;

-- Fold pref.state onto locations.states so existing rows have the same shape
-- new writes get from normalizeBuyBox.
update public.buyers b
set criteria = jsonb_set(
  coalesce(b.criteria, '{}'::jsonb),
  '{locations,states}',
  coalesce((
    select jsonb_agg(distinct s)
    from (
      select public.buyer_state_code(x) s
      from jsonb_array_elements_text(coalesce(b.criteria->'locations'->'states','[]'::jsonb)) x
      union
      select public.buyer_state_code(p->>'state')
      from jsonb_array_elements(coalesce(b.criteria->'location_prefs','[]'::jsonb)) p
      where coalesce(p->>'restricted','false') not in ('true')
      union
      select public.buyer_state_code(p->>'name')
      from jsonb_array_elements(coalesce(b.criteria->'location_prefs','[]'::jsonb)) p
      where p->>'type' = 'state' and coalesce(p->>'restricted','false') not in ('true')
    ) z where s is not null
  ), '[]'::jsonb),
  true
)
where b.criteria is not null
  and (
    jsonb_typeof(b.criteria->'location_prefs') = 'array'
    or jsonb_typeof(b.criteria->'locations'->'states') = 'array'
  );
