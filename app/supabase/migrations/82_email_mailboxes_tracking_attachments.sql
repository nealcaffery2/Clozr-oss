-- 82: the Email tab grows up — whose mailbox, Cc/Bcc, attachments, read receipts.
--
-- Four gaps in the mail CLOZR already syncs (migration 78):
--
--   whose     A communications row is one message, stored once per workspace
--             and keyed by its RFC Message-ID, so two reps on a thread share
--             it. Nothing said which mailbox it came from, so an admin could
--             not open one rep's inbox — every row was everyone's.
--             communication_mailboxes says which connected account holds it:
--             the pull writes a row for every mailbox it reads the message
--             in, a send writes the sender's.
--   cc/bcc    The pull folded Cc into to_email and a send could not set
--             either. cc_email / bcc_email hold them on their own now;
--             to_email is the To line for new rows (older rows keep To+Cc).
--   files     email_attachments lists every file on a message. A received
--             file stays in Gmail — the row names the account, the message
--             and the MIME part, and google-sync fetches it on demand. A sent
--             file was uploaded to the deal-files bucket first, and the row
--             keeps that path. Either can be saved onto the deal's files.
--   opens     email_tracking is one row per tracked send: a random token in
--             a 1×1 pixel and in each rewritten link (email_tracking_links),
--             counted by the public `email-track` function. email_events
--             keeps each open and click. Opens are a signal, not proof: a
--             mail client that blocks images never reports one, and Apple
--             Mail's privacy proxy reports one without a person reading it.

-- ---------------------------------------------------------------- cc / bcc
alter table public.communications
  add column if not exists cc_email  text,
  add column if not exists bcc_email text;

-- ---------------------------------------------------------------- mailboxes
create table if not exists public.communication_mailboxes (
  communication_id bigint not null references public.communications(id) on delete cascade,
  account_id       bigint not null references public.google_accounts(id) on delete cascade,
  workspace_id     bigint not null references public.workspaces(id) on delete cascade,
  user_id          uuid   not null references auth.users(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (communication_id, account_id)
);
create index if not exists communication_mailboxes_user_idx on public.communication_mailboxes (workspace_id, user_id);
create index if not exists communication_mailboxes_account_idx on public.communication_mailboxes (account_id);

alter table public.communication_mailboxes enable row level security;
-- Members read which mailbox holds what (it is how "Mine" filters); only the
-- sync and the send write it, as the service role.
drop policy if exists communication_mailboxes_read on public.communication_mailboxes;
create policy communication_mailboxes_read on public.communication_mailboxes for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.communication_mailboxes to authenticated;

-- History: whichever connected address sent a stored message, or is on its
-- To/Cc line, held it. New mail is written by the pull and the send.
insert into public.communication_mailboxes (communication_id, account_id, workspace_id, user_id)
select c.id, g.id, c.workspace_id, g.user_id
from public.communications c
join public.google_accounts g on g.workspace_id = c.workspace_id
where c.channel = 'email'
  and g.email is not null
  and (lower(coalesce(c.from_email, '')) = lower(g.email)
       or position(lower(g.email) in lower(coalesce(c.to_email, ''))) > 0)
on conflict do nothing;

-- An admin reading a rep's inbox sees what that rep has read. Members still
-- read and write only their own (migration 73's cus_own); this adds a read.
drop policy if exists cus_admin_read on public.communication_user_state;
create policy cus_admin_read on public.communication_user_state for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));

-- ---------------------------------------------------------------- attachments
create table if not exists public.email_attachments (
  id                 bigint generated always as identity primary key,
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  communication_id   bigint not null references public.communications(id) on delete cascade,
  -- "gmail:<partId>" for a received part, "sent:<n>" for a file CLOZR sent. One row per part per message.
  part_key           text   not null,
  filename           text   not null,
  content_type       text,
  byte_size          bigint,
  -- Received: fetched from this mailbox on demand.
  account_id         bigint references public.google_accounts(id) on delete set null,
  gmail_message_id   text,
  -- Sent (or saved): the deal-files bucket object.
  storage_path       text,
  -- Set once it is on the deal's files.
  deal_file_id       bigint references public.deal_files(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (communication_id, part_key)
);
create index if not exists email_attachments_ws_idx on public.email_attachments (workspace_id);
create index if not exists email_attachments_account_idx on public.email_attachments (account_id);
create index if not exists email_attachments_deal_file_idx on public.email_attachments (deal_file_id);

alter table public.email_attachments enable row level security;
drop policy if exists email_attachments_read on public.email_attachments;
create policy email_attachments_read on public.email_attachments for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.email_attachments to authenticated;

-- ---------------------------------------------------------------- tracking
create table if not exists public.email_tracking (
  token             text primary key,
  workspace_id      bigint not null references public.workspaces(id) on delete cascade,
  communication_id  bigint references public.communications(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  recipients        text,
  subject           text,
  sent_at           timestamptz not null default now(),
  opens             integer not null default 0,
  first_opened_at   timestamptz,
  last_opened_at    timestamptz,
  clicks            integer not null default 0,
  last_clicked_at   timestamptz
);
create index if not exists email_tracking_comm_idx on public.email_tracking (communication_id);
create index if not exists email_tracking_ws_idx on public.email_tracking (workspace_id, sent_at desc);
create index if not exists email_tracking_user_idx on public.email_tracking (user_id);

create table if not exists public.email_tracking_links (
  token  text    not null references public.email_tracking(token) on delete cascade,
  idx    integer not null,
  url    text    not null,
  primary key (token, idx)
);

create table if not exists public.email_events (
  id          bigint generated always as identity primary key,
  token       text not null references public.email_tracking(token) on delete cascade,
  kind        text not null check (kind in ('open', 'click')),
  url         text,
  user_agent  text,
  at          timestamptz not null default now()
);
create index if not exists email_events_token_idx on public.email_events (token, at desc);

alter table public.email_tracking enable row level security;
alter table public.email_tracking_links enable row level security;
alter table public.email_events enable row level security;
drop policy if exists email_tracking_read on public.email_tracking;
create policy email_tracking_read on public.email_tracking for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists email_events_read on public.email_events;
create policy email_events_read on public.email_events for select to authenticated
  using (exists (select 1 from public.email_tracking t where t.token = email_events.token and public.is_workspace_member(t.workspace_id)));
grant select on public.email_tracking, public.email_events to authenticated;
-- The links table is read only by the public redirect, as the service role.

-- One open or click, counted atomically. The function is the only writer; it
-- runs as the service role, so this is not granted to members.
create or replace function public.email_track_hit(p_token text, p_kind text, p_url text, p_ua text)
returns table (workspace_id bigint, user_id uuid, communication_id bigint, subject text, recipients text, opens integer, first_open boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r public.email_tracking%rowtype; was integer;
begin
  select * into r from public.email_tracking t where t.token = p_token for update;
  if not found then return; end if;
  was := r.opens;
  if p_kind = 'open' then
    update public.email_tracking t set opens = t.opens + 1, first_opened_at = coalesce(t.first_opened_at, now()), last_opened_at = now()
      where t.token = p_token returning * into r;
  else
    -- A click is also an open: the link was read.
    update public.email_tracking t set clicks = t.clicks + 1, last_clicked_at = now(),
        opens = greatest(t.opens, 1), first_opened_at = coalesce(t.first_opened_at, now()), last_opened_at = coalesce(t.last_opened_at, now())
      where t.token = p_token returning * into r;
  end if;
  insert into public.email_events (token, kind, url, user_agent) values (p_token, p_kind, left(p_url, 2000), left(p_ua, 400));
  return query select r.workspace_id, r.user_id, r.communication_id, r.subject, r.recipients, r.opens, (was = 0 and r.opens > 0);
end $$;
revoke all on function public.email_track_hit(text, text, text, text) from public, anon, authenticated;

-- …and the watermark that decides what counts as unread for them (migration 73).
drop policy if exists inbox_user_prefs_admin_read on public.inbox_user_prefs;
create policy inbox_user_prefs_admin_read on public.inbox_user_prefs for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));
