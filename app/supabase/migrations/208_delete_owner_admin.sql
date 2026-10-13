-- Hard-deleting a seller or a buyer takes its deals' links, communications
-- and history with it (the foreign keys cascade or set null). The app archives
-- instead; a real delete is now for owners and admins only. Everyone who could
-- add or edit before still can. Same initplan form as 94, so the check is
-- planned once, not per row.

-- sellers: delete was any member of the workspace (151).
drop policy if exists sellers_delete on public.sellers;
create policy sellers_delete on public.sellers
  for delete to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin'])
    )
  );

-- buyers: buyers_write (94) was FOR ALL to owner, admin and dispositions.
-- Split it so dispositions keep insert and update but not delete.
drop policy if exists buyers_write on public.buyers;

drop policy if exists buyers_insert on public.buyers;
create policy buyers_insert on public.buyers
  for insert to authenticated
  with check (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions'])
    )
  );

drop policy if exists buyers_update on public.buyers;
create policy buyers_update on public.buyers
  for update to authenticated
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

drop policy if exists buyers_delete on public.buyers;
create policy buyers_delete on public.buyers
  for delete to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin'])
    )
  );
