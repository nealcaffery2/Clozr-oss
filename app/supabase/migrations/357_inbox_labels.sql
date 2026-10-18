-- 357 · Inbox labels, "mark unread" and saved filters, on the Inbox's own memory.
--
-- The Inbox gained SmarterContact's folder rail, label chips and a Filter
-- threads dialog (app/clozr/screens/Inbox.tsx). Three things it must keep per
-- member that Talkr does not hold, all on inbox_item_state (migration 154):
--   labels     the disposition chips on a thread (Lead, Follow up, Wrong
--              number, …), per rep, per thread key.
--   unread_at  "Mark unread": unread again until the rep opens it (seen_at
--              newer than unread_at).
--   data       a saved filter's name and settings, on rows keyed
--              filter:<id>; those rows carry no seen/pinned/cleared state.
-- Idempotent.

alter table public.inbox_item_state
  add column if not exists labels    text[] not null default '{}',
  add column if not exists unread_at timestamptz,
  add column if not exists data      jsonb;
