-- Lane chats: more than one conversation with Lane, kept, and each one filed
-- under the property it is about.
--
-- Lane used to keep one thread in memory, tied to whichever record happened
-- to be on screen when the drawer opened (or, from the nav, the first
-- transaction in the workspace). Ask about another address and Lane answered
-- from the wrong file; reload and the thread was gone.
--
-- lane_chats: one conversation. It belongs to whoever started it. seller_id /
--   deal_id / address are the property it is about: empty until Lane finds
--   the record (it searches sellers, deals, TC files, buyers and vendors on
--   its own), then set, and the chat is titled with the address. A question
--   about a different property files that exchange in that property's chat.
-- lane_messages: the turns. role is 'tc' (the person asking) or 'lane'; refs,
--   drafts, actions and cards are what the drawer renders under an answer.
--
-- The lane edge function reads and writes both as the caller, so RLS here is
-- the only rule: your own chats, in a workspace you belong to.

create table if not exists public.lane_chats (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id      uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  title        text   not null default 'New chat',
  seller_id    bigint references public.sellers(id) on delete set null,
  deal_id      bigint references public.deals(id) on delete set null,
  address      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);

create index if not exists lane_chats_mine_idx on public.lane_chats (workspace_id, user_id, updated_at desc);
create index if not exists lane_chats_seller_idx on public.lane_chats (seller_id) where seller_id is not null;
create index if not exists lane_chats_deal_idx on public.lane_chats (deal_id) where deal_id is not null;

create table if not exists public.lane_messages (
  id           bigint generated always as identity primary key,
  chat_id      bigint not null references public.lane_chats(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  role         text   not null check (role in ('tc', 'lane')),
  body         text   not null,
  refs         jsonb  not null default '[]'::jsonb,
  drafts       jsonb  not null default '[]'::jsonb,
  actions      jsonb  not null default '[]'::jsonb,
  cards        jsonb  not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists lane_messages_chat_idx on public.lane_messages (chat_id, id);
create index if not exists lane_messages_ws_idx on public.lane_messages (workspace_id);

alter table public.lane_chats enable row level security;
alter table public.lane_messages enable row level security;

drop policy if exists lane_chats_read on public.lane_chats;
create policy lane_chats_read on public.lane_chats for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists lane_chats_insert on public.lane_chats;
create policy lane_chats_insert on public.lane_chats for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists lane_chats_update on public.lane_chats;
create policy lane_chats_update on public.lane_chats for update to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists lane_chats_delete on public.lane_chats;
create policy lane_chats_delete on public.lane_chats for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- A message is readable and writable when its chat is yours.
drop policy if exists lane_messages_read on public.lane_messages;
create policy lane_messages_read on public.lane_messages for select to authenticated
  using (exists (select 1 from public.lane_chats c
                 where c.id = lane_messages.chat_id and c.user_id = (select auth.uid())
                   and c.workspace_id = lane_messages.workspace_id));

drop policy if exists lane_messages_insert on public.lane_messages;
create policy lane_messages_insert on public.lane_messages for insert to authenticated
  with check (exists (select 1 from public.lane_chats c
                      where c.id = lane_messages.chat_id and c.user_id = (select auth.uid())
                        and c.workspace_id = lane_messages.workspace_id)
              and public.is_workspace_member(workspace_id));

drop policy if exists lane_messages_delete on public.lane_messages;
create policy lane_messages_delete on public.lane_messages for delete to authenticated
  using (exists (select 1 from public.lane_chats c
                 where c.id = lane_messages.chat_id and c.user_id = (select auth.uid())));

grant select, insert, update, delete on public.lane_chats to authenticated;
grant select, insert, delete on public.lane_messages to authenticated;
