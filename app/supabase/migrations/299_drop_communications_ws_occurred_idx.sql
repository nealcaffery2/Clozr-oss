-- communications_ws_occurred_idx (workspace_id, occurred_at desc) is a prefix of
-- communications_ws_occurred_id_idx (workspace_id, occurred_at desc, id desc),
-- which serves every query it served. One less index to write on every insert.
drop index concurrently if exists public.communications_ws_occurred_idx;
