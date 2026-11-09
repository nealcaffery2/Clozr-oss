-- 387 · cold_exclusions: keep warm contacts out of cold campaigns without
-- blocking the reps' own email to them.
--
-- On 2026-10-06 the Compr import (post_import.sql, outside this repo) put 647
-- warm contacts (CLOZR buyers and sellers, Compr users) on email_suppressions
-- as 'manual' rows in workspace 13, so the cold campaign would skip them.
-- email_suppressions is workspace-wide and mailguard.guardSend blocks every
-- non-transactional send to a 'manual' row, so reps could not email their own
-- buyers and sellers. The rows were removed on 2026-10-19 (backup in
-- public._backup_email_suppressions_20261019).
--
-- A warm exclusion now goes in cold_exclusions. Only cold mail reads it:
-- 1. A BEFORE INSERT trigger on cold_enrollments enrolls an excluded address
--    as 'suppressed' ("Warm contact, kept out of cold campaigns."), whatever
--    path enrolls it (cold_auto_enroll, cold-pool Launch, a script).
-- 2. cold-pool Launch and cold-campaign-tick read it too (coldEnrollBlock,
--    sequenceStop), so an address excluded after it was enrolled stops at its
--    next send.
-- mailguard never reads it, so Gmail, Resend and action-plan mail still go.
--
-- Backfill: the 647 rows from the 2026-10-19 backup, so workspace 13's
-- compr-cold campaign still skips them (295 of them carry the compr-cold tag).
-- Any active cold enrollment for an excluded address is stopped. Safe to re-run.

create table if not exists public.cold_exclusions (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  note text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, email)
);
alter table public.cold_exclusions enable row level security;
revoke all on public.cold_exclusions from anon, authenticated;

create or replace function public.cold_enrollment_excluded()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.status = 'active' and exists (
    select 1 from public.cold_exclusions x where x.workspace_id = new.workspace_id and x.email = lower(trim(new.email))
  ) then
    new.status := 'suppressed';
    -- COLD_EXCLUDED_REASON in supabase/functions/_shared/cold-campaign.ts
    new.stop_reason := 'Warm contact, kept out of cold campaigns.';
  end if;
  return new;
end $$;

drop trigger if exists cold_enrollment_excluded on public.cold_enrollments;
create trigger cold_enrollment_excluded before insert on public.cold_enrollments
  for each row execute function public.cold_enrollment_excluded();

do $$
begin
  if to_regclass('public._backup_email_suppressions_20261019') is not null then
    insert into public.cold_exclusions (workspace_id, email, note, created_at)
    select workspace_id, lower(trim(email)), note, created_at
      from public._backup_email_suppressions_20261019
     where reason = 'manual' and coalesce(email, '') like '%_@_%'
    on conflict do nothing;
  end if;
end $$;

update public.cold_enrollments e
   set status = 'stopped', stop_reason = 'Warm contact, kept out of cold campaigns.', stopped_at = now()
  from public.cold_exclusions x
 where e.status = 'active' and x.workspace_id = e.workspace_id and x.email = e.email;
