-- 116 · Clozr Docs: AI extraction and contract webhooks (docs/esign spec, phase 2)
--
-- Extraction
--   contract_extractions  one row per term the docs-extract function read off
--        a contract's PDF (or an uploaded PDF on a deal): field_key, value as
--        printed, confidence 0..1, the page it is on, and where on the page.
--        A person applies a row to the deal (applied_to_deal_at / applied_by)
--        or dismisses it. Members read; only the function writes, so every
--        apply goes through its workspace and role checks and leaves an audit
--        event. A re-run replaces the rows nobody applied yet.
--   contracts.extract_status / extracted_at / extract_error  where the last
--        run stands, so the card can say "reading…" or why it failed.
--
-- Webhooks
--   webhook_events() gains contract.sent, contract.completed,
--        contract.declined, contract.expired, contract.voided and
--        contract.extracted. contract.signed now means one signer signed;
--        contract.completed is everyone.
--   CLOZR-engine contracts publish from the functions where each event is
--        logged (_shared/contract-webhooks.ts → webhook_enqueue), with the
--        signer on the payload. The row trigger on contracts now handles only
--        PandaDoc rows (webhook_emit_contract), which have no such call site;
--        on completion they send contract.completed and, as before,
--        contract.signed.

-- ---------------------------------------------------------------- extraction
create table if not exists public.contract_extractions (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  contract_id        bigint references public.contracts(id) on delete cascade,
  deal_file_id       bigint references public.deal_files(id) on delete cascade,
  deal_id            bigint references public.deals(id) on delete set null,
  field_key          text   not null,
  value              text   not null,
  confidence         numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  page               int,
  bbox               jsonb,
  applied_to_deal_at timestamptz,
  applied_by         uuid references auth.users(id) on delete set null,
  dismissed_at       timestamptz,
  model              text,
  created_at         timestamptz not null default now(),
  constraint contract_extractions_source_chk check (contract_id is not null or deal_file_id is not null)
);
create index if not exists contract_extractions_contract_idx on public.contract_extractions (contract_id);
create index if not exists contract_extractions_file_idx on public.contract_extractions (deal_file_id) where deal_file_id is not null;
create index if not exists contract_extractions_ws_field_idx on public.contract_extractions (workspace_id, field_key, created_at desc);
create index if not exists contract_extractions_deal_idx on public.contract_extractions (deal_id) where deal_id is not null;
create index if not exists contract_extractions_applied_by_idx on public.contract_extractions (applied_by) where applied_by is not null;

alter table public.contract_extractions enable row level security;
revoke all on public.contract_extractions from anon;
revoke insert, update, delete on public.contract_extractions from authenticated;
grant select on public.contract_extractions to authenticated;
drop policy if exists contract_extractions_select on public.contract_extractions;
create policy contract_extractions_select on public.contract_extractions for select to authenticated
  using (public.is_workspace_member(workspace_id));

alter table public.contracts
  add column if not exists extract_status text,
  add column if not exists extracted_at timestamptz,
  add column if not exists extract_error text;
alter table public.contracts drop constraint if exists contracts_extract_status_chk;
alter table public.contracts add constraint contracts_extract_status_chk
  check (extract_status is null or extract_status in ('running', 'done', 'failed'));

-- ---------------------------------------------------------------- webhooks
create or replace function public.webhook_events()
returns text[] language sql immutable as $$
  select array['seller.created', 'seller.stage_changed', 'deal.created', 'deal.stage_changed', 'buyer.created',
               'task.completed', 'offer.sent',
               'contract.sent', 'contract.viewed', 'contract.signed', 'contract.completed',
               'contract.declined', 'contract.expired', 'contract.voided', 'contract.extracted',
               'communication.inbound', 'appointment.created']
$$;
revoke all on function public.webhook_events() from public, anon;

-- The functions enqueue contract events with the service key.
grant execute on function public.webhook_enqueue(bigint, text, jsonb) to service_role;

-- PandaDoc rows only: the CLOZR engine publishes from its functions, where it
-- knows which signer did what. Same payload keys as contract-webhooks.ts.
create or replace function public.webhook_emit_contract()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n   jsonb := to_jsonb(new);
  o   jsonb := to_jsonb(old);
  evs text[] := '{}';
  p   jsonb;
  ev  text;
begin
  if coalesce(n->>'provider', 'pandadoc') = 'clozr' then return null; end if;
  if not exists (select 1 from public.webhook_subscriptions
                  where workspace_id = new.workspace_id and active) then
    return null;
  end if;
  if ((n->>'completed_at') is not null and (o->>'completed_at') is null)
     or (n->>'status' = 'completed' and (o->>'status') is distinct from 'completed') then
    evs := array['contract.completed', 'contract.signed'];
  elsif (n->>'sent_at') is not null and (o->>'sent_at') is null then
    evs := array['contract.sent'];
  elsif (n->>'viewed_at') is not null and (o->>'viewed_at') is null then
    evs := array['contract.viewed'];
  elsif n->>'status' is distinct from o->>'status' and n->>'status' in ('declined', 'rejected') then
    evs := array['contract.declined'];
  elsif n->>'status' is distinct from o->>'status' and n->>'status' = 'voided' then
    evs := array['contract.voided'];
  elsif n->>'status' is distinct from o->>'status' and n->>'status' = 'expired' then
    evs := array['contract.expired'];
  end if;
  if coalesce(array_length(evs, 1), 0) = 0 then return null; end if;
  p := jsonb_build_object('record_type', 'contract', 'record_id', n->'id', 'id', n->'id', 'contract_id', n->'id',
    'ref_number', n->>'ref_number', 'name', n->>'name', 'contract_name', n->>'name', 'kind', n->>'kind',
    'status', n->>'status', 'provider', n->>'provider',
    'deal_id', n->'deal_id', 'seller_id', n->'seller_id', 'buyer_id', n->'buyer_id',
    'url', case when (n->>'deal_id') is not null then public.webhook_record_url('deal', (n->>'deal_id')::bigint) end);
  foreach ev in array evs loop
    perform public.webhook_enqueue(new.workspace_id, ev, p);
  end loop;
  return null;
end $$;
revoke all on function public.webhook_emit_contract() from public, anon, authenticated;

drop trigger if exists webhook_emit on public.contracts;
drop trigger if exists webhook_emit_contract on public.contracts;
create trigger webhook_emit_contract after update of sent_at, viewed_at, completed_at, status on public.contracts
  for each row execute function public.webhook_emit_contract();
