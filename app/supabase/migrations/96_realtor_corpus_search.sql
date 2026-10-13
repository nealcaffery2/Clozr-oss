-- 96 · Realtors can be browsed without loading the free-agent corpus into the shell.
--
-- Workspace 11 holds ~127k buyers with source dispogenius-free-agents and
-- buyer_type realtors. Hydrating them with the rest of the shell trips the
-- 8s statement timeout, so the shell still skips that source. This index
-- makes a name-ordered page and the unfiltered count an index scan, and the
-- function pages a search (name, company, email, phone, market) for the
-- Buyers › Realtors list.

create index if not exists buyers_free_agents_name_idx
  on public.buyers (workspace_id, name, id)
  where source = 'dispogenius-free-agents';

create or replace function public.search_free_agent_buyers(
  p_workspace_id bigint,
  p_q text default '',
  p_limit integer default 50,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_q text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 0), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb;
begin
  if p_workspace_id is null then
    raise exception 'workspace required' using errcode = '22023';
  end if;
  v_q := left(btrim(coalesce(p_q, '')), 80);
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  if v_q = '' then
    select count(*) into v_total
      from public.buyers
     where workspace_id = p_workspace_id
       and source = 'dispogenius-free-agents';
    if v_limit = 0 then
      return jsonb_build_object('total', v_total, 'rows', '[]'::jsonb);
    end if;
    select coalesce(jsonb_agg(to_jsonb(t) order by t.name, t.id), '[]'::jsonb) into v_rows
      from (
        select id, name, company, email, phone, markets, max_purchase_price, buy_box, status, notes, source,
               buyer_type, entity_type, criteria, vetted_at, vip, blacklisted_at, preferred_channel,
               created_at, last_activity_at, tags
          from public.buyers
         where workspace_id = p_workspace_id
           and source = 'dispogenius-free-agents'
         order by name, id
         limit v_limit offset v_offset
      ) t;
  else
    select count(*) into v_total
      from public.buyers b
     where b.workspace_id = p_workspace_id
       and b.source = 'dispogenius-free-agents'
       and (
         b.name ilike '%' || v_q || '%' escape '\'
         or coalesce(b.company, '') ilike '%' || v_q || '%' escape '\'
         or coalesce(b.email, '') ilike '%' || v_q || '%' escape '\'
         or coalesce(b.phone, '') ilike '%' || v_q || '%' escape '\'
         or exists (
           select 1 from unnest(coalesce(b.markets, '{}'::text[])) m
            where m ilike '%' || v_q || '%' escape '\'
         )
       );
    if v_limit = 0 then
      return jsonb_build_object('total', v_total, 'rows', '[]'::jsonb);
    end if;
    select coalesce(jsonb_agg(to_jsonb(t) order by t.name, t.id), '[]'::jsonb) into v_rows
      from (
        select id, name, company, email, phone, markets, max_purchase_price, buy_box, status, notes, source,
               buyer_type, entity_type, criteria, vetted_at, vip, blacklisted_at, preferred_channel,
               created_at, last_activity_at, tags
          from public.buyers b
         where b.workspace_id = p_workspace_id
           and b.source = 'dispogenius-free-agents'
           and (
             b.name ilike '%' || v_q || '%' escape '\'
             or coalesce(b.company, '') ilike '%' || v_q || '%' escape '\'
             or coalesce(b.email, '') ilike '%' || v_q || '%' escape '\'
             or coalesce(b.phone, '') ilike '%' || v_q || '%' escape '\'
             or exists (
               select 1 from unnest(coalesce(b.markets, '{}'::text[])) m
                where m ilike '%' || v_q || '%' escape '\'
             )
           )
         order by name, id
         limit v_limit offset v_offset
      ) t;
  end if;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

revoke all on function public.search_free_agent_buyers(bigint, text, integer, integer) from public;
grant execute on function public.search_free_agent_buyers(bigint, text, integer, integer) to authenticated;
