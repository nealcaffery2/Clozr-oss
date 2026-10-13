-- 228 · Contact opt-outs and buyer opt-in fields.
--
-- In the hosted product this migration also added a demo-setter agent for
-- the private underwriting provider's own sales (its settings table and seed
-- row, and an agent state column). That part was removed in the open-source
-- release: private underwriting provider integration. What stays is generic:
--
-- 2. contact_opt_outs: one row per phone or email that said stop, per
--    workspace. Forever and on every channel: inserting one tags every
--    seller and buyer with that phone or email DNC, marks the buyer phone
--    DNC and adds the email to email_suppressions; a seller or buyer created
--    or edited later with that phone or email gets the DNC tag back. Members
--    read; the functions write. Deleting the row is the only way back.
-- 3. buyers.opted_in_at / opt_in_source: the person asked to hear from us
--    (a sign-up, a form, an ad). Calls, ringless voicemail and texts from an
--    AI agent need this or a reply on file.

-- 2 ────────────────────────────────────────────────────────────────────────────
create table if not exists public.contact_opt_outs (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  -- The same form as sellers.phone_key / buyers.phone_key: normalize_phone(), +1XXXXXXXXXX.
  phone_key    text check (phone_key is null or phone_key ~ '^\+[0-9]{8,15}$'),
  email        text check (email is null or (email = lower(email) and email like '%@%')),
  channel      text,
  said         text,
  record_kind  text check (record_kind is null or record_kind in ('seller', 'buyer')),
  record_id    bigint,
  created_at   timestamptz not null default now(),
  check (phone_key is not null or email is not null)
);
create unique index if not exists contact_opt_outs_phone on public.contact_opt_outs (workspace_id, phone_key) where phone_key is not null;
create unique index if not exists contact_opt_outs_email on public.contact_opt_outs (workspace_id, email) where email is not null;

alter table public.contact_opt_outs enable row level security;
drop policy if exists contact_opt_outs_read on public.contact_opt_outs;
create policy contact_opt_outs_read on public.contact_opt_outs for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));

-- Tags with DNC added, unless one already says do not contact (lib/rvm.ts isDncTag).
create or replace function public.tags_with_dnc(p_tags text[])
 returns text[]
 language sql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
  select case
    when exists (select 1 from unnest(coalesce(p_tags, '{}')) t where btrim(t) ~* '^(dnc|dnd|do[[:space:]_-]?not[[:space:]_-]?(call|contact|disturb))$')
      then coalesce(p_tags, '{}')
    else coalesce(p_tags, '{}') || 'DNC'::text
  end
$function$;

-- Whatever form the phone arrives in, it is stored the way the people tables key it.
create or replace function public.contact_opt_out_normalize()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  new.phone_key := public.normalize_phone(new.phone_key);
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  return new;
end $function$;

drop trigger if exists contact_opt_out_normalize on public.contact_opt_outs;
create trigger contact_opt_out_normalize
  before insert or update on public.contact_opt_outs
  for each row execute function public.contact_opt_out_normalize();

create or replace function public.contact_opt_out_apply()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.phone_key is not null then
    update public.sellers set tags = public.tags_with_dnc(tags)
     where workspace_id = new.workspace_id and phone_key = new.phone_key and tags is distinct from public.tags_with_dnc(tags);
    update public.buyers set tags = public.tags_with_dnc(tags)
     where workspace_id = new.workspace_id and phone_key = new.phone_key and tags is distinct from public.tags_with_dnc(tags);
    update public.buyer_phones set is_dnc = true
     where workspace_id = new.workspace_id and phone_key = new.phone_key and not is_dnc;
  end if;
  if new.email is not null then
    update public.sellers set tags = public.tags_with_dnc(tags)
     where workspace_id = new.workspace_id and lower(email) = new.email and tags is distinct from public.tags_with_dnc(tags);
    update public.buyers set tags = public.tags_with_dnc(tags)
     where workspace_id = new.workspace_id and lower(email) = new.email and tags is distinct from public.tags_with_dnc(tags);
    insert into public.email_suppressions (workspace_id, email, reason, note)
    values (new.workspace_id, new.email, 'unsubscribe', left('Asked to stop: ' || coalesce(new.said, ''), 500))
    on conflict (workspace_id, email) do nothing;
  end if;
  return new;
end $function$;

drop trigger if exists contact_opt_out_apply on public.contact_opt_outs;
create trigger contact_opt_out_apply
  after insert on public.contact_opt_outs
  for each row execute function public.contact_opt_out_apply();

-- A seller or buyer added or edited later with an opted-out phone or email is DNC again.
-- phone_key is a generated column, not yet filled in a BEFORE trigger, so the phone is normalized here.
create or replace function public.contact_opt_out_sticks()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if exists (select 1 from public.contact_opt_outs o
              where o.workspace_id = new.workspace_id
                and ((new.phone is not null and o.phone_key = public.normalize_phone(new.phone))
                  or (new.email is not null and o.email = lower(btrim(new.email))))) then
    new.tags := public.tags_with_dnc(new.tags);
  end if;
  return new;
end $function$;

drop trigger if exists contact_opt_out_sticks on public.sellers;
create trigger contact_opt_out_sticks
  before insert or update of phone, email, tags on public.sellers
  for each row execute function public.contact_opt_out_sticks();

drop trigger if exists contact_opt_out_sticks on public.buyers;
create trigger contact_opt_out_sticks
  before insert or update of phone, email, tags on public.buyers
  for each row execute function public.contact_opt_out_sticks();

-- 3 ────────────────────────────────────────────────────────────────────────────
alter table public.buyers add column if not exists opted_in_at timestamptz;
alter table public.buyers add column if not exists opt_in_source text;
