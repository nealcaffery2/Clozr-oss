-- 435 · One row that keeps two migration runs from applying the same files at
-- once. The Vercel production build (scripts/deploy-supabase.mjs) and the
-- "Apply database migrations" workflow both run scripts/migrate.mjs on a merge;
-- each read the ledger and applied the same pending files side by side.
-- A run that writes takes this row (holder, locked_at) before it reads the
-- ledger, refreshes locked_at before each file and clears it when done; a lock
-- older than 30 minutes belongs to a run that died and is taken over. A row,
-- not pg_advisory_lock, because the Management API path sends each statement
-- in a session of its own. Written only by the runner; no policies, so clients
-- can't read it. Safe to re-run.

create table if not exists public.migration_lock (
  id        int primary key check (id = 1),
  holder    text,
  locked_at timestamptz
);

alter table public.migration_lock enable row level security;

insert into public.migration_lock (id) values (1) on conflict (id) do nothing;
