-- 359 · people_page without the properties join, as definer with a membership gate.
--
-- 358's function took 36 to 77 s on the live workspace (4.7 million buffers):
-- with every filter optional the planner expected one seller row and nested
-- a seq scan of properties inside the loop over every seller. The
-- prototype measured at 25 ms had literal filters, so it never hit this.
-- PostgREST's statement timeout cancelled the call and the live People list
-- showed nothing until the client fell back. Now the house's address is read
-- through its key, only when a search needs it. Also security definer with
-- `p_ws in (select my_workspace_ids())` or null, the way migration 280's
-- table functions decide who may read, so RLS subqueries stay out of the
-- plan. Same rows. Safe to re-run.

create or replace function public.people_page(
  p_ws bigint,
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'touch',
  p_dir text default 'desc',
  p_lim int default 50,
  p_off int default 0
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_ws in (select public.my_workspace_ids()) then (
  with f as (
    select
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'stages') x) stages,
      p_filters->>'stage_prefix' stage_prefix,
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'not_stages') x) not_stages,
      (select array_agg(x::uuid) from jsonb_array_elements_text(p_filters->'owners') x) owners,
      coalesce((p_filters->>'unassigned')::bool, false) unassigned,
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'sources') x) sources,
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'tags') x) tags,
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'not_tags') x) not_tags,
      (select array_agg(x::bigint) from jsonb_array_elements_text(p_filters->'ids') x) ids,
      (select array_agg(x::bigint) from jsonb_array_elements_text(p_filters->'not_ids') x) not_ids,
      p_filters->>'phone' phone,
      p_filters->>'email' email,
      p_filters->>'touch' touch,
      (p_filters->>'touch_within_min')::int touch_within_min,
      (p_filters->>'touch_older_min')::int touch_older_min,
      (p_filters->>'touch_quiet_min')::int touch_quiet_min,
      (p_filters->>'created_from')::timestamptz created_from,
      (p_filters->>'created_to')::timestamptz created_to,
      (p_filters->>'due_before')::timestamptz due_before,
      (p_filters->>'closing')::bool closing,
      p_filters->>'compr' compr,
      (p_filters->>'dm')::bool dm,
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'terms') x) terms,
      p_filters->>'digits' digits,
      coalesce((p_filters->>'archived')::bool, false) archived,
      (select array_agg(x) from jsonb_array_elements_text(p_filters->'stage_order') x) stage_order,
      coalesce((p_filters->>'ids_only')::bool, false) ids_only
  ),
  m as (
    select s.id, s.created_at, s.last_touch_at, s.name, s.lead_stage,
           count(*) over () total
      from sellers s cross join f
     where s.workspace_id = p_ws
       and (f.archived or s.archived_at is null)
       and (f.stages is null or s.lead_stage = any (f.stages))
       and (f.stage_prefix is null or s.lead_stage like f.stage_prefix || '%')
       and (f.not_stages is null or not (coalesce(s.lead_stage, 'Lead') = any (f.not_stages)))
       and (f.owners is null and not f.unassigned
            or s.assigned_to = any (coalesce(f.owners, '{}'::uuid[]))
            or (f.unassigned and s.assigned_to is null))
       and (f.sources is null or coalesce(s.source, 'Manual') = any (f.sources))
       and (f.tags is null or coalesce(s.tags, '{}'::text[]) && f.tags)
       and (f.not_tags is null or not (coalesce(s.tags, '{}'::text[]) && f.not_tags))
       and (f.ids is null or s.id = any (f.ids))
       and (f.not_ids is null or not (s.id = any (f.not_ids)))
       and (f.phone is null or (f.phone = 'has') = (length(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) >= 7))
       and (f.email is null or (f.email = 'has') = (trim(coalesce(s.email, '')) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'))
       and (f.touch is null or (f.touch = 'any') = (s.last_touch_at is not null))
       and (f.touch_within_min is null or s.last_touch_at > now() - make_interval(mins => f.touch_within_min))
       and (f.touch_older_min is null or s.last_touch_at is null or s.last_touch_at < now() - make_interval(mins => f.touch_older_min))
       and (f.touch_quiet_min is null or (s.last_touch_at is not null and s.last_touch_at < now() - make_interval(mins => f.touch_quiet_min)))
       and (f.created_from is null or s.created_at >= f.created_from)
       and (f.created_to is null or s.created_at < f.created_to)
       and (f.due_before is null or exists (
             select 1 from tasks t
              where t.seller_id = s.id and not t.done and not t.automated and t.due_at < f.due_before))
       and (f.closing is null or f.closing = exists (
             select 1 from deals b where b.seller_id = s.id and b.archived_at is null and b.close_date is not null))
       and (f.compr is null or (f.compr = 'run') = exists (
             select 1 from deals b where b.seller_id = s.id and b.archived_at is null and (b.underwriting_url is not null or b.arv is not null)))
       and (f.dm is null or f.dm = (lower(coalesce(s.source, '')) = 'deal_machine'
             or exists (select 1 from unnest(coalesce(s.tags, '{}'::text[])) tg where lower(trim(tg)) in ('dm-prospect', 'deal-machine', 'deal_machine'))))
       -- The house's line through its key only when searching: a join on
       -- properties here made the planner nest a seq scan of it per seller.
       and (f.terms is null or not exists (
             select 1 from unnest(f.terms) term
              where concat_ws(' ', s.name, s.phone, s.email, s.property_address, s.source, array_to_string(s.tags, ' '),
                              (select concat_ws(' ', p.line1, p.city, p.state, p.zip) from properties p where p.id = s.property_id))
                    not ilike '%' || term || '%'))
       and (f.digits is null or regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') like '%' || f.digits || '%')
  ),
  pg as (
    select m.*
      from m, f
     order by
       -- A search ranks name matches first (lib/list-search.ts searchRank).
       case when f.terms is null then 0
            when lower(m.name) = array_to_string(f.terms, ' ') then 0
            when lower(m.name) like array_to_string(f.terms, ' ') || '%' then 1
            when lower(m.name) like '%' || array_to_string(f.terms, ' ') || '%' then 2
            else 4 end,
       case when p_sort = 'name' and p_dir = 'asc' then m.name end asc,
       case when p_sort = 'name' and p_dir <> 'asc' then m.name end desc,
       case when p_sort = 'stage' and p_dir = 'asc' then coalesce(array_position(f.stage_order, m.lead_stage), 9999) end asc,
       case when p_sort = 'stage' and p_dir <> 'asc' then coalesce(array_position(f.stage_order, m.lead_stage), 9999) end desc,
       case when p_sort = 'touch' and p_dir = 'asc' then m.last_touch_at end asc nulls first,
       case when p_sort = 'touch' and p_dir <> 'asc' then m.last_touch_at end desc nulls last,
       case when p_sort in ('created', 'score') and p_dir = 'asc' then m.created_at end asc,
       case when p_sort in ('created', 'score') and p_dir <> 'asc' then m.created_at end desc,
       m.id desc
     limit case when (select ids_only from f) then null else greatest(1, least(coalesce(p_lim, 50), 500)) end
     offset case when (select ids_only from f) then 0 else greatest(0, coalesce(p_off, 0)) end
  ),
  numbered as (
    select pg.*, row_number() over () n from pg
  )
  select case
    when (select ids_only from f) then jsonb_build_object(
      'total', coalesce((select max(total) from numbered), 0),
      'ids', coalesce((select jsonb_agg(id order by n) from numbered), '[]'::jsonb))
    else jsonb_build_object(
      'total', coalesce((select max(total) from numbered), 0),
      'rows', coalesce((
        select jsonb_agg(jsonb_strip_nulls(
          jsonb_build_object(
            'id', s.id, 'name', s.name, 'email', s.email, 'phone', s.phone, 'property_address', s.property_address,
            'asking_price', s.asking_price, 'motivation', s.motivation, 'timeline', s.timeline, 'condition', s.condition,
            'occupancy', s.occupancy, 'mortgage', s.mortgage, 'desired_close', s.desired_close,
            'decision_makers', s.decision_makers, 'intake', s.intake, 'lead_stage', s.lead_stage,
            'stage_entered_at', s.stage_entered_at, 'notes', s.notes, 'source', s.source, 'created_at', s.created_at,
            'created_by', s.created_by, 'property_id', s.property_id, 'assigned_to', s.assigned_to, 'tags', s.tags,
            'updated_at', s.updated_at, 'underwriter_id', s.underwriter_id, 'archived_at', s.archived_at,
            'last_touch_at', s.last_touch_at, 'last_touch_channel', s.last_touch_channel,
            'properties', (select jsonb_build_object(
                'id', p.id, 'line1', p.line1, 'city', p.city, 'state', p.state, 'zip', p.zip,
                'beds', p.beds, 'baths', p.baths, 'sqft', p.sqft, 'year_built', p.year_built,
                'property_type', p.property_type, 'apn', p.apn, 'lat', p.lat, 'lng', p.lng)
              from properties p where p.id = s.property_id),
            'next_task', (select jsonb_build_object('title', t.title, 'due_at', t.due_at)
              from tasks t where t.seller_id = s.id and not t.done and not t.automated
              order by t.due_at asc nulls last, t.id limit 1),
            'deal', (select jsonb_build_object(
                'id', b.id, 'stage', b.stage, 'offer_amount', b.offer_amount, 'owner_id', b.owner_id, 'market', b.market,
                'hero_image_url', b.hero_image_url, 'close_date', b.close_date, 'underwriting_url', b.underwriting_url, 'arv', b.arv)
              from deals b where b.seller_id = s.id and b.archived_at is null
              order by (case when b.stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow') then 3
                             when b.stage is not null and b.stage <> 'Prospect' then 2 else 1 end) desc,
                       coalesce(b.contract_date::timestamptz, b.submitted_at) desc nulls last, b.id desc
              limit 1)
          )) order by numbered.n)
          from numbered join sellers s on s.id = numbered.id), '[]'::jsonb))
  end
  from f) end;
$$;

revoke all on function public.people_page(bigint, jsonb, text, text, int, int) from public, anon;
grant execute on function public.people_page(bigint, jsonb, text, text, int, int) to authenticated, service_role;
