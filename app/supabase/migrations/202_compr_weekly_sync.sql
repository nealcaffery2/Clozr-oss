-- 202: weekly outcome sync to the underwriting provider.
--
-- Removed in the open-source release: private underwriting provider
-- integration (a weekly cron that sent closed deals to the provider's
-- calibration endpoint, and its report table). Kept as a no-op so the
-- migration ledger order holds.
select 1;
