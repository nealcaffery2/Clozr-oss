-- 26 · covering indexes for every foreign key the advisor found bare
--
-- Postgres does not index the referencing side of a foreign key. Every
-- delete on the referenced row scans the referencing table, and every
-- workspace-scoped read walks it. Cheap to add, and the security advisor's
-- companion performance list is otherwise noise that hides real findings.

create index if not exists action_plan_steps_workspace_id_idx on public.action_plan_steps (workspace_id);
create index if not exists action_plans_created_by_idx on public.action_plans (created_by);
create index if not exists action_plans_workspace_id_idx on public.action_plans (workspace_id);
create index if not exists activity_actor_id_idx on public.activity (actor_id);
create index if not exists appointments_buyer_id_idx on public.appointments (buyer_id);
create index if not exists appointments_created_by_idx on public.appointments (created_by);
create index if not exists appointments_property_id_idx on public.appointments (property_id);
create index if not exists appointments_seller_id_idx on public.appointments (seller_id);
create index if not exists buyers_created_by_idx on public.buyers (created_by);
create index if not exists deals_buyer_id_idx on public.deals (buyer_id);
create index if not exists deals_created_by_idx on public.deals (created_by);
create index if not exists deals_dispo_rep2_id_idx on public.deals (dispo_rep2_id);
create index if not exists deals_dispo_rep_id_idx on public.deals (dispo_rep_id);
create index if not exists deals_owner_id_idx on public.deals (owner_id);
create index if not exists deals_property_id_idx on public.deals (property_id);
create index if not exists deals_tc_rep_id_idx on public.deals (tc_rep_id);
create index if not exists deals_title_vendor_id_idx on public.deals (title_vendor_id);
create index if not exists enrollments_created_by_idx on public.enrollments (created_by);
create index if not exists enrollments_seller_id_idx on public.enrollments (seller_id);
create index if not exists enrollments_workspace_id_idx on public.enrollments (workspace_id);
create index if not exists ingest_events_communication_id_idx on public.ingest_events (communication_id);
create index if not exists ingest_events_seller_id_idx on public.ingest_events (seller_id);
create index if not exists notifications_deal_id_idx on public.notifications (deal_id);
create index if not exists notifications_seller_id_idx on public.notifications (seller_id);
create index if not exists notifications_user_id_idx on public.notifications (user_id);
create index if not exists offers_buyer_id_idx on public.offers (buyer_id);
create index if not exists offers_created_by_idx on public.offers (created_by);
create index if not exists offers_property_id_idx on public.offers (property_id);
create index if not exists offers_workspace_id_idx on public.offers (workspace_id);
create index if not exists sellers_created_by_idx on public.sellers (created_by);
create index if not exists tasks_assigned_to_idx on public.tasks (assigned_to);
create index if not exists tasks_created_by_idx on public.tasks (created_by);
create index if not exists tasks_deal_id_idx on public.tasks (deal_id);
create index if not exists transaction_items_workspace_id_idx on public.transaction_items (workspace_id);
create index if not exists transactions_buyer_id_idx on public.transactions (buyer_id);
create index if not exists transactions_created_by_idx on public.transactions (created_by);
create index if not exists transactions_deal_id_idx on public.transactions (deal_id);
create index if not exists transactions_property_id_idx on public.transactions (property_id);
create index if not exists transactions_seller_id_idx on public.transactions (seller_id);
create index if not exists vendors_created_by_idx on public.vendors (created_by);
create index if not exists workspace_invites_invited_by_idx on public.workspace_invites (invited_by);
create index if not exists workspaces_owner_id_idx on public.workspaces (owner_id);
