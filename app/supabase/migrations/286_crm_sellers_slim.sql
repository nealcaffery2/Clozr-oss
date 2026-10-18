-- 286 · crm_sellers without null keys and without the full notes column.
--
-- A cold open of a large workspace downloaded crm_sellers as about 20 MB.
-- About a fifth of that was null-valued keys and more than a quarter was
-- sellers.notes. The list does not show the full note: the phone's context
-- uses the first 240 characters, "Podio stage:" is a list filter, and
-- "Photos:" lines become deal photo links (lib/house-photos photosLineUrls).
-- The record reads the whole note when it opens (loadSellerSlice).
--
-- crm_seller_list_notes keeps those three and drops the rest. jsonb_strip_nulls
-- drops null keys on the row, its intake, and the property embed. A missing
-- key and a null are the same to lib/crm.ts (mapPerson, mapProperty).
-- last_touch_at stays selected: a null touch is omitted, and the app treats
-- a missing key as null (rowsCarryLastTouch looks for the key on any row).
--
-- Safe to re-run.

create or replace function public.crm_seller_list_notes(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p is null or btrim(p) = '' then null
    else left(p, 240)
      || coalesce(E'\n' || (
           select string_agg(line[1], E'\n')
             from regexp_matches(substring(p from 241), 'Photos:[^\n]*', 'gi') as m(line)
         ), '')
      || coalesce(E'\n' || (
           select string_agg(line[1], E'\n')
             from regexp_matches(substring(p from 241), 'Podio stage:[^\n]*', 'gi') as m(line)
         ), '')
  end;
$$;

revoke all on function public.crm_seller_list_notes(text) from public, anon;

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
        select jsonb_agg(
                 jsonb_strip_nulls(
                   (to_jsonb(x) - 'notes')
                   || jsonb_build_object(
                        'notes', public.crm_seller_list_notes(x.notes),
                        'properties', (
                          select jsonb_strip_nulls(jsonb_build_object(
                            'id', p.id, 'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip,
                            'beds', p.beds, 'baths', p.baths, 'sqft', p.sqft, 'year_built', p.year_built,
                            'property_type', p.property_type, 'apn', p.apn, 'lat', p.lat, 'lng', p.lng))
                            from public.properties p
                           where p.id = x.property_id and p.workspace_id = p_ws)))
               order by x.created_at desc, x.id desc)
          from (
            select s.id, s.name, s.email, s.phone, s.property_address, s.asking_price, s.motivation, s.timeline,
                   s.condition, s.occupancy, s.mortgage, s.desired_close, s.decision_makers, s.intake, s.lead_stage,
                   s.stage_entered_at, s.notes, s.source, s.created_at, s.created_by, s.property_id, s.assigned_to,
                   s.tags, s.updated_at, s.underwriter_id, s.last_touch_at, s.last_touch_channel
              from public.sellers s
             where s.workspace_id = p_ws and s.archived_at is null
               and (p_since is null or s.updated_at >= p_since
                    or exists (select 1 from public.properties p
                                where p.id = s.property_id and p.workspace_id = p_ws and p.updated_at >= p_since))
          ) x), '[]'::jsonb))
    else null
  end;
$$;

revoke all on function public.crm_sellers(bigint, timestamptz) from public, anon;
grant execute on function public.crm_sellers(bigint, timestamptz) to authenticated, service_role;
