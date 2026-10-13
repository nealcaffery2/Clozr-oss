-- 43 — @mentions in notes, and pinned activity.
--
-- Mentions. A note body carries `@[Full Name](user-uuid)` (lib/mentions.ts).
-- When a note is written or edited, each teammate newly mentioned gets one
-- notification: category 'Mention' (the panel's tabs are capitalised),
-- "<author> mentioned you on <record>", the note as plain text, and the record
-- it is on so "Open record" lands there. It runs in the database so every
-- writer — the record composer, Quick Add, call notes, an import — is covered,
-- and so a token naming someone outside the workspace notifies nobody. The
-- author is never notified of their own mention.
--
-- Notifications were workspace-wide; a mention is addressed to one person,
-- so the client now reads rows with no user_id plus its own. `buyer_id` lets a
-- mention on a buyer's note open the buyer.
--
-- Pins. Any timeline entry can be pinned to the top of a record's Activity
-- feed. A timeline entry is a `communications` row or an `activity` row, so
-- both get pinned_at / pinned_by; the existing member-write policies cover
-- the update.

alter table public.communications
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references auth.users(id) on delete set null;

alter table public.activity
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references auth.users(id) on delete set null;

alter table public.notifications
  add column if not exists buyer_id bigint references public.buyers(id) on delete cascade;

create index if not exists notifications_buyer_id_idx on public.notifications (buyer_id);
create index if not exists notifications_user_id_created_idx on public.notifications (user_id, created_at desc);

create or replace function public.notify_note_mentions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_body text;
  author text;
  record_name text;
  excerpt text;
begin
  if new.channel <> 'note' or new.body is null or position('@[' in new.body) = 0 then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    old_body := old.body;
  end if;

  select coalesce(nullif(trim(p.full_name), ''), p.email) into author
    from public.profiles p where p.id = auth.uid();
  if new.seller_id is not null then
    select s.name into record_name from public.sellers s where s.id = new.seller_id;
  elsif new.buyer_id is not null then
    select b.name into record_name from public.buyers b where b.id = new.buyer_id;
  end if;
  excerpt := left(regexp_replace(new.body, '@\[([^]\n]{1,80})\]\(([\w-]{1,64})\)', '@\1', 'g'), 240);

  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, buyer_id)
  select new.workspace_id, m.user_id, 'Mention',
         coalesce(author, 'A teammate') || ' mentioned you on ' || coalesce(record_name, 'a record'),
         excerpt, new.seller_id, new.buyer_id
    from (select distinct lower(t[1]) as uid
            from regexp_matches(new.body, '@\[[^]\n]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g') t) ids
    join public.workspace_members m
      on m.workspace_id = new.workspace_id and m.user_id::text = ids.uid
   where m.user_id is distinct from auth.uid()
     and not exists (
       select 1 from regexp_matches(coalesce(old_body, ''), '@\[[^]\n]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g') o
        where lower(o[1]) = ids.uid);
  return new;
end;
$$;

revoke all on function public.notify_note_mentions() from public, anon, authenticated;

drop trigger if exists communications_note_mentions on public.communications;
create trigger communications_note_mentions
  after insert or update of body on public.communications
  for each row when (new.channel = 'note')
  execute function public.notify_note_mentions();
