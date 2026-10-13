-- 36 — The TC file, on the transaction.
--
-- Migration 15 gave every workspace a `transactions` table and nothing ever
-- wrote to it, so a signed-in workspace showed no transaction coordination at
-- all and Lane had no file to read. This makes the row the team's
-- contract-to-close file:
--
--   deal_type      which printed checklist runs the file (assignment | novation)
--   contract_date  D0 — every day marker counts from here
--   ctc_target     Clear-to-Close target, D10 by default
--   checklist      the ticks on the checklist, keyed by task id ("a16": true)
--   hud            the ticks on the HUD/CD T-2 review block, same shape
--   tc_review /    "Sam · Sept 18" once the TC has walked the lines, and
--   signoff        the owner's explicit sign-off — the hard gate before any wire
--   buyer_financing, lender, structure
--                  what Lane needs to be lender- and structure-aware
--   title_email, title_phone
--                  the title rep, next to the escrow officer already here
--
-- And a trigger opens the file: the moment a deal reaches Under Contract
-- Seller (by hand, by the PandaDoc webhook, by e-sign) a transaction row
-- exists for it, dated from the deal's contract date, so the TC screen and
-- Lane's daily drive start on D0 rather than after someone remembers to.

alter table transactions
  add column if not exists deal_type       text not null default 'assignment',
  add column if not exists contract_date   date,
  add column if not exists ctc_target      date,
  add column if not exists checklist       jsonb not null default '{}'::jsonb,
  add column if not exists hud             jsonb not null default '{}'::jsonb,
  add column if not exists tc_review       text,
  add column if not exists signoff         text,
  add column if not exists buyer_financing text,
  add column if not exists lender          text,
  add column if not exists structure       text,
  add column if not exists title_email     text,
  add column if not exists title_phone     text;

alter table transactions
  drop constraint if exists transactions_deal_type_check,
  add constraint transactions_deal_type_check check (deal_type in ('assignment', 'novation'));

create index if not exists transactions_deal_idx on transactions (deal_id);

create or replace function open_tc_file_for_deal() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d0 date;
begin
  if new.stage <> 'Under Contract Seller' then return new; end if;
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

drop trigger if exists deals_open_tc_file on deals;
create trigger deals_open_tc_file
  after insert or update of stage on deals
  for each row execute function open_tc_file_for_deal();
