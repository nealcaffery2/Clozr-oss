-- 146: AI Autopilot. New leads are worked by an AI agent within seconds, the
-- ones it does not reach stay on a follow-up cadence, and aged leads are
-- reactivated every night (docs/ai-agents.md, AI Autopilot).
--
-- ai_autopilot_settings  one row per workspace: { speed, followup,
--                        reactivation, send_as } as jsonb, normalized by the
--                        ai-agent function (_shared/ai-autopilot.ts). Members
--                        read; only the function writes (owner/admin checked
--                        there).
-- ai_autopilot_leads     the queue and the ledger of what the autopilot did
--                        with each lead: one row per (seller, program), so a
--                        lead is speed-dialed once and reactivated once, ever.
--                        status queued → working → touched | skipped | failed;
--                        lead_created_at and first_touch_at give the speed
--                        (seconds to first touch) for the report.
-- ai_agent_enrollments   gains program (speed, followup, reactivation: null for
--                        an agent a rep switched on) and autopilot (the speed
--                        phase: the call it is waiting on, when the window
--                        opens, the follow-up hand-over).
-- appointments           gains booked_by ('ai_agent') and ai_agent_key, so
--                        reporting can count what the agents booked.
--
-- Speed to lead does not wait for the 2-minute cron: a statement trigger on
-- sellers queues every new seller whose source the owner picked and POSTs
-- {"action":"speed"} to ai-agent with pg_net (one request per statement, so a
-- bulk insert of a thousand rows is one request, not a thousand). The function
-- claims at most `concurrency` leads at a time through
-- ai_autopilot_claim_speed (FOR UPDATE SKIP LOCKED, with a cap on what is in
-- flight across every invocation); the rest wait for the next run, which it
-- kicks itself, and clozr-ai-autopilot (every minute) catches anything left.
-- The trigger never fails the insert that fired it.
--
-- Reactivation: clozr-ai-autopilot-nightly (07:23 UTC, the small hours in the
-- US) POSTs {"action":"reactivate"}; the function reads candidates through
-- ai_autopilot_reactivation_candidates and enrolls up to each workspace's cap.
--
-- The kicks read the same Vault secrets as ai_agent_kick (clozr_project_url,
-- clozr_service_role_key, migration 53). Idempotent.

-- ---- settings -------------------------------------------------------------------------

create table if not exists public.ai_autopilot_settings (
  workspace_id bigint primary key references public.workspaces(id) on delete cascade,
  settings     jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null,
  constraint ai_autopilot_settings_is_object check (jsonb_typeof(settings) = 'object')
);
alter table public.ai_autopilot_settings enable row level security;
drop policy if exists ai_autopilot_settings_select on public.ai_autopilot_settings;
create policy ai_autopilot_settings_select on public.ai_autopilot_settings
  for select to authenticated
  using (workspace_id in (select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())));
revoke insert, update, delete on public.ai_autopilot_settings from anon, authenticated;

-- ---- the queue and ledger -------------------------------------------------------------

create table if not exists public.ai_autopilot_leads (
  id                  bigint generated always as identity primary key,
  workspace_id        bigint not null references public.workspaces(id) on delete cascade,
  seller_id           bigint not null references public.sellers(id) on delete cascade,
  program             text   not null check (program in ('speed', 'reactivation')),
  status              text   not null default 'queued' check (status in ('queued', 'working', 'touched', 'enrolled', 'skipped', 'failed')),
  lead_created_at     timestamptz,
  queued_at           timestamptz not null default now(),
  claimed_at          timestamptz,
  attempts            integer not null default 0,
  first_touch_at      timestamptz,
  first_touch_channel text check (first_touch_channel in ('call', 'sms', 'email')),
  enrollment_id       bigint references public.ai_agent_enrollments(id) on delete set null,
  agent_key           text,
  skip_reason         text,
  detail              jsonb not null default '{}'::jsonb,
  updated_at          timestamptz not null default now(),
  unique (workspace_id, seller_id, program)
);
create index if not exists ai_autopilot_leads_queue_idx on public.ai_autopilot_leads (queued_at) where status in ('queued', 'working');
create index if not exists ai_autopilot_leads_ws_idx on public.ai_autopilot_leads (workspace_id, program, queued_at desc);
create index if not exists ai_autopilot_leads_seller_idx on public.ai_autopilot_leads (seller_id);
create index if not exists ai_autopilot_leads_enrollment_idx on public.ai_autopilot_leads (enrollment_id);

alter table public.ai_autopilot_leads enable row level security;
drop policy if exists ai_autopilot_leads_select on public.ai_autopilot_leads;
create policy ai_autopilot_leads_select on public.ai_autopilot_leads
  for select to authenticated
  using (workspace_id in (select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())));
revoke insert, update, delete on public.ai_autopilot_leads from anon, authenticated;

-- ---- enrollments and appointments -------------------------------------------------------

alter table public.ai_agent_enrollments
  add column if not exists program   text,
  add column if not exists autopilot jsonb not null default '{}'::jsonb;
alter table public.ai_agent_enrollments drop constraint if exists ai_agent_enrollments_program_check;
alter table public.ai_agent_enrollments add constraint ai_agent_enrollments_program_check
  check (program is null or program in ('speed', 'followup', 'reactivation'));
create index if not exists ai_agent_enrollments_program_idx
  on public.ai_agent_enrollments (workspace_id, program) where program is not null;

alter table public.appointments
  add column if not exists booked_by    text,
  add column if not exists ai_agent_key text;
alter table public.appointments drop constraint if exists appointments_booked_by_check;
alter table public.appointments add constraint appointments_booked_by_check
  check (booked_by is null or booked_by in ('ai_agent'));
create index if not exists appointments_booked_by_ai_idx
  on public.appointments (workspace_id, created_at desc) where booked_by = 'ai_agent';

-- ---- the kick --------------------------------------------------------------------------

-- POST a body to ai-agent with the service key. Returns false when the Vault
-- secrets are not there (nothing is sent).
create or replace function public.ai_autopilot_post(p_body jsonb)
returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return false; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/ai-agent',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := p_body,
    timeout_milliseconds := 5000);
  return true;
end $$;
revoke all on function public.ai_autopilot_post(jsonb) from public, anon, authenticated;

-- New sellers from a picked source go in the queue, and the function is woken
-- at once. One statement, one request.
create or replace function public.ai_autopilot_on_seller_insert()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer := 0;
begin
  begin
    insert into public.ai_autopilot_leads (workspace_id, seller_id, program, lead_created_at)
    select s.workspace_id, s.id, 'speed', coalesce(s.created_at, now())
      from new_sellers s
      join public.ai_autopilot_settings a on a.workspace_id = s.workspace_id
     where coalesce(a.settings -> 'speed' ->> 'enabled', 'false') = 'true'
       and s.archived_at is null
       and (nullif(btrim(coalesce(s.phone, '')), '') is not null or nullif(btrim(coalesce(s.email, '')), '') is not null)
       and nullif(btrim(coalesce(s.source, '')), '') is not null
       and lower(btrim(s.source)) in (
         select lower(btrim(x)) from jsonb_array_elements_text(
           case when jsonb_typeof(a.settings -> 'speed' -> 'sources') = 'array' then a.settings -> 'speed' -> 'sources' else '[]'::jsonb end) x)
    on conflict (workspace_id, seller_id, program) do nothing;
    get diagnostics n = row_count;
    if n > 0 then perform public.ai_autopilot_post(jsonb_build_object('action', 'speed')); end if;
  exception when others then
    raise warning 'ai_autopilot_on_seller_insert: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.ai_autopilot_on_seller_insert() from public, anon, authenticated;
drop trigger if exists ai_autopilot_on_seller_insert on public.sellers;
create trigger ai_autopilot_on_seller_insert
  after insert on public.sellers
  referencing new table as new_sellers
  for each statement execute function public.ai_autopilot_on_seller_insert();

-- Claim up to p_limit queued leads, never more than p_inflight working at once
-- across every invocation. A lead stuck in working for five minutes (a crashed
-- run) is claimed again, three tries at most.
create or replace function public.ai_autopilot_claim_speed(p_limit integer, p_inflight integer)
returns setof public.ai_autopilot_leads
language plpgsql security definer set search_path = '' as $$
declare v_room integer;
begin
  update public.ai_autopilot_leads set status = 'failed', skip_reason = coalesce(skip_reason, 'gave up after three tries'), updated_at = now()
   where program = 'speed' and status = 'working' and claimed_at <= now() - interval '5 minutes' and attempts >= 3;
  select greatest(0, least(p_limit, p_inflight - count(*)::int)) into v_room
    from public.ai_autopilot_leads where status = 'working' and claimed_at > now() - interval '5 minutes';
  if v_room <= 0 then return; end if;
  return query
  with pick as (
    select l.id from public.ai_autopilot_leads l
     where l.program = 'speed'
       and (l.status = 'queued' or (l.status = 'working' and l.claimed_at <= now() - interval '5 minutes' and l.attempts < 3))
     order by l.queued_at
     limit v_room
     for update skip locked
  )
  , claimed as (
    update public.ai_autopilot_leads l
       set status = 'working', claimed_at = now(), attempts = l.attempts + 1, updated_at = now()
      from pick where l.id = pick.id
    returning l.*
  )
  select * from claimed;
end $$;
revoke all on function public.ai_autopilot_claim_speed(integer, integer) from public, anon, authenticated;
grant execute on function public.ai_autopilot_claim_speed(integer, integer) to service_role;

-- Every minute: anything still queued (a burst bigger than one run, a kick that
-- was lost) gets another run.
create or replace function public.ai_autopilot_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if exists (select 1 from public.ai_autopilot_leads where status = 'queued' or (status = 'working' and claimed_at <= now() - interval '5 minutes')) then
    perform public.ai_autopilot_post('{"action":"speed"}'::jsonb);
  end if;
end $$;
revoke execute on function public.ai_autopilot_kick() from public, anon, authenticated;

create or replace function public.ai_autopilot_nightly()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if exists (select 1 from public.ai_autopilot_settings where coalesce(settings -> 'reactivation' ->> 'enabled', 'false') = 'true') then
    perform public.ai_autopilot_post('{"action":"reactivate"}'::jsonb);
  end if;
end $$;
revoke execute on function public.ai_autopilot_nightly() from public, anon, authenticated;

select cron.unschedule('clozr-ai-autopilot') where exists (select 1 from cron.job where jobname = 'clozr-ai-autopilot');
select cron.schedule('clozr-ai-autopilot', '* * * * *', 'select public.ai_autopilot_kick()');
select cron.unschedule('clozr-ai-autopilot-nightly') where exists (select 1 from cron.job where jobname = 'clozr-ai-autopilot-nightly');
select cron.schedule('clozr-ai-autopilot-nightly', '23 7 * * *', 'select public.ai_autopilot_nightly()');

-- ---- reads for the function --------------------------------------------------------------

-- Aged leads for tonight, by the same rules as the People smart lists
-- (lib/reactivation.ts): 'reactivation' (talked to, gone quiet, stage not dead,
-- refund or closed), 'dead_leads' (a dead or refund stage) and 'no_contact'
-- (never reached), each quiet for p_idle_days (a lead never reached must be
-- that old). Never a contract, closed or wholesaler/buyer ('other') stage,
-- archived, tagged DNC or blacklisted, on an agent now, or reactivated before.
-- The function re-checks each one (_shared/ai-autopilot.ts reactivationEligible)
-- before it enrolls it.
drop function if exists public.ai_autopilot_reactivation_candidates(bigint, text[], text[], integer, integer);
create or replace function public.ai_autopilot_reactivation_candidates(p_ws bigint, p_lists text[], p_sources text[], p_idle_days integer, p_limit integer)
returns table (id bigint, lead_stage text, source text, tags text[], archived_at timestamptz, phone text, email text, last_touch_at timestamptz, created_at timestamptz, assigned_to uuid)
language sql stable security definer set search_path = '' as $$
  with base as (
    select s.*, coalesce(g.grp, 'other') as grp, t.last_at
      from public.sellers s
      left join public.seller_stages g on g.label = s.lead_stage
      left join lateral (
        select max(c.occurred_at) as last_at from public.communications c
         where c.workspace_id = s.workspace_id and c.seller_id = s.id and c.channel in ('call', 'sms', 'email')
      ) t on true
     where s.workspace_id = p_ws
       and s.archived_at is null
       and (coalesce(cardinality(p_sources), 0) = 0 or lower(btrim(coalesce(s.source, ''))) in (select lower(btrim(x)) from unnest(p_sources) x))
  )
  select b.id, b.lead_stage, b.source, b.tags, b.archived_at, b.phone, b.email, b.last_at, b.created_at, b.assigned_to
    from base b
   where b.grp not in ('contract', 'closed', 'other')
     and (
          ('reactivation' = any(p_lists) and b.last_at is not null and b.grp not in ('dead', 'refund') and b.last_at < now() - make_interval(days => greatest(1, p_idle_days)))
       or ('dead_leads' = any(p_lists) and b.grp in ('dead', 'refund') and coalesce(b.last_at, b.created_at) < now() - make_interval(days => greatest(1, p_idle_days)))
       or ('no_contact' = any(p_lists) and b.last_at is null and b.grp not in ('dead', 'refund') and b.created_at < now() - make_interval(days => greatest(1, p_idle_days)))
     )
     and (nullif(btrim(coalesce(b.phone, '')), '') is not null or nullif(btrim(coalesce(b.email, '')), '') is not null)
     and not exists (select 1 from unnest(coalesce(b.tags, '{}'::text[])) g
                      where g ~* '^(dnc|dnd|do[\s_-]?not[\s_-]?(call|contact|disturb))$' or lower(g) = 'secret-blacklist')
     and not exists (select 1 from public.ai_agent_enrollments e
                      where e.workspace_id = b.workspace_id and e.record_kind = 'seller' and e.record_id = b.id and e.status in ('draft', 'active', 'paused'))
     and not exists (select 1 from public.ai_autopilot_leads l
                      where l.workspace_id = b.workspace_id and l.seller_id = b.id and l.program = 'reactivation')
   order by coalesce(b.last_at, b.created_at) desc
   limit greatest(0, least(p_limit, 2000));
$$;
revoke all on function public.ai_autopilot_reactivation_candidates(bigint, text[], text[], integer, integer) from public, anon, authenticated;
grant execute on function public.ai_autopilot_reactivation_candidates(bigint, text[], text[], integer, integer) to service_role;

-- The lead sources seen in a workspace, for the owner's picker: sellers.source
-- with how many and the newest, plus the workspace's ingest keys that have not
-- produced a seller yet.
create or replace function public.ai_autopilot_sources(p_ws bigint)
returns table (source text, leads bigint, last_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.source, sum(x.leads)::bigint, max(x.last_at)
    from (
      select btrim(s.source) as source, count(*) as leads, max(s.created_at) as last_at
        from public.sellers s
       where s.workspace_id = p_ws and nullif(btrim(coalesce(s.source, '')), '') is not null
       group by btrim(s.source)
      union all
      select i.name, 0, null from public.ingest_sources i where i.workspace_id = p_ws and coalesce(i.active, true)
    ) x
   group by x.source
   order by max(x.last_at) desc nulls last, x.source
   limit 300;
$$;
revoke all on function public.ai_autopilot_sources(bigint) from public, anon, authenticated;
grant execute on function public.ai_autopilot_sources(bigint) to service_role;
