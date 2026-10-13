-- 181 · A submission moved to Under Contract opens the deal.
--
-- A partner's house (a submission: a deal at Prospect whose acquisitions stage
-- is deals.lead_stage, migration 130) only joined the pipeline on Offer
-- Accepted. Moved straight to Under Contract - Seller it stayed at Prospect:
-- a deal sheet and nothing on the Deals board or Dispo. A seller lead already does this (sellers_stage_after, 27).
--
--   submission_into_pipeline(deal, target)
--       the submission's deal goes to the stage seller_stages maps its lead
--       stage to (Under Contract Seller, Buyer Under Contract), takes the
--       workspace's TC when it has none and leaves the archive; the deal's TC
--       and dispo rep hear about it. Blank deal sheet fields stay blank: the
--       deal sheet reminders (lib/section-gaps) tell the acquisitions rep.
--       When the house is already on the board as another deal, that deal
--       stays the one: this sheet's numbers fill its blanks and this sheet is
--       archived as its duplicate.
--   deals_submission_notify
--       calls it when a submission's lead stage moves to either stage.
--   backfill
--       submissions already sitting at Under Contract on Prospect, newest first.

create or replace function public.submission_into_pipeline(p_deal_id bigint, p_target text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.deals;
  v_addr text;
  v_tc uuid;
  v_other bigint;
begin
  if p_target not in ('Under Contract Seller', 'Buyer Under Contract') then return; end if;
  select * into d from public.deals where id = p_deal_id;
  -- Only a submission still at Prospect; a deal already on the pipeline keeps its stage.
  if not found or coalesce(d.stage, 'Prospect') <> 'Prospect' then return; end if;
  select nullif(trim(line1), '') into v_addr from public.properties where id = d.property_id;
  v_addr := coalesce(v_addr, 'A property');

  -- The same house already on the board: one deal, not two.
  if d.property_id is not null then
    select id into v_other from public.deals
     where workspace_id = d.workspace_id and property_id = d.property_id and id <> d.id
       and archived_at is null
       and stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow')
     order by created_at desc limit 1;
  end if;
  if v_other is not null then
    update public.deals o set
      owner_id = coalesce(o.owner_id, d.owner_id),
      offer_amount = coalesce(o.offer_amount, d.offer_amount),
      arv = coalesce(o.arv, d.arv),
      rehab = coalesce(o.rehab, d.rehab),
      earnest_money = coalesce(o.earnest_money, d.earnest_money),
      contract_date = coalesce(o.contract_date, d.contract_date),
      option_ends_on = coalesce(o.option_ends_on, d.option_ends_on),
      close_date = coalesce(o.close_date, d.close_date),
      underwriting_url = coalesce(o.underwriting_url, d.underwriting_url),
      condition_notes = coalesce(o.condition_notes, d.condition_notes),
      occupancy_notes = coalesce(o.occupancy_notes, d.occupancy_notes)
     where o.id = v_other;
    update public.deals set archived_at = now(), archived_reason = 'Duplicate of deal ' || v_other
     where id = d.id and archived_at is null;
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
    values (d.workspace_id, 'deal', d.id, 'stage', 'Already on the board',
            v_addr || ' is deal ' || v_other || ' on the Deals board. This sheet''s numbers filled its blanks and this sheet was archived as its duplicate.');
    return;
  end if;

  v_tc := public.workspace_tc(d.workspace_id);
  -- Inside a trigger: deals_stage_after (depth > 1) leaves the partner contact's
  -- stage alone, and deals_stage_before stamps the contract date.
  update public.deals set
    stage = p_target,
    tc_rep_id = coalesce(tc_rep_id, v_tc),
    archived_at = null, archived_reason = null
   where id = d.id;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
  values (d.workspace_id, 'deal', d.id, 'stage', 'Deal opened · ' || p_target,
          v_addr || ' moved to ' || coalesce(d.lead_stage, p_target) || '. On the Deals board and Dispo'
            || case when coalesce(d.tc_rep_id, v_tc) is not null then ' with a TC.' else '; no TC in the workspace yet.' end);

  -- The deal's own TC and dispo rep (with neither, the workspace owner), as on
  -- Offer Accepted (migration 159); the person who moved it does not.
  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
  select d.workspace_id, u.user_id, 'Dispo', 'Under contract · ' || v_addr,
         v_addr || ' is under contract and on the Deals board.'
           || case when d.offer_amount is not null then ' Contract price $' || to_char(d.offer_amount, 'FM999,999,999') || '.' else '' end,
         d.seller_id, d.id
    from (
      select coalesce(d.tc_rep_id, v_tc) as user_id
      union
      select coalesce(d.dispo_rep_id, case when coalesce(d.tc_rep_id, v_tc) is null then (select w.owner_id from public.workspaces w where w.id = d.workspace_id) end)
    ) u
   where u.user_id is not null and u.user_id is distinct from auth.uid();
end $$;
revoke all on function public.submission_into_pipeline(bigint, text) from public, anon, authenticated;

create or replace function public.deals_submission_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_addr text;
  v_who uuid;
  v_band text;
  v_target text;
begin
  if tg_op = 'UPDATE'
     and new.lead_stage is not distinct from old.lead_stage
     and new.underwriter_id is not distinct from old.underwriter_id then
    return new;
  end if;
  select nullif(trim(line1), '') into v_addr from public.properties where id = new.property_id;
  v_addr := coalesce(v_addr, 'A submission');

  -- Into an underwriting stage, or handed to a new underwriter while in one.
  if new.underwriter_id is not null
     and coalesce(new.lead_stage, '') in ('New Submission', 'Underwriting', 'Underwriting - Need Info')
     and (tg_op = 'INSERT'
          or old.lead_stage is distinct from new.lead_stage
          or old.underwriter_id is distinct from new.underwriter_id)
     and new.underwriter_id is distinct from auth.uid() then
    insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
    values (new.workspace_id, new.underwriter_id, 'Underwriting', 'Underwrite ' || v_addr,
            v_addr || ' is in ' || new.lead_stage || ' and you are the underwriter.', new.seller_id, new.id);
  end if;

  if tg_op = 'UPDATE' and new.lead_stage is distinct from old.lead_stage then
    if new.lead_stage in ('Underwriting Complete', 'Underwrite Declined') then
      v_who := coalesce(new.owner_id, new.created_by);
      v_band := case
        when new.wholesale_offer is not null and new.institutional_offer is not null
          then ' Low $' || to_char(new.wholesale_offer, 'FM999,999,999') || ' · high $' || to_char(new.institutional_offer, 'FM999,999,999') || '.'
        when coalesce(new.wholesale_offer, new.institutional_offer, new.mao) is not null
          then ' Offer $' || to_char(coalesce(new.wholesale_offer, new.institutional_offer, new.mao), 'FM999,999,999') || '.'
        else '' end;
      if v_who is not null and v_who is distinct from auth.uid() then
        insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
        values (new.workspace_id, v_who, 'Underwriting',
                case when new.lead_stage = 'Underwriting Complete' then 'Underwriting complete · ' else 'Underwrite declined · ' end || v_addr,
                v_addr || case when new.lead_stage = 'Underwriting Complete' then ' is underwritten and ready for your offer.' else ' was declined in underwriting.' end || v_band,
                new.seller_id, new.id);
      end if;
    elsif new.lead_stage = 'Offer Accepted' and pg_trigger_depth() = 1 then
      perform public.offer_accepted_to_dispo(new.id);
    elsif pg_trigger_depth() = 1 then
      -- Migration 181: Under Contract - Seller / - Buyer opens the deal.
      select deal_stage into v_target from public.seller_stages where label = new.lead_stage limit 1;
      if v_target in ('Under Contract Seller', 'Buyer Under Contract') then
        perform public.submission_into_pipeline(new.id, v_target);
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.deals_submission_notify() from public, anon, authenticated;

-- Submissions already moved to Under Contract that stayed at Prospect. Newest
-- first, so a house with two sheets keeps the newer one on the board.
do $$
declare
  r record;
begin
  for r in
    select d.id, (select ss.deal_stage from public.seller_stages ss where ss.label = d.lead_stage limit 1) as target
      from public.deals d
     where coalesce(d.stage, 'Prospect') = 'Prospect' and d.archived_at is null
       and d.lead_stage in (select label from public.seller_stages where deal_stage in ('Under Contract Seller', 'Buyer Under Contract'))
     order by d.created_at desc
  loop
    if r.target in ('Under Contract Seller', 'Buyer Under Contract') then
      perform public.submission_into_pipeline(r.id, r.target);
    end if;
  end loop;
end $$;
