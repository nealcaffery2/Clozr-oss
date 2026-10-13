-- 66: the seller record's Details card writes back.
--
-- The card showed Timeline, Condition, Occupancy, Mortgage, Desired close and
-- Decision makers as "—" with nowhere to put an answer: the columns did not
-- exist, so every seller looked blank however much the rep had learned. Each
-- is free text, edited in place on the record (lib/crm-write.ts
-- updateSellerDetails); motivation and asking_price were already columns and
-- now save the same way.
alter table public.sellers
  add column if not exists timeline text,
  add column if not exists condition text,
  add column if not exists occupancy text,
  add column if not exists mortgage text,
  add column if not exists desired_close text,
  add column if not exists decision_makers text;
