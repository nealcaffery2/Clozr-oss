-- 130 · A partner's submissions worked one property at a time.
--
-- Institutional partners send a list a day. Each row is a deal on the
-- partner's one contact (migration 49), and its acquisitions stage is
-- deals.lead_stage. Until now only the contact had an underwriter and only the
-- contact's stage notified anyone, so fifty houses from one partner shared one
-- underwriter and one "underwriting complete".
--
--   deals.underwriter_id      who underwrites this submission (no FK, like
--                             sellers.underwriter_id: a departed user leaves a
--                             name the app shows as unknown, not a failed write)
--   deals_submission_notify   the underwriter hears when a submission is theirs
--                             to underwrite; the deal's owner hears when it is
--                             Underwriting Complete or Underwrite Declined, with
--                             the low / high offer when the underwriter set them
--   offer_accepted_to_dispo   Offer Accepted puts the deal on the Dispo board
--                             (Under Contract Seller), gives it the workspace's
--                             TC when it has none, and tells dispositions and TC.
--                             From a submission's stage or a seller lead's.
--
-- The seller's own Underwriting Complete notice (migration 91) also fires on
-- Underwrite Declined now: the rep waiting on the number wants either answer.

alter table public.deals add column if not exists underwriter_id uuid;
create index if not exists deals_underwriter_id_idx on public.deals (workspace_id, underwriter_id) where underwriter_id is not null;

-- ============================================================ the TC
-- The workspace's transaction coordinator: the first member with the tc role
-- (lib/team.ts teamTc reads the same way).
create or replace function public.workspace_tc(p_workspace_id bigint)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.user_id from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.role = 'tc'
   order by m.joined_at, m.user_id limit 1
$$;
revoke all on function public.workspace_tc(bigint) from public, anon, authenticated;

-- ============================================================ Offer Accepted → Dispo
create or replace function public.offer_accepted_to_dispo(p_deal_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.deals;
  v_addr text;
  v_tc uuid;
  v_moved boolean := false;
begin
  select * into d from public.deals where id = p_deal_id;
  if not found then return; end if;
  select nullif(trim(line1), '') into v_addr from public.properties where id = d.property_id;
  v_addr := coalesce(v_addr, 'A property');
  v_tc := public.workspace_tc(d.workspace_id);

  -- A deal still at Prospect (a submission, or a lead's placeholder) joins the
  -- pipeline; one already further along keeps its stage. Written inside a
  -- trigger, so deals_stage_after (depth > 1) leaves the seller's stage alone:
  -- the seller stays at Offer Accepted.
  update public.deals set
    stage = case when coalesce(stage, 'Prospect') = 'Prospect' then 'Under Contract Seller' else stage end,
    tc_rep_id = coalesce(tc_rep_id, v_tc),
    archived_at = null, archived_reason = null
   where id = d.id
  returning (d.stage is distinct from stage) into v_moved;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
  values (d.workspace_id, 'deal', d.id, 'stage',
          case when v_moved then 'Deal opened · Under Contract Seller' else 'Offer accepted' end,
          'Offer accepted on ' || v_addr || '. On the Dispo board'
            || case when coalesce(d.tc_rep_id, v_tc) is not null then ' with a TC.' else '; no TC in the workspace yet.' end);

  -- Dispositions and TC hear about it, once each; the person who moved it does not.
  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
  select d.workspace_id, u.user_id, 'Dispo', 'Offer accepted · ' || v_addr,
         v_addr || ' is under contract with the seller and on the Dispo board.'
           || case when d.offer_amount is not null then ' Contract price $' || to_char(d.offer_amount, 'FM999,999,999') || '.' else '' end,
         d.seller_id, d.id
    from (
      select m.user_id from public.workspace_members m
       where m.workspace_id = d.workspace_id and m.role in ('dispositions', 'tc')
      union
      select coalesce(d.tc_rep_id, v_tc)
      union
      select d.dispo_rep_id
    ) u
   where u.user_id is not null and u.user_id is distinct from auth.uid();
end $$;
revoke all on function public.offer_accepted_to_dispo(bigint) from public, anon, authenticated;

-- ============================================================ a submission's own stage
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
    end if;
  end if;
  return new;
end $$;
revoke all on function public.deals_submission_notify() from public, anon, authenticated;

create or replace trigger deals_submission_notify
  after insert or update of lead_stage, underwriter_id on public.deals
  for each row execute function public.deals_submission_notify();

-- ============================================================ a seller lead's Offer Accepted
-- The lead's open deal, or a new one. A partner contact carrying several open
-- submissions is skipped: which house was accepted is the submission's own
-- stage, not the contact's.
create or replace function public.sellers_offer_accepted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deal bigint;
  v_open int;
begin
  if new.lead_stage is distinct from 'Offer Accepted' or old.lead_stage is not distinct from new.lead_stage then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if;
  select count(*) into v_open from public.deals
   where seller_id = new.id and archived_at is null and stage not in ('Closed', 'Terminated', 'Realtor Referral');
  if v_open > 1 then
    select id into v_deal from public.deals
     where seller_id = new.id and archived_at is null and stage not in ('Closed', 'Terminated', 'Realtor Referral')
       and property_id is not distinct from new.property_id
     order by created_at desc limit 1;
    if v_deal is null then return new; end if;
  elsif v_open = 1 then
    select id into v_deal from public.deals
     where seller_id = new.id and archived_at is null and stage not in ('Closed', 'Terminated', 'Realtor Referral');
  else
    insert into public.deals (workspace_id, seller_id, property_id, stage, offer_amount, owner_id, created_by, source)
    values (new.workspace_id, new.id, new.property_id, 'Prospect', new.asking_price,
            coalesce(new.assigned_to, auth.uid()), coalesce(auth.uid(), new.assigned_to), 'stage')
    returning id into v_deal;
  end if;
  perform public.offer_accepted_to_dispo(v_deal);
  return new;
end $$;
revoke all on function public.sellers_offer_accepted() from public, anon, authenticated;

create or replace trigger sellers_offer_accepted
  after update of lead_stage on public.sellers
  for each row execute function public.sellers_offer_accepted();

-- ============================================================ declined tells the rep too
create or replace function public.notify_underwrite_complete()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_who uuid;
begin
  if tg_op = 'UPDATE'
     and new.lead_stage in ('Underwriting Complete', 'Underwrite Declined')
     and old.lead_stage is distinct from new.lead_stage then
    v_who := coalesce(new.assigned_to, new.created_by);
    if v_who is not null and v_who is distinct from auth.uid() then
      insert into public.notifications (workspace_id, user_id, category, title, body, seller_id)
      values (new.workspace_id, v_who, 'Underwriting',
              case when new.lead_stage = 'Underwriting Complete' then 'Underwriting complete' else 'Underwrite declined' end,
              coalesce(nullif(trim(new.name), ''), 'A submission')
                || case when new.lead_stage = 'Underwriting Complete' then ' is underwriting complete.' else ' was declined in underwriting.' end,
              new.id);
    end if;
  end if;
  return new;
end;
$$;
