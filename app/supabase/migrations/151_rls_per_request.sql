-- 151: workspace access checked once per request, not once per row.
--
-- communications, sellers, deals and properties checked access with
-- is_workspace_member(workspace_id) (and, for an email, can_read_email) on
-- every row. Both are SECURITY DEFINER SQL functions with their own
-- search_path, so Postgres cannot inline them: a read of the workspace's
-- ~44k communications ran tens of thousands of lookups and hit the statement
-- timeout (500s, screens loading empty, 2026-10-04). The same rules now read
-- the caller's workspaces once (an initplan) and compare each row's
-- workspace_id to that list:
--   my_workspace_ids()             workspaces the caller belongs to
--   my_email_admin_workspace_ids() where they are owner, admin or tc (who
--                                  read every email, as can_read_email says)
-- can_read_email stays for everyone else's emails. Who can see or change
-- what is unchanged. Also adds communications (workspace_id, occurred_at
-- desc) for the "newest first" reads. Safe to run again.

create or replace function public.my_workspace_ids()
returns setof bigint language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
$$;

create or replace function public.my_email_admin_workspace_ids()
returns setof bigint language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid()) and m.role in ('owner', 'admin', 'tc')
$$;

revoke all on function public.my_workspace_ids() from public, anon;
revoke all on function public.my_email_admin_workspace_ids() from public, anon;
grant execute on function public.my_workspace_ids() to authenticated, service_role;
grant execute on function public.my_email_admin_workspace_ids() to authenticated, service_role;

create index if not exists communications_ws_occurred_idx on public.communications (workspace_id, occurred_at desc);

alter policy communications_read on public.communications
  using (workspace_id in (select public.my_workspace_ids())
         and (channel is distinct from 'email'
              or workspace_id in (select public.my_email_admin_workspace_ids())
              or public.can_read_email(workspace_id, id)));
alter policy communications_update on public.communications
  using (workspace_id in (select public.my_workspace_ids())
         and (channel is distinct from 'email'
              or workspace_id in (select public.my_email_admin_workspace_ids())
              or public.can_read_email(workspace_id, id)))
  with check (workspace_id in (select public.my_workspace_ids()));
alter policy communications_delete on public.communications
  using (workspace_id in (select public.my_workspace_ids())
         and (channel is distinct from 'email'
              or workspace_id in (select public.my_email_admin_workspace_ids())
              or public.can_read_email(workspace_id, id)));
alter policy communications_insert on public.communications
  with check (workspace_id in (select public.my_workspace_ids()));

alter policy sellers_select on public.sellers using (workspace_id in (select public.my_workspace_ids()));
alter policy sellers_update on public.sellers using (workspace_id in (select public.my_workspace_ids())) with check (workspace_id in (select public.my_workspace_ids()));
alter policy sellers_delete on public.sellers using (workspace_id in (select public.my_workspace_ids()));
alter policy sellers_insert on public.sellers with check (workspace_id in (select public.my_workspace_ids()));

alter policy deals_write on public.deals using (workspace_id in (select public.my_workspace_ids())) with check (workspace_id in (select public.my_workspace_ids()));

alter policy properties_select on public.properties using (workspace_id in (select public.my_workspace_ids()));
alter policy properties_update on public.properties using (workspace_id in (select public.my_workspace_ids())) with check (workspace_id in (select public.my_workspace_ids()));
alter policy properties_delete on public.properties using (workspace_id in (select public.my_workspace_ids()));
alter policy properties_insert on public.properties with check (workspace_id in (select public.my_workspace_ids()));
