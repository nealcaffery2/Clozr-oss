-- 235: the dispo SOP, in the database.
--
-- Dispositions sells a house in a fixed order: read the acquisitions handoff,
-- check access and comps, market (VIP and A-list first, then the list), log
-- every offer with proof of funds, take a below-ask offer only with an
-- owner's or admin's approval, accept a qualified sale, mark it Sold and tell
-- acquisitions. The screens (app/components/dispo/*) need somewhere to keep
-- each of those steps. Additive and safe to run again.

-- ---- The deal: handoff, access, BIN, sold ---------------------------------
-- Columns that already existed are reused rather than duplicated:
-- transaction_type (cash / novation), contract_status, contract_date (signed),
-- offer_amount (purchase price), arv, rehab, occupancy_notes (occupant),
-- condition_notes, photos_url, notes, marketed_price (the ask) and
-- marketing_started_on (days on market; stamped when the deal reaches Ready
-- To Market, migrations 27 / 118).
alter table public.deals
  add column if not exists bin_price numeric,
  add column if not exists contract_url text,
  add column if not exists occupancy_status text,
  add column if not exists access_kind text,
  add column if not exists access_instructions text,
  add column if not exists utilities text,
  add column if not exists foundation text,
  add column if not exists roof text,
  add column if not exists major_repairs text,
  add column if not exists sticky_issues text,
  add column if not exists buyer_restrictions text,
  add column if not exists target_buyer text,
  add column if not exists urgency text,
  add column if not exists access_verified_at timestamptz,
  add column if not exists access_verified_by uuid references auth.users(id) on delete set null,
  add column if not exists comps_dated_on date,
  add column if not exists sold_at timestamptz,
  add column if not exists sold_by uuid references auth.users(id) on delete set null;

do $$ begin
  alter table public.deals add constraint deals_occupancy_status_check check (occupancy_status is null or occupancy_status in ('vacant', 'occupied'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.deals add constraint deals_access_kind_check check (access_kind is null or access_kind in ('lockbox', 'appointment'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.deals add constraint deals_bin_price_check check (bin_price is null or bin_price > 0);
exception when duplicate_object then null; end $$;

comment on column public.deals.bin_price is 'Buy-it-now price offered to VIP buyers first; the market sees the ask (marketed_price) and this BIN.';
comment on column public.deals.access_verified_at is 'When dispo confirmed the house can be shown (vacant within 24h, occupied within 48h of the handoff).';
comment on column public.deals.comps_dated_on is 'The date of the comps dispo is selling on; older than 30 days fails the validation check.';
comment on column public.deals.sold_at is 'Mark Sold: the sale is qualified and acquisitions has been told. sold_price and buyer_id are written in the same step.';

-- ---- Offers: proof of funds, below-ask approval, the qualified-sale check --
alter table public.offers
  add column if not exists pof_url text,
  add column if not exists pof_path text,
  add column if not exists pof_verified boolean not null default false,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists ask_at_offer numeric,
  add column if not exists qualified jsonb,
  add column if not exists override_reason text;

comment on column public.offers.pof_path is 'Proof of funds uploaded to the deal-files bucket (ws/<id>/deals/<deal>/pof-…).';
comment on column public.offers.approved_at is 'An owner or admin approved taking this offer below the ask (or with no ask set). Set only by them (offers_approval_guard).';
comment on column public.offers.ask_at_offer is 'The deal''s ask (deals.marketed_price) when the offer was logged, stamped by offers_approval_guard. Lowering or clearing the ask later does not make an existing offer look at or over it.';
comment on column public.offers.qualified is 'The qualified-sale checklist at accept: {verified_buyer, pof, executed_contract, emd, no_option, close_by_ab} booleans.';

-- The below-ask rule, enforced on every write a signed-in user makes to a
-- buyer's offer. Owners and admins, and sessions with no user (the service
-- role, migrations, cron), are not limited.
--   - The ask an offer is judged against is the higher of the deal's ask when
--     the offer was logged (ask_at_offer, stamped here, never client-set) and
--     the deal's ask now. An ask counts only when it is set and above zero:
--     if either one is missing or zero, the offer needs approval (fail closed).
--     GREATEST alone would skip a null and let a lowered ask through.
--   - Only an owner or admin sets approved_at, stamped as themselves. Changing
--     an offer's amount clears an approval someone else gave.
--   - An offer under the ask, or with no ask, cannot become Accepted without
--     an approval.
--   - Once Accepted, its amount, ask, direction, buyer and deal are fixed.
--   - Owner or admin is judged on the offer's deal's workspace; the row's own
--     workspace_id must match that deal and never changes. Moving an offer
--     to another deal or buyer clears its approval and re-stamps the ask, and
--     an offer cannot move deal and become Accepted in one statement.
-- "A buyer's offer" is read from both the old and the new row, so clearing
-- buyer_id or flipping direction in the same update does not dodge it.
create or replace function public.offers_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws bigint;
  v_admin boolean;
  v_buyer_offer boolean;
  v_retarget boolean := false;
  v_ask_now numeric;
  v_ask numeric;
begin
  v_buyer_offer := (new.buyer_id is not null and new.direction is not distinct from 'inbound')
    or (tg_op = 'UPDATE' and old.buyer_id is not null and old.direction is not distinct from 'inbound');
  if tg_op = 'INSERT' then
    new.ask_at_offer := (select d.marketed_price from public.deals d where d.id = new.deal_id);
  end if;
  if v_uid is null or not v_buyer_offer then
    return new;
  end if;

  -- Whose offer this is comes from its deal, not from the row's own
  -- workspace_id, which the client can write.
  if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
    raise exception 'An offer cannot move to another workspace' using errcode = '42501';
  end if;
  if coalesce(new.deal_id, old.deal_id) is not null then
    select d.workspace_id into v_ws from public.deals d where d.id = coalesce(new.deal_id, old.deal_id);
    if v_ws is null then
      raise exception 'That deal is not on your workspace' using errcode = '42501';
    end if;
    if new.workspace_id is distinct from v_ws then
      raise exception 'An offer belongs to its deal''s workspace' using errcode = '42501';
    end if;
  else
    v_ws := case when tg_op = 'UPDATE' then old.workspace_id else new.workspace_id end;
  end if;
  v_admin := public.has_role(v_ws, 'owner', 'admin');
  if v_admin then
    if new.approved_at is not null and (tg_op = 'INSERT' or new.approved_at is distinct from old.approved_at) then
      new.approved_by := v_uid;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_retarget := new.deal_id is distinct from old.deal_id or new.buyer_id is distinct from old.buyer_id;
    -- The stamped ask is the database's, not the caller's; an offer moved to
    -- another deal takes that deal's ask now.
    new.ask_at_offer := case when new.deal_id is distinct from old.deal_id
      then (select d.marketed_price from public.deals d where d.id = new.deal_id) else old.ask_at_offer end;
    if lower(coalesce(old.status, '')) = 'accepted'
       and (new.amount is distinct from old.amount or new.direction is distinct from old.direction or v_retarget) then
      raise exception 'An accepted offer''s price, buyer and deal are fixed. An owner or admin can change them' using errcode = '42501';
    end if;
    if new.deal_id is distinct from old.deal_id and lower(coalesce(new.status, '')) = 'accepted' then
      raise exception 'Move the offer to its deal first, then accept it' using errcode = '42501';
    end if;
    -- An approval is for this amount, this buyer, on this deal.
    if old.approved_at is not null and (new.amount is distinct from old.amount or v_retarget) then
      new.approved_at := null;
      new.approved_by := null;
    end if;
  end if;
  if new.approved_at is not null and (tg_op = 'INSERT' or new.approved_at is distinct from old.approved_at) then
    raise exception 'Only an owner or admin can approve an offer below the ask' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.approved_by is distinct from old.approved_by and new.approved_at is not null then
    new.approved_by := old.approved_by;
  end if;

  if lower(coalesce(new.status, '')) = 'accepted'
     and (tg_op = 'INSERT' or lower(coalesce(old.status, '')) <> 'accepted')
     and new.approved_at is null then
    select d.marketed_price into v_ask_now from public.deals d where d.id = new.deal_id;
    v_ask := case when coalesce(new.ask_at_offer, 0) > 0 and coalesce(v_ask_now, 0) > 0
                  then greatest(new.ask_at_offer, v_ask_now) end;
    if v_ask is null or new.amount is null or new.amount < v_ask then
      raise exception 'This offer is under the ask, or the deal has no ask. An owner or admin has to approve it first' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- Offers logged before this migration have no stamped ask: take the deal's
-- ask now where it is above zero, a batch of ids at a time. Any still empty
-- stay approval-required under the rule above. Safe to run again.
do $$
declare
  v_lo bigint := 0;
  v_max bigint;
begin
  select coalesce(max(id), 0) into v_max from public.offers;
  while v_lo <= v_max loop
    update public.offers o
       set ask_at_offer = d.marketed_price
      from public.deals d
     where o.deal_id = d.id
       and o.id > v_lo and o.id <= v_lo + 20000
       and o.ask_at_offer is null
       and d.marketed_price > 0;
    v_lo := v_lo + 20000;
  end loop;
end $$;

drop trigger if exists offers_approval_guard on public.offers;
create trigger offers_approval_guard
  before insert or update on public.offers
  for each row execute function public.offers_approval_guard();

-- ---- Walkthroughs: confirmed ---------------------------------------------
alter table public.appointments
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references auth.users(id) on delete set null;

comment on column public.appointments.confirmed_at is 'A walkthrough the buyer confirmed (Dispo → Walkthroughs → Confirm).';
