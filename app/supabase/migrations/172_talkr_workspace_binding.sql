-- 172: one Talkr org per Clozr workspace.
--
-- Talkr scopes history, numbers and texts to the org of the user on the
-- partner token, not to a Clozr workspace. A cron that walked every workspace
-- of that owner copied the org into each one. talkr_connections is the
-- binding. A Talkr org may be bound to at most one workspace.
--
-- settings.talkr.enabled = false pauses a workspace, and the old
-- talkr_url https://talkr-disabled.invalid still pauses: such a workspace
-- also gets talkr.enabled = false. The URL is left in place. (The hosted
-- product's own workspace binding is not part of the open-source release.)

create table if not exists public.talkr_connections (
  workspace_id bigint primary key references public.workspaces(id) on delete cascade,
  talkr_org_id text not null check (length(btrim(talkr_org_id)) > 0),
  enabled boolean not null default true,
  connected_by uuid references auth.users(id),
  connected_at timestamptz not null default now(),
  unique (talkr_org_id)
);

alter table public.talkr_connections enable row level security;

drop policy if exists talkr_connections_select on public.talkr_connections;
create policy talkr_connections_select on public.talkr_connections
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists talkr_connections_insert on public.talkr_connections;
create policy talkr_connections_insert on public.talkr_connections
  for insert to authenticated
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists talkr_connections_update on public.talkr_connections;
create policy talkr_connections_update on public.talkr_connections
  for update to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

drop policy if exists talkr_connections_delete on public.talkr_connections;
create policy talkr_connections_delete on public.talkr_connections
  for delete to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));

revoke all on public.talkr_connections from public, anon, authenticated;
grant select, insert, update, delete on public.talkr_connections to authenticated;

-- Pause flag for any workspace already pointed at the disabled origin.
-- Does not insert a talkr_connections row.
update public.workspaces
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{talkr}',
  coalesce(settings->'talkr', '{}'::jsonb) || jsonb_build_object('enabled', false),
  true)
where coalesce(settings->>'talkr_url', '') = 'https://talkr-disabled.invalid';
