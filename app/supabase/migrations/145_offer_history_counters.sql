-- Offers on a seller or a partner submission, every one of them, counters too.
--
-- * An outbound offer (Make offer) on a deal that is a partner submission
--   (deals.lead_stage set) now moves that submission to Offer Made when it is
--   still before it, and logs "Offer made $X" on the submission as well as on
--   the contact. Before, only the contact moved and the line never reached the
--   submission's timeline.
-- * A counter is an offers row with direction 'inbound', status 'countered',
--   the seller (and deal) set and no buyer. It logs "Counter $X" the same way
--   and leaves deals.offer_amount (our number) alone.
-- * Acquisitions can see and record the offers on sellers and submissions
--   (seller set, no buyer). Buyer offers keep the rules they had.

create or replace function public.offers_after_write()
returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare
  cur_sort integer;
  v_deal_stage text;
  v_title text;
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

  if new.deal_id is not null and new.amount is not null then
    update public.deals set offer_amount = new.amount, updated_at = now() where id = new.deal_id;
  end if;
  if tg_op = 'INSERT' then
    select s.sort into cur_sort from public.sellers x join public.seller_stages s on s.label = x.lead_stage where x.id = new.seller_id;
    if cur_sort is null or cur_sort < 130 then
      update public.sellers set lead_stage = 'Offer Made' where id = new.seller_id;
    end if;
    v_title := 'Offer made ' || coalesce(to_char(new.amount, 'FM$999,999,999'), '—') || coalesce(' · ' || new.basis, '');
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
    values (new.workspace_id, 'seller', new.seller_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);

    -- The partner submission the offer is on.
    if new.deal_id is not null then
      select lead_stage into v_deal_stage from public.deals where id = new.deal_id;
      if v_deal_stage is not null then
        if v_deal_stage in ('New Submission', 'Lead', 'Underwriting', 'Underwriting - Need Info', 'Underwriting Complete', 'Pending Response') then
          update public.deals set lead_stage = 'Offer Made', updated_at = now() where id = new.deal_id;
        end if;
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
        values (new.workspace_id, 'deal', new.deal_id, 'offer', v_title, coalesce(new.notes, ''), new.created_by);
      end if;
    end if;
  end if;
  return new;
end $$;

drop policy if exists offers_seller_acquisitions on public.offers;
create policy offers_seller_acquisitions on public.offers for all to authenticated
  using (public.has_role(workspace_id, variadic array['acquisitions']) and seller_id is not null and buyer_id is null)
  with check (public.has_role(workspace_id, variadic array['acquisitions']) and seller_id is not null and buyer_id is null);
