-- One sequence per person: an action plan and an AI agent never run on the
-- same record at once.
--
-- A seller could be on an action plan (a rep's, or the one "AI plan from
-- this lead" wrote) and have Riley switched on with its own plan, so two
-- sequences texted and emailed the same person. Now the newer one wins:
--   * starting an action plan stops the record's running AI agent;
--   * switching an AI agent on (or Autopilot enrolling the record) ends the
--     record's running action plan and removes its open tasks.
-- Either way the record's Activity says what took over.

create or replace function public.plan_started_stops_ai_agent()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_kind text := case when new.seller_id is not null then 'seller' when new.buyer_id is not null then 'buyer' end;
  v_id bigint := coalesce(new.seller_id, new.buyer_id);
  v_plan text;
  v_n int;
begin
  if v_kind is null or new.status = 'done' then return null; end if;
  select name into v_plan from public.action_plans where id = new.plan_id;
  update public.ai_agent_enrollments
     set status = 'stopped', stop_reason = 'action plan started: ' || coalesce(v_plan, 'a plan'),
         stopped_at = now(), stopped_by = new.created_by, next_action_at = null, updated_at = now()
   where workspace_id = new.workspace_id and record_kind = v_kind and record_id = v_id and status in ('active', 'paused');
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
    values (new.workspace_id, v_kind, v_id, 'ai_agent', 'AI agent stopped: an action plan took over',
            'The action plan "' || coalesce(v_plan, '') || '" was started, so the AI agent stopped. One sequence runs at a time.', new.created_by, now());
  end if;
  return null;
end $function$;

drop trigger if exists enrollments_stop_ai_agent on public.enrollments;
create trigger enrollments_stop_ai_agent after insert on public.enrollments
  for each row execute function public.plan_started_stops_ai_agent();

create or replace function public.ai_agent_started_ends_plan()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  v_n int := 0;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return null; end if;
  for r in
    select e.id, p.name from public.enrollments e left join public.action_plans p on p.id = e.plan_id
     where e.workspace_id = new.workspace_id and e.status <> 'done'
       and ((new.record_kind = 'seller' and e.seller_id = new.record_id) or (new.record_kind = 'buyer' and e.buyer_id = new.record_id))
  loop
    update public.enrollments set status = 'done', completed_at = now(), stopped_reason = 'ai_agent' where id = r.id;
    delete from public.tasks where enrollment_id = r.id and not done;
    v_n := v_n + 1;
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
    values (new.workspace_id, new.record_kind, new.record_id, 'ai_agent', 'Action plan stopped: the AI agent took over',
            'The AI agent ' || initcap(replace(new.agent_key, '_', ' ')) || ' was switched on, so the action plan "' || coalesce(r.name, '') || '" stopped and its open tasks were removed. One sequence runs at a time.',
            new.started_by, now());
  end loop;
  return null;
end $function$;

drop trigger if exists ai_agent_enrollments_end_plan on public.ai_agent_enrollments;
create trigger ai_agent_enrollments_end_plan after insert or update of status on public.ai_agent_enrollments
  for each row execute function public.ai_agent_started_ends_plan();
