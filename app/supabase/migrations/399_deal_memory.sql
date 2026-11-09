-- 399: deal memory, the Smart Summary for a deal under contract.
--
-- Lead memory (110) answers "who is this person"; a TC working a file needs
-- "where does this deal stand and what disagrees with what". deal_memory holds
-- one summary per deal, written by the deal-memory edge function from the
-- contract PDFs (sent to Claude as documents), the terms docs-extract read off
-- them, the deal sheet, the TC file, the deal team, and every email, text,
-- call and note filed on the deal.
--
-- body:        { brief, issues[], terms[], timeline[], parties[] }, each issue,
--              term and event with sources [{ ref, quote, page }]
--              (lib/deal-memory.ts cleans it).
-- sources:     the catalogue those refs point into: { "doc:f12": { kind,
--              label, at, deal_file_id }, "msg:345": { kind, label, at,
--              communication_id, preview }, "field:assignment_fee": ... }, so
--              the panel can open the document or the message a fact came from.
-- input_hash:  a fingerprint of everything read. A refresh whose inputs hash
--              the same as the stored row skips the model call.
-- updated_at:  the moment the inputs were READ, so anything filed while Claude
--              was writing still shows as new.
--
-- deal_memory_newest(p_deal_ids): the newest input on each deal (a message,
-- note, file, contract, extraction, or an edit to the deal row). The panel
-- compares it with updated_at to say "New info since the summary". Security
-- invoker: it sees only what the caller can see.
--
-- deal_memory_dirty(): deals with a TC file, a contract or a summary already,
-- touched in the last few days by something newer than their summary. Edits
-- to the deal row count only once a deal has a summary, so COMPR writing ARV
-- onto a lead does not queue a model call.
--
-- deal_memory_kick(): every ten minutes, only when something is dirty, POSTs
-- {"action":"refresh_dirty"} to the deal-memory function with the vault's
-- service key (same pattern as lead_memory_kick in 110).
--
-- Idempotent. Members read; only the service role writes.

create table if not exists public.deal_memory (
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  deal_id        bigint not null references public.deals(id) on delete cascade,
  body           jsonb  not null default '{}'::jsonb,
  sources        jsonb  not null default '{}'::jsonb,
  input_hash     text,
  source_count   integer not null default 0,
  last_source_at timestamptz,
  model          text,
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, deal_id)
);
create index if not exists deal_memory_deal_idx on public.deal_memory (deal_id);

alter table public.deal_memory enable row level security;
drop policy if exists deal_memory_select on public.deal_memory;
create policy deal_memory_select on public.deal_memory
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.deal_memory from anon, authenticated;
grant select on public.deal_memory to authenticated;

-- The newest-input scans read by deal.
create index if not exists communications_deal_created_idx on public.communications (deal_id, created_at desc) where deal_id is not null;
create index if not exists activity_entity_created_idx on public.activity (entity_type, entity_id, created_at desc);

create or replace function public.deal_memory_newest(p_deal_ids bigint[])
returns table (deal_id bigint, newest_at timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  with ids as (select unnest(p_deal_ids) as id),
  t as (
    select c.deal_id as id, max(c.created_at) as at from public.communications c where c.deal_id = any(p_deal_ids) group by c.deal_id
    union all
    select a.entity_id, max(a.created_at) from public.activity a where a.entity_type = 'deal' and a.entity_id = any(p_deal_ids) group by a.entity_id
    union all
    select f.deal_id, max(f.created_at) from public.deal_files f where f.deal_id = any(p_deal_ids) group by f.deal_id
    union all
    select k.deal_id, max(k.updated_at) from public.contracts k where k.deal_id = any(p_deal_ids) group by k.deal_id
    union all
    select x.deal_id, max(x.created_at) from public.contract_extractions x where x.deal_id = any(p_deal_ids) group by x.deal_id
    union all
    select d.id, d.updated_at from public.deals d where d.id = any(p_deal_ids)
  )
  select ids.id, max(t.at) from ids left join t on t.id = ids.id group by ids.id;
$$;
revoke execute on function public.deal_memory_newest(bigint[]) from public, anon;
grant execute on function public.deal_memory_newest(bigint[]) to authenticated, service_role;

create or replace function public.deal_memory_dirty(p_limit integer default 6, p_window interval default interval '3 days')
returns table (workspace_id bigint, deal_id bigint, last_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  with touches as (
    select c.workspace_id, c.deal_id, max(c.created_at) as last_at
      from public.communications c
     where c.deal_id is not null and c.created_at > now() - p_window
     group by c.workspace_id, c.deal_id
    union all
    select a.workspace_id, a.entity_id, max(a.created_at)
      from public.activity a
     where a.entity_type = 'deal' and a.created_at > now() - p_window
     group by a.workspace_id, a.entity_id
    union all
    select f.workspace_id, f.deal_id, max(f.created_at)
      from public.deal_files f
     where f.kind = 'file' and f.created_at > now() - p_window
     group by f.workspace_id, f.deal_id
    union all
    select k.workspace_id, k.deal_id, max(k.updated_at)
      from public.contracts k
     where k.deal_id is not null and k.updated_at > now() - p_window
     group by k.workspace_id, k.deal_id
    union all
    select x.workspace_id, x.deal_id, max(x.created_at)
      from public.contract_extractions x
     where x.deal_id is not null and x.created_at > now() - p_window
     group by x.workspace_id, x.deal_id
    union all
    select d.workspace_id, d.id, d.updated_at
      from public.deals d
      join public.deal_memory m on m.deal_id = d.id and m.workspace_id = d.workspace_id
     where d.updated_at > now() - p_window
  ), latest as (
    select t.workspace_id, t.deal_id, max(t.last_at) as last_at from touches t group by t.workspace_id, t.deal_id
  )
  select l.workspace_id, l.deal_id, l.last_at
    from latest l
    join public.deals d on d.id = l.deal_id and d.workspace_id = l.workspace_id
    left join public.deal_memory m on m.workspace_id = l.workspace_id and m.deal_id = l.deal_id
   where d.archived_at is null
     and (m.updated_at is null or l.last_at > m.updated_at)
     and (m.deal_id is not null
          or exists (select 1 from public.transactions t where t.deal_id = l.deal_id)
          or exists (select 1 from public.contracts k where k.deal_id = l.deal_id))
   order by l.last_at desc
   limit greatest(1, least(coalesce(p_limit, 6), 50));
$$;
revoke execute on function public.deal_memory_dirty(integer, interval) from public, anon, authenticated;

create or replace function public.deal_memory_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.deal_memory_dirty(1)) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/deal-memory',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"refresh_dirty"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.deal_memory_kick() from public, anon, authenticated;

select cron.unschedule('clozr-deal-memory') where exists (select 1 from cron.job where jobname = 'clozr-deal-memory');
select cron.schedule('clozr-deal-memory', '*/10 * * * *', 'select public.deal_memory_kick()');
