-- 39_compr_report_step
--
-- Action plans get a "provider report" step: send the provider Seller report (to
-- the seller) or the provider Buyer report (to the deal's buyer) by text or
-- email. config = { audience: 'seller' | 'buyer', via: 'sms' | 'email' }, and
-- the body carries {{report_link}}, which plan_render_merge leaves in place
-- (it only fills fields it knows) so the record's "Send report" button can
-- fill it with the link the compr-underwrite function mints.
--
-- There is still no scheduler: enrolment queues a task with
-- task_type 'compr_report' (tasks.task_type has no check constraint), and the
-- Next action card on the seller record sends it in one click.

alter table public.action_plan_steps drop constraint if exists action_plan_steps_channel_check;
alter table public.action_plan_steps add constraint action_plan_steps_channel_check
  check (channel in ('sms', 'email', 'call', 'task', 'wait', 'stage', 'tag', 'assign', 'compr_report'));

-- plan_enroll as in 34, plus the compr_report task type and title.
create or replace function public.plan_enroll(p_workspace bigint, p_plan bigint, p_seller bigint, p_actor uuid)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_enr bigint;
  v_seller record;
  v_prop record;
  v_first text;
  v_fields jsonb;
  v_offset integer := 0;
  st record;
  v_title text;
  v_type text;
  v_assignee uuid;
begin
  if exists (select 1 from enrollments where plan_id = p_plan and seller_id = p_seller and status = 'active') then
    return null;
  end if;
  select * into v_seller from sellers where id = p_seller and workspace_id = p_workspace;
  if not found then return null; end if;
  if not exists (select 1 from action_plans where id = p_plan and workspace_id = p_workspace) then return null; end if;

  select line1, city, state, zip into v_prop from properties where id = v_seller.property_id;
  v_first := split_part(btrim(coalesce(v_seller.name, '')), ' ', 1);
  v_fields := jsonb_build_object(
    'first_name', v_first,
    'name', coalesce(v_seller.name, ''),
    'contact_name', coalesce(v_seller.name, ''),
    'address', coalesce(v_prop.line1, v_seller.property_address, ''),
    'city', coalesce(v_prop.city, ''),
    'state', coalesce(v_prop.state, ''),
    'zip', coalesce(v_prop.zip, ''),
    'postal_code', coalesce(v_prop.zip, '')
  );

  insert into enrollments (workspace_id, plan_id, seller_id, created_by)
  values (p_workspace, p_plan, p_seller, p_actor)
  returning id into v_enr;

  for st in select * from action_plan_steps where plan_id = p_plan order by position loop
    v_offset := v_offset + coalesce(st.delay_minutes, 0);
    if st.channel = 'wait' then continue; end if;

    v_type := case st.channel when 'sms' then 'text' when 'call' then 'call' when 'email' then 'email' when 'compr_report' then 'compr_report' else 'todo' end;
    v_title := case st.channel
      when 'sms'    then 'Text ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'call'   then 'Call ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'email'  then 'Email ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'stage'  then 'Move ' || v_first || ' to ' || coalesce(st.config->>'stage', 'stage')
      when 'tag'    then 'Tag ' || v_first || ' "' || coalesce(st.config->>'tag', '') || '"'
      when 'assign' then 'Reassign ' || v_first
      when 'compr_report' then 'Send underwriting ' || case when st.config->>'audience' = 'buyer' then 'buyer' else 'seller' end || ' report' || case when st.config->>'audience' = 'buyer' then ' for ' || v_first else ' to ' || v_first end
      else coalesce(nullif(st.title, ''), 'Follow up with ' || v_first)
    end;

    v_assignee := null;
    begin
      v_assignee := nullif(st.config->>'assignee', '')::uuid;
    exception when others then v_assignee := null;
    end;

    insert into tasks (workspace_id, seller_id, title, task_type, priority, due_at, assigned_to, notes, enrollment_id, plan_step_id, created_by)
    values (
      p_workspace, p_seller, v_title, v_type,
      coalesce(nullif(st.config->>'priority', ''), 'normal'),
      now() + make_interval(mins => v_offset),
      coalesce(v_assignee, v_seller.assigned_to, p_actor),
      plan_render_merge(st.body, v_fields),
      v_enr, st.id, p_actor
    )
    on conflict (enrollment_id, plan_step_id) do nothing;
  end loop;

  return v_enr;
end;
$$;
