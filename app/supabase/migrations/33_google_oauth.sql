-- 33 — Google, connected with a button.
--
-- The calendar feed (migration 22) asked the user to copy a secret URL into
-- Google Calendar's "From URL" box. That is a code to chase, it is one-way,
-- and it says nothing about Gmail. This replaces it with the normal thing:
-- click Connect, approve on Google's own consent screen, done.
--
-- What that needs on our side is somewhere to keep the grant. Three tables:
--
--   google_accounts     the connection, as the team sees it — whose Google
--                       account, what it may do, when it last synced. Readable
--                       by the workspace; the toggles are the member's own.
--   google_tokens       the refresh token. RLS on with no policy at all and
--                       every grant revoked, so only the service role — the
--                       edge functions — can see a row. Split from the table
--                       above precisely so "readable by the workspace" can
--                       never mean readable tokens.
--   google_oauth_states the one-time state parameter, proving a callback came
--                       from a consent we started. Service role only, same way.
--
-- google_event_links maps a CLOZR appointment or task to the Google event it
-- became, which is what makes the sync two-way instead of a re-import: we know
-- which event is ours, so an edit on either side lands on the other.

-- ------------------------------------------------------------- connections
create table if not exists public.google_accounts (
  id                     bigint generated always as identity primary key,
  workspace_id           bigint not null references public.workspaces(id) on delete cascade,
  user_id                uuid   not null references auth.users(id) on delete cascade,
  email                  text   not null,
  -- Exactly what Google granted. Consent is granular: a user can approve the
  -- calendar and decline Gmail, and the features follow what is in here.
  scopes                 text[] not null default '{}',
  calendar_id            text,                                -- the CLOZR calendar in their account
  calendar_sync          boolean not null default true,
  gmail_send             boolean not null default true,
  gmail_read             boolean not null default true,
  status                 text    not null default 'active' check (status in ('active','needs_reauth','revoked')),
  sync_token             text,                                -- Google's incremental calendar cursor
  last_calendar_sync_at  timestamptz,
  last_gmail_sync_at     timestamptz,
  last_error             text,
  connected_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index if not exists google_accounts_ws_idx on public.google_accounts (workspace_id);

alter table public.google_accounts enable row level security;
drop policy if exists google_accounts_select on public.google_accounts;
create policy google_accounts_select on public.google_accounts for select
  using (public.is_workspace_member(workspace_id));
-- The member owns their own connection: they can flip what it syncs. Creating
-- and deleting a row goes through the function, which also has to talk to
-- Google (exchange a code, revoke a grant), so neither is granted here.
drop policy if exists google_accounts_own_update on public.google_accounts;
create policy google_accounts_own_update on public.google_accounts for update
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on public.google_accounts from anon, authenticated;
grant select (id, workspace_id, user_id, email, scopes, calendar_id, calendar_sync,
              gmail_send, gmail_read, status, last_calendar_sync_at, last_gmail_sync_at,
              last_error, connected_at, updated_at)
  on public.google_accounts to authenticated;
grant update (calendar_sync, gmail_send, gmail_read) on public.google_accounts to authenticated;

drop trigger if exists google_accounts_touch on public.google_accounts;
create trigger google_accounts_touch before update on public.google_accounts
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ tokens
create table if not exists public.google_tokens (
  account_id        bigint primary key references public.google_accounts(id) on delete cascade,
  refresh_token     text not null,
  access_token      text,
  access_expires_at timestamptz,
  updated_at        timestamptz not null default now()
);
-- RLS on, no policy, no grant: the service role bypasses RLS, everyone else
-- gets nothing. Both halves matter — the revoke stops a future policy from
-- quietly opening the table, and the RLS stops a future grant from doing it.
alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;

drop trigger if exists google_tokens_touch on public.google_tokens;
create trigger google_tokens_touch before update on public.google_tokens
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------- state
create table if not exists public.google_oauth_states (
  state         text primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  user_id       uuid   not null references auth.users(id) on delete cascade,
  origin        text,
  scopes        text,
  created_at    timestamptz not null default now()
);
create index if not exists google_oauth_states_created_idx on public.google_oauth_states (created_at);
alter table public.google_oauth_states enable row level security;
revoke all on public.google_oauth_states from anon, authenticated;

-- ------------------------------------------------------------ event links
create table if not exists public.google_event_links (
  id          bigint generated always as identity primary key,
  account_id  bigint not null references public.google_accounts(id) on delete cascade,
  source      text   not null check (source in ('appointment','task')),
  source_id   bigint not null,
  event_id    text   not null,
  pushed      text,                                  -- fingerprint of what we last sent
  updated_at  timestamptz not null default now(),
  unique (account_id, source, source_id)
);
create index if not exists google_event_links_event_idx on public.google_event_links (account_id, event_id);
alter table public.google_event_links enable row level security;
revoke all on public.google_event_links from anon, authenticated;

drop trigger if exists google_event_links_touch on public.google_event_links;
create trigger google_event_links_touch before update on public.google_event_links
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------- mail in the
-- timeline. A pulled Gmail message becomes an activity row like any other, so
-- the record shows the thread beside the calls, texts and contracts. The
-- Gmail message id goes in external_id and the unique index makes the pull
-- idempotent: re-running it inserts nothing twice.
alter table public.activity add column if not exists external_id text;
-- Not a partial index: nulls are distinct in a unique index, so the rows with
-- no external id (every hand-written note) are unaffected, and ON CONFLICT can
-- name these three columns — which a partial index would not let it do.
create unique index if not exists activity_external_idx
  on public.activity (workspace_id, kind, external_id);
