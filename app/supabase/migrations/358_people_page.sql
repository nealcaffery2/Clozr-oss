-- 358 · people_page: one page of the People list, filtered and sorted in
-- Postgres, with the total, in one call (lib/people-page.ts).
--
-- Follow Up Boss style: the list asks for 50 rows, offset, sort and its
-- filters, instead of the client reading every seller (crm_sellers, about 2 s
-- on a large workspace) and filtering in memory. Security invoker: RLS on sellers,
-- properties, tasks and deals answers as it always has.
--
-- p_filters keys (every one optional; a missing key narrows nothing):
--   stages text[]        lead_stage in
--   stage_prefix text    lead_stage like prefix%          (Appointments)
--   not_stages text[]    lead_stage not in                 (Reactivation)
--   owners uuid[]        assigned_to in
--   unassigned bool      assigned_to is null (or-ed with owners)
--   sources text[]       source in
--   tags text[]          tags overlap
--   not_tags text[]      no tag in (the secret-list tag)
--   ids bigint[]         id in (the realtime single-row read)
--   not_ids bigint[]     id not in (this session's hidden rows)
--   phone 'has'|'none'   email 'has'|'none'  (lib/contact-presence.ts: 7+ digits, an @ and a dot)
--   touch 'none'|'any'   last_touch_at null / not null
--   touch_within_min int last touch newer than N minutes ago
--   touch_older_min int  last touch null or older than N minutes ago
--   touch_quiet_min int  last touch not null and older than N minutes ago
--   created_from / created_to timestamptz
--   due_before timestamptz  an open, manual task due before it (Follow Up Today)
--   closing bool         the best deal has a close date
--   compr 'run'|'not'    the best deal has a COMPR report or an ARV
--   dm bool              source deal_machine or a dm-prospect tag
--   terms text[]         every term ilike-matches name, phone, email, address, source, tags
--   digits text          the phone's digits contain it
--   archived bool        include archived rows (default: live rows only)
--   stage_order text[]   the order the Stage sort uses
--   ids_only bool        return {total, ids} instead of rows
-- p_sort: touch | created | name | stage | score (score is created: nothing scores a live lead yet)
-- p_dir: asc | desc
--
-- Rows are the sellers columns the client's SellerRow names, plus
-- properties (as crm_sellers embeds it), next_task {title, due_at} and deal
-- (the best deal by crm.ts dealRank: an open contract, else a real deal,
-- else the newest submission). jsonb_strip_nulls as crm_sellers (284).

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
security invoker
set search_path = public, pg_temp
as $$
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
      left join properties p on p.id = s.property_id
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
       and (f.terms is null or not exists (
             select 1 from unnest(f.terms) term
              where concat_ws(' ', s.name, s.phone, s.email, s.property_address, s.source, array_to_string(s.tags, ' '),
                              p.line1, p.city, p.state, p.zip) not ilike '%' || term || '%'))
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
  from f;
$$;

revoke all on function public.people_page(bigint, jsonb, text, text, int, int) from public, anon;
grant execute on function public.people_page(bigint, jsonb, text, text, int, int) to authenticated, service_role;
