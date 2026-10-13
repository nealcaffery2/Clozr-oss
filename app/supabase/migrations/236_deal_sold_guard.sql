-- 236: a deal is marked sold only to the buyer and price of an accepted offer.
--
-- Mark Sold (lib/dispo-sop.ts markSold) writes deals.sold_at, sold_price and
-- buyer_id. Without a check in the database, anyone who can edit the deal
-- could mark it sold for a price no offer was accepted at, skipping the
-- below-ask approval that offers_approval_guard (235) enforces on the offer,
-- and hand it to TC that way.
--
-- For a signed-in caller who is not an owner or admin of the deal's
-- workspace:
--   - setting sold_at, or changing sold_price or buyer_id on a deal being
--     marked sold, needs an Accepted inbound offer on this deal from that
--     buyer for exactly that price; sold_by is stamped as the caller;
--   - once sold_at is set, sold_at, sold_price and buyer_id are fixed.
-- Owners, admins and sessions with no user (the service role, migrations,
-- cron, the docs engine) are not limited. Deals that are not marked sold are
-- not affected, so attaching a buyer or editing the deal sheet works as
-- before. Rows sold before 235 have no sold_at and are untouched.
--
-- No recursion: this only reads offers, and deals_tx_sync (239) writes
-- transactions, never deals. Safe to run again.

create or replace function public.deals_sold_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return new;
  end if;
  if new.sold_at is not distinct from old.sold_at
     and new.sold_price is not distinct from old.sold_price
     and new.buyer_id is not distinct from old.buyer_id then
    return new;
  end if;
  if public.has_role(old.workspace_id, 'owner', 'admin') then
    return new;
  end if;
  if old.sold_at is not null then
    raise exception 'This deal is marked sold: its buyer and price are fixed. An owner or admin can change them' using errcode = '42501';
  end if;
  if new.sold_at is null then
    -- Not being marked sold: a buyer attached or a price typed on the sheet.
    return new;
  end if;
  if new.buyer_id is null or new.sold_price is null or not exists (
    select 1 from public.offers o
     where o.deal_id = new.id
       and o.buyer_id = new.buyer_id
       and o.direction = 'inbound'
       and lower(o.status) = 'accepted'
       and o.amount = new.sold_price
  ) then
    raise exception 'A deal is marked sold to the buyer and price of an accepted offer. An owner or admin can record a different sale' using errcode = '42501';
  end if;
  new.sold_by := v_uid;
  return new;
end $$;

drop trigger if exists deals_sold_guard on public.deals;
create trigger deals_sold_guard
  before update on public.deals
  for each row execute function public.deals_sold_guard();
