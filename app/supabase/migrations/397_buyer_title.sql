-- A buyer contact's job title (Director of Acquisitions, Acquisitions): what the
-- company org chart on the buyer record ranks people by.
alter table public.buyers add column if not exists title text;
