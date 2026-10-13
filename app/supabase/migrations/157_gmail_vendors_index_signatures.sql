-- 157: the Gmail sync's vendor read indexed, and Gmail signatures kept.
--
-- google.ts loadBook reads every vendor with an email on each sync. With the
-- DispoGenius corpus (~128k vendors) and no index on the address, that was a
-- sequential scan that ran past the API's 8s statement timeout whenever the
-- database was busy, failing the whole Gmail pass: no new mail, no files.
-- Same shape as sellers_email_idx and buyers_email_idx.
create index if not exists vendors_email_idx on public.vendors (workspace_id, lower(email)) where email is not null;

-- Each connection's Gmail signature (users.settings.sendAs), read by every
-- sync and added under mail sent from CLOZR, so it signs off the way the
-- user's Gmail does.
alter table public.google_accounts add column if not exists gmail_signature text;
alter table public.google_accounts add column if not exists gmail_signature_at timestamptz;
