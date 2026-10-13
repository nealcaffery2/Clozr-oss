-- 50 · Buyers can be enrolled in an action plan, for a deal.
--
-- Buyers → "Enroll in plan for a deal" puts the buyers whose buy box fits a
-- deal (deal_buyer_matches, migration 27) on a plan. An enrolment is for a
-- seller or for a buyer, never both; a buyer's enrolment names the deal it is
-- about, and its queued tasks point at the buyer so they show on that record.

alter table public.enrollments
  add column if not exists buyer_id bigint references public.buyers(id) on delete cascade,
  add column if not exists deal_id  bigint references public.deals(id) on delete cascade;

alter table public.enrollments drop constraint if exists enrollments_one_contact;
alter table public.enrollments add constraint enrollments_one_contact
  check ((seller_id is null) <> (buyer_id is null));

create index if not exists enrollments_buyer_active_idx
  on public.enrollments (buyer_id) where status = 'active';
create index if not exists enrollments_deal_id_idx on public.enrollments (deal_id);

alter table public.tasks
  add column if not exists buyer_id bigint references public.buyers(id) on delete cascade;
create index if not exists tasks_buyer_id_idx on public.tasks (buyer_id);
