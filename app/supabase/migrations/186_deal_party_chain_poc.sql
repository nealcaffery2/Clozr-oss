-- 186 · Daisy chains and the point of contact on a deal team.
--
-- A daisy-chained deal has more than one wholesaler between the owner and
-- us, and the TC needs to know who sits where and who to call.
--
--   deal_parties.chain_position  where this person sits in the chain:
--                                OOR (owner of record), W1, W2, W3
--                                (wholesaler 1, 2, 3). Null when not in a chain.
--   deal_parties.is_poc          the star: the person the TC works this deal
--                                through. More than one may carry it (one per
--                                side of the chain).

alter table public.deal_parties add column if not exists chain_position text;
alter table public.deal_parties add column if not exists is_poc boolean not null default false;

alter table public.deal_parties drop constraint if exists deal_parties_chain_position_check;
alter table public.deal_parties add constraint deal_parties_chain_position_check
  check (chain_position is null or chain_position in ('OOR', 'W1', 'W2', 'W3'));
