-- The TC file follows its deal, and the deal's people are named from their ids.
--
-- 1. transactions keeps copies of contract_date, close_date, option_ends_on and
--    buyer_id (migration 36 copied them once, when the file opened). The TC
--    countdown, D3/D7/D10/T-2/T-1 and Lane's drive count from those copies, so
--    a close date moved on the deal sheet, by Lane or by SQL left the file on
--    the old date. AFTER UPDATE on deals now writes the deal's value onto its
--    file whenever one of the four changes. ctc_target moves with the contract
--    date when it still sits at contract + 10 (the default); a target a person
--    set is left alone.
-- 2. deals.lead_manager_id: the lead manager as a member, not free text.
--    deals_fill_rep_names already named acq_agent / dispo_agent from owner_id /
--    dispo_rep_id; it now also names coordinator from tc_rep_id and
--    lead_manager from lead_manager_id, so the four text columns are derived.
-- 3. transactions.schedule_c: the title commitment's Schedule C requirements
--    as [{id, text, status: green|yellow|red}], the TC's traffic light.
--
-- 4. transactions_deal_workspace: a TC file's deal (and property) must be in the
--    file's own workspace. RLS on transactions checks only the row's workspace_id,
--    so without this a TC in one workspace could point a file at another
--    workspace's deal id and the definer triggers here and in 241 would read or
--    write across tenants. 0 rows cross today (checked 2026-10-10).
--
-- Idempotent. The one-time repair of files that already drifted is 240.

alter table public.deals add column if not exists lead_manager_id uuid references auth.users(id) on delete set null;
alter table public.transactions add column if not exists schedule_c jsonb not null default '[]'::jsonb;

create or replace function public.deals_tx_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.contract_date is not distinct from old.contract_date
     and new.close_date is not distinct from old.close_date
     and new.option_ends_on is not distinct from old.option_ends_on
     and new.buyer_id is not distinct from old.buyer_id then
    return null;
  end if;
  -- Definer: the file is this deal's own, and a role that may edit the deal
  -- (an acquisitions rep) must not leave the TC file behind for lack of a
  -- transactions grant. Only the deal's own values are copied.
  update public.transactions t set
    contract_date  = case when new.contract_date is distinct from old.contract_date then coalesce(new.contract_date, t.contract_date) else t.contract_date end,
    ctc_target     = case when new.contract_date is distinct from old.contract_date and new.contract_date is not null
                            and (t.ctc_target is null or t.ctc_target = t.contract_date + 10)
                          then new.contract_date + 10 else t.ctc_target end,
    close_date     = case when new.close_date is distinct from old.close_date then new.close_date else t.close_date end,
    option_ends_on = case when new.option_ends_on is distinct from old.option_ends_on then new.option_ends_on else t.option_ends_on end,
    buyer_id       = case when new.buyer_id is distinct from old.buyer_id then new.buyer_id else t.buyer_id end,
    updated_at     = now()
  where t.deal_id = new.id
    -- Only this workspace's file: a deal never writes another tenant's row (and 239's guard below
    -- stops a file pointing at another workspace's deal in the first place).
    and t.workspace_id = new.workspace_id
    and (t.contract_date is distinct from coalesce(new.contract_date, t.contract_date)
      or t.close_date is distinct from new.close_date
      or t.option_ends_on is distinct from new.option_ends_on
      or t.buyer_id is distinct from new.buyer_id);
  return null;
end $$;
revoke all on function public.deals_tx_sync() from public, anon, authenticated;

drop trigger if exists deals_tx_sync on public.deals;
create trigger deals_tx_sync
  after update of contract_date, close_date, option_ends_on, buyer_id on public.deals
  for each row execute function public.deals_tx_sync();

-- A member's display name, the way deals_fill_rep_names has always written it.
create or replace function public.deals_fill_rep_names() returns trigger
language plpgsql set search_path = public as $$
declare
  v_name text;
begin
  if tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id then
    if new.owner_id is null then
      if tg_op = 'UPDATE' then new.acq_agent := null; end if;
    else
      select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = new.owner_id;
      if found then new.acq_agent := v_name; end if;
    end if;
  end if;

  if tg_op = 'INSERT' or new.dispo_rep_id is distinct from old.dispo_rep_id then
    if new.dispo_rep_id is null then
      if tg_op = 'UPDATE' then new.dispo_agent := null; end if;
    else
      select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = new.dispo_rep_id;
      if found then new.dispo_agent := v_name; end if;
    end if;
  end if;

  if tg_op = 'INSERT' or new.tc_rep_id is distinct from old.tc_rep_id then
    if new.tc_rep_id is null then
      if tg_op = 'UPDATE' then new.coordinator := null; end if;
    else
      select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = new.tc_rep_id;
      if found then new.coordinator := v_name; end if;
    end if;
  end if;

  if tg_op = 'INSERT' or new.lead_manager_id is distinct from old.lead_manager_id then
    if new.lead_manager_id is null then
      if tg_op = 'UPDATE' then new.lead_manager := null; end if;
    else
      select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = new.lead_manager_id;
      if found then new.lead_manager := v_name; end if;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists deals_fill_rep_names on public.deals;
create trigger deals_fill_rep_names
  before insert or update of owner_id, dispo_rep_id, tc_rep_id, lead_manager_id on public.deals
  for each row execute function public.deals_fill_rep_names();

-- A file's deal and property belong to the file's workspace. Definer so the check
-- sees the row even where RLS would hide it, and so a hidden row reads as a mismatch.
create or replace function public.transactions_deal_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deal_id is not null and not exists (
    select 1 from public.deals d where d.id = new.deal_id and d.workspace_id = new.workspace_id
  ) then
    raise exception 'transactions.deal_id % is not a deal in workspace %', new.deal_id, new.workspace_id
      using errcode = '42501';
  end if;
  if new.property_id is not null and not exists (
    select 1 from public.properties p where p.id = new.property_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'transactions.property_id % is not a property in workspace %', new.property_id, new.workspace_id
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.transactions_deal_workspace() from public, anon, authenticated;

drop trigger if exists transactions_deal_workspace on public.transactions;
create trigger transactions_deal_workspace
  before insert or update of deal_id, property_id, workspace_id on public.transactions
  for each row execute function public.transactions_deal_workspace();
