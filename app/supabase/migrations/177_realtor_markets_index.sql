-- 177 · free_agent_markets reads an index, not the realtor heap.
--
-- free_agent_markets (migration 106) unnests `markets` for every one of the
-- ~127k free-agent realtors in workspace 11. The name index from 96 finds the
-- rows but not the column, so each call read ~128k heap pages (about 1 GB),
-- and under load it ran past the 8s statement timeout and answered 500.
-- With `markets` carried in a partial covering index the same call is an
-- index-only scan of ~1.2k pages. No function or data change. (126's GIN
-- index on `markets` is buyers_free_agents_markets_idx; this one is separate.)

create index if not exists buyers_free_agents_markets_cover_idx
  on public.buyers (workspace_id) include (markets)
  where source = 'dispogenius-free-agents';
