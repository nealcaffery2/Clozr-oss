-- 79: a call queue each rep fills themselves.
--
-- The dialer's "Queue" tab used to be computed on every render: the first five
-- sellers with an open task. Nobody could put a buyer on it, choose who was on
-- it, or empty it. Now the Sellers and Buyers bulk bars have "Add to call
-- queue", and the queue's header has an X that empties it.
--
-- Two rules, both held here rather than in the browser:
--   one queue per rep     rows are keyed by user_id, and a rep reads and writes
--                         only their own; there is no second queue to open.
--   one row per person    a seller or buyer already on your queue is skipped
--                         when added again (the unique indexes below; the app
--                         inserts with ignoreDuplicates).
--
-- Exactly one of seller_id / buyer_id is set. Deleting the record deletes its
-- queue row. `position` is the order they were added; the app calls from the top.

create table if not exists public.call_queue_items (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id      uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  seller_id    bigint references public.sellers(id) on delete cascade,
  buyer_id     bigint references public.buyers(id) on delete cascade,
  position     bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint,
  created_at   timestamptz not null default now(),
  constraint call_queue_items_one_record check ((seller_id is null) <> (buyer_id is null)),
  -- Plain (not partial) so PostgREST's on_conflict can name them; NULLs are
  -- distinct, so a buyer row's null seller_id never collides with another's.
  constraint call_queue_items_seller_uniq unique (user_id, seller_id),
  constraint call_queue_items_buyer_uniq unique (user_id, buyer_id)
);
create index if not exists call_queue_items_mine
  on public.call_queue_items (user_id, workspace_id, position);

alter table public.call_queue_items enable row level security;

drop policy if exists call_queue_items_read on public.call_queue_items;
create policy call_queue_items_read on public.call_queue_items for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists call_queue_items_insert on public.call_queue_items;
create policy call_queue_items_insert on public.call_queue_items for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists call_queue_items_delete on public.call_queue_items;
create policy call_queue_items_delete on public.call_queue_items for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

grant select, insert, delete on public.call_queue_items to authenticated;
