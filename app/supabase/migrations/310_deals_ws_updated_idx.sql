-- 310 · deals by workspace and last change, for crm_deals' delta read (311).
--
-- A delta read asks for the deals changed since the client's last read. With
-- no (workspace_id, updated_at) index on deals, that was a scan of every deal
-- in the workspace (thousands of buffers on a large workspace) on every reload.
-- sellers (sellers_workspace_idx) and properties (properties_ws_updated_idx)
-- already have theirs.
--
-- CONCURRENTLY, so the runner applies this file outside a transaction. A
-- failed build leaves an INVALID index that `if not exists` then skips: drop
-- it by hand (drop index concurrently deals_ws_updated_idx) and run again.

create index concurrently if not exists deals_ws_updated_idx
  on public.deals (workspace_id, updated_at);
