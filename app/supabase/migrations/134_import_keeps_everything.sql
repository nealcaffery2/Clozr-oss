-- 134 · An import keeps every column of the file.
--
-- A PropStream export (and a partner's submission sheet) came in with the
-- owner's mailing address, a second owner, phones 3 to 5 with their type and
-- DNC / litigator flags, emails 2 to 4, the property type, lot, assessed and
-- estimated value, equity, loans, last sale, MLS status, vacant / absentee…
-- and the import kept the name, two phones, one email, the address and a few
-- house facts. Everything else was parsed and dropped.
--
-- Now:
--   sellers.mailing_line1 / mailing_city / mailing_state / mailing_zip
--                         the owner's mailing address
--   sellers.do_not_mail   the list's "Do Not Mail" (null: the list did not say)
--   sellers.owner2_name   a second owner of record
--   sellers.other_emails  every email after the first, in file order
--   sellers.import_extra  every column the import had no field for, by its
--                         header ({"Mailing County": "Bexar", …}), so nothing
--                         in a file is dropped unless a person says so
--   properties.facts      what a list says about the house that has no column
--                         of its own: est_value, assessed_value, est_equity,
--                         ltv, open_loans, loan_balance, lien_amount,
--                         monthly_rent, last_sale_date, last_sale_price,
--                         mls_status, mls_date, mls_amount, vacant, absentee,
--                         owner_occupied (lib/import-extras.ts FACTS)
--
-- Property type, county, lot size, APN, beds, baths, sqft and year already had
-- columns on properties and now get filled from an import. Phones after the
-- first go to seller_phones (migration 129) with their type and DNC flag.
--
-- All nullable, nothing backfilled: rows imported before this never kept the
-- raw file, so the way to fill them is to import the same file again with
-- "Add new info". The app reads these for one open record only
-- (loadImportInfo), never with the workspace, and an import against a
-- database without them puts the same values in the seller's notes — so
-- nothing breaks in the window before this is applied.
--
-- Row security is unchanged: these are columns on sellers and properties,
-- under those tables' own policies. Idempotent.

alter table public.sellers
  add column if not exists mailing_line1 text,
  add column if not exists mailing_city  text,
  add column if not exists mailing_state text,
  add column if not exists mailing_zip   text,
  add column if not exists do_not_mail   boolean,
  add column if not exists owner2_name   text,
  add column if not exists other_emails  text[] not null default '{}',
  add column if not exists import_extra  jsonb not null default '{}'::jsonb;

alter table public.properties
  add column if not exists facts jsonb not null default '{}'::jsonb;

comment on column public.sellers.import_extra is
  'Columns an import had no field for, by their header. Written by lib/import.ts (migration 134).';
comment on column public.properties.facts is
  'What a list says about the house with no column of its own (est_value, est_equity, ltv, last_sale_*, mls_*, vacant…). lib/import-extras.ts FACTS (migration 134).';
