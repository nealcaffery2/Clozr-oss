-- 48 · Target assignment, and every amended deal price on the record.
--
-- A price reduction is a fact with an author: who changed which price, from
-- what, to what, when. The trigger writes it, so a change from any screen (Deal
-- Sheet, Deals, Dispo, an import, the tracker) lands in the same history and no
-- client can skip it. The deal row keeps the current value; the history is the
-- amendment trail every screen reads.

alter table public.deals add column if not exists target_assignment numeric;

create table if not exists public.deal_price_changes (
  id          bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  deal_id     bigint not null references public.deals(id) on delete cascade,
  field       text not null,
  old_value   numeric,
  new_value   numeric,
  delta       numeric generated always as (coalesce(new_value, 0) - coalesce(old_value, 0)) stored,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index if not exists deal_price_changes_deal_idx on public.deal_price_changes (deal_id, changed_at desc);
create index if not exists deal_price_changes_ws_idx on public.deal_price_changes (workspace_id, changed_at desc);

alter table public.deal_price_changes enable row level security;
drop policy if exists deal_price_changes_select on public.deal_price_changes;
create policy deal_price_changes_select on public.deal_price_changes for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.deal_price_changes to authenticated;

create or replace function public.deals_price_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare f text; o numeric; n numeric;
begin
  foreach f in array array['offer_amount','sold_price','marketed_price','marketed_fee','dispo_fee','assignment_fee','target_assignment','price_drop'] loop
    execute format('select ($1).%1$I::numeric, ($2).%1$I::numeric', f) into o, n using old, new;
    -- An amendment changes a price that was already set; filling a blank is not one.
    if o is not null and o is distinct from n then
      insert into public.deal_price_changes (workspace_id, deal_id, field, old_value, new_value, changed_by)
      values (new.workspace_id, new.id, f, o, n, auth.uid());
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists deals_price_history on public.deals;
create trigger deals_price_history
  after update of offer_amount, sold_price, marketed_price, marketed_fee, dispo_fee, assignment_fee, target_assignment, price_drop
  on public.deals for each row execute function public.deals_price_history();
revoke all on function public.deals_price_history() from public, anon, authenticated;
