-- 227 · Indexes for the reads that timed out, built without locking writes.
--
-- Every statement here is CONCURRENTLY, so the runner applies this file
-- outside a transaction, one statement at a time (scripts/migrate.mjs; the
-- Management API path splits it with scripts/sql-split.mjs). Each is
-- `if not exists` / `if exists`, so a run that stopped half way is finished
-- by running it again. A concurrent build that failed leaves an INVALID
-- index behind under the same name, which `if not exists` would then skip:
-- drop that one by hand (drop index concurrently <name>) and run again.
-- Each build reads one table of at most ~180,000 rows: seconds, well under
-- the API's 60 s.
--
-- What each serves, with the read in lib/ that uses it:

-- Trigram search (contact pickers lib/contract-recipients.ts, the deal team,
-- Archive). `name ilike '%x%' or company ilike …` cannot use a btree: every
-- search read all ~143,000 buyers or ~128,000 vendors. With a trigram index on
-- each column the OR becomes a BitmapOr of index scans.
create extension if not exists pg_trgm with schema extensions;

create index concurrently if not exists buyers_name_trgm_idx on public.buyers using gin (name extensions.gin_trgm_ops);
create index concurrently if not exists buyers_company_trgm_idx on public.buyers using gin (company extensions.gin_trgm_ops);
create index concurrently if not exists buyers_email_trgm_idx on public.buyers using gin (email extensions.gin_trgm_ops);
create index concurrently if not exists buyers_phone_trgm_idx on public.buyers using gin (phone extensions.gin_trgm_ops);
create index concurrently if not exists vendors_business_name_trgm_idx on public.vendors using gin (business_name extensions.gin_trgm_ops);
create index concurrently if not exists vendors_contact_name_trgm_idx on public.vendors using gin (contact_name extensions.gin_trgm_ops);
create index concurrently if not exists vendors_email_trgm_idx on public.vendors using gin (email extensions.gin_trgm_ops);
create index concurrently if not exists vendors_phone_trgm_idx on public.vendors using gin (phone extensions.gin_trgm_ops);

-- One cover photo per deal (226 deal_cover_photos): the order it picks in,
-- so each deal is one index row. A deal's gallery (loadDealGallery) reads the
-- same rows by deal_id.
create index concurrently if not exists deal_files_cover_idx on public.deal_files
  (deal_id, is_cover desc nulls last, (source = 'compr') desc nulls last, created_at, id)
  where kind = 'photo' and url is not null;

-- Photo links (Podio Photos, a Drive folder) on enrichWorkspace: the read
-- walked all ~143,000 deal_files rows by sequential scan, 5,000+ times a day.
create index concurrently if not exists deal_files_ws_links_idx on public.deal_files (workspace_id, id)
  where kind = 'link' and url is not null;

-- Pinned messages and activity (newest 200 of each on the workspace load):
-- unbounded and unindexed, the two reads scanned every row (25 timeouts).
create index concurrently if not exists communications_ws_pinned_idx on public.communications (workspace_id, pinned_at desc)
  where pinned_at is not null;
create index concurrently if not exists activity_ws_pinned_idx on public.activity (workspace_id, pinned_at desc)
  where pinned_at is not null;

-- A number's texts outside Talkr (loadPhoneTexts): inbound by from_phone,
-- outbound by to_phone, newest first.
create index concurrently if not exists communications_sms_from_idx on public.communications (workspace_id, from_phone, occurred_at desc)
  where channel = 'sms';
create index concurrently if not exists communications_sms_to_idx on public.communications (workspace_id, to_phone, occurred_at desc)
  where channel = 'sms';

-- Podio's Submissions items, keyset-paged by item_id (14 timeouts, 2,000+
-- sequential scans a day): the app filter came after the key.
create index concurrently if not exists podio_items_ws_app_item_idx on public.podio_items (workspace_id, app_key, item_id);

-- Submission stage moves a person made, keyset-paged by (changed_at, id).
create index concurrently if not exists stage_events_person_moves_idx on public.stage_events (workspace_id, entity_type, field, changed_at, id)
  where changed_by is not null;

-- Four exact duplicates (same columns, same predicate): every write paid for
-- each twice. The older of each pair stays. None backs a constraint.
drop index concurrently if exists public.appointments_ws_starts_idx;   -- = appointments_workspace_start_idx
drop index concurrently if exists public.transactions_deal_idx;        -- = transactions_deal_id_idx
drop index concurrently if exists public.buyer_contacts_ws_email_idx;  -- = idx_buyer_contacts_email
drop index concurrently if exists public.deals_podio_item_id_idx;      -- = idx_deals_podio_item
