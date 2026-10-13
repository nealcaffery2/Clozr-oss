-- 106 · Buyer AI scores, blacklist reasons, realtor city/state filters.
--
-- buyer_scores: the buyer-score edge function reads a buyer's whole history
-- (texts, emails, calls, deal sends, offers, closings) and stores a response
-- rate and a 0-100 score with a one-line reason. The Buyers list reads this
-- cache instead of recomputing on every load; computed_at says when it goes
-- stale. Written only by the service role (the function), read by whoever can
-- read buyers.
--
-- blacklist_reasons: the blacklist is still the secret-blacklist tag (lib/
-- secret-list.ts). The reason sits beside it so Account can say why someone is
-- on the list. Keyed by record, so blacklisting again replaces the reason.
--
-- search_free_agent_buyers_geo / free_agent_markets: the Realtors list pages
-- ~127k rows on the server, so a city or state filter has to run there too.
-- Markets are stored "City, ST".

create table if not exists public.buyer_scores (
  buyer_id      bigint primary key references public.buyers(id) on delete cascade,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  response_rate integer check (response_rate between 0 and 100),
  score         integer check (score between 0 and 100),
  reason        text,
  source        text not null default 'ai' check (source in ('ai', 'rule')),
  model         text,
  stats         jsonb not null default '{}'::jsonb,
  computed_at   timestamptz not null default now()
);
create index if not exists buyer_scores_workspace_idx on public.buyer_scores (workspace_id);
alter table public.buyer_scores enable row level security;
drop policy if exists buyer_scores_select on public.buyer_scores;
create policy buyer_scores_select on public.buyer_scores
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
    )
  );
revoke insert, update, delete on public.buyer_scores from authenticated;

create table if not exists public.blacklist_reasons (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  record_kind  text   not null check (record_kind in ('seller', 'buyer')),
  record_id    bigint not null,
  reason       text   not null check (length(reason) between 1 and 500),
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, record_kind, record_id)
);
alter table public.blacklist_reasons enable row level security;
drop policy if exists blacklist_reasons_member on public.blacklist_reasons;
create policy blacklist_reasons_member on public.blacklist_reasons
  for all to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  )
  with check (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );

create or replace function public.search_free_agent_buyers_geo(
  p_workspace_id bigint,
  p_q text default '',
  p_limit integer default 50,
  p_offset integer default 0,
  p_state text default '',
  p_city text default ''
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_q text;
  v_state text := upper(btrim(coalesce(p_state, '')));
  v_city text := btrim(coalesce(p_city, ''));
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

  with hits as (
    select b.*
      from public.buyers b
     where b.workspace_id = p_workspace_id
       and b.source = 'dispogenius-free-agents'
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
  )
  select count(*)::integer,
         coalesce((
           select jsonb_agg(to_jsonb(t) order by t.name, t.id)
             from (
               select id, name, company, email, phone, markets, max_purchase_price, buy_box, status, notes, source,
                      buyer_type, entity_type, criteria, vetted_at, vip, blacklisted_at, preferred_channel,
                      created_at, last_activity_at, tags
                 from hits
                order by name, id
                limit v_limit offset v_offset
             ) t
         ), '[]'::jsonb)
    into v_total, v_rows
    from hits;
  return jsonb_build_object('total', v_total, 'rows', case when v_limit = 0 then '[]'::jsonb else v_rows end);
end;
$$;

revoke all on function public.search_free_agent_buyers_geo(bigint, text, integer, integer, text, text) from public;
grant execute on function public.search_free_agent_buyers_geo(bigint, text, integer, integer, text, text) to authenticated;

-- Every "City, ST" in the corpus with how many realtors carry it: the options
-- for the Realtors city and state filters.
create or replace function public.free_agent_markets(p_workspace_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('market', market, 'count', n) order by n desc), '[]'::jsonb)
    from (
      select btrim(m) as market, count(*)::integer as n
        from public.buyers b, unnest(coalesce(b.markets, '{}'::text[])) m
       where b.workspace_id = p_workspace_id
         and b.source = 'dispogenius-free-agents'
         and position(',' in m) > 0
       group by btrim(m)
       order by n desc
       limit 5000
    ) f;
$$;

revoke all on function public.free_agent_markets(bigint) from public;
grant execute on function public.free_agent_markets(bigint) to authenticated;
