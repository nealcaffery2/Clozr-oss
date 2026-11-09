-- 436: saving a plan keeps its steps.
--
-- Saving a plan (lib/plans.ts savePlanDraft, lib/crm-write.ts savePlan)
-- deleted every step and then inserted the new list in a second request. A
-- failed insert left the plan with no steps, and every save gave the steps
-- new ids, so the queued tasks and RVM drops of people already running the
-- plan (tasks.plan_step_id, rvm_drops.plan_step_id) lost the step they were
-- queued for.
--
-- plan_replace_steps(p_plan, p_steps) does the save in one transaction. Step
-- i of p_steps (a JSON array of {channel, delay_minutes, delay_hours, title,
-- body, subject, config}) updates the step already at position i in place,
-- so its id stays; a position the plan did not have yet is inserted; steps
-- past the new length (and any second row at one position) are deleted. A
-- missing subject is null and a missing config is {}, as the old insert left
-- them. Security invoker: the caller's row policies apply, as they did to the
-- requests it replaces. The plan row is locked so two saves take turns.
-- Safe to re-run.

create or replace function public.plan_replace_steps(p_plan bigint, p_steps jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_ws bigint;
  v_keep bigint[] := '{}';
  v_id bigint;
  v_kept integer := 0;
  v_added integer := 0;
  v_removed integer := 0;
  r record;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'steps must be a JSON array';
  end if;
  select workspace_id into v_ws from public.action_plans where id = p_plan for update;
  if v_ws is null then
    raise exception 'plan not found';
  end if;

  for r in
    select e.value as s, (e.ord - 1)::integer as pos
      from jsonb_array_elements(p_steps) with ordinality as e(value, ord)
     order by e.ord
  loop
    v_id := null;
    select st.id into v_id from public.action_plan_steps st
     where st.plan_id = p_plan and st.position = r.pos and not (st.id = any(v_keep))
     order by st.id
     limit 1;
    if v_id is not null then
      update public.action_plan_steps set
        channel = r.s->>'channel',
        delay_minutes = coalesce(round((r.s->>'delay_minutes')::numeric), 0)::integer,
        delay_hours = coalesce(round((r.s->>'delay_hours')::numeric), 0)::integer,
        title = r.s->>'title',
        body = r.s->>'body',
        subject = r.s->>'subject',
        config = coalesce(case when jsonb_typeof(r.s->'config') = 'object' then r.s->'config' end, '{}'::jsonb)
       where id = v_id;
      v_kept := v_kept + 1;
    else
      insert into public.action_plan_steps
        (workspace_id, plan_id, position, channel, delay_minutes, delay_hours, title, body, subject, config)
      values (
        v_ws, p_plan, r.pos, r.s->>'channel',
        coalesce(round((r.s->>'delay_minutes')::numeric), 0)::integer,
        coalesce(round((r.s->>'delay_hours')::numeric), 0)::integer,
        r.s->>'title', r.s->>'body', r.s->>'subject',
        coalesce(case when jsonb_typeof(r.s->'config') = 'object' then r.s->'config' end, '{}'::jsonb))
      returning id into v_id;
      v_added := v_added + 1;
    end if;
    v_keep := v_keep || v_id;
  end loop;

  with d as (
    delete from public.action_plan_steps
     where plan_id = p_plan and not (id = any(v_keep))
     returning id)
  select count(*) into v_removed from d;

  return jsonb_build_object('kept', v_kept, 'added', v_added, 'removed', v_removed);
end $$;
revoke all on function public.plan_replace_steps(bigint, jsonb) from public, anon;
grant execute on function public.plan_replace_steps(bigint, jsonb) to authenticated, service_role;
