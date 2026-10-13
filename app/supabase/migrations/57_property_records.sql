-- 57 · Property records from the provider.
--
-- When the provider underwrites a property, compr-underwrite also keeps the public
-- record the provider pulled for it: owner of record, mailing address / absentee,
-- the recorded loan, equity, assessed value and tax, last sale, foreclosure
-- and tax-delinquency events, the permit summary and the rent estimate. One
-- row per property, replaced on every run. A field the provider did not return is
-- null, never a guess. owner_name is the owner of record only — it never
-- renames the seller.
--
-- Written by the edge function with the service role; members only read.

create table if not exists public.property_records (
  id              bigint generated always as identity primary key,
  workspace_id    bigint not null references public.workspaces(id) on delete cascade,
  property_id     bigint not null unique references public.properties(id) on delete cascade,
  source          text not null default 'compr',
  owner_name      text,
  owner_mailing   jsonb,
  absentee        boolean,
  mortgages       jsonb,
  est_equity      numeric,
  ltv             numeric,
  assessed_value  numeric,
  tax_amount      numeric,
  last_sale       jsonb,
  events          jsonb,
  permits         jsonb,
  rent_estimate   numeric,
  raw             jsonb,
  fetched_at      timestamptz not null default now()
);
create index if not exists property_records_ws_idx on public.property_records (workspace_id);

alter table public.property_records enable row level security;
drop policy if exists property_records_select on public.property_records;
create policy property_records_select on public.property_records for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.property_records from anon, authenticated;
grant select on public.property_records to authenticated;
