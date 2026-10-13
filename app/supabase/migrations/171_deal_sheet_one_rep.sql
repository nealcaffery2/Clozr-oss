-- 171 · One person per side, and assignment / double close are not round-robined.
--
-- The deal sheet asks for the acquisitions rep once (owner_id) and dispositions
-- once (dispo_rep_id). acq_agent and dispo_agent stay on the row for the tracker
-- and imports, and this trigger copies the profile's name into them so the two
-- columns cannot name a different person. Clearing the id clears the name. A
-- missing profile leaves whatever text is already there (a Podio name). No
-- backfill: deals_stage_before and deals_price_history run on every deals write.
--
-- Novation with an empty dispo seat is still dealt by deals_dispo_round_robin
-- (migration 121). Assignment and double close are whoever is selling the deal,
-- so that function returns before it picks anyone.

create or replace function public.deals_fill_rep_names()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  if tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id then
    if new.owner_id is null then
      if tg_op = 'UPDATE' then new.acq_agent := null; end if;
    else
      select coalesce(nullif(trim(full_name), ''), email) into v_name
        from public.profiles where id = new.owner_id;
      if found then new.acq_agent := v_name; end if;
    end if;
  end if;

  if tg_op = 'INSERT' or new.dispo_rep_id is distinct from old.dispo_rep_id then
    if new.dispo_rep_id is null then
      if tg_op = 'UPDATE' then new.dispo_agent := null; end if;
    else
      select coalesce(nullif(trim(full_name), ''), email) into v_name
        from public.profiles where id = new.dispo_rep_id;
      if found then new.dispo_agent := v_name; end if;
    end if;
  end if;

  return new;
end $$;
revoke all on function public.deals_fill_rep_names() from public, anon, authenticated;

drop trigger if exists deals_fill_rep_names on public.deals;
create trigger deals_fill_rep_names
  before insert or update of owner_id, dispo_rep_id on public.deals
  for each row execute function public.deals_fill_rep_names();

create or replace function public.deals_dispo_round_robin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := public.deal_type_key(new.transaction_type);
  v_rr  bigint;
  v_rep uuid;
begin
  if new.dispo_rep_id is not null or v_key is null or new.archived_at is not null then return null; end if;
  if tg_op = 'UPDATE' and public.deal_type_key(old.transaction_type) is not distinct from v_key then return null; end if;
  -- Assignment and double close: the dispo is whoever sells it, not a rotation.
  if v_key in ('assignment', 'double_close') then return null; end if;

  -- The rotation for exactly this type wins over an "any type" one; the oldest breaks a tie.
  select id into v_rr from public.round_robins
   where workspace_id = new.workspace_id and team = 'dispositions' and active
     and coalesce(deal_type, 'novation') in (v_key, 'any')
   order by (coalesce(deal_type, 'novation') = v_key) desc, id
   limit 1;
  if v_rr is null then return null; end if;

  v_rep := public.round_robin_pick(v_rr);
  if v_rep is null then return null; end if;

  -- An UPDATE OF dispo_rep_id, so deals_team_sync adds the Dispositions party
  -- and deals_fill_rep_names copies that person's name onto dispo_agent.
  update public.deals set dispo_rep_id = v_rep where id = new.id and dispo_rep_id is null;
  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
  values (new.workspace_id, v_rep, 'Dispositions', 'New ' || initcap(replace(v_key, '_', ' ')) || ' deal assigned to you',
          'You are the dispo rep on this deal (round robin).', new.seller_id, new.id);
  return null;
end $$;
revoke all on function public.deals_dispo_round_robin() from public, anon, authenticated;
