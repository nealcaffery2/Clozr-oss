-- The TC SOP's later plans start on their own, and the owner hears when a
-- preliminary settlement statement is waiting on him.
--
-- 1. Plans. "TC · Access, photos, ready for market" starts when the seller
--    reaches Under Contract - Seller (SOP steps 6–7: access, lockbox and photos
--    within 24 h, then Ready To Market), beside "Contract out and handoff".
--    "TC · Title to funded" starts at Under Contract - Buyer, which the
--    database sets when the deal moves to Buyer Under Contract (deals_stage_after).
--    Only plans still on Manual enrollment change, so a workspace that set its
--    own trigger keeps it. `active` is not touched: a plan that is switched off
--    (workspace 11's three TC plans are, today) still enrolls nobody until
--    someone turns it on in Action plans.
-- 2. Prelim approval. When the TC marks the HUD / CD review done
--    (transactions.tc_review set, owner sign-off still empty), every owner and
--    admin of the workspace gets an in-app notification to approve it; the
--    approve action is the TC file's existing owner sign-off (signoff). When
--    the sign-off lands, the deal's TC (else whoever opened the file) is told.
--
-- Idempotent.

update public.action_plans
set trigger_type = 'stage', trigger_value = 'Under Contract - Seller', trigger_event = 'Stage → Under Contract - Seller', updated_at = now()
where name = 'TC · Access, photos, ready for market' and trigger_type = 'manual';

update public.action_plans
set trigger_type = 'stage', trigger_value = 'Under Contract - Buyer', trigger_event = 'Stage → Under Contract - Buyer', updated_at = now()
where name = 'TC · Title to funded' and trigger_type = 'manual';

create or replace function public.tc_prelim_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_addr text;
  v_tc uuid;
  v_seller bigint;
begin
  select coalesce(p.line1, 'A deal'), d.tc_rep_id, coalesce(d.seller_id, new.seller_id)
    into v_addr, v_tc, v_seller
  from (select 1) x
  -- Only this workspace's deal and property: never another tenant's address in a notification.
  left join public.deals d on d.id = new.deal_id and d.workspace_id = new.workspace_id
  left join public.properties p on p.id = coalesce(new.property_id, d.property_id) and p.workspace_id = new.workspace_id;
  v_addr := coalesce(v_addr, 'A deal');

  if new.tc_review is not null and old.tc_review is null and new.signoff is null then
    insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
    select new.workspace_id, m.user_id, 'TC',
           'Approve the preliminary settlement statement · ' || v_addr,
           'The TC has verified every HUD / CD line (' || new.tc_review || '). No wires until you sign off on the TC file.',
           v_seller, new.deal_id
    from public.workspace_members m
    where m.workspace_id = new.workspace_id and m.role in ('owner', 'admin');
    if new.deal_id is not null then
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (new.workspace_id, 'deal', new.deal_id, 'tc', 'Prelim settlement statement sent for approval', new.tc_review);
    end if;
  end if;

  if new.signoff is not null and old.signoff is null then
    insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
    select new.workspace_id, u, 'TC', 'Settlement statement approved · ' || v_addr, new.signoff || '. Funding can go ahead.', v_seller, new.deal_id
    from (select coalesce(v_tc, new.created_by) as u) x
    where u is not null;
    if new.deal_id is not null then
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (new.workspace_id, 'deal', new.deal_id, 'tc', 'Prelim settlement statement approved', new.signoff);
    end if;
  end if;
  return null;
end $$;
revoke all on function public.tc_prelim_notify() from public, anon, authenticated;

drop trigger if exists transactions_prelim_notify on public.transactions;
create trigger transactions_prelim_notify
  after update of tc_review, signoff on public.transactions
  for each row execute function public.tc_prelim_notify();
