-- 368 · The wholesaler master list: every wholesaler we know of in one place,
-- so Genius and the deed searches never start from an empty list.
--
-- 1. Every vendor with service type Wholesaler (the people who submit deals to
--    us) and every buyer typed wholesaler becomes a wholesaler_entities row,
--    and a trigger keeps new and edited vendors in step.
-- 2. An LLC read off a contract whose email, phone or company email domain
--    matches a wholesaler vendor is filed under that vendor: the DBA becomes
--    the family, its LLCs the shells. Free mail domains never match.
-- 3. The national wholesale brands (WHOLESALER_FAMILIES in genius-methods.ts)
--    get a family row in workspace 11, so their LLCs roll up from day one.
-- 4. The Drive contract harvest runs every 20 minutes (it reads a few
--    contracts per run now; see dispo-contracts MAX_READS).
-- Safe to re-run.

alter table public.wholesaler_entities drop constraint if exists wholesaler_entities_source_check;
alter table public.wholesaler_entities add constraint wholesaler_entities_source_check
  check (source in ('drive', 'deed', 'manual', 'genius', 'contract', 'vendor', 'buyer'));

-- genius-core.ts ownerKey(name, true): the same key the edge functions write.
create or replace function public.wholesaler_name_key(p_name text) returns text
language sql immutable set search_path = pg_catalog as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(replace(lower(coalesce(p_name, '')), '&', ' and '), '[^a-z0-9 ]+', ' ', 'g'),
      '\m(the|llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc)\M', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;

create or replace function public.wholesaler_phone_key(p_phone text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when length(d) >= 10 then right(d, 10) end from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') d) x
$$;

-- A company mail domain (not gmail and friends), for matching an LLC's signer to a submitter.
create or replace function public.wholesaler_mail_domain(p_email text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when d is null or d in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'me.com', 'comcast.net', 'att.net', 'protonmail.com', 'ymail.com') then null else d end
  from (select nullif(lower(split_part(btrim(coalesce(p_email, '')), '@', 2)), '') d) x
$$;

-- 1 · vendors → entities -------------------------------------------------------------
create or replace function public.wholesaler_from_vendor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := public.wholesaler_name_key(new.business_name);
begin
  if new.service_type is distinct from 'Wholesaler' or k = '' then return new; end if;
  insert into public.wholesaler_entities (workspace_id, name, name_key, kind, state, contact_name, email, phone, vendor_id, source)
  values (new.workspace_id, btrim(new.business_name), k, 'wholesaler', nullif(upper(btrim(new.state)), ''), new.contact_name, new.email, new.phone, new.id, 'vendor')
  on conflict (workspace_id, name_key) do update set
    vendor_id = coalesce(wholesaler_entities.vendor_id, excluded.vendor_id),
    kind = case wholesaler_entities.kind when 'unknown' then 'wholesaler' when 'buyer' then 'both' else wholesaler_entities.kind end,
    contact_name = coalesce(wholesaler_entities.contact_name, excluded.contact_name),
    email = coalesce(wholesaler_entities.email, excluded.email),
    phone = coalesce(wholesaler_entities.phone, excluded.phone),
    state = coalesce(wholesaler_entities.state, excluded.state);
  return new;
end $$;
revoke execute on function public.wholesaler_from_vendor() from public, anon, authenticated;

drop trigger if exists vendors_wholesaler_entity on public.vendors;
create trigger vendors_wholesaler_entity after insert or update of business_name, service_type, email, phone on public.vendors
  for each row execute function public.wholesaler_from_vendor();

-- 2 · an LLC that shares a submitter's email, phone or company domain is that submitter's shell ----
create or replace function public.wholesaler_link_vendor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v record; dom text := public.wholesaler_mail_domain(new.email); ph text := public.wholesaler_phone_key(new.phone);
begin
  if new.vendor_id is not null or (new.email is null and ph is null) then return new; end if;
  select x.id into v from public.vendors x
   where x.workspace_id = new.workspace_id and x.service_type = 'Wholesaler'
     and ((new.email is not null and lower(btrim(x.email)) = lower(btrim(new.email)))
       or (ph is not null and public.wholesaler_phone_key(x.phone) = ph)
       or (dom is not null and public.wholesaler_mail_domain(x.email) = dom))
   order by x.id limit 1;
  if v.id is null then return new; end if;
  new.vendor_id := v.id;
  if new.kind = 'unknown' then new.kind := 'wholesaler'; elsif new.kind = 'buyer' then new.kind := 'both'; end if;
  if new.parent_id is null then
    select e.id into new.parent_id from public.wholesaler_entities e
     where e.workspace_id = new.workspace_id and e.vendor_id = v.id and e.id is distinct from new.id and e.source = 'vendor' limit 1;
  end if;
  return new;
end $$;
revoke execute on function public.wholesaler_link_vendor() from public, anon, authenticated;

drop trigger if exists wholesaler_entities_link_vendor on public.wholesaler_entities;
create trigger wholesaler_entities_link_vendor before insert or update of email, phone, vendor_id on public.wholesaler_entities
  for each row execute function public.wholesaler_link_vendor();

-- Backfill: every wholesaler vendor (fires the trigger above), every buyer typed wholesaler, then link the rows already read off contracts.
update public.vendors set business_name = business_name where service_type = 'Wholesaler' and btrim(coalesce(business_name, '')) <> '';

insert into public.wholesaler_entities (workspace_id, name, name_key, kind, state, contact_name, email, phone, buyer_id, source)
select distinct on (b.workspace_id, public.wholesaler_name_key(coalesce(nullif(b.company, ''), b.name)))
       b.workspace_id, btrim(coalesce(nullif(b.company, ''), b.name)), public.wholesaler_name_key(coalesce(nullif(b.company, ''), b.name)),
       'wholesaler', null, b.name, b.email, b.phone, b.id, 'buyer'
  from public.buyers b
 where b.buyer_type = 'wholesaler' and b.archived_at is null and public.wholesaler_name_key(coalesce(nullif(b.company, ''), b.name)) <> ''
 order by b.workspace_id, public.wholesaler_name_key(coalesce(nullif(b.company, ''), b.name)), b.id
on conflict (workspace_id, name_key) do update set buyer_id = coalesce(wholesaler_entities.buyer_id, excluded.buyer_id),
  kind = case wholesaler_entities.kind when 'unknown' then 'wholesaler' when 'buyer' then 'both' else wholesaler_entities.kind end;

update public.wholesaler_entities set email = email where vendor_id is null and (email is not null or phone is not null);

-- 3 · the national brands, in Acme Homes' workspace -----------------------------------------
do $$
begin
  if not exists (select 1 from public.workspaces where id = 11) then return; end if;
  insert into public.wholesaler_entities (workspace_id, name, name_key, kind, source, notes)
  values (11, 'New Western', 'new western', 'wholesaler', 'manual', 'National wholesaler; assigns through many LLCs.'),
         (11, 'HomeVestors', 'homevestors', 'wholesaler', 'manual', 'National franchise (We Buy Ugly Houses); each franchisee trades through its own LLC.'),
         (11, 'Networth Realty', 'networth realty', 'wholesaler', 'manual', 'National wholesaler.'),
         (11, 'Fast Track Realty', 'fast track realty', 'wholesaler', 'manual', 'Wholesaler.')
  on conflict (workspace_id, name_key) do nothing;
end $$;

-- 4 · the contract harvest, every 20 minutes ----------------------------------------------
select cron.unschedule('clozr-dispo-contracts') where exists (select 1 from cron.job where jobname = 'clozr-dispo-contracts');
select cron.schedule('clozr-dispo-contracts', '*/20 * * * *', 'select public.dispo_contracts_kick()');
