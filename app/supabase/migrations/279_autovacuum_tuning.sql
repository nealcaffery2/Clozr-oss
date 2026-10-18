-- 279 · Planner statistics that keep up with the tables that matter.
--
-- On a large workspace sellers, vendors, buyer_phones, podio_items and
-- properties could go without an auto-analyze for good, and buyers carried
-- many dead rows days after its last autovacuum. The planner's row estimates
-- were far too low, and it answered with sequential scans of properties and
-- deal_files, while the indexes that fit sat unused. A manual ANALYZE fixed the plans at once.
--
-- The global thresholds (analyze after 10% of rows change, vacuum after 20%)
-- are right for small tables and wrong for these: tens of thousands of
-- buyers have to change before the statistics move. Per table, the thresholds here mean a re-analyze
-- after about 2% of rows (plus 500) and a vacuum after 5% (plus 1,000), which
-- autovacuum checks every minute at no visible cost. Nothing else changes:
-- the same autovacuum, the same workers, the same cost limits.
--
-- Safe to re-run. ALTER TABLE SET takes a short lock that does not block reads.

alter table public.buyers          set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.sellers         set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 500);
alter table public.vendors         set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.properties      set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 500);
alter table public.communications  set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.deal_files      set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.deals           set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 100, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 200);
alter table public.buyer_phones    set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.buyer_emails    set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 500);
alter table public.activity        set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
alter table public.podio_items     set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200, autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 500);

-- Fresh statistics now, not at the next threshold.
analyze public.buyers;
analyze public.sellers;
analyze public.vendors;
analyze public.properties;
analyze public.communications;
analyze public.deal_files;
analyze public.deals;
analyze public.buyer_phones;
analyze public.buyer_emails;
analyze public.activity;
analyze public.podio_items;
