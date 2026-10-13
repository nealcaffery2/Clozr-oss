-- 47 · A seller's name is a person or company, never the property address.
--
-- Imports used to fill a missing name with the address ("Owner of 1420 Palo
-- Verde", or the address itself). A record with no known name now keeps an
-- empty name and the screens say "No name"; the address stays on the property.

create or replace function public.sellers_name_not_address() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare line1 text;
begin
  select p.line1 into line1 from public.properties p where p.id = new.property_id;
  if new.name ~* '^\s*owner of\s'
     or lower(regexp_replace(new.name, '[^a-z0-9]', '', 'gi')) in (
          lower(regexp_replace(coalesce(new.property_address, ''), '[^a-z0-9]', '', 'gi')),
          lower(regexp_replace(coalesce(line1, ''), '[^a-z0-9]', '', 'gi')))
       and new.name ~ '\d'
  then
    new.name := '';
  end if;
  return new;
end $$;

drop trigger if exists sellers_name_not_address on public.sellers;
create trigger sellers_name_not_address before insert or update of name, property_address, property_id on public.sellers
  for each row execute function public.sellers_name_not_address();
revoke all on function public.sellers_name_not_address() from public, anon, authenticated;

-- Existing records named after their address.
update public.sellers set name = name where name ~* '^\s*owner of\s' or (name ~ '^\s*\d' and property_id is not null);
