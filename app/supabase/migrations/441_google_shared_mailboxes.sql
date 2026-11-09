-- 441 · More than one Google account per member, Gmail without Calendar, and
-- Gmail deal mail into the wholesaler list.
--
-- 1. google_accounts.shared: a mailbox a member links for the workspace
--    (deals@, a second address) that is not their own CLOZR login. user_id is
--    the member who linked it, so the update policy and the disconnect check
--    already treat it as theirs, and its mail is written on the account's
--    workspace like any other. Every lookup of "my connection" now reads
--    shared = false, so a linked mailbox never becomes the address a rep
--    sends from.
--    The old unique (workspace_id, user_id) allowed one row per member; it
--    becomes one OWN row per member plus one row per shared address.
-- 2. google_oauth_states.shared / account_id: which row a consent is for, so
--    the callback writes a linked mailbox as a new row, and "Add Calendar"
--    (incremental auth, include_granted_scopes) lands on the row it was
--    started from.
-- 3. wholesaler_entities.source allows 'gmail': LLC names read off wholesaler
--    blasts and assignment mail (_shared/deal-mail.ts).
-- Safe to re-run.

alter table public.google_accounts add column if not exists shared boolean not null default false;

alter table public.google_accounts drop constraint if exists google_accounts_workspace_id_user_id_key;
create unique index if not exists google_accounts_own_uidx
  on public.google_accounts (workspace_id, user_id) where not shared;
create unique index if not exists google_accounts_shared_uidx
  on public.google_accounts (workspace_id, lower(email)) where shared;

grant select (shared) on public.google_accounts to authenticated;

alter table public.google_oauth_states add column if not exists shared boolean not null default false;
alter table public.google_oauth_states add column if not exists account_id bigint;

alter table public.wholesaler_entities drop constraint if exists wholesaler_entities_source_check;
alter table public.wholesaler_entities add constraint wholesaler_entities_source_check
  check (source in ('drive', 'deed', 'manual', 'genius', 'contract', 'vendor', 'buyer', 'investorlift', 'gmail'));
