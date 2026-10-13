-- 73: the Email tab becomes a mailbox — per-member read, star and archive.
--
-- The Email tab reads `communications` (channel 'email') for the whole
-- workspace and has never known what anyone has looked at. The list row has
-- drawn an unread dot since it was written (app/components/inbox/InboxRow.tsx)
-- and the All tab hard-codes every email row `unread: false`
-- (app/clozr/screens/Inbox.tsx:175) because there has never been anything to
-- feed it. That is why the inbox reads as a flat list: the strongest signal a
-- mail client has — an unread message looking different from a read one — had
-- no source.
--
-- Read and star belong to one person, not to the workspace. Two reps working
-- the same seller thread each have their own idea of what is still open, so
-- these are not columns on `communications`: the member-write policy there
-- lets any member update any row (which is what makes note pinning work in
-- migration 43), and that is the wrong shape for a private flag. They go in a
-- table keyed by the member.
--
-- None of it reaches Gmail. The connection holds `gmail.readonly` and
-- `gmail.send` and nothing else (supabase/functions/_shared/google.ts) — there
-- is no `gmail.modify` — so CLOZR cannot mark a message read, star it or
-- archive it in the member's real mailbox, and must not pretend otherwise.
-- This is CLOZR's own reading state. `communications.source_id` holds the RFC
-- Message-ID, which is the honest way out: link to the real thread for
-- everything CLOZR cannot do to it.

create table if not exists public.communication_user_state (
  workspace_id     bigint not null references public.workspaces(id) on delete cascade,
  user_id          uuid   not null references auth.users(id) on delete cascade,
  communication_id bigint not null references public.communications(id) on delete cascade,
  read_at          timestamptz,
  starred_at       timestamptz,
  archived_at      timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (user_id, communication_id)
);

-- What the Email tab reads on open: this member's state in this workspace.
create index if not exists cus_ws_user_idx
  on public.communication_user_state (workspace_id, user_id);
-- Starred, newest first, without scanning a member's whole history.
create index if not exists cus_starred_idx
  on public.communication_user_state (workspace_id, user_id, starred_at desc)
  where starred_at is not null;
create index if not exists cus_archived_idx
  on public.communication_user_state (workspace_id, user_id)
  where archived_at is not null;
-- Covers the foreign key, the way migration 26 covers the rest of them.
create index if not exists cus_communication_idx
  on public.communication_user_state (communication_id);

alter table public.communication_user_state enable row level security;
drop policy if exists cus_own on public.communication_user_state;
create policy cus_own on public.communication_user_state for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
grant select, insert, update, delete on public.communication_user_state to authenticated;

drop trigger if exists cus_touch on public.communication_user_state;
create trigger cus_touch before update on public.communication_user_state
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------- the cold start
-- Without a watermark, the first open of a synced mailbox is several hundred
-- bold threads, every one of which the member has already read in their own
-- Gmail. That is not an inbox, it is a wall. The watermark is written the
-- first time the Email tab opens, and anything older than it counts as read
-- whether or not it has a state row — so only mail that arrives after CLOZR
-- started looking can be unread.
create table if not exists public.inbox_user_prefs (
  workspace_id       bigint not null references public.workspaces(id) on delete cascade,
  user_id            uuid   not null references auth.users(id) on delete cascade,
  email_seen_through timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.inbox_user_prefs enable row level security;
drop policy if exists inbox_user_prefs_own on public.inbox_user_prefs;
create policy inbox_user_prefs_own on public.inbox_user_prefs for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
grant select, insert, update, delete on public.inbox_user_prefs to authenticated;

drop trigger if exists inbox_user_prefs_touch on public.inbox_user_prefs;
create trigger inbox_user_prefs_touch before update on public.inbox_user_prefs
  for each row execute function public.touch_updated_at();
