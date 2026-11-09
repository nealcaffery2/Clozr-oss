-- 377 · Action plans: a daily start cap (drip).
--
-- Asked for by the owner on 2026-10-18: put 15,000 contacts on a plan and
-- have it start 200 a day. `action_plans.settings.daily_cap` (lib/plans.ts
-- PlanSettings) is the number of people who start the plan per day; blank
-- or 0 is no cap. Enrolling from the app (lib/crm-write.ts enrollMany) gives
-- each new enrolment the first day with room and dates its step tasks from
-- that day, so plan-tick only sends a step once it is due. `starts_at` is
-- that day; the enrolment row is still written at once, so the person shows
-- as on the plan and is not enrolled twice. Enrolments made by SQL triggers
-- (auto-enroll) do not read the cap.
-- Additive, safe to re-run.

alter table public.enrollments add column if not exists starts_at timestamptz;
comment on column public.enrollments.starts_at is
  'When this enrolment''s first step is dated from: later than enrolled_at when the plan''s settings.daily_cap queued it for a later day (migration 377). Null means at enrolment.';
create index if not exists enrollments_plan_starts_at on public.enrollments (plan_id, starts_at) where starts_at is not null;
