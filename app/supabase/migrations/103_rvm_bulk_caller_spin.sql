-- 103: the caller ID a ringless drop went out on.
--
-- Bulk sends rotate across caller_lines so one number does not carry the
-- whole blast. There is no workspace daily cap; the tick still skips
-- do-not-call, a recent conversation, a recent drop, and a closed local window.

alter table public.rvm_drops add column if not exists from_e164 text;

create index if not exists rvm_drops_from_recent
  on public.rvm_drops (workspace_id, from_e164, created_at desc)
  where from_e164 is not null;
