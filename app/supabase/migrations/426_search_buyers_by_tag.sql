-- 426 · One page of a workspace's buyers by tag, on the server.
--
-- Compr's Realtors smart list filters on avatar-realtor: ~137k rows, ~128k of
-- them the free-agent corpus the shell never loads (lib/crm.ts). The client
-- filter only saw the ~8k in memory. This pages every active row with the tag,
-- same shape and search as search_free_agent_buyers_geo (migration 106).
-- Count and page are separate queries: the page walks
-- buyers_workspace_name_id_idx (~25 ms), the count is a narrow scan (~300 ms).

create or replace function public.search_buyers_by_tag(
  p_workspace_id bigint,
  p_tag text,
  p_q text default '',
  p_limit integer default 50,
  p_offset integer default 0,
  p_state text default '',
  p_city text default ''
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_q text;
  v_state text := upper(btrim(coalesce(p_state, '')));
  v_city text := btrim(coalesce(p_city, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 0), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb := '[]'::jsonb;
begin
  if p_workspace_id is null or coalesce(btrim(p_tag), '') = '' then
    raise exception 'workspace and tag required' using errcode = '22023';
  end if;
  v_q := left(btrim(coalesce(p_q, '')), 80);
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  select count(*)::integer into v_total
    from public.buyers b
   where b.workspace_id = p_workspace_id
     and b.archived_at is null
     and b.tags @> array[p_tag]
     and (v_q = '' or (
       b.name ilike '%' || v_q || '%' escape '\'
       or coalesce(b.company, '') ilike '%' || v_q || '%' escape '\'
       or coalesce(b.email, '') ilike '%' || v_q || '%' escape '\'
       or coalesce(b.phone, '') ilike '%' || v_q || '%' escape '\'
       or exists (select 1 from unnest(coalesce(b.markets, '{}'::text[])) m where m ilike '%' || v_q || '%' escape '\')
     ))
     and (v_state = '' or exists (
       select 1 from unnest(coalesce(b.markets, '{}'::text[])) m where upper(btrim(split_part(m, ',', 2))) = v_state
     ))
     and (v_city = '' or exists (
       select 1 from unnest(coalesce(b.markets, '{}'::text[])) m
        where lower(btrim(split_part(m, ',', 1))) = lower(split_part(v_city, ',', 1))
          and (v_state = '' or upper(btrim(split_part(m, ',', 2))) = v_state)
          and (position(',' in v_city) = 0 or upper(btrim(split_part(m, ',', 2))) = upper(btrim(split_part(v_city, ',', 2))))
     ));

  if v_limit > 0 and v_total > 0 then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.name, t.id), '[]'::jsonb) into v_rows
      from (
        select id, name, company, email, phone, markets, max_purchase_price, buy_box, status, notes, source,
               buyer_type, entity_type, criteria, vetted_at, vip, blacklisted_at, preferred_channel,
               created_at, last_activity_at, tags
          from public.buyers b
         where b.workspace_id = p_workspace_id
           and b.archived_at is null
           and b.tags @> array[p_tag]
           and (v_q = '' or (
             b.name ilike '%' || v_q || '%' escape '\'
             or coalesce(b.company, '') ilike '%' || v_q || '%' escape '\'
             or coalesce(b.email, '') ilike '%' || v_q || '%' escape '\'
             or coalesce(b.phone, '') ilike '%' || v_q || '%' escape '\'
             or exists (select 1 from unnest(coalesce(b.markets, '{}'::text[])) m where m ilike '%' || v_q || '%' escape '\')
           ))
           and (v_state = '' or exists (
             select 1 from unnest(coalesce(b.markets, '{}'::text[])) m where upper(btrim(split_part(m, ',', 2))) = v_state
           ))
           and (v_city = '' or exists (
             select 1 from unnest(coalesce(b.markets, '{}'::text[])) m
              where lower(btrim(split_part(m, ',', 1))) = lower(split_part(v_city, ',', 1))
                and (v_state = '' or upper(btrim(split_part(m, ',', 2))) = v_state)
                and (position(',' in v_city) = 0 or upper(btrim(split_part(m, ',', 2))) = upper(btrim(split_part(v_city, ',', 2))))
           ))
         order by name, id
         limit v_limit offset v_offset
      ) t;
  end if;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

revoke all on function public.search_buyers_by_tag(bigint, text, text, integer, integer, text, text) from public;
grant execute on function public.search_buyers_by_tag(bigint, text, text, integer, integer, text, text) to authenticated;
