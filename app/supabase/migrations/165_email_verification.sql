-- 165 · Email verification on the addresses CLOZR already stores.
--
-- There is no contacts table. An address lives on buyers.email, buyer_emails.email
-- (migration 162, one row per extra address), buyer_contacts.email, or
-- sellers.email. sellers.other_emails is the rest of a seller's addresses; those
-- are verified when that seller is verified, and the result is written onto
-- every row whose own email column is that address.
--
-- email_safe_to_send null means not verified yet. A send still goes out until
-- something writes false. workspaces.settings.require_verified_email (absent or
-- false by default) is read by the send guard: when true, bulk mail also
-- refuses an address that is still null. This file does not set that key.

alter table public.buyers
  add column if not exists email_status text,
  add column if not exists email_safe_to_send boolean,
  add column if not exists email_verified_at timestamptz,
  add column if not exists email_verify_provider text;

alter table public.buyer_emails
  add column if not exists email_status text,
  add column if not exists email_safe_to_send boolean,
  add column if not exists email_verified_at timestamptz,
  add column if not exists email_verify_provider text;

alter table public.buyer_contacts
  add column if not exists email_status text,
  add column if not exists email_safe_to_send boolean,
  add column if not exists email_verified_at timestamptz,
  add column if not exists email_verify_provider text;

alter table public.sellers
  add column if not exists email_status text,
  add column if not exists email_safe_to_send boolean,
  add column if not exists email_verified_at timestamptz,
  add column if not exists email_verify_provider text;

-- buyers_email_idx and sellers_email_idx already exist (migration 41).
-- buyer_emails is looked up by email_key (migration 162), which is not
-- lower(email), so the send guard's address match gets its own index.
create index if not exists buyers_email_idx on public.buyers (workspace_id, lower(email)) where email is not null;
create index if not exists sellers_email_idx on public.sellers (workspace_id, lower(email)) where email is not null;
create index if not exists buyer_emails_ws_email_idx on public.buyer_emails (workspace_id, lower(email)) where email is not null;
create index if not exists buyer_contacts_ws_email_idx on public.buyer_contacts (workspace_id, lower(email)) where email is not null;
