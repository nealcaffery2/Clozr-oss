-- 429 · One row that keeps Vercel's production builds from deploying edge
-- functions on top of each other. Several merges in a row start several
-- builds at once, and each one runs scripts/deploy-supabase.mjs; without a
-- turn the last one to finish wins, which can be an older commit.
-- newest_* is the newest commit any build has seen (older builds skip);
-- holder_sha is the build deploying right now. Written only by the build,
-- through the Management API; no policies, so clients can't read it.
-- deploy-supabase.mjs runs this file itself before it takes the lock, so it
-- exists before migrate.mjs reaches it. Safe to re-run.

create table if not exists public.deploy_lock (
  id               int primary key default 1 check (id = 1),
  newest_sha       text,
  newest_commit_at timestamptz,
  holder_sha       text,
  locked_at        timestamptz
);

alter table public.deploy_lock enable row level security;
