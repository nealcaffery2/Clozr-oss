-- 24 · audit_log: an append-only trail of security-relevant changes
--
-- Modeled on a SOC 2 (CC7.2) audit table. Two write paths:
--   • row triggers on the tables whose changes matter for access — who is in
--     a workspace, invites, API keys/secrets, workspace settings — capture
--     before/after JSON automatically, so no handler has to remember;
--   • public.audit_event() for actions that are not one row change (sign-in
--     with 2FA, an export, a key shown), called from the browser as the user.
-- Nothing can update or delete a row, service role included: the BEFORE
-- triggers raise. Owners and admins of the workspace may read their trail.

create table if not exists public.audit_log (
  id             bigserial primary key,
  occurred_at    timestamptz not null default now(),
  workspace_id   bigint references public.workspaces(id) on delete set null,
  action         text not null,
  principal_kind text not null default 'user',     -- user | service | system
  principal_id   uuid,
  resource_type  text,
  resource_id    text,
  detail         jsonb
);
create index if not exists audit_log_ws_idx     on public.audit_log (workspace_id, occurred_at desc);
create index if not exists audit_log_action_idx on public.audit_log (action, occurred_at desc);

create or replace function public.audit_no_mutate() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op using errcode = '42501';
end $$;
drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update on public.audit_log for each row execute function public.audit_no_mutate();
drop trigger if exists audit_log_no_delete on public.audit_log;
create trigger audit_log_no_delete before delete on public.audit_log for each row execute function public.audit_no_mutate();

alter table public.audit_log enable row level security;
drop policy if exists audit_log_admin_read on public.audit_log;
create policy audit_log_admin_read on public.audit_log for select to authenticated
  using (workspace_id is not null and public.has_role(workspace_id, 'owner', 'admin'));
revoke all on table public.audit_log from anon;
revoke insert, update, delete, truncate, trigger, references on table public.audit_log from authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

-- Secrets never land in the trail: hashes and signing secrets are redacted.
create or replace function public.audit_scrub(j jsonb) returns jsonb
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case when j is null then null else
    (j - 'key_hash' - 'calendar_token')
      || case when j ? 'settings' and (j->'settings') ? 'signing_secret'
              then jsonb_build_object('settings', (j->'settings') || '{"signing_secret":"[redacted]"}'::jsonb)
              else '{}'::jsonb end
  end
$$;

create or replace function public.audit_data_change() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ws  bigint;
  v_id  text;
begin
  v_ws := case when tg_table_name = 'workspaces'
               then coalesce((to_jsonb(new)->>'id')::bigint, (to_jsonb(old)->>'id')::bigint)
               else coalesce((to_jsonb(new)->>'workspace_id')::bigint, (to_jsonb(old)->>'workspace_id')::bigint) end;
  v_id := coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id',
                   to_jsonb(new)->>'user_id', to_jsonb(old)->>'user_id');
  insert into public.audit_log (workspace_id, action, principal_kind, principal_id, resource_type, resource_id, detail)
  values (
    v_ws,
    tg_table_name || '.' || lower(tg_op),
    case when auth.uid() is null then 'service' else 'user' end,
    auth.uid(),
    tg_table_name,
    v_id,
    case
      when tg_op = 'DELETE' then jsonb_build_object('before', public.audit_scrub(to_jsonb(old)))
      when tg_op = 'UPDATE' then jsonb_build_object('before', public.audit_scrub(to_jsonb(old)), 'after', public.audit_scrub(to_jsonb(new)))
      else jsonb_build_object('after', public.audit_scrub(to_jsonb(new)))
    end);
  return coalesce(new, old);
end $$;
revoke execute on function public.audit_data_change() from public, anon, authenticated;
revoke execute on function public.audit_no_mutate() from public, anon, authenticated;
revoke execute on function public.audit_scrub(jsonb) from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['workspace_members', 'workspace_invites', 'ingest_sources', 'workspaces'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_data_change()', t || '_audit', t);
  end loop;
end $$;

-- App-level events. The caller must be a member; the action is a short slug.
create or replace function public.audit_event(p_workspace_id bigint, p_action text, p_detail jsonb default null)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  if auth.uid() is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of that workspace' using errcode = '42501';
  end if;
  if p_action !~ '^[a-z][a-z0-9_.]{1,63}$' then
    raise exception 'action must be a short lower_snake.slug' using errcode = '22023';
  end if;
  insert into public.audit_log (workspace_id, action, principal_kind, principal_id, detail)
  values (p_workspace_id, p_action, 'user', auth.uid(), left(coalesce(p_detail, '{}'::jsonb)::text, 4000)::jsonb);
end $$;
revoke execute on function public.audit_event(bigint, text, jsonb) from public, anon;
grant execute on function public.audit_event(bigint, text, jsonb) to authenticated;
