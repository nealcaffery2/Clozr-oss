-- 348: two every-minute jobs that never had work move to every 2 minutes.
--
-- Phase 3 cron review. Eight jobs ran every minute. Measured over
-- 7 days (cron.job_run_details, the edge function logs, each job's
-- own tables). Six stay every minute: their source changes within the minute,
-- or the minute is load-bearing (speed to lead, the cold reply poll, plan
-- bursts, the Gmail fast lane). The PR has the table for all eight.
--
--   clozr-webhook-tick  no webhook subscription and no delivery, ever. The first
--                       delivery goes out from the insert trigger (41), not
--                       from this tick; the tick reads responses, retries with
--                       backoff and cleans up. A retry or a "Send test"
--                       response now lands up to a minute later.
--   clozr-docs-bulk     no bulk send, ever. bulk_create sends the first 20 rows
--                       itself; this drains the rest at 20 a run: 10 a minute
--                       instead of 20.
--
-- Odd minutes, off the even ones the five */2 jobs use. alter_job keeps each
-- job's id and run history, and does nothing when a job is missing. Safe to
-- re-run.

select cron.alter_job(job_id := jobid, schedule := '1-59/2 * * * *')
  from cron.job
 where jobname in ('clozr-webhook-tick', 'clozr-docs-bulk');
