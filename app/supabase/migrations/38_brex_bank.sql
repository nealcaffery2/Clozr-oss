-- 38 · Bank sync (Brex) for the owner's Profitability report.
--
--   bank_connections   the Brex API token for a workspace. RLS on, no policy,
--                      every grant revoked — only the service role (the
--                      brex-sync function) can read it. Same shape as
--                      google_tokens (33): a token is never readable from a
--                      browser, an owner's included.
--   bank_accounts      cash/card accounts and their last balance.
--   bank_transactions  one row per Brex transaction, deduplicated on
--                      (workspace_id, provider, external_id). amount_cents is signed from
--                      the business's side: positive is money in.
--
-- Bank rows are owner/admin only — they carry commission payouts. SELECT is
-- has_role(owner, admin); there is no INSERT/UPDATE/DELETE grant at all, so
-- writes come from the service role, and the one client write (tagging a
-- transaction to a deal) goes through tag_bank_transaction(), which checks the
-- role and that the deal is in the same workspace.

-- ------------------------------------------------------------ connections
create table if not exists public.bank_connections (
  workspace_id    bigint primary key references public.workspaces(id) on delete cascade,
  provider        text   not null default 'brex' check (provider in ('brex')),
  api_token       text   not null,
  connected_by    uuid   references auth.users(id) on delete set null,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.bank_connections enable row level security;
revoke all on public.bank_connections from anon, authenticated;
drop trigger if exists bank_connections_touch on public.bank_connections;
create trigger bank_connections_touch before update on public.bank_connections
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- accounts
create table if not exists public.bank_accounts (
  id                      bigint generated always as identity primary key,
  workspace_id            bigint not null references public.workspaces(id) on delete cascade,
  provider                text   not null default 'brex',
  external_id             text   not null,
  kind                    text   not null check (kind in ('cash', 'card')),
  name                    text,
  current_balance_cents   bigint,
  available_balance_cents bigint,
  currency                text   not null default 'USD',
  is_primary              boolean not null default false,
  raw                     jsonb  not null default '{}',
  synced_at               timestamptz not null default now(),
  unique (workspace_id, provider, external_id)
);
create index if not exists bank_accounts_ws_idx on public.bank_accounts (workspace_id);

-- ------------------------------------------------------------ transactions
create table if not exists public.bank_transactions (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  provider       text   not null default 'brex',
  external_id    text   not null,
  account_id     bigint references public.bank_accounts(id) on delete set null,
  posted_at      date   not null,
  amount_cents   bigint not null,
  currency       text   not null default 'USD',
  description    text,
  counterparty   text,
  category       text,
  deal_id        bigint references public.deals(id) on delete set null,
  raw            jsonb  not null default '{}',
  synced_at      timestamptz not null default now(),
  unique (workspace_id, provider, external_id)
);
create index if not exists bank_transactions_ws_posted_idx on public.bank_transactions (workspace_id, posted_at desc);
create index if not exists bank_transactions_deal_idx on public.bank_transactions (deal_id);
create index if not exists bank_transactions_account_idx on public.bank_transactions (account_id);

alter table public.bank_accounts enable row level security;
alter table public.bank_transactions enable row level security;
revoke all on public.bank_accounts, public.bank_transactions from anon, authenticated;
grant select on public.bank_accounts, public.bank_transactions to authenticated;

drop policy if exists bank_accounts_admin_select on public.bank_accounts;
create policy bank_accounts_admin_select on public.bank_accounts for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));
drop policy if exists bank_transactions_admin_select on public.bank_transactions;
create policy bank_transactions_admin_select on public.bank_transactions for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));

-- ---------------------------------------------------- tag a txn to a deal
create or replace function public.tag_bank_transaction(p_id bigint, p_deal_id bigint)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare ws bigint;
begin
  select workspace_id into ws from public.bank_transactions where id = p_id;
  if ws is null or not public.has_role(ws, 'owner', 'admin') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_deal_id is not null and not exists (select 1 from public.deals where id = p_deal_id and workspace_id = ws) then
    raise exception 'deal is not in this workspace' using errcode = '22023';
  end if;
  update public.bank_transactions set deal_id = p_deal_id where id = p_id;
end $$;
revoke all on function public.tag_bank_transaction(bigint, bigint) from public, anon;
grant execute on function public.tag_bank_transaction(bigint, bigint) to authenticated;
