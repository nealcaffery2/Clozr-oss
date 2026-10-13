-- 101: a checklist item with no priority no longer blocks the stage change that
-- applies it. deals_apply_stage_checklist runs inside the deal update, and
-- apply_checklist_template copied checklist_template_items.priority (nullable,
-- no default) into tasks.priority (not null, default 'Medium'). Every item of
-- the "Dispo launch" template had none, so moving a deal to Ready To Market
-- failed with `null value in column "priority" of relation "tasks"` and the
-- move was rolled back.
--
-- apply_checklist_template and apply_stage_checklist were created outside the
-- migrations; this is their first definition in the repo. Behaviour is
-- unchanged apart from the priority fallback.

alter table public.checklist_template_items alter column priority set default 'Medium';
update public.checklist_template_items set priority = 'Medium' where priority is null;

create or replace function public.apply_checklist_template(p_deal_id bigint, p_template_id bigint)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare v_ws bigint; n integer := 0;
begin
  select workspace_id into v_ws from public.deals where id = p_deal_id;
  if v_ws is null then raise exception 'deal % not found', p_deal_id; end if;

  insert into public.tasks (workspace_id, deal_id, title, task_type, priority, due_at, notes, created_by)
  select v_ws, p_deal_id, i.title, coalesce(i.task_type, 'checklist'), coalesce(nullif(i.priority, ''), 'Medium'),
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

create or replace function public.apply_stage_checklist()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare v_template bigint;
begin
  if new.stage is distinct from old.stage then
    select id into v_template from public.checklist_templates
     where workspace_id = new.workspace_id and stage = new.stage and auto_apply
     limit 1;
    if v_template is not null then
      perform public.apply_checklist_template(new.id, v_template);
    end if;
  end if;
  return null;
end $function$;
