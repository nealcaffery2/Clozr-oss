-- 94 · Buyers reads were calling has_role once per row.
--
-- buyers_select was `has_role(workspace_id, ...)`. That function is SECURITY
-- DEFINER, so it is not inlined, and it queries workspace_members. On a
-- workspace with 128k buyers the API role's 8s statement_timeout cancelled
-- the statement and PostgREST answered 500, which failed the whole shell load.
--
-- The check does not depend on any column except workspace_id. An IN-list of
-- the caller's workspaces is planned once (auth.uid() is wrapped in a
-- subselect so it is an initplan) and the row filter is a hash lookup.
-- Same roles as before: acquisitions still cannot read buyers.

drop policy if exists buyers_select on public.buyers;
create policy buyers_select on public.buyers
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
    )
  );

drop policy if exists buyers_write on public.buyers;
create policy buyers_write on public.buyers
  for all to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions'])
    )
  )
  with check (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions'])
    )
  );

-- The shell orders buyers by name, id. Without this, every page sorts the
-- whole workspace. The free-agent corpus is not loaded into the shell
-- (lib/prospect-lists.ts), and this keeps a name-ordered page an index scan.
create index if not exists buyers_workspace_name_id_idx
  on public.buyers (workspace_id, name, id);

-- The shell skips the free-agent corpus. This is that slice, in name order,
-- so the boot read does not scan the other 128k rows.
create index if not exists buyers_workspace_shell_idx
  on public.buyers (workspace_id, name, id)
  where source is distinct from 'dispogenius-free-agents';
