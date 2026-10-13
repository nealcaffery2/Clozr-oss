-- 240: one-time repair of transaction files and rep name columns on one
-- production database's deals.
--
-- Removed in the open-source release: a data backfill for the company's own
-- deal history, with no schema change. Kept as a no-op so the migration
-- ledger order holds.
select 1;
