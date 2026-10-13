-- The Inbox's own memory, per person: what they opened, pinned and cleared.
--
-- Talkr owns the SMS threads and calls, so CLOZR could not remember that a
-- rep had read a missed call, wanted a thread on top, or wanted one gone.
-- inbox_item_state keeps that per member, keyed by what the item is about:
--   sms:<E.164>     a text thread, by the other side's number (a new text to
--                   or from that number is the same thread again)
--   call:<talkr id> a call or voicemail
--   email:<thread>  an email thread
-- seen_at   opened at; an item is unread only for activity after it.
-- pinned_at on top of the list until unpinned.
-- cleared_at hidden until something newer happens on it.

create table if not exists public.inbox_item_state (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  item_key     text not null,
  seen_at      timestamptz,
  pinned_at    timestamptz,
  cleared_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id, item_key)
);

alter table public.inbox_item_state enable row level security;

drop policy if exists inbox_item_state_own on public.inbox_item_state;
create policy inbox_item_state_own on public.inbox_item_state for all
  using (user_id = auth.uid() and workspace_id in (select public.my_workspace_ids()))
  with check (user_id = auth.uid() and workspace_id in (select public.my_workspace_ids()));
