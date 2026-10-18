-- 334 · cold_workspace_settings.health_checked_at: when cold-campaign-tick
-- last ran its 15-minute health pass for the workspace.
--
-- The pass (auto-pause on bounce, complaint, unsubscribe and reply rates)
-- ran at the end of every tick. It now runs before a workspace's first send
-- in a tick, after a tick that sent or recorded a reply there, and otherwise
-- once every 15 minutes: the run whose conditional update moves this stamp
-- takes the slot, so overlapping runs do it once. '-infinity' means never.
-- Until this applies the update errors and the tick runs the pass every
-- time, as before. Constant default: no table rewrite. Safe to re-run.

alter table public.cold_workspace_settings
  add column if not exists health_checked_at timestamptz not null default '-infinity';
