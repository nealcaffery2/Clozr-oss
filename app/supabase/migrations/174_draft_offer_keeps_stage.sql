-- 174 · A draft AI offer letter does not move the stage. Sending it does.
--
-- generateOffer inserts an outbound offers row before the letter exists to
-- be read: status 'Draft' when it is not sent yet, 'Sent' when it goes out
-- immediately. offers_after_write (163) treated every outbound insert as
-- Offer Made, so opening that draft moved sellers.lead_stage and the
-- submission's deals.lead_stage.
--
-- A draft still logs the timeline line and writes offer_amount. The seller
-- and the submission move when the row is inserted already Sent, or when a
-- Draft is later marked Sent (applySent does that). That update is the
-- submission's move to Offer Made, and stage_events_log still names the
-- offer's maker (clozr.actor) so Podio writeback runs. The stage list matches
-- SUBMISSION_TO_OFFER_MADE in app/lib/tc-sync.ts. Inbound counters are unchanged.

create or replace function public.offers_after_write()
returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare
  cur_sort integer;
  v_deal_stage text;
  v_title text;
  -- Viewing or saving the letter is not an offer out. 'Draft' is what
  -- generateOffer writes when send is off. Leaving Draft is the send.
  -- CASE so INSERT never reads OLD (that record is unassigned).
  v_advance boolean := lower(btrim(coalesce(new.status, ''))) <> 'draft';
  v_move boolean := v_advance and case
    when tg_op = 'INSERT' then true
    when tg_op = 'UPDATE' then lower(btrim(coalesce(old.status, ''))) = 'draft'
    else false
  end;
begin
  if pg_trigger_depth() > 1 or new.seller_id is null then return new; end if;

  -- A counter from the seller or partner: a line on the timeline, nothing else.
  if new.direction = 'inbound' then
    if tg_op = 'INSERT' and new.buyer_id is null then
      v_title := 'Counter ' || coalesce(to_char(new.amount, 'FM$999,999,999'), '—');
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
      values (new.workspace_id, 'seller', new.seller_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      if new.deal_id is not null and exists (select 1 from public.deals where id = new.deal_id and lead_stage is not null) then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
        values (new.workspace_id, 'deal', new.deal_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      end if;
    end if;
    return new;
  end if;
  if new.direction <> 'outbound' then return new; end if;

  -- The stage moves and the offer price below are this person's (stage_events_log,
  -- podio_outbox_values), also when the offers function wrote the row.
  if new.created_by is not null then perform set_config('clozr.actor', new.created_by::text, true); end if;

  if new.deal_id is not null and new.amount is not null then
    update public.deals set offer_amount = new.amount, updated_at = now() where id = new.deal_id;
  end if;
  if tg_op = 'INSERT' then
    v_title := 'Offer made ' || coalesce(to_char(new.amount, 'FM$999,999,999'), '—') || coalesce(' · ' || new.basis, '');
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
    values (new.workspace_id, 'seller', new.seller_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);

    if new.deal_id is not null then
      select lead_stage into v_deal_stage from public.deals where id = new.deal_id;
      if v_deal_stage is not null then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
        values (new.workspace_id, 'deal', new.deal_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      end if;
    end if;
  end if;

  if v_move then
    select s.sort into cur_sort from public.sellers x join public.seller_stages s on s.label = x.lead_stage where x.id = new.seller_id;
    if cur_sort is null or cur_sort < 130 then
      update public.sellers set lead_stage = 'Offer Made' where id = new.seller_id;
    end if;

    -- The partner submission the offer is on. A sent offer after a decline
    -- reopens it; accepted, in inspections or at auction stays.
    if new.deal_id is not null then
      if tg_op <> 'INSERT' then
        select lead_stage into v_deal_stage from public.deals where id = new.deal_id;
      end if;
      if v_deal_stage in ('New Submission', 'Lead', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete', 'Pending Response',
                          'Underwrite Declined', 'Offer Declined') then
        update public.deals set lead_stage = 'Offer Made', updated_at = now() where id = new.deal_id;
      end if;
    end if;
  end if;

  perform set_config('clozr.actor', '', true);
  return new;
end $$;
