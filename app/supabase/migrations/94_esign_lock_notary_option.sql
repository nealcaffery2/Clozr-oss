-- 94 · Signing links open only for the named email, a signed contract
-- writes the deal sheet (price, fee, option dates), and an option that is
-- about to run out pings the rep on that side plus the TC.
--
-- A notary is a workspace role. Their seal (name, state, expiration, and
-- whatever else that state puts on a seal) is stored when they are added.
-- A contract or file can be marked for digital notarization, a wet stamp,
-- or a third-party vendor.

alter table public.contract_signers
  add column if not exists email_verified_at timestamptz,
  add column if not exists access_code_hash text,
  add column if not exists access_code_expires timestamptz,
  add column if not exists access_gate text,
  add column if not exists view_seconds integer not null default 0,
  add column if not exists view_open_at timestamptz;

alter table public.contracts
  add column if not exists needs_notary boolean not null default false,
  add column if not exists notary_mode text,
  add column if not exists notary_status text not null default 'none',
  add column if not exists notary_vendor text,
  add column if not exists notarized_at timestamptz;

alter table public.contracts drop constraint if exists contracts_notary_mode_check;
alter table public.contracts add constraint contracts_notary_mode_check
  check (notary_mode is null or notary_mode in ('digital', 'wet', 'vendor'));
alter table public.contracts drop constraint if exists contracts_notary_status_check;
alter table public.contracts add constraint contracts_notary_status_check
  check (notary_status in ('none', 'needed', 'requested', 'stamped', 'wet', 'vendor'));

alter table public.deals
  add column if not exists option_ends_on date,
  add column if not exists buyer_option_ends_on date;

alter table public.transactions
  add column if not exists option_ends_on date;

alter table public.deal_files
  add column if not exists needs_notary boolean not null default false,
  add column if not exists notary_mode text,
  add column if not exists notary_status text,
  add column if not exists contract_id bigint references public.contracts(id) on delete set null;

alter table public.workspace_members
  add column if not exists notary_state text,
  add column if not exists notary_commission_expires date,
  add column if not exists notary_commission_number text,
  add column if not exists notary_county text,
  add column if not exists notary_stamp_svg text;

create table if not exists public.notary_requests (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  contract_id   bigint references public.contracts(id) on delete cascade,
  deal_id       bigint references public.deals(id) on delete cascade,
  notary_user_id uuid,
  token         text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  mode          text not null check (mode in ('digital', 'wet', 'vendor')),
  status        text not null default 'requested' check (status in ('requested', 'stamped', 'wet', 'vendor', 'cancelled')),
  vendor_name   text,
  emailed_to    text,
  access_code_hash text,
  access_code_expires timestamptz,
  access_gate   text,
  email_verified_at timestamptz,
  stamped_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists notary_requests_contract_idx on public.notary_requests (contract_id);
alter table public.notary_requests enable row level security;
drop policy if exists notary_requests_select on public.notary_requests;
create policy notary_requests_select on public.notary_requests for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.notary_requests to authenticated;

-- One alert per option date. An amendment that moves the date is a new row,
-- so the new window can notify again. A termination clears the date and the
-- scan skips the deal.
create table if not exists public.option_alerts (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  deal_id      bigint not null references public.deals(id) on delete cascade,
  side         text not null check (side in ('seller', 'buyer')),
  ends_on      date not null,
  notified_at  timestamptz not null default now(),
  unique (deal_id, side, ends_on)
);
alter table public.option_alerts enable row level security;
drop policy if exists option_alerts_select on public.option_alerts;
create policy option_alerts_select on public.option_alerts for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.option_alerts to authenticated;

create or replace function public.option_risk_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  today date := (timezone('America/Chicago', now()))::date;
  title text;
  body text;
  recipients uuid[];
begin
  for r in
    select d.id, d.workspace_id, d.seller_id, d.owner_id, d.dispo_rep_id, d.tc_rep_id,
           d.option_ends_on, d.buyer_option_ends_on,
           coalesce(p.line1, 'This deal') as addr
    from public.deals d
    left join public.properties p on p.id = d.property_id
    where coalesce(d.terminated, false) = false
      and d.stage not in ('Closed', 'Terminated', 'Prospect')
      and (
        (d.option_ends_on is not null and d.option_ends_on <= today + 3)
        or (d.buyer_option_ends_on is not null and d.buyer_option_ends_on <= today + 3)
      )
  loop
    -- Seller option: acquisitions on this contract and the TC.
    if r.option_ends_on is not null and r.option_ends_on <= today + 3
       and not exists (select 1 from public.option_alerts a where a.deal_id = r.id and a.side = 'seller' and a.ends_on = r.option_ends_on) then
      select coalesce(array_agg(distinct q.user_id), '{}') into recipients
      from (
        select r.owner_id as user_id
        union all select r.tc_rep_id
        union all select dp.user_id from public.deal_parties dp
          where dp.deal_id = r.id and dp.role = 'acquisitions' and dp.user_id is not null
        union all select m.user_id from public.workspace_members m
          where m.workspace_id = r.workspace_id and m.role = 'tc'
      ) q
      where q.user_id is not null;
      title := 'Seller option at risk';
      body := r.addr || ' · seller option ends ' || to_char(r.option_ends_on, 'Mon DD, YYYY');
      if cardinality(recipients) > 0 then
        insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
        select r.workspace_id, x, 'TC', title, body, r.seller_id, r.id from unnest(recipients) as x;
      end if;
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (r.workspace_id, 'deal', r.id, 'contract', title, body);
      if r.seller_id is not null then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
        values (r.workspace_id, 'seller', r.seller_id, 'contract', title, body);
      end if;
      insert into public.option_alerts (workspace_id, deal_id, side, ends_on)
      values (r.workspace_id, r.id, 'seller', r.option_ends_on);
    end if;

    -- Buyer option: dispositions on this contract and the TC.
    if r.buyer_option_ends_on is not null and r.buyer_option_ends_on <= today + 3
       and not exists (select 1 from public.option_alerts a where a.deal_id = r.id and a.side = 'buyer' and a.ends_on = r.buyer_option_ends_on) then
      select coalesce(array_agg(distinct q.user_id), '{}') into recipients
      from (
        select r.dispo_rep_id as user_id
        union all select r.tc_rep_id
        union all select dp.user_id from public.deal_parties dp
          where dp.deal_id = r.id and dp.role = 'dispositions' and dp.user_id is not null
        union all select m.user_id from public.workspace_members m
          where m.workspace_id = r.workspace_id and m.role = 'tc'
      ) q
      where q.user_id is not null;
      title := 'Buyer option at risk';
      body := r.addr || ' · buyer option ends ' || to_char(r.buyer_option_ends_on, 'Mon DD, YYYY');
      if cardinality(recipients) > 0 then
        insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
        select r.workspace_id, x, 'TC', title, body, r.seller_id, r.id from unnest(recipients) as x;
      end if;
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (r.workspace_id, 'deal', r.id, 'contract', title, body);
      insert into public.option_alerts (workspace_id, deal_id, side, ends_on)
      values (r.workspace_id, r.id, 'buyer', r.buyer_option_ends_on);
    end if;
  end loop;
end $$;
revoke all on function public.option_risk_tick() from public, anon, authenticated;

select cron.unschedule('clozr-option-risk') where exists (select 1 from cron.job where jobname = 'clozr-option-risk');
select cron.schedule('clozr-option-risk', '17 * * * *', 'select public.option_risk_tick()');
