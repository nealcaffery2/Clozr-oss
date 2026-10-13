-- 105 · Acquisitions must not see buyer identity on a deal team.
--
-- deal_parties_select already hid rows with a buyer_id from acquisitions
-- (migrations 40 / 46). A typed-in buyer party (role = 'buyer', buyer_id null)
-- still carried name / email / phone. Hide every buyer-role party the same way
-- buyers_select hides the buyers table.

drop policy if exists deal_parties_select on public.deal_parties;
create policy deal_parties_select on public.deal_parties for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      (role <> 'buyer' and buyer_id is null)
      or exists (
        select 1 from public.workspace_members m
         where m.workspace_id = deal_parties.workspace_id
           and m.user_id = (select auth.uid())
           and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
      )
    )
  );

drop policy if exists deal_parties_write on public.deal_parties;
create policy deal_parties_write on public.deal_parties for all to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      (role <> 'buyer' and buyer_id is null)
      or exists (
        select 1 from public.workspace_members m
         where m.workspace_id = deal_parties.workspace_id
           and m.user_id = (select auth.uid())
           and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
      )
    )
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (
      (role <> 'buyer' and buyer_id is null)
      or exists (
        select 1 from public.workspace_members m
         where m.workspace_id = deal_parties.workspace_id
           and m.user_id = (select auth.uid())
           and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
      )
    )
    and exists (
      select 1 from public.deals d
       where d.id = deal_id and d.workspace_id = deal_parties.workspace_id
    )
  );
