-- 265 · Option-at-risk alerts only on live deals, and only while there is time.
--
-- option_risk_tick (migration 94) alerted on any deal not Closed, Terminated
-- or Prospect whose option ended on or before three days out, so archived
-- deals and options that ran out weeks ago still pinged the TC. It now looks
-- only at deals in the pipeline (not archived, not closed, stage Under
-- Contract Seller, Ready To Market, Buyer Under Contract or In Escrow, the
-- same set Lane and the team stoplight use) whose option ends between
-- yesterday and three days out. Who it tells and the one-alert-per-date rule
-- are unchanged. Safe to re-run.

create or replace function public.option_risk_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  today date := (timezone('America/Chicago', now()))::date;
  title text;
  body text;
  recipients uuid[];
begin
  for r in
    select d.id, d.workspace_id, d.seller_id, d.owner_id, d.dispo_rep_id, d.tc_rep_id,
           d.option_ends_on, d.buyer_option_ends_on,
           coalesce(p.line1, 'This deal') as addr
    from public.deals d
    left join public.properties p on p.id = d.property_id
    where coalesce(d.terminated, false) = false
      and d.archived_at is null
      and d.closed_on is null
      and d.stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow')
      and (
        (d.option_ends_on is not null and d.option_ends_on between today - 1 and today + 3)
        or (d.buyer_option_ends_on is not null and d.buyer_option_ends_on between today - 1 and today + 3)
      )
  loop
    -- Seller option: acquisitions on this contract and the TC.
    if r.option_ends_on is not null and r.option_ends_on between today - 1 and today + 3
       and not exists (select 1 from public.option_alerts a where a.deal_id = r.id and a.side = 'seller' and a.ends_on = r.option_ends_on) then
      select coalesce(array_agg(distinct q.user_id), '{}') into recipients
      from (
        select r.owner_id as user_id
        union all select r.tc_rep_id
        union all select dp.user_id from public.deal_parties dp
          where dp.deal_id = r.id and dp.role = 'acquisitions' and dp.user_id is not null
        union all select m.user_id from public.workspace_members m
          where m.workspace_id = r.workspace_id and m.role = 'tc'
      ) q
      where q.user_id is not null;
      title := 'Seller option at risk';
      body := r.addr || ' · seller option ends ' || to_char(r.option_ends_on, 'Mon DD, YYYY');
      if cardinality(recipients) > 0 then
        insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
        select r.workspace_id, x, 'TC', title, body, r.seller_id, r.id from unnest(recipients) as x;
      end if;
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (r.workspace_id, 'deal', r.id, 'contract', title, body);
      if r.seller_id is not null then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
        values (r.workspace_id, 'seller', r.seller_id, 'contract', title, body);
      end if;
      insert into public.option_alerts (workspace_id, deal_id, side, ends_on)
      values (r.workspace_id, r.id, 'seller', r.option_ends_on);
    end if;

    -- Buyer option: dispositions on this contract and the TC.
    if r.buyer_option_ends_on is not null and r.buyer_option_ends_on between today - 1 and today + 3
       and not exists (select 1 from public.option_alerts a where a.deal_id = r.id and a.side = 'buyer' and a.ends_on = r.buyer_option_ends_on) then
      select coalesce(array_agg(distinct q.user_id), '{}') into recipients
      from (
        select r.dispo_rep_id as user_id
        union all select r.tc_rep_id
        union all select dp.user_id from public.deal_parties dp
          where dp.deal_id = r.id and dp.role = 'dispositions' and dp.user_id is not null
        union all select m.user_id from public.workspace_members m
          where m.workspace_id = r.workspace_id and m.role = 'tc'
      ) q
      where q.user_id is not null;
      title := 'Buyer option at risk';
      body := r.addr || ' · buyer option ends ' || to_char(r.buyer_option_ends_on, 'Mon DD, YYYY');
      if cardinality(recipients) > 0 then
        insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
        select r.workspace_id, x, 'TC', title, body, r.seller_id, r.id from unnest(recipients) as x;
      end if;
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (r.workspace_id, 'deal', r.id, 'contract', title, body);
      insert into public.option_alerts (workspace_id, deal_id, side, ends_on)
      values (r.workspace_id, r.id, 'buyer', r.buyer_option_ends_on);
    end if;
  end loop;
end $$;
