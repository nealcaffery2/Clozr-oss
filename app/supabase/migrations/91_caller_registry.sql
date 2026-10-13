-- 91: Free Caller Registry, and the Telnyx steps that follow a new line.
--
-- freecallerregistry.com has no API. First Orion, Hiya and TNS email a
-- verification code; that mailbox is an AgentMail inbox, and caller_registry_mail
-- is where the code lands. caller_lines is one row per number: whether it is
-- on the registry, on Telnyx Number Reputation, on a branded-calling DIR, and
-- whether a spam remediation is already in flight. caller_registry_state is
-- the workspace's enterprise, DIR and the last Firecrawl job.
--
-- Writes are the caller-registry function only. Members can read.

create table if not exists public.caller_registry_state (
  workspace_id        bigint primary key references public.workspaces(id) on delete cascade,
  enterprise_id       text,
  reputation_status   text,
  loa_status          text,
  dir_id              text,
  dir_status          text,
  fcr_job_id          text,
  fcr_job_status      text,
  last_code           text,
  last_code_at        timestamptz,
  last_error          text,
  last_run_at         timestamptz,
  notes               jsonb not null default '[]'::jsonb,
  updated_at          timestamptz not null default now()
);

alter table public.caller_registry_state enable row level security;
drop policy if exists caller_registry_state_read on public.caller_registry_state;
create policy caller_registry_state_read on public.caller_registry_state for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = caller_registry_state.workspace_id and m.user_id = (select auth.uid())));

create table if not exists public.caller_lines (
  workspace_id          bigint not null references public.workspaces(id) on delete cascade,
  phone_e164            text not null,
  talkr_number_id       text,
  fcr_status            text not null default 'queued'
                          check (fcr_status in ('queued', 'submitting', 'code_ready', 'verified', 'registered', 'failed')),
  reputation_enrolled   boolean not null default false,
  branded_attached      boolean not null default false,
  remediation_open      boolean not null default false,
  remediation_id        text,
  spam_risk             text,
  last_error            text,
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, phone_e164)
);

alter table public.caller_lines enable row level security;
drop policy if exists caller_lines_read on public.caller_lines;
create policy caller_lines_read on public.caller_lines for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = caller_lines.workspace_id and m.user_id = (select auth.uid())));

create table if not exists public.caller_registry_mail (
  message_id    text primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  from_addr     text,
  subject       text,
  code          text,
  confirm_url   text,
  clicked_at    timestamptz,
  received_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists caller_registry_mail_ws_idx on public.caller_registry_mail (workspace_id, created_at desc);

alter table public.caller_registry_mail enable row level security;
drop policy if exists caller_registry_mail_read on public.caller_registry_mail;
create policy caller_registry_mail_read on public.caller_registry_mail for select to authenticated
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = caller_registry_mail.workspace_id and m.user_id = (select auth.uid())));

create or replace function public.caller_registry_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.caller_registry_touch() from public, anon, authenticated;

drop trigger if exists caller_registry_state_touch on public.caller_registry_state;
create trigger caller_registry_state_touch before update on public.caller_registry_state
  for each row execute function public.caller_registry_touch();

drop trigger if exists caller_lines_touch on public.caller_lines;
create trigger caller_lines_touch before update on public.caller_lines
  for each row execute function public.caller_registry_touch();
