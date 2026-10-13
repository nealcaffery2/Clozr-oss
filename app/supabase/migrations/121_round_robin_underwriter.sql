-- 121 · Round-robin lead assignment, and an underwriter on every lead.
--
-- Round robins (Settings → Round robin)
--   round_robins          one rotation per row: a name, a team (acquisitions or
--                         dispositions) and, for dispositions, the deal type it
--                         deals out (novation by default). Owner/admin edit it,
--                         every member reads it.
--   round_robin_members   who is in a rotation. `active = false` takes a rep out
--                         of the rotation without forgetting them (vacation, a
--                         full pipeline); deleting the row removes them. A rep
--                         who has left the workspace is skipped automatically.
--   round_robin_pick(id)  the next rep: the active member who was dealt a lead
--                         longest ago (never-dealt first, then the order they
--                         were added). The rotation row is locked FOR UPDATE so
--                         two webhooks arriving together cannot get the same rep.
--
-- Acquisitions: inbound leads
--   An ingest key (Zapier / the company website form, Jotform, Deal Machine…)
--   names a rotation in settings.round_robin (set_ingest_setting). The ingest
--   function calls round_robin_assign_lead after a lead lands: an unassigned
--   seller gets the next rep as assigned_to, the open deals of that seller with
--   no owner get the same owner_id, and the rotation's `underwriter` rule can
--   make that rep the underwriter too. A lead that is already assigned (a
--   repeat submission, a step-2 after step-1) keeps its rep and consumes no turn.
--
-- Jotform auto-sync
--   A Jotform key can name a form in settings.sync_form. Every five minutes
--   pg_cron asks the jotform-import function (action 'sync', service role) to
--   pull that form's newest submissions through the same mapper and ledger as
--   the webhook, so a form syncs whether or not its WebHooks integration was
--   ever pasted in, and a webhook that also fires dedupes against it.
--   Needs the vault secrets clozr_project_url and clozr_service_role_key
--   (already used by lead-memory, migration 110).
--
-- Dispositions: novations (or any deal type)
--   When a deal is created with, or changed to, a deal type an active
--   dispositions rotation covers and it has no dispo rep, deals_dispo_round_robin
--   sets dispo_rep_id from that rotation. It is an UPDATE of dispo_rep_id, so
--   the deal-team sync (migration 46) adds the Dispositions party as usual.
--
-- Underwriter
--   sellers.underwriter_id  who underwrites this lead. The Import screen asks for
--   it (same as the assigned rep, a teammate, or nobody), the seller record can
--   change it, and the underwriter is notified when the lead moves into an
--   underwriting stage. Underwriting complete still notifies the assigned rep
--   (migration 91).
--
-- No foreign keys to workspaces / auth.users (see 117): those locks are what
-- the live project cannot take in time. Membership is checked at pick time.

-- ============================================================ tables
create table if not exists public.round_robins (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null,
  name          text not null,
  team          text not null,
  deal_type     text,
  underwriter   text not null default 'none',
  active        boolean not null default true,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint round_robins_team_chk check (team in ('acquisitions', 'dispositions')),
  constraint round_robins_deal_type_chk check (
    deal_type is null or deal_type in ('novation', 'assignment', 'jv', 'double_close', 'any')),
  constraint round_robins_underwriter_chk check (underwriter in ('none', 'same')),
  constraint round_robins_name_chk check (length(trim(name)) between 1 and 80)
);
create index if not exists round_robins_ws_idx on public.round_robins (workspace_id);

create table if not exists public.round_robin_members (
  round_robin_id   bigint not null references public.round_robins(id) on delete cascade,
  user_id          uuid not null,
  workspace_id     bigint not null,
  active           boolean not null default true,
  last_assigned_at timestamptz,
  assigned_count   integer not null default 0,
  added_at         timestamptz not null default now(),
  primary key (round_robin_id, user_id)
);
create index if not exists round_robin_members_ws_idx on public.round_robin_members (workspace_id);

alter table public.round_robins enable row level security;
alter table public.round_robin_members enable row level security;

drop policy if exists round_robins_select on public.round_robins;
create policy round_robins_select on public.round_robins for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists round_robins_write on public.round_robins;
create policy round_robins_write on public.round_robins for all
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists round_robin_members_select on public.round_robin_members;
create policy round_robin_members_select on public.round_robin_members for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists round_robin_members_write on public.round_robin_members;
create policy round_robin_members_write on public.round_robin_members for all
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (
    public.has_role(workspace_id, 'owner', 'admin')
    and exists (select 1 from public.round_robins r where r.id = round_robin_id and r.workspace_id = round_robin_members.workspace_id)
    and exists (select 1 from public.workspace_members m where m.workspace_id = round_robin_members.workspace_id and m.user_id = round_robin_members.user_id)
  );

grant select, insert, update, delete on public.round_robins, public.round_robin_members to authenticated;

-- ============================================================ underwriter
alter table public.sellers add column if not exists underwriter_id uuid;
create index if not exists sellers_underwriter_id_idx on public.sellers (underwriter_id) where underwriter_id is not null;

-- ============================================================ picking
-- 'Novation', 'novation - sub2', 'Double close', 'JV', 'wholesale' → a key, as lib/deal-types.ts reads it.
create or replace function public.deal_type_key(p_raw text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when s = '' then null
    when s in ('jv', 'joint venture') then 'jv'
    when s in ('double close', 'doubleclose', 'double closing') then 'double_close'
    when s like 'novation%' then 'novation'
    when s like 'assignment%' or s in ('wholesale', 'assign') then 'assignment'
    else null
  end
  from (select regexp_replace(regexp_replace(lower(trim(coalesce(p_raw, ''))), '[_-]+', ' ', 'g'), '\s+', ' ', 'g') as s) x
$$;

create or replace function public.round_robin_pick(p_round_robin_id bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rr     public.round_robins;
  v_user uuid;
begin
  select * into rr from public.round_robins where id = p_round_robin_id for update;
  if not found or not rr.active then return null; end if;

  select m.user_id into v_user
    from public.round_robin_members m
    join public.workspace_members wm on wm.workspace_id = m.workspace_id and wm.user_id = m.user_id
   where m.round_robin_id = rr.id and m.active
   order by m.last_assigned_at asc nulls first, m.added_at, m.user_id
   limit 1;
  if v_user is null then return null; end if;

  update public.round_robin_members
     set last_assigned_at = clock_timestamp(), assigned_count = assigned_count + 1
   where round_robin_id = rr.id and user_id = v_user;
  return v_user;
end $$;
revoke all on function public.round_robin_pick(bigint) from public, anon, authenticated;
grant execute on function public.round_robin_pick(bigint) to service_role;

-- What the ingest function calls once a lead has landed. Idempotent: an
-- assigned seller is left alone and consumes no turn.
create or replace function public.round_robin_assign_lead(p_ingest_source_id bigint, p_seller_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  src    public.ingest_sources;
  rr     public.round_robins;
  s      public.sellers;
  v_rr   bigint;
  v_rep  uuid;
begin
  select * into src from public.ingest_sources where id = p_ingest_source_id;
  if not found then return jsonb_build_object('assigned', false, 'reason', 'unknown key'); end if;
  v_rr := nullif(src.settings->>'round_robin', 'off')::bigint;
  if v_rr is null then return jsonb_build_object('assigned', false, 'reason', 'no round robin on this key'); end if;

  select * into rr from public.round_robins where id = v_rr and workspace_id = src.workspace_id;
  if not found or not rr.active then return jsonb_build_object('assigned', false, 'reason', 'round robin is off'); end if;

  select * into s from public.sellers where id = p_seller_id and workspace_id = src.workspace_id for update;
  if not found then return jsonb_build_object('assigned', false, 'reason', 'no such lead'); end if;
  if s.assigned_to is not null then
    return jsonb_build_object('assigned', false, 'reason', 'already assigned', 'user_id', s.assigned_to);
  end if;

  v_rep := public.round_robin_pick(rr.id);
  if v_rep is null then return jsonb_build_object('assigned', false, 'reason', 'nobody active in the round robin'); end if;

  update public.sellers
     set assigned_to = v_rep,
         underwriter_id = case when rr.underwriter = 'same' then coalesce(underwriter_id, v_rep) else underwriter_id end
   where id = s.id;
  update public.deals set owner_id = v_rep
   where workspace_id = src.workspace_id and seller_id = s.id and owner_id is null and archived_at is null;

  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id)
  values (src.workspace_id, v_rep, 'Lead', 'New lead assigned to you',
          coalesce(nullif(trim(s.name), ''), 'A new lead') || ' · ' || rr.name || ' round robin', s.id);

  return jsonb_build_object('assigned', true, 'user_id', v_rep, 'round_robin_id', rr.id);
end $$;
revoke all on function public.round_robin_assign_lead(bigint, bigint) from public, anon, authenticated;
grant execute on function public.round_robin_assign_lead(bigint, bigint) to service_role;

-- ============================================================ dispositions
create or replace function public.deals_dispo_round_robin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := public.deal_type_key(new.transaction_type);
  v_rr  bigint;
  v_rep uuid;
begin
  if new.dispo_rep_id is not null or v_key is null or new.archived_at is not null then return null; end if;
  if tg_op = 'UPDATE' and public.deal_type_key(old.transaction_type) is not distinct from v_key then return null; end if;

  -- The rotation for exactly this type wins over an "any type" one; the oldest breaks a tie.
  select id into v_rr from public.round_robins
   where workspace_id = new.workspace_id and team = 'dispositions' and active
     and coalesce(deal_type, 'novation') in (v_key, 'any')
   order by (coalesce(deal_type, 'novation') = v_key) desc, id
   limit 1;
  if v_rr is null then return null; end if;

  v_rep := public.round_robin_pick(v_rr);
  if v_rep is null then return null; end if;

  -- An UPDATE OF dispo_rep_id, so deals_team_sync adds the Dispositions party.
  update public.deals set dispo_rep_id = v_rep where id = new.id and dispo_rep_id is null;
  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
  values (new.workspace_id, v_rep, 'Dispositions', 'New ' || initcap(replace(v_key, '_', ' ')) || ' deal assigned to you',
          'You are the dispo rep on this deal (round robin).', new.seller_id, new.id);
  return null;
end $$;
revoke all on function public.deals_dispo_round_robin() from public, anon, authenticated;

drop trigger if exists deals_dispo_round_robin on public.deals;
create trigger deals_dispo_round_robin
  after insert or update of transaction_type on public.deals
  for each row execute function public.deals_dispo_round_robin();

-- ============================================================ underwriter notice
create or replace function public.notify_underwriter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.underwriter_id is null then return new; end if;
  -- Into an underwriting stage, or handed to a new underwriter while in one.
  if coalesce(new.lead_stage, '') in ('New Submission', 'Underwriting', 'Underwriting - Need Info')
     and (tg_op = 'INSERT'
          or old.lead_stage is distinct from new.lead_stage
          or old.underwriter_id is distinct from new.underwriter_id)
     and new.underwriter_id is distinct from auth.uid() then
    insert into public.notifications (workspace_id, user_id, category, title, body, seller_id)
    values (new.workspace_id, new.underwriter_id, 'Underwriting', 'Underwrite this lead',
            coalesce(nullif(trim(new.name), ''), 'A lead') || ' is in ' || new.lead_stage || ' and you are the underwriter.',
            new.id);
  end if;
  return new;
end $$;
revoke all on function public.notify_underwriter() from public, anon, authenticated;

drop trigger if exists sellers_notify_underwriter on public.sellers;
create trigger sellers_notify_underwriter
  after insert or update of lead_stage, underwriter_id on public.sellers
  for each row execute function public.notify_underwriter();

-- ============================================================ ingest key setting
create or replace function public.set_ingest_setting(p_id bigint, p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare ws bigint; v_name text;
begin
  select workspace_id, name into ws, v_name from public.ingest_sources where id = p_id;
  if ws is null or not public.has_role(ws, 'owner', 'admin') then
    raise exception 'only an owner or admin can change a key' using errcode = '42501';
  end if;
  if p_key = 'creates' and p_value in ('seller', 'wholesaler', 'buyer') then null;
  elsif p_key = 'auto_compr' and p_value in ('on', 'off') then null;
  elsif p_key = 'jotform_api_key' and v_name = 'jotform' and length(coalesce(p_value, '')) between 16 and 128 then null;
  elsif p_key = 'sync_form' and v_name = 'jotform' and (p_value = 'off' or p_value ~ '^\d{6,24}$') then null;
  elsif p_key = 'round_robin' and (p_value = 'off' or exists (
          select 1 from public.round_robins r
           where r.workspace_id = ws and r.team = 'acquisitions' and r.id::text = p_value)) then null;
  else raise exception 'unsupported setting' using errcode = '22023';
  end if;
  update public.ingest_sources
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = p_id;
end $$;
revoke all on function public.set_ingest_setting(bigint, text, text) from public, anon;
grant execute on function public.set_ingest_setting(bigint, text, text) to authenticated;

-- The view gains the key's rotation, appended so `create or replace` keeps the grants.
create or replace view public.ingest_sources_public with (security_invoker = false) as
  select id, workspace_id, name, label, key_prefix, active, last_used_at, created_at,
         (settings ? 'signing_secret')  as has_signing_secret,
         coalesce(settings->>'creates', 'seller') as creates,
         coalesce(settings->>'auto_compr', 'on') as auto_compr,
         (settings ? 'jotform_api_key') as has_api_key,
         coalesce(settings->>'round_robin', 'off') as round_robin,
         coalesce(settings->>'sync_form', 'off') as sync_form
    from public.ingest_sources
   where public.has_role(workspace_id, 'owner', 'admin');
revoke all on public.ingest_sources_public from anon, authenticated;
grant select on public.ingest_sources_public to authenticated;

-- ============================================================ Jotform auto-sync
create or replace function public.jotform_sync_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.ingest_sources
                  where name = 'jotform' and active and coalesce(settings->>'sync_form', 'off') <> 'off') then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/jotform-import',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.jotform_sync_kick() from public, anon, authenticated;

select cron.unschedule('clozr-jotform-sync') where exists (select 1 from cron.job where jobname = 'clozr-jotform-sync');
select cron.schedule('clozr-jotform-sync', '1-56/5 * * * *', 'select public.jotform_sync_kick()');
