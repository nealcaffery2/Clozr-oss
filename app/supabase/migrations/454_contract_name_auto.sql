-- A contract name CLOZR made (true) or one a person typed (false). Only an
-- auto name is renamed when an amendment is signed ("2016 Meadow Lane closing
-- date change to 11/30", lib/contract-name.ts); a rename from the app sets it
-- false so a TC's name is never overwritten. Existing rows stay false.
alter table public.contracts add column if not exists name_auto boolean not null default false;
