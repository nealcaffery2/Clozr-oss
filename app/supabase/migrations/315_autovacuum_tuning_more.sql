-- 315 · 279's autovacuum thresholds on five more tables the CRM reads.
--
-- buyer_rule_states (large) and stage_events showed no autovacuum or
-- autoanalyze for days after a statistics reset: at 10% / 20% of rows,
-- buyer_rule_states needs tens of thousands of changed rows before its
-- statistics move. notifications, inbox_threads and deal_buyer_matches are
-- small but rewritten often (deal_buyer_matches: each row updated several times
-- a week).
--
-- Same rule as 279: re-analyze after about 2% of rows change (plus a floor
-- sized to the table) and vacuum after about 5%. Nothing else changes.
--
-- Safe to re-run. ALTER TABLE SET takes a short lock that does not block reads.

alter table public.buyer_rule_states  set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.stage_events       set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 500);
alter table public.notifications      set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 100, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 200);
alter table public.inbox_threads      set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 100, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 200);
alter table public.deal_buyer_matches set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 100, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 200);

-- Fresh statistics now, not at the next threshold.
analyze public.buyer_rule_states;
analyze public.stage_events;
analyze public.notifications;
analyze public.inbox_threads;
analyze public.deal_buyer_matches;
