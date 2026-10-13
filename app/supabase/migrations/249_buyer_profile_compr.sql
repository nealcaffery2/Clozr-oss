-- 249: buyer list profile for the underwriting provider's own workspace.
--
-- Removed in the open-source release: private underwriting provider
-- integration (trial-user columns on buyers and a workspace-specific
-- setting). Kept as a no-op so the migration ledger order holds.
select 1;
