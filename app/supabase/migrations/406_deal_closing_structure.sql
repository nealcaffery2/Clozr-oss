-- How a deal closes, and the deal team seats that go with it.
--
-- deals.closing_structure: assignment, split double close (two title
-- companies, so the team gets a second title), passthrough double close, or
-- liquid double close (we close the first leg on a transactional funder's
-- money, so the team gets a transactional funder and Admin / COGS asks for
-- the funding fee). Null until someone picks it.
-- deal_parties.role gains second_title and transactional_funder. Neither
-- syncs to a deal column (migration 46 only syncs reps, buyer and title).

alter table public.deals add column if not exists closing_structure text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_closing_structure_check') then
    alter table public.deals add constraint deals_closing_structure_check
      check (closing_structure is null or closing_structure in ('assignment', 'split_double_close', 'passthrough_double_close', 'liquid_double_close'));
  end if;
end $$;

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.deal_parties'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%listing_agent%';
  if c is not null and not exists (
    select 1 from pg_constraint where conname = c and pg_get_constraintdef(oid) like '%transactional_funder%'
  ) then
    execute format('alter table public.deal_parties drop constraint %I', c);
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.deal_parties'::regclass and pg_get_constraintdef(oid) like '%transactional_funder%'
  ) then
    alter table public.deal_parties add constraint deal_parties_role_check check (role in (
      'seller','buyer','title','photographer','wholesaler','listing_agent','buyers_agent','realtor','tc',
      'acquisitions','dispositions','lender','contractor','inspector','attorney','other',
      'second_title','transactional_funder'));
  end if;
end $$;
