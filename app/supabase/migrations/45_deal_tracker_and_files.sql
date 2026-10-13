-- 45 · The 2026 Deal Tracker's columns on deals, and files/photos on a deal.
--
-- The team's Deal Tracker (Excel, "Deals" tab) is the source of truth for
-- contracts. Its columns that CLOZR had no home for land here, named as the
-- sheet names them, so the Deals table can read like the sheet:
--   Property # · Seller Price · Price Drop · Marketed Price · Marketed Fee ·
--   Dispo Price · Dispo Upsell · Dispo Fee · Transaction Type · Contract Status ·
--   Lead Source · Acquisitions/Dispositions Agent · Lead Manager · Coordinator
-- Seller Price stays offer_amount, Dispo Price stays sold_price, the dates stay
-- contract_date / close_date / closed_on. Agents are kept as the sheet's names
-- because not every agent is a CLOZR user; owner_id / dispo_rep_id still carry
-- the user when there is one.
--
-- deal_files holds what a deal carries: uploaded files (storage bucket
-- deal-files, path ws/<workspace_id>/deals/<deal_id>/<file>) and links — a
-- photo link is a row with kind 'photo' and a url, no upload needed.

alter table public.deals
  add column if not exists tracker_no       integer,
  add column if not exists price_drop       numeric,
  add column if not exists marketed_price   numeric,
  add column if not exists marketed_fee     numeric,
  add column if not exists dispo_upsell     numeric,
  add column if not exists dispo_fee        numeric,
  add column if not exists transaction_type text,
  add column if not exists contract_status  text,
  add column if not exists lead_source      text,
  add column if not exists acq_agent        text,
  add column if not exists dispo_agent      text,
  add column if not exists lead_manager     text,
  add column if not exists coordinator      text;

create table if not exists public.deal_files (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  deal_id       bigint not null references public.deals(id) on delete cascade,
  kind          text not null default 'file' check (kind in ('file', 'photo', 'link')),
  name          text not null,
  url           text,
  storage_path  text,
  content_type  text,
  byte_size     bigint,
  source        text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  check (url is not null or storage_path is not null)
);
create index if not exists deal_files_deal_idx on public.deal_files (deal_id);
create index if not exists deal_files_workspace_idx on public.deal_files (workspace_id);
create unique index if not exists deal_files_deal_url_uniq on public.deal_files (deal_id, url) where url is not null;

alter table public.deal_files enable row level security;
drop policy if exists deal_files_all on public.deal_files;
create policy deal_files_all on public.deal_files for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
grant select, insert, update, delete on public.deal_files to authenticated;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('deal-files', 'deal-files', false) on conflict (id) do nothing;
    execute 'drop policy if exists deal_files_rw on storage.objects';
    execute $p$create policy deal_files_rw on storage.objects for all to authenticated
      using (bucket_id = 'deal-files' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))
      with check (bucket_id = 'deal-files' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))$p$;
  end if;
end $$;
