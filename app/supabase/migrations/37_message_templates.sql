-- 37 — Message templates CLOZR owns, and email that reads like a thread.
--
-- Templates. Talkr's SMS templates live on Talkr's server and know nothing
-- about email, audiences or a teammate's private drafts. This table is the
-- CLOZR-owned library the inbox composers pick from:
--
--   channel      sms | email
--   audience     seller | buyer | tc | general — the filter a rep reaches for
--   owner_id     who wrote it; `shared` puts it in front of the whole team
--   subject      email only
--   body_text    the SMS body, or the email's plain-text part
--   body_html    the email's generated, inline-styled table HTML
--   blocks       the block editor's source (heading, paragraph, button, …) —
--                body_html is generated from it, so it is what gets edited
--   merge_fields the {{fields}} the template uses, for the picker's chips
--   archived_at  retired, not deleted, so a sent message can still name it
--
-- Who can do what: every member reads the shared ones and their own; the
-- author edits their own (including sharing it); an owner or admin edits
-- anything shared.
--
-- Email on the record. The Gmail pull used to write a subject and a snippet
-- into `activity`, sellers only in practice and with nothing to reply to. It
-- now writes `communications` rows (channel 'email', source 'gmail', source_id
-- the RFC Message-ID, which is the same in every teammate's mailbox and is
-- what a reply threads on), so it needs somewhere to put who it was between:
--
--   buyer_id     a buyer's mail lands on the buyer, the way seller_id does
--   from_email / to_email
--                the counterpart, for the inbox's Email tab and for re-linking
--                a message when the address is added to a record later

create table if not exists public.message_templates (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shared        boolean not null default false,
  name          text not null check (length(trim(name)) between 1 and 120),
  channel       text not null check (channel in ('sms', 'email')),
  audience      text not null default 'general' check (audience in ('seller', 'buyer', 'tc', 'general')),
  category      text,
  subject       text,
  body_text     text not null default '',
  body_html     text,
  blocks        jsonb,
  merge_fields  text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create index if not exists message_templates_ws_idx on public.message_templates (workspace_id, channel) where archived_at is null;
create index if not exists message_templates_owner_idx on public.message_templates (owner_id);

alter table public.message_templates enable row level security;

drop policy if exists message_templates_select on public.message_templates;
create policy message_templates_select on public.message_templates for select to authenticated
  using (public.is_workspace_member(workspace_id) and (shared or owner_id = (select auth.uid())));

drop policy if exists message_templates_insert on public.message_templates;
create policy message_templates_insert on public.message_templates for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and owner_id = (select auth.uid()));

drop policy if exists message_templates_update on public.message_templates;
create policy message_templates_update on public.message_templates for update to authenticated
  using (public.is_workspace_member(workspace_id)
         and (owner_id = (select auth.uid()) or (shared and public.has_role(workspace_id, 'owner', 'admin'))))
  with check (public.is_workspace_member(workspace_id)
         and (owner_id = (select auth.uid()) or (shared and public.has_role(workspace_id, 'owner', 'admin'))));

drop policy if exists message_templates_delete on public.message_templates;
create policy message_templates_delete on public.message_templates for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (owner_id = (select auth.uid()) or (shared and public.has_role(workspace_id, 'owner', 'admin'))));

grant select, insert, update, delete on public.message_templates to authenticated;

drop trigger if exists message_templates_touch on public.message_templates;
create trigger message_templates_touch before update on public.message_templates
  for each row execute function public.touch_updated_at();

-- ---- email on communications -------------------------------------------------
alter table public.communications
  add column if not exists buyer_id   bigint references public.buyers(id) on delete set null,
  add column if not exists from_email text,
  add column if not exists to_email   text;

create index if not exists communications_buyer_idx on public.communications (buyer_id);
create index if not exists communications_email_idx on public.communications (workspace_id, occurred_at desc) where channel = 'email';
