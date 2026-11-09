-- A vendor / wholesaler contact's job title: what the company org chart in
-- People (grouped view) ranks people by, under the main point of contact.
alter table public.vendors add column if not exists title text;
