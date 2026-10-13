-- 95 · Vendors reads were calling is_workspace_member once per row.
--
-- vendors_select was `is_workspace_member(workspace_id)`. That function is
-- STABLE SECURITY DEFINER, so it is not inlined, and it queries
-- workspace_members. Workspace 11 holds ~128k dispogenius-free-agents
-- vendors. The shell pages them 1,000 at a time, ordered by business_name,
-- and PostgREST returns 500 when the 8s statement_timeout cancels the sort.
--
-- Membership does not depend on any column except workspace_id. An IN-list
-- of the caller's workspaces is planned once (auth.uid() is wrapped in a
-- subselect so it is an initplan) and the row filter is a hash lookup.
-- Same audience as before: any workspace member can read vendors.

drop policy if exists vendors_select on public.vendors;
create policy vendors_select on public.vendors
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
    )
  );

-- The shell orders vendors by business_name, id, and skips archived rows
-- and the free-agent corpus (lib/prospect-lists.ts). This is that slice.
create index if not exists vendors_workspace_shell_idx
  on public.vendors (workspace_id, business_name, id)
  where status <> 'archived'
    and source is distinct from 'dispogenius-free-agents';
