-- 191 · Deal tracker fields fill themselves; checklist tasks carry the seller.
--
-- Property # (tracker_no): next number in the workspace when a deal leaves
-- Prospect / New Lead for the pipeline. Lead source copies the seller's source
-- when blank. Contract status follows the deal stage (the Deals table and sheet
-- formulas read one thing). Checklist tasks insert with deals.seller_id, and
-- existing deal-only tasks get that seller backfilled.

-- Checklist / stage tasks: hang on the seller as well as the deal.
create or replace function public.apply_checklist_template(p_deal_id bigint, p_template_id bigint)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare v_ws bigint; v_seller bigint; n integer := 0;
begin
  select workspace_id, seller_id into v_ws, v_seller from public.deals where id = p_deal_id;
  if v_ws is null then raise exception 'deal % not found', p_deal_id; end if;

  insert into public.tasks (workspace_id, deal_id, seller_id, title, task_type, priority, due_at, notes, created_by)
  select v_ws, p_deal_id, v_seller, i.title, coalesce(i.task_type, 'checklist'), coalesce(nullif(i.priority, ''), 'Medium'),
         case when i.due_offset_days is not null
              then now() + make_interval(days => i.due_offset_days) end,
         i.notes, auth.uid()
  from public.checklist_template_items i
  where i.template_id = p_template_id
    and not exists (
      select 1 from public.tasks t
      where t.deal_id = p_deal_id and lower(t.title) = lower(i.title) and not t.done)
  order by i.position;
  get diagnostics n = row_count;
  return n;
end $function$;

-- Existing checklist rows that only had deal_id.
update public.tasks t
   set seller_id = d.seller_id
  from public.deals d
 where t.deal_id = d.id
   and t.seller_id is null
   and d.seller_id is not null;

-- Auto Property #, lead source, and contract status = stage.
create or replace function public.deals_tracker_autofill()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare v_next integer;
begin
  -- Lead source from the seller when the deal has none.
  if new.lead_source is null and new.seller_id is not null then
    select nullif(trim(source), '') into new.lead_source
      from public.sellers where id = new.seller_id;
  end if;

  -- Contract status is the stage (Prospect stays blank / as-typed).
  if new.stage is not null
     and new.stage not in ('Prospect', 'New Lead')
     and (tg_op = 'INSERT' or new.stage is distinct from old.stage or new.contract_status is null) then
    new.contract_status := new.stage;
  end if;

  -- Property #: first pipeline stage that still has no number.
  if new.tracker_no is null
     and new.stage is not null
     and new.stage not in ('Prospect', 'New Lead') then
    select coalesce(max(tracker_no), 0) + 1 into v_next
      from public.deals where workspace_id = new.workspace_id;
    new.tracker_no := v_next;
  end if;

  return new;
end $function$;

drop trigger if exists deals_tracker_autofill on public.deals;
create trigger deals_tracker_autofill
  before insert or update of stage, seller_id, lead_source, contract_status, tracker_no
  on public.deals
  for each row execute function public.deals_tracker_autofill();

-- Backfill: pipeline deals missing a Property # get one in id order per workspace.
with ranked as (
  select id, workspace_id,
         row_number() over (partition by workspace_id order by id)
           + coalesce((select max(tracker_no) from public.deals d2 where d2.workspace_id = d.workspace_id), 0) as n
    from public.deals d
   where tracker_no is null
     and stage is not null
     and stage not in ('Prospect', 'New Lead')
)
update public.deals d
   set tracker_no = ranked.n
  from ranked
 where d.id = ranked.id;

-- Lead source from the seller where still blank.
update public.deals d
   set lead_source = nullif(trim(s.source), '')
  from public.sellers s
 where d.seller_id = s.id
   and d.lead_source is null
   and nullif(trim(s.source), '') is not null;

-- Contract status follows stage for pipeline deals that never got one.
update public.deals
   set contract_status = stage
 where (contract_status is null or contract_status = '')
   and stage is not null
   and stage not in ('Prospect', 'New Lead');
