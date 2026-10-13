-- 201: which house facts the provider filled, so the next run sends the seller's own.
--
-- compr-underwrite sends the record's beds, baths, sqft, year built and lot
-- to the provider, which locks a value it is sent. After a run it writes the provider's
-- facts back onto the property, blanks only. Without a mark, the run after
-- that sent the provider's own old answer back as if the seller had said it, and
-- the provider locked it. compr_filled names the fields the provider wrote; compr-underwrite
-- leaves those off the request so the provider looks them up again.
--
-- A person who edits a marked field makes it theirs: the trigger drops the
-- mark whenever the value changes in an update that does not move
-- compr_filled_at. Both provider writers (compr-underwrite's write-back and the
-- app's applyComprReport) stamp compr_filled_at on every write, so a provider
-- re-apply that changes a value it already owns keeps its mark. Comparing
-- compr_filled itself is not enough: re-marking an already-marked field
-- leaves the array unchanged and would read as a person's edit.
--
-- Existing rows start unmarked, so every value already on a property is
-- treated as the submitter's. Nothing records which of those the provider filled
-- before this column existed.

alter table public.properties
  add column if not exists compr_filled text[] not null default '{}',
  add column if not exists compr_filled_at timestamptz;

create or replace function public.properties_compr_filled_clear()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.compr_filled_at is distinct from old.compr_filled_at then
    return new;
  end if;
  if new.beds is distinct from old.beds then
    new.compr_filled := array_remove(new.compr_filled, 'beds');
  end if;
  if new.baths is distinct from old.baths then
    new.compr_filled := array_remove(new.compr_filled, 'baths');
  end if;
  if new.sqft is distinct from old.sqft then
    new.compr_filled := array_remove(new.compr_filled, 'sqft');
  end if;
  if new.year_built is distinct from old.year_built then
    new.compr_filled := array_remove(new.compr_filled, 'year_built');
  end if;
  if new.lot_sqft is distinct from old.lot_sqft then
    new.compr_filled := array_remove(new.compr_filled, 'lot_sqft');
  end if;
  return new;
end;
$$;

drop trigger if exists properties_compr_filled_clear on public.properties;
create trigger properties_compr_filled_clear
  before update on public.properties
  for each row
  when (cardinality(old.compr_filled) > 0)
  execute function public.properties_compr_filled_clear();

comment on column public.properties.compr_filled is
  'House facts (beds, baths, sqft, year_built, lot_sqft) the provider wrote onto this property. compr-underwrite leaves these off its request so the provider looks them up again; a person editing one drops it from the list.';
