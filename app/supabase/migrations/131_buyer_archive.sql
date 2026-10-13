-- 131 · Buyers can be archived.
--
-- Sellers have archived_at; buyers could only be deleted or set Inactive.
-- Ctrl+A on the Buyers list or an open buyer (lib/people-keys.ts) archives
-- after a Yes/No prompt: the buyer leaves every list and the dispo pickers
-- but nothing is deleted, and clearing the column brings them back. The app
-- reads it on its own (lib/crm.ts), so the Buyers list still loads on a
-- database without it. Writes go through the buyers table's own row security.

alter table public.buyers
  add column if not exists archived_at timestamptz;

create index if not exists buyers_archived_idx
  on public.buyers (workspace_id)
  where archived_at is not null;
