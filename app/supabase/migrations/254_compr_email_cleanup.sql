-- 254: email sender cleanup for one production workspace.
--
-- Removed in the open-source release: private underwriting provider
-- integration (it only switched one workspace's blast senders and domain).
-- Kept as a no-op so the migration ledger order holds.
select 1;
