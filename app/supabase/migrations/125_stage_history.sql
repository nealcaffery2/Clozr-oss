-- Stage history: every stage a seller, a deal or a buyer has been in, when,
-- and who moved it.
--
-- Until now a record kept only the stage it is in. stage_entered_at said when
-- the current one started, the activity log said "Stage → X" (never the stage
-- before it, and with no author whenever a trigger or a webhook moved it), and
-- a buyer's stage left no trace at all. So "everyone we ever made an offer to"
-- could not be asked: Susy went Lead (Aug 1), Offer Made (Aug 15), Under
-- Contract (Aug 30), and a filter on Offer Made only finds people who are
-- still there.
--
-- Triggers write the history, so a change from any path lands in it: a screen,
-- a bulk move, the seller/deal sync, e-sign, an import. changed_by is
-- auth.uid(), the signed-in user behind the request; a change no user made (a
-- webhook, the cron, an edge function on the service key) has none and reads
-- as System. Same pattern as deal_price_changes (migration 48).

create table if not exists public.stage_events (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  entity_type  text not null check (entity_type in ('seller', 'deal', 'buyer')),
  entity_id    bigint not null,
  -- sellers.lead_stage, deals.stage (the pipeline), deals.lead_stage (a
  -- submission's acquisitions stage), buyers.status.
  field        text not null check (field in ('lead_stage', 'stage', 'status')),
  from_stage   text,
  to_stage     text not null,
  changed_at   timestamptz not null default now(),
  changed_by   uuid,
  -- 'backfill' rows were rebuilt from what the database already held when this
  -- shipped; their dates are the best one on file (see below), not a clock.
  source       text not null default 'live' check (source in ('live', 'backfill'))
);
create index if not exists stage_events_entity_idx on public.stage_events (entity_type, entity_id, changed_at desc);
create index if not exists stage_events_stage_idx on public.stage_events (workspace_id, entity_type, to_stage, changed_at);

alter table public.stage_events enable row level security;
drop policy if exists stage_events_select on public.stage_events;
create policy stage_events_select on public.stage_events for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.stage_events to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill, once. Every row is marked 'backfill'.
--   1. The activity log's "Stage → X" (sellers) and "Deal → X" (deals), with
--      the rep when the app wrote it.
--   2. Each seller's current stage, at stage_entered_at.
--   3. Each deal's submission ("New Submission" at submitted_at), its current
--      acquisitions stage, and Offer Made wherever an offer amount is on the
--      deal: 2,800 Podio submissions carry an offer whose stage has since moved
--      on to Declined or Accepted. Podio kept no stage dates, so these sit on
--      the submission date, a second apart so they read in the order they
--      happened.
--   4. Each deal's pipeline milestones from the dates the stage trigger has
--      always stamped: contract_date, marketing_started_on, closed_on,
--      terminated_on; then its current pipeline stage at stage_entered_at.
-- Buyers start empty: the only thing on file is the stage they are in now.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.stage_events where source = 'backfill') then return; end if;

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, changed_by, source)
  select a.workspace_id, a.entity_type, a.entity_id,
         case a.entity_type when 'seller' then 'lead_stage' else 'stage' end,
         btrim(x.m[1]), a.occurred_at, a.actor_id, 'backfill'
    from public.activity a
   cross join lateral (select regexp_match(a.title, '^(?:Stage|Deal) → (.+)$') as m) x
   where a.kind = 'stage' and a.entity_type in ('seller', 'deal') and x.m is not null;

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, source)
  select s.workspace_id, 'seller', s.id, 'lead_stage', s.lead_stage, coalesce(s.stage_entered_at, s.created_at), 'backfill'
    from public.sellers s
   where s.lead_stage is not null
     and not exists (select 1 from public.stage_events e
                      where e.entity_type = 'seller' and e.entity_id = s.id and e.to_stage = s.lead_stage);

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, source)
  select d.workspace_id, 'deal', d.id, 'lead_stage', 'New Submission', d.submitted_at, 'backfill'
    from public.deals d where d.submitted_at is not null;

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, source)
  select d.workspace_id, 'deal', d.id, 'lead_stage', 'Offer Made', coalesce(d.submitted_at, d.created_at) + interval '1 second', 'backfill'
    from public.deals d
   where d.offer_amount is not null and d.lead_stage is distinct from 'Offer Made';

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, source)
  select d.workspace_id, 'deal', d.id, 'lead_stage', d.lead_stage, coalesce(d.submitted_at, d.created_at) + interval '2 seconds', 'backfill'
    from public.deals d
   where d.lead_stage is not null and d.lead_stage <> 'New Submission';

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, source)
  select d.workspace_id, 'deal', d.id, 'stage', m.stage, m.at, 'backfill'
    from public.deals d
   cross join lateral (values
     ('Under Contract Seller', d.contract_date::timestamptz),
     ('Ready To Market', d.marketing_started_on::timestamptz),
     ('Closed', d.closed_on::timestamptz),
     ('Terminated', d.terminated_on::timestamptz)
   ) as m(stage, at)
   where m.at is not null
     and not exists (select 1 from public.stage_events e
                      where e.entity_type = 'deal' and e.entity_id = d.id and e.field = 'stage' and e.to_stage = m.stage);

  insert into public.stage_events (workspace_id, entity_type, entity_id, field, to_stage, changed_at, source)
  select d.workspace_id, 'deal', d.id, 'stage', d.stage, coalesce(d.stage_entered_at, d.created_at), 'backfill'
    from public.deals d
   where d.stage is not null and d.stage <> 'Prospect'
     and not exists (select 1 from public.stage_events e
                      where e.entity_type = 'deal' and e.entity_id = d.id and e.field = 'stage' and e.to_stage = d.stage);
end $$;

-- ---------------------------------------------------------------------------
-- The triggers. AFTER, so the stage written is the one the BEFORE triggers
-- normalised. A buyer row is only logged on update: 139k buyers arrive by
-- import at the default stage, and that is not a move.
-- ---------------------------------------------------------------------------
create or replace function public.stage_events_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare ins boolean := tg_op = 'INSERT';
begin
  if tg_table_name = 'sellers' then
    if new.lead_stage is not null and (ins or new.lead_stage is distinct from old.lead_stage) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'seller', new.id, 'lead_stage', case when ins then null else old.lead_stage end, new.lead_stage, auth.uid());
    end if;
  elsif tg_table_name = 'deals' then
    -- Prospect is where every deal starts; reaching it is not a stage move.
    if new.stage is not null and ((ins and new.stage <> 'Prospect') or (not ins and new.stage is distinct from old.stage)) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'deal', new.id, 'stage', case when ins then null else old.stage end, new.stage, auth.uid());
    end if;
    if new.lead_stage is not null and (ins or new.lead_stage is distinct from old.lead_stage) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'deal', new.id, 'lead_stage', case when ins then null else old.lead_stage end, new.lead_stage, auth.uid());
    end if;
  elsif tg_table_name = 'buyers' then
    -- Older rows say 'active', newer ones 'Active': a change of case is not a move.
    if new.status is not null and lower(new.status) is distinct from lower(old.status) then
      insert into public.stage_events (workspace_id, entity_type, entity_id, field, from_stage, to_stage, changed_by)
      values (new.workspace_id, 'buyer', new.id, 'status', old.status, new.status, auth.uid());
    end if;
  end if;
  return null;
end $$;
revoke all on function public.stage_events_log() from public, anon, authenticated;

drop trigger if exists stage_events_seller on public.sellers;
create trigger stage_events_seller after insert or update of lead_stage on public.sellers
  for each row execute function public.stage_events_log();
drop trigger if exists stage_events_deal on public.deals;
create trigger stage_events_deal after insert or update of stage, lead_stage on public.deals
  for each row execute function public.stage_events_log();
drop trigger if exists stage_events_buyer on public.buyers;
create trigger stage_events_buyer after update of status on public.buyers
  for each row execute function public.stage_events_log();

-- ---------------------------------------------------------------------------
-- Reads.
-- ---------------------------------------------------------------------------

-- A deal's pipeline stage in the seller's words, the mapping deals_stage_after uses.
create or replace function public.deal_stage_as_seller_stage(p_stage text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case p_stage
    when 'Under Contract Seller' then 'Under Contract - Seller'
    when 'Ready To Market'       then 'Under Contract - Seller'
    when 'Buyer Under Contract'  then 'Under Contract - Buyer'
    when 'In Escrow'             then 'Under Contract - Buyer'
    when 'Closed'                then 'Closed'
    when 'Terminated'            then 'Terminated'
    when 'Realtor Referral'      then 'Referred to Realtor'
  end;
$$;

-- Who has ever been at a stage, optionally only when they reached it inside a
-- window. People: the seller's own moves and every one of their deals' (a
-- partner contact is "ever Offer Made" when any submission was), returned as
-- sellers and as deals so the submission lists match row by row. Buyers:
-- their moves, plus, for "ever" with no window, everyone sitting at that stage
-- now (buyers have no backfilled history). The realtor corpus is never in it.
create or replace function public.stage_history_ids(
  p_workspace_id bigint, p_entity text, p_stage text, p_from timestamptz default null, p_to timestamptz default null
) returns table (kind text, id bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with ok as (select public.is_workspace_member(p_workspace_id) as yes),
  ev as (
    select e.entity_type, e.entity_id, e.field, e.from_stage, e.to_stage
      from public.stage_events e, ok
     where ok.yes and e.workspace_id = p_workspace_id
       and (p_from is null or e.changed_at >= p_from)
       and (p_to is null or e.changed_at < p_to)
  ),
  seller_hits as (
    select ev.entity_id as id from ev
     where p_entity = 'seller' and ev.entity_type = 'seller' and ev.to_stage = p_stage
  ),
  deal_hits as (
    select ev.entity_id as id from ev
     where p_entity = 'seller' and ev.entity_type = 'deal'
       and (ev.to_stage = p_stage or (ev.field = 'stage' and public.deal_stage_as_seller_stage(ev.to_stage) = p_stage))
  )
  select 'seller', id from seller_hits
  union
  select 'deal', id from deal_hits
  union
  select 'seller', d.seller_id from public.deals d join deal_hits h on h.id = d.id where d.seller_id is not null
  union
  select 'buyer', ev.entity_id from ev
   where p_entity = 'buyer' and ev.entity_type = 'buyer'
     and (lower(ev.to_stage) = lower(p_stage)
       -- No history was rebuilt for buyers, so the stage a buyer left is
       -- the only record that they were ever in it.
       or (p_from is null and p_to is null and lower(ev.from_stage) = lower(p_stage)))
  union
  select 'buyer', b.id from public.buyers b, ok
   where ok.yes and p_entity = 'buyer' and p_from is null and p_to is null
     and b.workspace_id = p_workspace_id and lower(coalesce(b.status, 'active')) = lower(p_stage)
     and coalesce(b.source, '') <> 'dispogenius-free-agents';
$$;
revoke all on function public.stage_history_ids(bigint, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.stage_history_ids(bigint, text, text, timestamptz, timestamptz) to authenticated;

-- One record's history for its timeline: a seller's own moves and its deals'
-- (each named by its street), or a buyer's. Newest first. Read as the caller,
-- so RLS on stage_events and deals decides what comes back.
create or replace function public.record_stage_history(p_workspace_id bigint, p_entity text, p_id bigint)
returns table (id bigint, entity_type text, entity_id bigint, field text, from_stage text, to_stage text,
               changed_at timestamptz, changed_by uuid, source text, deal_label text)
language sql stable set search_path = public, pg_temp as $$
  select e.id, e.entity_type, e.entity_id, e.field, e.from_stage, e.to_stage, e.changed_at, e.changed_by, e.source,
         case when e.entity_type = 'deal' then p.line1 end
    from public.stage_events e
    left join public.deals d on e.entity_type = 'deal' and d.id = e.entity_id
    left join public.properties p on p.id = d.property_id
   where e.workspace_id = p_workspace_id
     and ((e.entity_type = p_entity and e.entity_id = p_id)
       or (p_entity = 'seller' and e.entity_type = 'deal'
           and e.entity_id in (select x.id from public.deals x where x.seller_id = p_id and x.workspace_id = p_workspace_id)))
   order by e.changed_at desc, e.id desc
   limit 400;
$$;
revoke all on function public.record_stage_history(bigint, text, bigint) from public, anon;
grant execute on function public.record_stage_history(bigint, text, bigint) to authenticated;

-- Submissions and outcomes per wholesaler/partner vendor (migration 91 keeps
-- them current) are read by the Vendors list; nothing else changes here.
