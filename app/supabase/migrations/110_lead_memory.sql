-- 110: lead memory, the one summary every channel reads.
--
-- A rep opening a record, an AI voice agent picking up, and Claude drafting a
-- text all needed the same thing: what has this person told us, what did we
-- promise, what happens next. Each one used to re-read the raw history (or
-- nothing at all), so the phone agent knew less than the rep and two drafts
-- could contradict each other. lead_memory holds one brief per seller or
-- buyer, rewritten by the lead-memory edge function after every touch.
--
-- brief:  under ~1200 characters, what someone needs in 20 seconds.
-- facts:  structured (first_name, preferred_name, property_address,
--         motivation, asking_price, offer_made, timeline, condition_notes,
--         objections[], promises_made[], next_step, do_not_mention[],
--         sentiment, last_contact_at, last_contact_summary, open_questions[]).
--         The voice agent reads it at call start without calling a model.
-- updated_at: the moment the history was READ, not when the write landed,
--         so a text that arrives while Claude is writing still marks the
--         record dirty for the next pass.
--
-- lead_memory_dirty(): records touched in the last few days (a
-- communication, an activity note or an offer newer than their memory),
-- newest first. Outbound buyer texts are skipped: a dispo blast sends the
-- same words to hundreds of buyers and says nothing about any one of them,
-- and counting it would queue a model call per recipient.
--
-- lead_memory_kick(): every two minutes, only when something is dirty, POSTs
-- {"action":"refresh_dirty"} to the lead-memory function with the vault's
-- service key (same pattern as call_sync_kick in 67 and rvm_kick in 101).
--
-- Idempotent. Members read; only the service role writes.

create table if not exists public.lead_memory (
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  record_kind    text   not null check (record_kind in ('seller', 'buyer')),
  record_id      bigint not null,
  brief          text   not null default '' check (length(brief) <= 2000),
  facts          jsonb  not null default '{}'::jsonb,
  source_count   integer not null default 0,
  last_source_at timestamptz,
  model          text,
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, record_kind, record_id)
);

alter table public.lead_memory enable row level security;
drop policy if exists lead_memory_select on public.lead_memory;
create policy lead_memory_select on public.lead_memory
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.lead_memory from anon, authenticated;

-- The dirty scan reads recent rows by creation time.
create index if not exists communications_created_at_idx on public.communications (created_at);
create index if not exists activity_created_at_idx on public.activity (created_at);

create or replace function public.lead_memory_dirty(p_limit integer default 15, p_window interval default interval '3 days')
returns table (workspace_id bigint, record_kind text, record_id bigint, last_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  with touches as (
    select c.workspace_id, 'seller'::text as record_kind, c.seller_id as record_id, max(c.created_at) as last_at
      from public.communications c
     where c.seller_id is not null and c.created_at > now() - p_window
     group by c.workspace_id, c.seller_id
    union all
    select c.workspace_id, 'buyer'::text, c.buyer_id, max(c.created_at)
      from public.communications c
     where c.buyer_id is not null and c.created_at > now() - p_window
       and (c.direction = 'inbound' or c.channel in ('call', 'voicemail', 'note'))
     group by c.workspace_id, c.buyer_id
    union all
    select a.workspace_id, a.entity_type, a.entity_id, max(a.created_at)
      from public.activity a
     where a.entity_type in ('seller', 'buyer') and a.created_at > now() - p_window
     group by a.workspace_id, a.entity_type, a.entity_id
    union all
    select o.workspace_id, 'seller'::text, o.seller_id, max(o.updated_at)
      from public.offers o
     where o.seller_id is not null and o.updated_at > now() - p_window
     group by o.workspace_id, o.seller_id
    union all
    select o.workspace_id, 'buyer'::text, o.buyer_id, max(o.updated_at)
      from public.offers o
     where o.buyer_id is not null and o.updated_at > now() - p_window
     group by o.workspace_id, o.buyer_id
  ), latest as (
    select t.workspace_id, t.record_kind, t.record_id, max(t.last_at) as last_at
      from touches t
     group by t.workspace_id, t.record_kind, t.record_id
  )
  select l.workspace_id, l.record_kind, l.record_id, l.last_at
    from latest l
    left join public.lead_memory m
      on m.workspace_id = l.workspace_id and m.record_kind = l.record_kind and m.record_id = l.record_id
   where m.updated_at is null or l.last_at > m.updated_at
   order by l.last_at desc
   limit greatest(1, least(coalesce(p_limit, 15), 100));
$$;
revoke execute on function public.lead_memory_dirty(integer, interval) from public, anon, authenticated;

create or replace function public.lead_memory_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.lead_memory_dirty(1)) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/lead-memory',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"refresh_dirty"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.lead_memory_kick() from public, anon, authenticated;

select cron.unschedule('clozr-lead-memory') where exists (select 1 from cron.job where jobname = 'clozr-lead-memory');
select cron.schedule('clozr-lead-memory', '*/2 * * * *', 'select public.lead_memory_kick()');
