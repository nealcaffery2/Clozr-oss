-- 198: which caller-ID tier each ringless drop went out on (local presence).
--
-- rvm-tick picks the pool line local first (lib/rvm-pool.ts pickPoolLine):
-- the recipient's own area code, then the lead's state (the property's, or
-- the buyer's first market), then the state of their phone, then a
-- neighbouring state, then any pool line. rvm_drops.pool_tier records which
-- one ('area_code', 'state', 'phone_state', 'neighbor', 'any'; null when the
-- workspace has no pool and the drop rotated over the main lines), so the
-- RVM tab's blast results can say how much of a send went out local.
-- Safe to run again.

alter table public.rvm_drops add column if not exists pool_tier text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rvm_drops_pool_tier_check') then
    alter table public.rvm_drops add constraint rvm_drops_pool_tier_check
      check (pool_tier is null or pool_tier in ('area_code', 'state', 'phone_state', 'neighbor', 'any'));
  end if;
end $$;
