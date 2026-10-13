-- 127 · The photo read that took the API down.
--
-- Every page load reads a workspace's deal photos newest-last
-- (lib/crm.ts: deal_files where workspace_id, kind = 'photo', url is not
-- null, order by created_at, limit 5000). With the provider and Drive photos the
-- table reached ~90,000 rows for one workspace, and with no index that
-- matches, the read sorted all of them under the per-row membership check
-- and hit the 8 s statement timeout on every load (723 times on
-- 2026-10-02). Enough of those at once held every pooled connection, and
-- PostgREST answered 503 "Could not query the database for the schema
-- cache" to everything for about a minute.
--
-- With this partial index the read walks the first 5,000 entries in order:
-- 25 ms instead of 8 s+. Created on the live project with CONCURRENTLY
-- ahead of this file; here it is a no-op (the runner applies files in a
-- transaction, where CONCURRENTLY cannot run).

create index if not exists deal_files_ws_photo_created_idx
  on public.deal_files (workspace_id, created_at)
  where kind = 'photo' and url is not null;
