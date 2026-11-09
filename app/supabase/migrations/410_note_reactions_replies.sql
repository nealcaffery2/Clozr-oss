-- 410: emoji reactions and threaded replies on notes (2026-10-23, Sam:
-- "need ability to put emojis and reactions on notes and also reply to notes").
--
-- A note is a communications row with channel 'note'. note_reactions holds one
-- row per (note, user, emoji): toggling an emoji inserts or deletes that row.
-- note_replies holds replies in time order under the note. Both carry the
-- note's workspace_id and are read by the workspace like communications are;
-- a user writes and deletes only their own rows, and only on a note in a
-- workspace they belong to. Deleting the note deletes both.

create table if not exists public.note_reactions (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  communication_id bigint not null references public.communications(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  unique (communication_id, user_id, emoji)
);

create table if not exists public.note_replies (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  communication_id bigint not null references public.communications(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists note_replies_comm_idx on public.note_replies (communication_id, created_at);

alter table public.note_reactions enable row level security;
alter table public.note_replies enable row level security;

-- Same shape on both tables: read in my workspaces; write as myself on a note
-- (channel 'note') whose workspace matches the row's; delete my own.
do $$
declare t text;
begin
  foreach t in array array['note_reactions', 'note_replies'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated
      using (workspace_id in (select public.my_workspace_ids()))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (user_id = (select auth.uid())
        and workspace_id in (select public.my_workspace_ids())
        and exists (select 1 from public.communications c
          where c.id = communication_id and c.workspace_id = %1$s.workspace_id and c.channel = ''note''))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated
      using (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()))', t);
    execute format('revoke all on public.%1$s from anon', t);
    execute format('grant select, insert, delete on public.%1$s to authenticated', t);
  end loop;
end $$;
