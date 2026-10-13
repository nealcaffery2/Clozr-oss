-- 23 · security hardening: privilege, policy and RPC review (2026-09)
--
-- Findings this closes, in order of severity:
--
--   1. workspace_members.members_insert_self let ANY signed-in user insert a
--      row for themselves into ANY workspace with ANY role — the policy only
--      checked user_id = auth.uid(). Nothing in the client inserts memberships
--      (handle_new_user runs as a trigger, add-teammate uses the service role),
--      so the policy is simply dropped.
--   2. Supabase's default grants give anon and authenticated TRUNCATE, TRIGGER
--      and REFERENCES on every table. Row-level security does not govern
--      TRUNCATE, so a signed-in user could empty a table. anon loses every
--      table privilege (the app never queries as anon); authenticated keeps
--      SELECT/INSERT/UPDATE/DELETE, all of which RLS does govern.
--   3. The key-handling RPCs (issue_ingest_key, set_ingest_secret,
--      ingest_replay, rotating ensure_calendar_token) checked membership only.
--      They now require owner or admin, matching what Settings shows.
--   4. ingest_sources_write let any member toggle keys and rewrite settings;
--      now owner/admin only.
--   5. Policies declared `to public` are re-declared `to authenticated`, and
--      the auth.uid() calls are wrapped in (select …) so Postgres evaluates
--      them once per query rather than once per row (advisor 0003).
--   6. Where a table's `_write` ALL policy already covers SELECT with the same
--      predicate, the separate `_select` policy is dropped (advisor 0006).

-- ── 1. the open membership door ─────────────────────────────────────────────
drop policy if exists members_insert_self on public.workspace_members;

-- ── 2. table privileges ─────────────────────────────────────────────────────
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v') loop
    execute format('revoke all on table public.%I from anon', t.relname);
    execute format('revoke truncate, trigger, references on table public.%I from authenticated', t.relname);
  end loop;
end $$;
-- Sequences: signed-in inserts still need nextval(); anon needs nothing.
do $$
declare s record;
begin
  for s in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'S' loop
    execute format('revoke all on sequence public.%I from anon', s.relname);
  end loop;
end $$;
-- New tables must not silently regain the anon grants.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke truncate, trigger, references on tables from authenticated;

-- ── 3. key RPCs need owner or admin ─────────────────────────────────────────
create or replace function public.issue_ingest_key(p_workspace_id bigint, p_name text, p_label text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_key text;
  v_id  bigint;
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can issue keys' using errcode = '42501';
  end if;
  if p_name !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'name must be lower_snake_case' using errcode = '22023';
  end if;
  v_key := 'clz_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.ingest_sources (workspace_id, name, label, key_hash, key_prefix)
  values (p_workspace_id, p_name, p_label,
          encode(extensions.digest(v_key, 'sha256'), 'hex'), left(v_key, 12))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'name', p_name, 'key', v_key, 'prefix', left(v_key, 12));
end $$;

create or replace function public.set_ingest_secret(p_id bigint, p_secret text)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare ws bigint;
begin
  select workspace_id into ws from public.ingest_sources where id = p_id;
  if ws is null or not public.has_role(ws, 'owner', 'admin') then
    raise exception 'only an owner or admin can set a signing secret' using errcode = '42501';
  end if;
  if length(p_secret) < 16 or length(p_secret) > 512 then
    raise exception 'secret must be 16 to 512 characters' using errcode = '22023';
  end if;
  update public.ingest_sources
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('signing_secret', p_secret)
   where id = p_id;
end $$;

create or replace function public.ingest_replay(p_workspace_id bigint, p_source text, p_since timestamptz default null)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r record;
  n integer := 0;
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can replay events' using errcode = '42501';
  end if;
  for r in
    select payload from public.ingest_events
     where workspace_id = p_workspace_id and source = p_source
       and (p_since is null or received_at >= p_since)
     order by received_at
  loop
    delete from public.ingest_events
     where workspace_id = p_workspace_id and source = p_source
       and source_id = r.payload->>'source_id';
    perform public.ingest_apply(p_workspace_id, r.payload);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Any member may read the feed URL (it is theirs to subscribe to); only an
-- owner or admin may rotate it, since rotating breaks everyone's calendar.
create or replace function public.ensure_calendar_token(ws bigint, rotate boolean default false)
returns text language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare tok text;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;
  if rotate and not public.has_role(ws, 'owner', 'admin') then
    raise exception 'only an owner or admin can rotate the calendar token' using errcode = '42501';
  end if;
  select calendar_token into tok from public.workspaces where id = ws;
  if tok is null or rotate then
    tok := encode(extensions.gen_random_bytes(24), 'hex');
    update public.workspaces set calendar_token = tok where id = ws;
  end if;
  return tok;
end $$;

-- ── 4. ingest_sources: owner/admin write ────────────────────────────────────
drop policy if exists ingest_sources_write on public.ingest_sources;
drop policy if exists ingest_sources_select on public.ingest_sources;
create policy ingest_sources_admin on public.ingest_sources
  for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

-- ── 5. every remaining `to public` policy becomes `to authenticated` ────────
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and roles = '{public}' loop
    execute format('alter policy %I on public.%I to authenticated', r.policyname, r.tablename);
  end loop;
end $$;

-- auth.uid() once per query, not once per row
drop policy if exists profiles_select_own  on public.profiles;
drop policy if exists profiles_select_team on public.profiles;
drop policy if exists profiles_update_own  on public.profiles;
drop policy if exists profiles_insert_own  on public.profiles;
create policy profiles_select_team on public.profiles for select to authenticated
  using (id = (select auth.uid()) or exists (
    select 1 from public.workspace_members a
    join public.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = (select auth.uid()) and b.user_id = profiles.id));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists workspaces_insert_owner on public.workspaces;
drop policy if exists workspaces_update_owner on public.workspaces;
create policy workspaces_insert_owner on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()));
-- workspaces_admin_update (owner or admin role) already covers the owner.

-- ── 6. redundant SELECT policies ────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['action_plan_steps','action_plans','activity','appointments',
                           'communications','deals','enrollments','notifications','tasks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
  end loop;
end $$;
drop policy if exists invites_select on public.workspace_invites;
