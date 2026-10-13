-- 250: trial-user sync schedule for the underwriting provider.
--
-- Removed in the open-source release: private underwriting provider
-- integration (a cron that pulled the provider's trial users into a
-- workspace). Kept as a no-op so the migration ledger order holds.
select 1;
