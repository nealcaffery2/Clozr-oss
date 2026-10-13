-- 111: the AI Agent console: several voice agents per workspace, their
-- structured settings, published versions, secrets and a per-call log.
--
-- voice_agent_settings: one row per (workspace, agent_key), agent_key a slug
--   ('lead_manager', 'acquisitions', 'jr_dispo' or custom). `settings` is the
--   DRAFT the console edits; `live_settings` is a copy of what was last
--   published, and is what the phone webhooks read, so an unpublished edit
--   never changes a live call. live_version / latest_version number the
--   snapshots in voice_agent_versions. agent_id is the ElevenLabs agent (one
--   per agent_key; the webhooks find the agent by it). Members read (the
--   console); nobody writes from the client, the voice-agent-admin edge
--   function does with the service role after checking the caller is an owner
--   or admin.
--
-- voice_agent_versions: append-only snapshots (settings, the assembled prompt,
--   who and why) written by publish and rollback.
--
-- voice_agent_secrets: ONE row per workspace: the three shared secrets the
--   voice-agent webhooks check (personalize header, tool header, post-call
--   HMAC), the ElevenLabs webhook id and lead_context tool id. The secrets
--   identify the workspace, and the agent inside it is found by the ElevenLabs
--   agent_id in each payload, so the agents of a workspace share one secret
--   set, one lead_context tool and one post-call webhook. RLS is on with NO
--   policy and every grant revoked: service role only.
--
-- voice_agent_calls: one row per AI call, written by /post-call: which agent,
--   how long, and what happened (booked, transferred, asked not to be called,
--   not interested), for the console's stats. Members read.
--
-- workspace_id is bigint like every other workspace_id here (workspaces.id).
-- Idempotent. Do not apply from a branch: run through the normal migration path.

create table if not exists public.voice_agent_settings (
  workspace_id   bigint not null references public.workspaces(id) on delete cascade,
  agent_key      text   not null check (agent_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  role           text   not null default 'custom',
  name           text   not null default '',
  status         text   not null default 'draft' check (status in ('draft', 'live')),
  enabled        boolean not null default false,
  settings       jsonb  not null default '{}'::jsonb,
  live_settings  jsonb,
  live_version   integer not null default 0,
  latest_version integer not null default 0,
  agent_id       text,
  connected_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  primary key (workspace_id, agent_key)
);

-- A webhook payload names the ElevenLabs agent; that lookup must be one index probe.
create unique index if not exists voice_agent_settings_agent_id_idx
  on public.voice_agent_settings (agent_id) where agent_id is not null;

alter table public.voice_agent_settings enable row level security;
drop policy if exists voice_agent_settings_select on public.voice_agent_settings;
create policy voice_agent_settings_select on public.voice_agent_settings
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.voice_agent_settings from anon, authenticated;

create table if not exists public.voice_agent_versions (
  workspace_id bigint  not null,
  agent_key    text    not null,
  version      integer not null,
  settings     jsonb   not null,
  prompt       text    not null default '',
  note         text    not null default '',
  created_by   uuid,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, agent_key, version),
  foreign key (workspace_id, agent_key) references public.voice_agent_settings (workspace_id, agent_key) on delete cascade
);

alter table public.voice_agent_versions enable row level security;
drop policy if exists voice_agent_versions_select on public.voice_agent_versions;
create policy voice_agent_versions_select on public.voice_agent_versions
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.voice_agent_versions from anon, authenticated;

create table if not exists public.voice_agent_secrets (
  workspace_id       bigint primary key references public.workspaces(id) on delete cascade,
  personalize_secret text,
  tool_secret        text,
  webhook_secret     text,
  webhook_id         text,
  tool_id            text,
  updated_at         timestamptz not null default now()
);

alter table public.voice_agent_secrets enable row level security;
revoke all on public.voice_agent_secrets from anon, authenticated;

create table if not exists public.voice_agent_calls (
  workspace_id    bigint not null references public.workspaces(id) on delete cascade,
  conversation_id text   not null,
  agent_key       text   not null default 'unassigned',
  agent_id        text,
  direction       text,
  occurred_at     timestamptz not null default now(),
  duration_s      integer,
  status          text,
  seller_id       bigint,
  buyer_id        bigint,
  booked          boolean not null default false,
  transferred     boolean not null default false,
  dnc_requested   boolean not null default false,
  not_interested  boolean not null default false,
  outcome         text,
  tools           text[] not null default '{}',
  created_at      timestamptz not null default now(),
  primary key (workspace_id, conversation_id)
);

create index if not exists voice_agent_calls_agent_idx
  on public.voice_agent_calls (workspace_id, agent_key, occurred_at desc);

alter table public.voice_agent_calls enable row level security;
drop policy if exists voice_agent_calls_select on public.voice_agent_calls;
create policy voice_agent_calls_select on public.voice_agent_calls
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.voice_agent_calls from anon, authenticated;
