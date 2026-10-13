-- The last ten policies that called auth.uid() once per row (advisor
-- auth_rls_initplan). Wrapped in a subselect it runs once per query.
-- Same predicates otherwise; ALTER POLICY is safe to run again.

alter policy call_sync_state_read on public.call_sync_state
  using (exists (select 1 from public.workspace_members m
                 where m.workspace_id = call_sync_state.workspace_id and m.user_id = (select auth.uid())));

alter policy number_health_read on public.number_health
  using (exists (select 1 from public.workspace_members m
                 where m.workspace_id = number_health.workspace_id and m.user_id = (select auth.uid())));

alter policy number_guard_runs_read on public.number_guard_runs
  using (exists (select 1 from public.workspace_members m
                 where m.workspace_id = number_guard_runs.workspace_id and m.user_id = (select auth.uid())));

alter policy rep_phone_numbers_write on public.rep_phone_numbers
  using (exists (select 1 from public.workspace_members m
                 where m.workspace_id = rep_phone_numbers.workspace_id and m.user_id = (select auth.uid())
                   and m.role = any (array['owner', 'admin'])))
  with check (exists (select 1 from public.workspace_members m
                      where m.workspace_id = rep_phone_numbers.workspace_id and m.user_id = (select auth.uid())
                        and m.role = any (array['owner', 'admin'])));

alter policy inbox_item_state_own on public.inbox_item_state
  using (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

alter policy notification_preferences_own on public.notification_preferences
  using (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()))
  with check (user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()));

alter policy roleplay_sessions_select on public.roleplay_sessions
  using ((user_id = (select auth.uid()) and workspace_id in (select public.my_workspace_ids()))
         or workspace_id in (select public.my_role_workspace_ids(variadic array['owner', 'admin'])));

alter policy call_review_submissions_select on public.call_review_submissions
  using (((user_id = (select auth.uid()) or rep_id = (select auth.uid())) and workspace_id in (select public.my_workspace_ids()))
         or workspace_id in (select public.my_role_workspace_ids(variadic array['owner', 'admin'])));

alter policy contract_comments_insert on public.contract_comments
  with check (workspace_id in (select public.my_workspace_ids())
              and author_user_id = (select auth.uid())
              and author_signer_id is null
              and exists (select 1 from public.contracts c
                          where c.id = contract_comments.contract_id and c.workspace_id = contract_comments.workspace_id));

alter policy contract_comments_update on public.contract_comments
  using (workspace_id in (select public.my_workspace_ids())
         and (author_user_id = (select auth.uid())
              or workspace_id in (select public.my_role_workspace_ids(variadic array['owner', 'admin']))))
  with check (exists (select 1 from public.contracts c
                      where c.id = contract_comments.contract_id and c.workspace_id = contract_comments.workspace_id));
