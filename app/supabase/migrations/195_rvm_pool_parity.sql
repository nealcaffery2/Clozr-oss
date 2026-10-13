-- 195: the RVM number pool gets the main lines' protection.
--
-- caller-registry now plans every caller_lines row with pool = 'rvm' (not only
-- the numbers Talkr's reputation summary returns), reads Telnyx Number
-- Reputation for every enrolled line, and lists the business name (CNAM) on a
-- pool line Talkr does not hold. New columns it writes:
--   spam_category          the carrier feed's label when a line is flagged
--   reputation_checked_at  when that verdict was last refreshed
--   cnam_listed            the CNAM listing is set on the carrier
--
-- caller_registry_state.fcr_job_phones: the numbers the open Firecrawl job was
-- handed. A finished job marks exactly those submitted (a failed one puts
-- them back in the queue); before, the AgentMail code moved them to
-- code_ready while the job ran, so nothing was ever marked and the same
-- numbers were resubmitted in a new paid job every run.
--
-- fcr_status gains 'submitted'. caller-registry has always written it when a
-- Firecrawl job finished, but the check from migration 91 did not allow it, so
-- the upsert failed and every line sat at queued or submitting. Safe to run again.

alter table public.caller_lines
  add column if not exists spam_category text,
  add column if not exists reputation_checked_at timestamptz,
  add column if not exists cnam_listed boolean not null default false;

alter table public.caller_registry_state add column if not exists fcr_job_phones text[];

-- The check from 91 is named caller_lines_fcr_status_check (live database, 2026-10-09).
alter table public.caller_lines drop constraint if exists caller_lines_fcr_status_check;
alter table public.caller_lines add constraint caller_lines_fcr_status_check
  check (fcr_status in ('queued', 'submitting', 'submitted', 'code_ready', 'verified', 'registered', 'failed'));
