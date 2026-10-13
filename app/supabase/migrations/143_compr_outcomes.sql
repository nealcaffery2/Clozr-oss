-- 143: underwriting ledger tables.
--
-- compr_underwrites is every underwrite CLOZR asked the underwriting provider
-- for: the lead_id it sent (compr-underwrite builds
-- clozr-w<ws>-d<deal>|s<seller>-<day>), for which seller and deal, and the
-- report link that came back.
--
-- compr_outcomes holds one row per (underwrite, outcome), where outcome is
-- purchase_close, disposition_close or terminated. The Ask CLOZR deal lookup
-- reads both tables.
--
-- In the hosted product this migration also backfilled the ledger from
-- existing report links and added a deals trigger that posted each closed or
-- terminated deal to the provider. That part was removed in the open-source
-- release: private underwriting provider integration.

create table if not exists public.compr_underwrites (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  seller_id    bigint references public.sellers(id) on delete set null,
  deal_id      bigint references public.deals(id) on delete set null,
  lead_id      text not null,
  report_url   text,
  source       text not null default 'run' check (source in ('run', 'report_link')),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (workspace_id, lead_id)
);
create index if not exists compr_underwrites_deal_idx on public.compr_underwrites (deal_id, created_at desc);
create index if not exists compr_underwrites_seller_idx on public.compr_underwrites (seller_id, created_at desc);

alter table public.compr_underwrites enable row level security;
drop policy if exists compr_underwrites_select on public.compr_underwrites;
create policy compr_underwrites_select on public.compr_underwrites
  for select to authenticated
  using (workspace_id in (select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())));
revoke insert, update, delete on public.compr_underwrites from anon, authenticated;

create table if not exists public.compr_outcomes (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  underwrite_id bigint not null references public.compr_underwrites(id) on delete cascade,
  deal_id       bigint references public.deals(id) on delete set null,
  outcome       text not null check (outcome in ('purchase_close', 'disposition_close', 'terminated')),
  lead_id       text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null check (status in ('sent', 'failed')),
  http_status   integer,
  error         text,
  attempts      integer not null default 1,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (underwrite_id, outcome)
);
create index if not exists compr_outcomes_deal_idx on public.compr_outcomes (deal_id);
create index if not exists compr_outcomes_workspace_idx on public.compr_outcomes (workspace_id, updated_at desc);

alter table public.compr_outcomes enable row level security;
drop policy if exists compr_outcomes_select on public.compr_outcomes;
create policy compr_outcomes_select on public.compr_outcomes
  for select to authenticated
  using (workspace_id in (select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())));
revoke insert, update, delete on public.compr_outcomes from anon, authenticated;
