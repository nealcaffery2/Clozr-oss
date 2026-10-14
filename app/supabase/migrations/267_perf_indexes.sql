-- 267 · Indexes for the reads that dominated the October API spike.
--
-- NOT reviewed on production yet. Do not merge this file until each index
-- has been checked with EXPLAIN (ANALYZE, BUFFERS) on a branch or a copy.
-- The runner applies a file that contains CONCURRENTLY outside a transaction
-- (227 is the pattern). To record it without building the indexes, mark the
-- ledger by hand (`pnpm migrate --mark 267_perf_indexes.sql`) and build them
-- with these statements yourself.
--
-- A concurrent build that failed leaves an INVALID index under the same name,
-- which `if not exists` then skips. Drop that one (`drop index concurrently
-- <name>`) and run again.
--
-- pg_trgm already lives in schema extensions (227). The operator class is
-- extensions.gin_trgm_ops.

create extension if not exists pg_trgm with schema extensions;

-- Report communications: ORDER BY occurred_at DESC, id DESC. The older index
-- has no id, so each page sorts.
create index concurrently if not exists communications_ws_occurred_id_idx
  on public.communications (workspace_id, occurred_at desc, id desc);

-- deal_buyer_matches paging ORDER BY score DESC, id had no workspace index,
-- so each page scanned the table.
create index concurrently if not exists deal_buyer_matches_ws_score_idx
  on public.deal_buyer_matches (workspace_id, score desc, id);

-- Full deal reads filter on workspace and order by id.
create index concurrently if not exists deals_ws_id_idx
  on public.deals (workspace_id, id);

-- Address match on properties.line1 (ilike) and state filters.
create index concurrently if not exists properties_line1_trgm_idx
  on public.properties using gin (line1 extensions.gin_trgm_ops);

create index concurrently if not exists properties_ws_state_idx
  on public.properties (workspace_id, state);

-- Delta reads by updated_at.
create index concurrently if not exists properties_ws_updated_idx
  on public.properties (workspace_id, updated_at);

-- Shell buyer pages. The free-agent corpus (source dispogenius-free-agents)
-- is searched through its own RPC and is left out of this index.
create index concurrently if not exists buyers_ws_updated_shell_idx
  on public.buyers (workspace_id, updated_at)
  where source is distinct from 'dispogenius-free-agents';
