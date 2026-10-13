-- 126 · Realtors by market, for the Buyers map lasso.
--
-- The realtor corpus (127k agents, source dispogenius-free-agents) is paged
-- on the server and shown on the map as one bubble per market. A lasso round
-- a few bubbles asks for every agent in those markets at once: Phoenix alone
-- is 8,210. Without an index that is an 0.8 s sequential scan of the whole
-- buyers table, and PostgREST's 1,000-row cap would repeat it per page, so
-- the agents come back as one jsonb payload and the overlap uses a partial GIN
-- index on the corpus's markets.

create index if not exists buyers_free_agents_markets_idx
  on public.buyers using gin (markets)
  where source = 'dispogenius-free-agents';

-- Up to p_limit agents (at most 10,000) in any of p_markets, by name, with
-- what the bulk bar needs to text, email or queue them, and the full count so
-- the app can say when it took the first 5,000 of more. Invoker: the buyers
-- table's own row security decides what a caller sees.
create or replace function public.free_agents_in_markets(p_workspace_id bigint, p_markets text[], p_limit integer default 5000)
returns jsonb
language sql
stable
set search_path = public
as $$
  with hits as (
    select b.id, b.name, b.company, b.phone, b.email, b.preferred_channel, b.status, b.blacklisted_at is not null as blacklisted
      from public.buyers b
     where b.workspace_id = p_workspace_id
       and b.source = 'dispogenius-free-agents'
       and b.markets && coalesce(p_markets, '{}'::text[])
  )
  select jsonb_build_object(
    'total', (select count(*) from hits),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.name, t.id)
        from (select * from hits order by name, id limit least(greatest(coalesce(p_limit, 5000), 0), 10000)) t
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.free_agents_in_markets(bigint, text[], integer) to authenticated;
