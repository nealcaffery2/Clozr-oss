-- 123: AI agents that work a record, and everything they do.
--
-- Until now an agent (voice_agent_settings, migration 111) only answered or
-- placed the calls ElevenLabs routed to it. This lets a rep switch an agent ON
-- for one seller or buyer, or for a selection of buyers, tell it what to do
-- in a chat box (or let it decide from the record's history), and have it
-- call, text and email on a plan until it is switched OFF.
--
-- voice_agent_settings gains a face and an audience:
--   avatar_url     the agent's picture (a public URL in the avatars bucket, or
--                  an inline data:image/svg+xml drawing). Written by the
--                  ai-agent function's generate_avatar.
--   avatar_prompt  what the picture was drawn from, so Regenerate keeps it.
--   audience       which records it may work: sellers, buyers or both. The
--                  buyer assistant template is buyers; the seller templates
--                  are sellers.
--
-- voice_agent_secrets gains tool_ids: the ElevenLabs ids of the write tools
-- (book_appointment, save_qualification, mark_do_not_contact), one per
-- workspace and shared by its agents like tool_id (lead_context).
--
-- ai_agent_enrollments: ONE row per record (a record has one agent working
--   it at a time). status draft (the rep is still shaping the plan in the
--   chat, nothing goes out) | active | paused | stopped | done. mode custom (a
--   rep's instructions) or auto (the agent decides from the history).
--   plan is the agent's own plan ({ summary, goal, steps[] }); chat is the
--   conversation with the rep in the popup. next_action_at is when the tick
--   looks at it again; claimed_at is the tick's lease so two ticks never
--   work the same record. Written only by the ai-agent function.
--
-- ai_agent_actions: append-only ledger of every action an agent took or
--   refused (texts, emails, calls, bookings, plans, switches), for the
--   record's AI log and the AI agents report. Every one of them also lands
--   on the record's activity timeline (kind 'ai_agent').
--
-- A reply (an inbound call, text or email on the record) wakes an active
-- enrollment: the trigger below brings its next look forward to now, so the
-- agent answers on the next tick instead of waiting out the plan.
--
-- VIP buyers and funds (buyer_type or entity_type fund / institutional) are
-- never enrolled: the function refuses them, and ai_agent_guard() below
-- refuses them again at the database, so no path can put one on an agent.
--
-- The tick kick reads the same two Vault secrets as the dispo campaigns
-- (clozr_project_url, clozr_service_role_key, migration 53).
-- Idempotent.

alter table public.voice_agent_settings
  add column if not exists avatar_url    text,
  add column if not exists avatar_prompt text not null default '',
  add column if not exists audience      text not null default 'sellers';
alter table public.voice_agent_settings drop constraint if exists voice_agent_settings_audience_check;
alter table public.voice_agent_settings add constraint voice_agent_settings_audience_check
  check (audience in ('sellers', 'buyers', 'both'));
-- The buyer-facing roles start out on buyers.
update public.voice_agent_settings set audience = 'buyers'
 where audience = 'sellers' and role in ('buyer_assistant', 'jr_dispo');

alter table public.voice_agent_secrets
  add column if not exists tool_ids jsonb not null default '{}'::jsonb;

-- ---- enrollments ------------------------------------------------------------------

create table if not exists public.ai_agent_enrollments (
  id                   bigint generated always as identity primary key,
  workspace_id         bigint not null references public.workspaces(id) on delete cascade,
  record_kind          text   not null check (record_kind in ('seller', 'buyer')),
  record_id            bigint not null,
  agent_key            text   not null,
  status               text   not null default 'active' check (status in ('draft', 'active', 'paused', 'stopped', 'done')),
  mode                 text   not null default 'auto' check (mode in ('auto', 'custom')),
  instructions         text   not null default '',
  channels             text[] not null default '{sms,email}',
  plan                 jsonb  not null default '{}'::jsonb,
  chat                 jsonb  not null default '[]'::jsonb,
  touches              integer not null default 0,
  max_touches          integer not null default 12 check (max_touches between 1 and 60),
  next_action_at       timestamptz,
  last_action_at       timestamptz,
  last_inbound_seen_at timestamptz,
  claimed_at           timestamptz,
  stop_reason          text,
  started_by           uuid references auth.users(id) on delete set null,
  started_at           timestamptz not null default now(),
  stopped_by           uuid references auth.users(id) on delete set null,
  stopped_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, record_kind, record_id),
  foreign key (workspace_id, agent_key) references public.voice_agent_settings (workspace_id, agent_key) on delete cascade,
  constraint ai_agent_enrollments_channels_check check (channels <@ array['call', 'sms', 'email']::text[]),
  constraint ai_agent_enrollments_chat_is_array check (jsonb_typeof(chat) = 'array')
);

-- What the tick scans: active rows that are due.
create index if not exists ai_agent_enrollments_due_idx
  on public.ai_agent_enrollments (next_action_at) where status = 'active';
create index if not exists ai_agent_enrollments_agent_idx
  on public.ai_agent_enrollments (workspace_id, agent_key, status);

alter table public.ai_agent_enrollments enable row level security;
drop policy if exists ai_agent_enrollments_select on public.ai_agent_enrollments;
create policy ai_agent_enrollments_select on public.ai_agent_enrollments
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.ai_agent_enrollments from anon, authenticated;

-- ---- the ledger ---------------------------------------------------------------------

create table if not exists public.ai_agent_actions (
  id               bigint generated always as identity primary key,
  workspace_id     bigint not null references public.workspaces(id) on delete cascade,
  agent_key        text   not null,
  enrollment_id    bigint references public.ai_agent_enrollments(id) on delete set null,
  record_kind      text   check (record_kind in ('seller', 'buyer')),
  record_id        bigint,
  channel          text   not null default 'system' check (channel in ('call', 'sms', 'email', 'plan', 'system')),
  action           text   not null,
  status           text   not null default 'done' check (status in ('done', 'skipped', 'failed')),
  summary          text   not null default '',
  detail           jsonb  not null default '{}'::jsonb,
  communication_id bigint,
  conversation_id  text,
  actor_id         uuid,
  created_at       timestamptz not null default now()
);

create index if not exists ai_agent_actions_agent_idx
  on public.ai_agent_actions (workspace_id, agent_key, created_at desc);
create index if not exists ai_agent_actions_record_idx
  on public.ai_agent_actions (workspace_id, record_kind, record_id, created_at desc);
create index if not exists ai_agent_actions_enrollment_idx
  on public.ai_agent_actions (enrollment_id);

alter table public.ai_agent_actions enable row level security;
drop policy if exists ai_agent_actions_select on public.ai_agent_actions;
create policy ai_agent_actions_select on public.ai_agent_actions
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.ai_agent_actions from anon, authenticated;

-- Append-only: a row is never rewritten, by anyone. The one change allowed is
-- the foreign key's own ON DELETE SET NULL when an enrollment goes (its agent
-- was deleted). Rows still go with their workspace.
create or replace function public.ai_agent_actions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enrollment_id is null and (to_jsonb(new) - 'enrollment_id') = (to_jsonb(old) - 'enrollment_id') then
    return new;
  end if;
  raise exception 'ai_agent_actions is append-only';
end $$;
revoke all on function public.ai_agent_actions_append_only() from public, anon, authenticated;
drop trigger if exists ai_agent_actions_append_only on public.ai_agent_actions;
create trigger ai_agent_actions_append_only
  before update on public.ai_agent_actions
  for each row execute function public.ai_agent_actions_append_only();

-- ---- guards -------------------------------------------------------------------------

-- No VIP buyer and no fund ever goes on an agent, whatever path writes the
-- row, and an agent only works the records its audience allows.
create or replace function public.ai_agent_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_audience text;
  b record;
begin
  new.updated_at := now();
  -- Only a row going on (or onto another agent or record) is checked; a tick
  -- moving next_action_at, or a stop, is not.
  if new.status not in ('active', 'paused') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('active', 'paused') and old.agent_key = new.agent_key
     and old.record_kind = new.record_kind and old.record_id = new.record_id then
    return new;
  end if;
  select audience into v_audience from public.voice_agent_settings
   where workspace_id = new.workspace_id and agent_key = new.agent_key;
  if v_audience is null then
    raise exception 'no agent % in this workspace', new.agent_key using errcode = '23503';
  end if;
  if (new.record_kind = 'seller' and v_audience = 'buyers') or (new.record_kind = 'buyer' and v_audience = 'sellers') then
    raise exception 'agent % works %, not %s', new.agent_key, v_audience, new.record_kind using errcode = '23514';
  end if;
  if new.record_kind = 'buyer' then
    select vip, buyer_type, entity_type into b from public.buyers
     where id = new.record_id and workspace_id = new.workspace_id;
    if not found then
      raise exception 'buyer % not found', new.record_id using errcode = '23503';
    end if;
    if coalesce(b.vip, false)
       or lower(coalesce(b.buyer_type, '')) in ('fund', 'institutional')
       or lower(coalesce(b.entity_type, '')) in ('fund', 'institutional') then
      raise exception 'VIP buyers and funds are never put on an AI agent' using errcode = '23514';
    end if;
  else
    perform 1 from public.sellers where id = new.record_id and workspace_id = new.workspace_id;
    if not found then
      raise exception 'seller % not found', new.record_id using errcode = '23503';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.ai_agent_guard() from public, anon, authenticated;
drop trigger if exists ai_agent_guard on public.ai_agent_enrollments;
create trigger ai_agent_guard
  before insert or update on public.ai_agent_enrollments
  for each row execute function public.ai_agent_guard();

-- A buyer made VIP or a fund after being enrolled is taken off the agent at once.
create or replace function public.ai_agent_buyer_became_protected()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.vip, false)
     or lower(coalesce(new.buyer_type, '')) in ('fund', 'institutional')
     or lower(coalesce(new.entity_type, '')) in ('fund', 'institutional') then
    update public.ai_agent_enrollments
       set status = 'stopped', stop_reason = 'buyer is VIP or a fund', stopped_at = now(), next_action_at = null
     where workspace_id = new.workspace_id and record_kind = 'buyer' and record_id = new.id and status in ('active', 'paused');
  end if;
  return new;
end $$;
revoke all on function public.ai_agent_buyer_became_protected() from public, anon, authenticated;
drop trigger if exists ai_agent_buyer_became_protected on public.buyers;
create trigger ai_agent_buyer_became_protected
  after update of vip, buyer_type, entity_type on public.buyers
  for each row execute function public.ai_agent_buyer_became_protected();

-- A reply wakes the agent: an inbound call, text or email on an enrolled record
-- brings its next look forward to now.
create or replace function public.ai_agent_reply_wakes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  -- Never let waking an agent fail the message that woke it.
  begin
  if new.seller_id is not null then
    update public.ai_agent_enrollments set next_action_at = now()
     where workspace_id = new.workspace_id and record_kind = 'seller' and record_id = new.seller_id and status = 'active'
       and (next_action_at is null or next_action_at > now());
  end if;
  if new.buyer_id is not null then
    update public.ai_agent_enrollments set next_action_at = now()
     where workspace_id = new.workspace_id and record_kind = 'buyer' and record_id = new.buyer_id and status = 'active'
       and (next_action_at is null or next_action_at > now());
  end if;
  exception when others then
    raise warning 'ai_agent_reply_wakes: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.ai_agent_reply_wakes() from public, anon, authenticated;
drop trigger if exists ai_agent_reply_wakes on public.communications;
create trigger ai_agent_reply_wakes
  after insert on public.communications
  for each row execute function public.ai_agent_reply_wakes();

-- ---- the tick -----------------------------------------------------------------------

create or replace function public.ai_agent_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.ai_agent_enrollments where status = 'active' and next_action_at <= now()) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/ai-agent',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.ai_agent_kick() from public, anon, authenticated;

select cron.unschedule('clozr-ai-agent-kick') where exists (select 1 from cron.job where jobname = 'clozr-ai-agent-kick');
select cron.schedule('clozr-ai-agent-kick', '*/2 * * * *', 'select public.ai_agent_kick()');
