-- 148: AI Autopilot speed-to-lead defaults for one production workspace.
--
-- Removed in the open-source release: it only wrote one company's own
-- autopilot settings (ai_autopilot_settings is set per workspace on the
-- Autopilot screen). Kept as a no-op so the migration ledger order holds.
select 1;
