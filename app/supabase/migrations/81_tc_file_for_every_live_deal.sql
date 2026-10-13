-- 81 · Every live deal has a TC file.
--
-- Migration 36 opens the transaction the moment a deal reaches Under Contract
-- Seller. A deal that reached In Escrow, Ready To Market or Buyer Under
-- Contract some other way (the Podio import, the Deal Tracker, a stage set by
-- hand past UC Seller) never got one, so its checklist, Lane's daily drive
-- and Lane's listening (migration 80) had no file to work: four of the
-- fourteen live deals on the board had none. The trigger now opens the file
-- on any active-inventory stage (deal_stages.active_inventory), and the live
-- deals without one get it now, dated from their contract date.

create or replace function open_tc_file_for_deal() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d0 date;
begin
  if not exists (select 1 from deal_stages where label = new.stage and active_inventory) then return new; end if;
  if tg_op = 'UPDATE' and old.stage = new.stage then return new; end if;
  if exists (select 1 from transactions where deal_id = new.id) then return new; end if;
  d0 := coalesce(new.contract_date, current_date);
  insert into transactions (workspace_id, deal_id, property_id, seller_id, buyer_id,
                            contract_date, ctc_target, close_date, status, created_by)
  values (new.workspace_id, new.id, new.property_id, new.seller_id, new.buyer_id,
          d0, d0 + 10, new.close_date, 'open', new.created_by);
  return new;
end $$;

revoke execute on function open_tc_file_for_deal() from public, anon, authenticated;

insert into transactions (workspace_id, deal_id, property_id, seller_id, buyer_id,
                          contract_date, ctc_target, close_date, status, created_by)
select d.workspace_id, d.id, d.property_id, d.seller_id, d.buyer_id,
       coalesce(d.contract_date, current_date), coalesce(d.contract_date, current_date) + 10, d.close_date, 'open', d.created_by
  from deals d
  join deal_stages s on s.label = d.stage and s.active_inventory
 where not exists (select 1 from transactions t where t.deal_id = d.id);
