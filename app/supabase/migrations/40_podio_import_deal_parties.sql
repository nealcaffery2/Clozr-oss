-- 40 · Podio import: everyone on a deal, and the connection that reads Podio.
--
--   deal_parties        one row per person or company on a deal, by role. The
--                       deal's single columns (seller_id, buyer_id, owner_id,
--                       dispo_rep_id, tc_rep_id, title_vendor_id) stay filled so
--                       the screens that read them keep working; this table
--                       holds everyone, extras included (photographer,
--                       wholesaler, agents). A party points at a CLOZR row when
--                       there is one (vendor/buyer/seller/teammate) and carries
--                       name/email/phone either way.
--   podio_connections   the Podio API client and app tokens. Same shape as
--                       bank_connections (38): RLS on, no policy, every grant
--                       revoked — only the podio-import function (service role)
--                       reads it, and it never sends a secret back.
--   vendors.source / source_id   so a re-run updates the vendor it created.
--   plan_on_seller_change        a seller imported from Podio is an existing
--                       deal, not a new lead: it is not enrolled in new-lead
--                       plans (which text and email the seller).

-- ------------------------------------------------------------ deal_parties
create table if not exists public.deal_parties (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  deal_id      bigint not null references public.deals(id) on delete cascade,
  role         text   not null check (role in ('seller','buyer','title','photographer','wholesaler','listing_agent',
                                               'buyers_agent','realtor','tc','acquisitions','dispositions','lender','contractor','other')),
  vendor_id    bigint references public.vendors(id) on delete set null,
  buyer_id     bigint references public.buyers(id) on delete set null,
  seller_id    bigint references public.sellers(id) on delete set null,
  user_id      uuid   references auth.users(id) on delete set null,
  name         text,
  company      text,
  email        text,
  phone        text,
  source       text,
  source_id    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- One row per person per role per deal. source_id is the Podio reference
-- ("item:123", "profile:456", "text:name"), so a re-import updates in place.
create unique index if not exists deal_parties_dedupe on public.deal_parties
  (deal_id, role, coalesce(source_id, ''), coalesce(vendor_id, 0), coalesce(buyer_id, 0), coalesce(seller_id, 0), coalesce(user_id::text, ''));
create index if not exists deal_parties_ws_idx on public.deal_parties (workspace_id);
create index if not exists deal_parties_deal_idx on public.deal_parties (deal_id);
create index if not exists deal_parties_vendor_idx on public.deal_parties (vendor_id) where vendor_id is not null;
create index if not exists deal_parties_buyer_idx on public.deal_parties (buyer_id) where buyer_id is not null;
create index if not exists deal_parties_seller_idx on public.deal_parties (seller_id) where seller_id is not null;
create index if not exists deal_parties_user_idx on public.deal_parties (user_id) where user_id is not null;

drop trigger if exists deal_parties_touch on public.deal_parties;
create trigger deal_parties_touch before update on public.deal_parties
  for each row execute function public.touch_updated_at();

alter table public.deal_parties enable row level security;
revoke all on public.deal_parties from anon, authenticated;
grant select, insert, update, delete on public.deal_parties to authenticated;

-- Members read a deal's team; a buyer row is only visible to the roles that
-- can read buyers (migration 17), so acquisitions does not see buyer contacts here either.
drop policy if exists deal_parties_select on public.deal_parties;
create policy deal_parties_select on public.deal_parties for select to authenticated
  using (public.is_workspace_member(workspace_id)
         and (buyer_id is null or public.has_role(workspace_id, 'owner', 'admin', 'dispositions', 'tc', 'member')));
drop policy if exists deal_parties_write on public.deal_parties;
create policy deal_parties_write on public.deal_parties for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'tc', 'dispositions'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'tc', 'dispositions'));

-- -------------------------------------------------------- vendor identity
alter table public.vendors add column if not exists source text;
alter table public.vendors add column if not exists source_id text;
create index if not exists vendors_source_idx on public.vendors (workspace_id, source, source_id) where source_id is not null;

-- ------------------------------------------------------ podio_connections
create table if not exists public.podio_connections (
  workspace_id   bigint primary key references public.workspaces(id) on delete cascade,
  client_id      text,
  client_secret  text,
  -- [{ key: 'deals' | 'contacts' | 'buyers' | 'vendors' | 'team' | 'other', app_id, app_token }]
  apps           jsonb  not null default '[]',
  -- The last mapping and stage options used, so the next run starts from them.
  last_mapping   jsonb  not null default '{}',
  connected_by   uuid   references auth.users(id) on delete set null,
  last_import_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.podio_connections enable row level security;
revoke all on public.podio_connections from anon, authenticated;
drop trigger if exists podio_connections_touch on public.podio_connections;
create trigger podio_connections_touch before update on public.podio_connections
  for each row execute function public.touch_updated_at();

-- ------------------------------------ imported sellers skip new-lead plans
create or replace function public.plan_on_seller_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  e record;
  p record;
begin
  if tg_op = 'INSERT' then
    -- A deal brought over from Podio is already under contract; a new-lead drip would text that seller.
    if new.source is not distinct from 'podio' then return new; end if;
    for p in select id from action_plans where workspace_id = new.workspace_id and active and trigger_type = 'new_lead' loop
      perform plan_enroll(new.workspace_id, p.id, new.id, new.created_by);
    end loop;
    return new;
  end if;

  if new.lead_stage is distinct from old.lead_stage then
    for e in
      select en.id from enrollments en join action_plans pl on pl.id = en.plan_id
      where en.seller_id = new.id and en.status = 'active'
        and coalesce((pl.settings ->> 'stop_on_stage')::boolean, false)
    loop
      perform plan_stop_enrollment(e.id, 'stage');
    end loop;
    for p in
      select id from action_plans
      where workspace_id = new.workspace_id and active and trigger_type = 'stage' and trigger_value = new.lead_stage
    loop
      perform plan_enroll(new.workspace_id, p.id, new.id, null);
    end loop;
  end if;

  if new.tags is distinct from old.tags then
    for p in
      select id from action_plans
      where workspace_id = new.workspace_id and active and trigger_type = 'tag'
        and trigger_value = any(new.tags) and not (trigger_value = any(coalesce(old.tags, '{}')))
    loop
      perform plan_enroll(new.workspace_id, p.id, new.id, null);
    end loop;
  end if;
  return new;
end;
$function$;
