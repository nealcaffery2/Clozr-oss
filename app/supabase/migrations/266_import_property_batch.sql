-- 266 · One call matches a batch of import addresses to properties.
--
-- A people import of about a thousand rows used to call address_key and then
-- select properties once per row, and the duplicate review also read every
-- property in the workspace. import_address_lookup only reads: each row comes
-- back with its address_key and the property already filed under it, if any.
-- import_property_batch finds or creates each house and fills or overwrites
-- its facts, never with a blank. Both cap at 500 rows. Security invoker, so
-- row security applies as for a direct read or write. Until this is applied
-- the import falls back to the per-row calls.

create or replace function public.import_address_lookup(p_workspace bigint, p_rows jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  n int;
  rec jsonb;
  v_line1 text;
  v_city text;
  v_state text;
  v_zip text;
  v_key text;
  v_id bigint;
  out jsonb := '[]'::jsonb;
begin
  if p_workspace is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'workspace and a row array are required' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_rows);
  if n > 500 then
    raise exception 'at most 500 rows' using errcode = '22023';
  end if;
  if n = 0 then
    return '[]'::jsonb;
  end if;

  for rec in select value from jsonb_array_elements(p_rows)
  loop
    v_line1 := nullif(btrim(rec->>'line1'), '');
    v_city := coalesce(rec->>'city', '');
    v_state := coalesce(rec->>'state', '');
    v_zip := coalesce(rec->>'zip', '');
    v_key := case when v_line1 is null then null else public.address_key(v_line1, v_city, v_state, v_zip) end;
    v_id := null;
    if v_key is not null then
      select id into v_id
        from public.properties
       where workspace_id = p_workspace and address_key = v_key
       order by id
       limit 1;
    end if;
    out := out || jsonb_build_array(jsonb_build_object(
      'i', (rec->>'i')::int,
      'property_id', v_id,
      'address_key', v_key
    ));
  end loop;
  return out;
end
$fn$;

create or replace function public.import_property_batch(p_workspace bigint, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  n int;
  rec jsonb;
  v_line1 text;
  v_city text;
  v_state text;
  v_zip text;
  v_mode text;
  v_key text;
  v_id bigint;
  cur public.properties%rowtype;
  v_beds numeric;
  v_baths numeric;
  v_sqft integer;
  v_year integer;
  v_lot integer;
  v_apn text;
  v_type text;
  v_county text;
  v_facts jsonb;
  v_in_facts jsonb;
  in_beds numeric;
  in_baths numeric;
  in_sqft numeric;
  in_year numeric;
  in_lot numeric;
  in_apn text;
  in_type text;
  in_county text;
  out jsonb := '[]'::jsonb;
begin
  if p_workspace is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'workspace and a row array are required' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_rows);
  if n > 500 then
    raise exception 'at most 500 rows' using errcode = '22023';
  end if;
  if n = 0 then
    return '[]'::jsonb;
  end if;

  for rec in select value from jsonb_array_elements(p_rows)
  loop
    v_line1 := nullif(btrim(rec->>'line1'), '');
    if v_line1 is null then
      out := out || jsonb_build_array(jsonb_build_object(
        'i', (rec->>'i')::int, 'property_id', null, 'address_key', null));
      continue;
    end if;

    v_city := coalesce(rec->>'city', '');
    v_state := coalesce(rec->>'state', '');
    v_zip := coalesce(rec->>'zip', '');
    v_mode := case when rec->>'mode' = 'overwrite' then 'overwrite' else 'fill' end;
    v_key := public.address_key(v_line1, v_city, v_state, v_zip);

    in_beds := case when coalesce(rec->>'beds', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (rec->>'beds')::numeric else null end;
    in_baths := case when coalesce(rec->>'baths', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (rec->>'baths')::numeric else null end;
    in_sqft := case when coalesce(rec->>'sqft', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (rec->>'sqft')::numeric else null end;
    in_year := case when coalesce(rec->>'year_built', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (rec->>'year_built')::numeric else null end;
    in_lot := case when coalesce(rec->>'lot_sqft', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (rec->>'lot_sqft')::numeric else null end;
    in_apn := nullif(btrim(rec->>'apn'), '');
    in_type := nullif(btrim(rec->>'property_type'), '');
    in_county := nullif(btrim(rec->>'county'), '');
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_in_facts
      from jsonb_each(case when jsonb_typeof(rec->'facts') = 'object' then rec->'facts' else '{}'::jsonb end) e
     where e.value <> 'null'::jsonb
       and not (jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') = '')
       and not (jsonb_typeof(e.value) = 'array' and e.value = '[]'::jsonb);

    v_id := null;
    if v_key is not null then
      select id into v_id
        from public.properties
       where workspace_id = p_workspace and address_key = v_key
       order by id
       limit 1;
    end if;

    if v_id is null then
      insert into public.properties (
        workspace_id, line1, city, state, zip, source,
        beds, baths, sqft, year_built, apn, property_type, county, lot_sqft, facts)
      values (
        p_workspace, v_line1, nullif(v_city, ''), nullif(v_state, ''), nullif(v_zip, ''), 'import',
        in_beds, in_baths,
        case when in_sqft is null or in_sqft < 0 or in_sqft > 2147483647 then null else trunc(in_sqft)::integer end,
        case when in_year is null or in_year < 0 or in_year > 2147483647 then null else trunc(in_year)::integer end,
        in_apn, in_type, in_county,
        case when in_lot is null or in_lot < 0 or in_lot > 2147483647 then null else trunc(in_lot)::integer end,
        v_in_facts)
      on conflict (workspace_id, address_key) where address_key is not null
      do update set line1 = public.properties.line1
      returning id into v_id;
    end if;

    select * into cur from public.properties where id = v_id;

    if v_mode = 'overwrite' then
      v_beds := coalesce(in_beds, cur.beds);
      v_baths := coalesce(in_baths, cur.baths);
      v_sqft := coalesce(case when in_sqft is null or in_sqft < 0 or in_sqft > 2147483647 then null else trunc(in_sqft)::integer end, cur.sqft);
      v_year := coalesce(case when in_year is null or in_year < 0 or in_year > 2147483647 then null else trunc(in_year)::integer end, cur.year_built);
      v_lot := coalesce(case when in_lot is null or in_lot < 0 or in_lot > 2147483647 then null else trunc(in_lot)::integer end, cur.lot_sqft);
      v_apn := coalesce(in_apn, nullif(btrim(cur.apn), ''));
      v_type := coalesce(in_type, nullif(btrim(cur.property_type), ''));
      v_county := coalesce(in_county, nullif(btrim(cur.county), ''));
      v_facts := coalesce(cur.facts, '{}'::jsonb) || v_in_facts;
    else
      v_beds := coalesce(cur.beds, in_beds);
      v_baths := coalesce(cur.baths, in_baths);
      v_sqft := coalesce(cur.sqft, case when in_sqft is null or in_sqft < 0 or in_sqft > 2147483647 then null else trunc(in_sqft)::integer end);
      v_year := coalesce(cur.year_built, case when in_year is null or in_year < 0 or in_year > 2147483647 then null else trunc(in_year)::integer end);
      v_lot := coalesce(cur.lot_sqft, case when in_lot is null or in_lot < 0 or in_lot > 2147483647 then null else trunc(in_lot)::integer end);
      v_apn := coalesce(nullif(btrim(cur.apn), ''), in_apn);
      v_type := coalesce(nullif(btrim(cur.property_type), ''), in_type);
      v_county := coalesce(nullif(btrim(cur.county), ''), in_county);
      v_facts := v_in_facts || coalesce(cur.facts, '{}'::jsonb);
    end if;

    if cur.beds is distinct from v_beds
      or cur.baths is distinct from v_baths
      or cur.sqft is distinct from v_sqft
      or cur.year_built is distinct from v_year
      or cur.lot_sqft is distinct from v_lot
      or cur.apn is distinct from v_apn
      or cur.property_type is distinct from v_type
      or cur.county is distinct from v_county
      or cur.facts is distinct from v_facts
    then
      update public.properties set
        beds = v_beds,
        baths = v_baths,
        sqft = v_sqft,
        year_built = v_year,
        lot_sqft = v_lot,
        apn = v_apn,
        property_type = v_type,
        county = v_county,
        facts = v_facts,
        updated_at = now()
      where id = v_id and workspace_id = p_workspace;
    end if;

    out := out || jsonb_build_array(jsonb_build_object(
      'i', (rec->>'i')::int,
      'property_id', v_id,
      'address_key', v_key
    ));
  end loop;
  return out;
end
$fn$;

revoke all on function public.import_address_lookup(bigint, jsonb) from public, anon;
grant execute on function public.import_address_lookup(bigint, jsonb) to authenticated, service_role;

revoke all on function public.import_property_batch(bigint, jsonb) from public, anon;
grant execute on function public.import_property_batch(bigint, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
