-- 112 · Clozr Docs e-sign v1 (docs/esign spec, phase 1)
--
-- Extends the native e-sign engine (27, 28, 94) rather than starting over:
--   * recipient types: signer, cc (gets the signed copy), viewer (may open,
--     never signs); approver and form filler are reserved for the editor
--   * signing order: parallel (everyone at once) or sequential (by `sort`)
--   * reminder policy and a real `expired` status, driven by docs-remind
--   * an append-only, hash-chained audit trail on contract_events
--   * completed contracts cannot have their text, values or files rewritten

-- ---------------------------------------------------------------- signers
alter table public.contract_signers
  add column if not exists recipient_type text not null default 'signer',
  add column if not exists last_reminded_at timestamptz,
  add column if not exists reminder_count int not null default 0,
  add column if not exists party_ref bigint;
alter table public.contract_signers drop constraint if exists contract_signers_recipient_type_chk;
alter table public.contract_signers add constraint contract_signers_recipient_type_chk
  check (recipient_type in ('signer', 'approver', 'cc', 'viewer', 'filler'));

-- ---------------------------------------------------------------- contracts
alter table public.contracts
  add column if not exists signing_order_mode text not null default 'parallel',
  add column if not exists reminder_policy jsonb not null default '{"first_after_days": 1, "repeat_every_days": 2}'::jsonb,
  add column if not exists ref_number text,
  add column if not exists value numeric,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists final_sha256 text,
  add column if not exists expired_at timestamptz,
  add column if not exists parent_contract_id bigint references public.contracts(id) on delete set null;
alter table public.contracts drop constraint if exists contracts_signing_order_chk;
alter table public.contracts add constraint contracts_signing_order_chk check (signing_order_mode in ('parallel', 'sequential'));
create index if not exists contracts_open_idx on public.contracts (status, expires_at) where status in ('sent', 'viewed');

-- A completed contract is the record of what was signed: its text, filled
-- values and files do not change afterwards. Completion itself (the update
-- that sets status = completed) is allowed through.
create or replace function public.contracts_lock_completed() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'completed' and (
       new.body_md is distinct from old.body_md
    or new.tokens is distinct from old.tokens
    or new.pdf_path is distinct from old.pdf_path
    or new.final_sha256 is distinct from old.final_sha256
  ) then
    raise exception 'contract % is completed; its text, values and files are locked', old.id;
  end if;
  return new;
end $$;
drop trigger if exists contracts_lock_completed on public.contracts;
create trigger contracts_lock_completed before update on public.contracts
  for each row execute function public.contracts_lock_completed();
revoke execute on function public.contracts_lock_completed() from public, anon, authenticated;

-- ---------------------------------------------------------------- audit trail
alter table public.contract_events
  add column if not exists actor_type text,
  add column if not exists actor_id text,
  add column if not exists signer_id bigint,
  add column if not exists ip text,
  add column if not exists user_agent text,
  add column if not exists prev_hash text,
  add column if not exists hash text;

-- Each event's hash covers the one before it on the same contract, so editing
-- or removing a past event breaks every hash after it. The advisory lock keeps
-- two events landing at once from forking the chain.
create or replace function public.contract_events_chain() returns trigger
language plpgsql set search_path = public as $$
declare prev text;
begin
  perform pg_advisory_xact_lock(hashtextextended('contract_events:' || new.contract_id::text, 0));
  select e.hash into prev from public.contract_events e
   where e.contract_id = new.contract_id order by e.id desc limit 1;
  new.prev_hash := prev;
  new.hash := encode(sha256(convert_to(
    coalesce(prev, '') || '|' || new.contract_id::text || '|' || new.event || '|' ||
    coalesce(new.payload::text, '') || '|' || coalesce(new.actor_type, '') || '|' || coalesce(new.actor_id, '') || '|' ||
    coalesce(new.signer_id::text, '') || '|' || coalesce(new.ip, '') || '|' || coalesce(new.user_agent, '') || '|' ||
    to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex');
  return new;
end $$;
drop trigger if exists contract_events_chain on public.contract_events;
create trigger contract_events_chain before insert on public.contract_events
  for each row execute function public.contract_events_chain();

-- Append-only: no edits ever; a delete only as part of deleting the contract
-- itself (the cascade runs after the contract row is gone).
create or replace function public.contract_events_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'contract_events is append-only';
  end if;
  if exists (select 1 from public.contracts c where c.id = old.contract_id) then
    raise exception 'contract_events is append-only';
  end if;
  return old;
end $$;
drop trigger if exists contract_events_append_only on public.contract_events;
create trigger contract_events_append_only before update or delete on public.contract_events
  for each row execute function public.contract_events_append_only();
revoke execute on function public.contract_events_chain() from public, anon, authenticated;
revoke execute on function public.contract_events_append_only() from public, anon, authenticated;

-- Chain the events already on file, oldest first, before the append-only rule
-- is in force for this statement's own rows (it is: so do it with the trigger
-- briefly off, inside this migration's transaction).
alter table public.contract_events disable trigger contract_events_append_only;
do $$
declare r record; prev text; cur bigint := null;
begin
  for r in select * from public.contract_events order by contract_id, id loop
    if cur is distinct from r.contract_id then prev := null; cur := r.contract_id; end if;
    update public.contract_events set prev_hash = prev, hash = encode(sha256(convert_to(
      coalesce(prev, '') || '|' || r.contract_id::text || '|' || r.event || '|' ||
      coalesce(r.payload::text, '') || '|' || coalesce(r.actor_type, '') || '|' || coalesce(r.actor_id, '') || '|' ||
      coalesce(r.signer_id::text, '') || '|' || coalesce(r.ip, '') || '|' || coalesce(r.user_agent, '') || '|' ||
      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex')
    where id = r.id returning hash into prev;
  end loop;
end $$;
alter table public.contract_events enable trigger contract_events_append_only;

-- Anyone can check a contract's chain: true when every event's hash still
-- matches its contents and the one before it.
create or replace function public.contract_events_verify(p_contract_id bigint) returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare r record; prev text := null; want text;
begin
  for r in select * from public.contract_events where contract_id = p_contract_id order by id loop
    want := encode(sha256(convert_to(
      coalesce(prev, '') || '|' || r.contract_id::text || '|' || r.event || '|' ||
      coalesce(r.payload::text, '') || '|' || coalesce(r.actor_type, '') || '|' || coalesce(r.actor_id, '') || '|' ||
      coalesce(r.signer_id::text, '') || '|' || coalesce(r.ip, '') || '|' || coalesce(r.user_agent, '') || '|' ||
      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex');
    if r.hash is distinct from want or r.prev_hash is distinct from prev then return false; end if;
    prev := r.hash;
  end loop;
  return true;
end $$;
grant execute on function public.contract_events_verify(bigint) to authenticated;

-- ---------------------------------------------------------------- reminders
-- docs-remind every 15 minutes: reminders per policy, and expiry.
create or replace function public.docs_remind_kick() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.contracts where status in ('sent', 'viewed') and provider = 'clozr') then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/docs-remind',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.docs_remind_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'clozr-docs-remind';
    perform cron.schedule('clozr-docs-remind', '*/15 * * * *', 'select public.docs_remind_kick()');
  end if;
end $$;
