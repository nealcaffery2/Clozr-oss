-- Buyers get addresses, so skip trace has somewhere to look them up.
-- mailing_address: where the owner gets mail ("123 Main St, City, ST 12345").
-- property_address: a property they own (Genius / buyr: their last purchase).
-- Before this, Genius and buyr wrote "Mailing: ..." into criteria.notes (the
-- buy box), while skip trace read buyers.notes, so it never found either.
alter table public.buyers
  add column if not exists mailing_address text,
  add column if not exists property_address text;

-- Backfill from the buy box notes Genius / buyr wrote.
update public.buyers b set mailing_address = nullif(trim(trailing '.' from trim(m[1])), '')
from (select id, regexp_match(criteria->>'notes', 'Mailing:\s*([^\n]+?)\.?\s*$') m from public.buyers where criteria->>'notes' ~ 'Mailing:') x
where b.id = x.id and b.mailing_address is null and x.m is not null;

-- "..., last 1813 Mesa Verde Cir, Decatur (2026-09). ..." plus the state of their first market.
update public.buyers b set property_address = x.m[1] || ', ' || trim(x.m[2]) || coalesce(', ' || x.st, '')
from (
  select id,
    regexp_match(criteria->>'notes', ', last ([^,]+), ([^.(]+?)\s*(?:\(|\.)') m,
    nullif(upper(criteria->'location_prefs'->0->>'state'), '') st
  from public.buyers where criteria->>'notes' ~ ', last '
) x
where b.id = x.id and b.property_address is null and x.m is not null;
