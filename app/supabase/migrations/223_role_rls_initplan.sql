-- has_role() once per query, not once per row, on every role-gated policy.
--
-- 187 moved 113 membership policies to `workspace_id in (select
-- my_workspace_ids())`; the role-gated ones kept has_role(workspace_id, …)
-- in qual / with_check, a SECURITY DEFINER lookup for every row scanned
-- (twice for UPDATE and ALL). 209 rewrote the four biggest tables
-- (deal_buyer_matches, buyer_rule_states, buyer_markets, buyer_phones); this
-- does the other 116 policies on 77 tables.
--
-- my_role_workspace_ids(roles…) keeps has_role's exact meaning: the caller's
-- workspaces where their role is one of `roles`. It runs has_role once per
-- workspace the caller belongs to (one or two), and the planner evaluates the
-- uncorrelated `IN (SELECT …)` once per query. Each policy is altered in place
-- (no drop, so it re-runs cleanly); only has_role(x, VARIADIC ARRAY[…]) is
-- swapped for `x IN (SELECT public.my_role_workspace_ids(VARIADIC ARRAY[…]))`,
-- every other condition is as it was. Generated from pg_policies on
-- 2026-10-10 and read line by line.

create or replace function public.my_role_workspace_ids(variadic p_roles text[])
returns setof bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select w from public.my_workspace_ids() w where public.has_role(w, variadic p_roles)
$$;
revoke all on function public.my_role_workspace_ids(text[]) from public, anon;
grant execute on function public.my_role_workspace_ids(text[]) to authenticated, service_role;

alter policy audit_log_admin_read on public.audit_log
  using (((workspace_id IS NOT NULL) AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))));
alter policy bank_accounts_admin_select on public.bank_accounts
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy bank_transactions_admin_select on public.bank_transactions
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy buy_box_links_select on public.buy_box_links
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buy_box_links_write on public.buy_box_links
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buy_box_submissions_select on public.buy_box_submissions
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buy_box_submissions_write on public.buy_box_submissions
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buy_box_templates_select on public.buy_box_templates
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buy_box_templates_write on public.buy_box_templates
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buyer_automation_rules_select on public.buyer_automation_rules
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buyer_automation_rules_write on public.buyer_automation_rules
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buyer_contacts_select on public.buyer_contacts
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buyer_contacts_write on public.buyer_contacts
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buyer_emails_select on public.buyer_emails
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buyer_emails_write on public.buyer_emails
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buyer_import_batches_select on public.buyer_import_batches
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buyer_import_batches_write on public.buyer_import_batches
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy buyer_import_column_maps_select on public.buyer_import_column_maps
  using (((workspace_id IS NULL) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text])))));
alter policy buyer_import_column_maps_write on public.buyer_import_column_maps
  using (((workspace_id IS NULL) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text])))))
  with check (((workspace_id IS NULL) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text])))));
alter policy buyer_import_rows_select on public.buyer_import_rows
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy buyer_import_rows_write on public.buyer_import_rows
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy call_review_submissions_select on public.call_review_submissions
  using (((((user_id = auth.uid()) OR (rep_id = auth.uid())) AND (workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids))) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))));
alter policy checklist_template_items_select on public.checklist_template_items
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy checklist_template_items_write on public.checklist_template_items
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))));
alter policy checklist_templates_select on public.checklist_templates
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy checklist_templates_write on public.checklist_templates
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))));
alter policy cold_campaigns_write on public.cold_campaigns
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy cold_domains_write on public.cold_domains
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy cold_mailboxes_write on public.cold_mailboxes
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy cold_steps_write on public.cold_steps
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy cold_workspace_settings_write on public.cold_workspace_settings
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy communication_mailboxes_read on public.communication_mailboxes
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((user_id = ( SELECT auth.uid() AS uid)) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text]))))));
alter policy cus_admin_read on public.communication_user_state
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text]))));
alter policy contract_comments_update on public.contract_comments
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((author_user_id = auth.uid()) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))))
  with check ((EXISTS ( SELECT 1
   FROM contracts c
  WHERE ((c.id = contract_comments.contract_id) AND (c.workspace_id = contract_comments.workspace_id)))));
alter policy contracts_write on public.contracts
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text, 'tc'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text, 'tc'::text]))));
alter policy custom_metrics_delete on public.custom_metrics
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))));
alter policy custom_metrics_update on public.custom_metrics
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
alter policy deal_outreach_settings_select on public.deal_outreach_settings
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy deal_outreach_settings_write on public.deal_outreach_settings
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy deal_page_views_select on public.deal_page_views
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy deal_page_views_write on public.deal_page_views
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy deal_public_links_select on public.deal_public_links
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy deal_public_links_write on public.deal_public_links
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy discover_runs_select on public.discover_runs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy discover_runs_write on public.discover_runs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy discovery_entities_select on public.discovery_entities
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy discovery_entities_write on public.discovery_entities
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy discovery_individuals_select on public.discovery_individuals
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy discovery_individuals_write on public.discovery_individuals
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy discovery_jobs_select on public.discovery_jobs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy discovery_jobs_write on public.discovery_jobs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy discovery_properties_select on public.discovery_properties
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy discovery_properties_write on public.discovery_properties
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispo_campaign_messages_select on public.dispo_campaign_messages
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispo_campaign_messages_update on public.dispo_campaign_messages
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispo_campaign_presets_write on public.dispo_campaign_presets
  using (((workspace_id IS NOT NULL) AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text])))))
  with check (((workspace_id IS NOT NULL) AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text])))));
alter policy dispo_campaign_recipients_select on public.dispo_campaign_recipients
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispo_campaign_recipients_update on public.dispo_campaign_recipients
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispo_campaigns_select on public.dispo_campaigns
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispo_campaigns_update on public.dispo_campaigns
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispo_engagement_events_select on public.dispo_engagement_events
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispo_engagement_events_write on public.dispo_engagement_events
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispo_match_snapshot_rows_select on public.dispo_match_snapshot_rows
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispo_match_snapshot_rows_write on public.dispo_match_snapshot_rows
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispo_match_snapshots_select on public.dispo_match_snapshots
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispo_match_snapshots_write on public.dispo_match_snapshots
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy dispogenius_buyer_snapshots_select on public.dispogenius_buyer_snapshots
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispogenius_buyer_snapshots_write on public.dispogenius_buyer_snapshots
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy dispogenius_sync_runs_select on public.dispogenius_sync_runs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy dispogenius_sync_runs_write on public.dispogenius_sync_runs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy dm_commands_cancel on public.dm_commands
  using (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text]))) AND (status = 'pending'::text)))
  with check ((status = 'cancelled'::text));
alter policy dm_commands_insert on public.dm_commands
  with check (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text]))) AND (status = 'pending'::text)));
alter policy dm_groups_write on public.dm_groups
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text]))));
alter policy dm_settings_write on public.dm_settings
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text]))));
alter policy doc_content_blocks_write on public.doc_content_blocks
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy doc_folders_write on public.doc_folders
  using (
CASE
    WHEN (scope = 'contracts'::text) THEN (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text, 'tc'::text])))
    ELSE (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))
END)
  with check (
CASE
    WHEN (scope = 'contracts'::text) THEN (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text, 'tc'::text])))
    ELSE (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))
END);
alter policy doc_forms_write on public.doc_forms
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text, 'tc'::text]))))
  with check (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'acquisitions'::text, 'dispositions'::text, 'tc'::text]))) AND (EXISTS ( SELECT 1
   FROM doc_templates t
  WHERE ((t.id = doc_forms.template_id) AND ((t.workspace_id = doc_forms.workspace_id) OR (t.workspace_id IS NULL)))))));
alter policy doc_template_fields_write on public.doc_template_fields
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))) AND (EXISTS ( SELECT 1
   FROM doc_templates t
  WHERE ((t.id = doc_template_fields.template_id) AND (t.workspace_id = doc_template_fields.workspace_id))))));
alter policy doc_templates_write on public.doc_templates
  using (((workspace_id IS NOT NULL) AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))))
  with check (((workspace_id IS NOT NULL) AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))));
alter policy genius_credit_log_select on public.genius_credit_log
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy genius_property_cache_select on public.genius_property_cache
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy genius_skip_cache_select on public.genius_skip_cache
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy inbox_user_prefs_admin_read on public.inbox_user_prefs
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy ingest_sources_admin on public.ingest_sources
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy message_templates_delete on public.message_templates
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((owner_id = ( SELECT auth.uid() AS uid)) OR (shared AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))))));
alter policy message_templates_update on public.message_templates
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((owner_id = ( SELECT auth.uid() AS uid)) OR (shared AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))))))
  with check (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((owner_id = ( SELECT auth.uid() AS uid)) OR (shared AND (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))))));
alter policy offers_select on public.offers
  using (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))) OR ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['acquisitions'::text]))) AND (direction = 'inbound'::text))));
alter policy offers_seller_acquisitions on public.offers
  using (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['acquisitions'::text, 'partnerships'::text]))) AND (seller_id IS NOT NULL) AND (buyer_id IS NULL)))
  with check (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['acquisitions'::text, 'partnerships'::text]))) AND (seller_id IS NOT NULL) AND (buyer_id IS NULL)));
alter policy offers_write on public.offers
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))));
alter policy outreach_snippets_select on public.outreach_snippets
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy outreach_snippets_write on public.outreach_snippets
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy report_schedules_write on public.report_schedules
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND (EXISTS ( SELECT 1
   FROM reports r
  WHERE ((r.id = report_schedules.report_id) AND ((r.owner_id = ( SELECT auth.uid() AS uid)) OR (r.workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))))))))
  with check (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND (EXISTS ( SELECT 1
   FROM reports r
  WHERE ((r.id = report_schedules.report_id) AND ((r.owner_id = ( SELECT auth.uid() AS uid)) OR (r.workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))))))));
alter policy reports_delete on public.reports
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((owner_id = ( SELECT auth.uid() AS uid)) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))));
alter policy reports_update on public.reports
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((owner_id = ( SELECT auth.uid() AS uid)) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))))
  with check (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((owner_id = ( SELECT auth.uid() AS uid)) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))));
alter policy roleplay_sessions_select on public.roleplay_sessions
  using ((((user_id = auth.uid()) AND (workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids))) OR (workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text])))));
alter policy round_robin_members_write on public.round_robin_members
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))) AND (EXISTS ( SELECT 1
   FROM round_robins r
  WHERE ((r.id = round_robin_members.round_robin_id) AND (r.workspace_id = round_robin_members.workspace_id)))) AND (EXISTS ( SELECT 1
   FROM workspace_members m
  WHERE ((m.workspace_id = round_robin_members.workspace_id) AND (m.user_id = round_robin_members.user_id))))));
alter policy round_robins_write on public.round_robins
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy sales_coach_settings_write on public.sales_coach_settings
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy talkr_connections_delete on public.talkr_connections
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy talkr_connections_insert on public.talkr_connections
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy talkr_connections_update on public.talkr_connections
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy transaction_items_write on public.transaction_items
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]))));
alter policy transactions_write on public.transactions
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]))));
alter policy walkthrough_invites_select on public.walkthrough_invites
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy walkthrough_invites_write on public.walkthrough_invites
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))));
alter policy walkthrough_slots_select on public.walkthrough_slots
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy walkthrough_slots_write on public.walkthrough_slots
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]))));
alter policy webhook_deliveries_admin on public.webhook_deliveries
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy webhook_subscriptions_admin on public.webhook_subscriptions
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy wholesaler_deals_write on public.wholesaler_deals
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy wholesaler_entities_write on public.wholesaler_entities
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))));
alter policy workspace_goals_select on public.workspace_goals
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))));
alter policy workspace_goals_write on public.workspace_goals
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy invites_manage on public.workspace_invites
  using ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
alter policy members_manage on public.workspace_members
  using (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))) AND (role <> 'owner'::text)))
  with check (((workspace_id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))) AND (role <> 'owner'::text)));
alter policy workspaces_admin_update on public.workspaces
  using ((id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))))
  with check ((id IN ( SELECT public.my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]))));
