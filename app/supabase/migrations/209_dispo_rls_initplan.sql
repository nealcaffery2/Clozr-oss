-- has_role() per row on the dispo tables. Each policy called has_role
-- (SECURITY DEFINER, so never inlined) once per row, twice when the select and
-- write policies both applied. As a dispositions member a count of workspace
-- 11's 1,012 deal_buyer_matches took 251 ms against 0.75 ms in the form below;
-- buyer_rule_states (417k rows) did not finish inside the statement timeout
-- and takes 352 ms. Same initplan form as 94 and 187: the caller's workspaces
-- are planned once and the row filter is a hash lookup. Same roles as before;
-- the policies apply to authenticated (anon was never a member of anything).

-- deal_buyer_matches
drop policy if exists deal_buyer_matches_select on public.deal_buyer_matches;
create policy deal_buyer_matches_select on public.deal_buyer_matches
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
    )
  );

drop policy if exists deal_buyer_matches_write on public.deal_buyer_matches;
create policy deal_buyer_matches_write on public.deal_buyer_matches
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

-- buyer_rule_states
drop policy if exists buyer_rule_states_select on public.buyer_rule_states;
create policy buyer_rule_states_select on public.buyer_rule_states
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
    )
  );

drop policy if exists buyer_rule_states_write on public.buyer_rule_states;
create policy buyer_rule_states_write on public.buyer_rule_states
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

-- buyer_markets
drop policy if exists buyer_markets_select on public.buyer_markets;
create policy buyer_markets_select on public.buyer_markets
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
    )
  );

drop policy if exists buyer_markets_write on public.buyer_markets;
create policy buyer_markets_write on public.buyer_markets
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

-- buyer_phones
drop policy if exists buyer_phones_select on public.buyer_phones;
create policy buyer_phones_select on public.buyer_phones
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id
      from public.workspace_members m
      where m.user_id = (select auth.uid())
        and m.role = any (array['owner', 'admin', 'dispositions', 'tc', 'member'])
    )
  );

drop policy if exists buyer_phones_write on public.buyer_phones;
create policy buyer_phones_write on public.buyer_phones
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
