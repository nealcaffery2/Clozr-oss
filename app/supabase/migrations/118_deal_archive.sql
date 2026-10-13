-- Archiving deals (Deals board, deal list, Dispo, the seller's record).
--
-- An archived deal leaves every board and list; the Archived view brings it
-- back. Archiving is reversible and never deletes anything.
--
-- Automatic, both ways:
--   * a deal moved to Terminated is archived; moved off it again it comes
--     back, when that is why it was archived (deals_stage_before);
--   * a seller moved to Memo Filed / Legal, Terminated or a Cancelled stage
--     archives that seller's open deals (sellers_stage_after).
-- The client asks before cascading anything else (archive the seller too?).
--
-- Applied to the live project in pieces: a new trigger on deals could not take
-- its lock in time, so the rules live in the two stage trigger functions that
-- already run, replaced here (no table lock needed).

alter table public.deals
  add column if not exists archived_at timestamptz,
  add column if not exists archived_reason text;

CREATE OR REPLACE FUNCTION public.deals_stage_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.stage := public.normalize_deal_stage(new.stage);
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    if tg_op = 'UPDATE' then new.stage_entered_at := now(); end if;
    if new.stage = 'Under Contract Seller' and new.contract_date is null then new.contract_date := current_date; end if;
    if new.stage = 'Ready To Market' and new.marketing_started_on is null then new.marketing_started_on := current_date; end if;
    if new.stage = 'Closed' and new.closed_on is null then new.closed_on := current_date; end if;
    if new.stage = 'Terminated' then
      new.terminated := true;
      if new.terminated_on is null then new.terminated_on := current_date; end if;
      -- Migration 118: a terminated deal goes to the archive.
      if new.archived_at is null then new.archived_at := now(); new.archived_reason := 'Terminated'; end if;
    elsif tg_op = 'UPDATE' and old.stage = 'Terminated' and new.archived_reason = 'Terminated' then
      -- Brought back from Terminated: it was archived for that, so it comes back too.
      new.archived_at := null; new.archived_reason := null;
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.sellers_stage_after()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  target text;
  d record;
  new_deal_id bigint;
begin
  if tg_op = 'UPDATE' and new.lead_stage is not distinct from old.lead_stage then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if;
  -- Migration 118: a seller gone to legal, terminated or cancelled takes their open deals to the archive.
  if tg_op = 'UPDATE' and new.lead_stage ~* '^(memo filed|legal|terminated|cancel)' then
    update public.deals set archived_at = now(), archived_reason = new.lead_stage
     where seller_id = new.id and workspace_id = new.workspace_id and archived_at is null and stage is distinct from 'Closed';
  end if;
  select deal_stage into target from public.seller_stages where label = new.lead_stage;
  if target is null then return new; end if;

  -- The seller's live deal, else the most recent one.
  select id, stage into d from public.deals
  where seller_id = new.id
  order by (stage in ('Closed','Terminated','Realtor Referral')) asc, created_at desc
  limit 1;

  if d.id is null or (d.stage in ('Closed','Terminated','Realtor Referral') and target in ('Under Contract Seller','Buyer Under Contract')) then
    if target in ('Under Contract Seller','Buyer Under Contract') then
      -- Seller under contract ⇒ a deal exists in active dispo inventory.
      insert into public.deals (workspace_id, seller_id, property_id, stage, offer_amount, owner_id, created_by, source, contract_date)
      values (new.workspace_id, new.id, new.property_id, target, new.asking_price, new.assigned_to, new.assigned_to, 'stage', current_date)
      returning id into new_deal_id;
      insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
      values (new.workspace_id, 'deal', new_deal_id, 'stage', 'Deal opened · ' || target, 'Created when the seller moved to ' || new.lead_stage);
    end if;
  elsif d.stage is distinct from target then
    update public.deals set stage = target where id = d.id;
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
    values (new.workspace_id, 'deal', d.id, 'stage', 'Deal → ' || target, 'Followed the seller moving to ' || new.lead_stage);
  end if;
  return new;
end $function$;

-- Deals already terminated, or whose seller already is, go to the archive now.
update public.deals set archived_at = now(), archived_reason = 'Terminated'
 where stage = 'Terminated' and archived_at is null;
update public.deals d set archived_at = now(), archived_reason = s.lead_stage
  from public.sellers s
 where s.id = d.seller_id and d.archived_at is null and d.stage is distinct from 'Closed' and d.stage <> 'Terminated'
   and s.lead_stage ~* '^(memo filed|legal|terminated|cancel)';
