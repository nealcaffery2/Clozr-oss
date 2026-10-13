-- 34_action_plan_builder
--
-- The action-plan builder grows up: a plan gets a description, a typed
-- trigger (manual / stage enters X / tag added / new lead / form), a settings
-- document (smart stop on reply / call / stage change, business hours, the
-- tone the AI wrote it in) and a pointer to the plan to enrol in when this
-- one ends. A step gets a delay in minutes relative to the previous step
-- (so a "wait" step is just a step with nothing to do), an email subject and
-- a config document (task priority / assignee, the stage or tag a step sets).
--
-- Enrolment queues tasks (migration 31). What this migration adds is the
-- automation that the database can do on its own, without a scheduler and
-- without a credential CLOZR does not hold:
--
--   * stop:   an inbound text or email, or a connected call, on a seller stops
--             every active enrolment whose plan asked for that (smart stop);
--             a stage change stops the ones that asked for that;
--   * start:  a seller entering a stage, gaining a tag, or being created
--             enrols them in the active plans triggered by it;
--   * chain:  when the last queued task of an enrolment is completed the
--             enrolment is done, and if the plan names a next plan the seller
--             goes straight onto it.
--
-- `plan_enroll` is the SQL twin of lib/crm-write.ts enrollInPlan and writes
-- the same task rows (same conflict target, same merge fields), so a plan
-- started by a trigger looks exactly like one started by hand.

-- ---- columns ----------------------------------------------------------------

alter table public.action_plans
  add column if not exists description text,
  add column if not exists trigger_type text not null default 'manual',
  add column if not exists trigger_value text,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists on_end_next_plan_id bigint references public.action_plans(id) on delete set null;

alter table public.action_plans drop constraint if exists action_plans_trigger_type_check;
alter table public.action_plans add constraint action_plans_trigger_type_check
  check (trigger_type in ('manual', 'stage', 'tag', 'new_lead', 'form'));

create index if not exists action_plans_trigger_idx
  on public.action_plans (workspace_id, trigger_type, trigger_value) where active;
create index if not exists action_plans_on_end_next_plan_id_idx
  on public.action_plans (on_end_next_plan_id);

alter table public.action_plan_steps
  add column if not exists delay_minutes integer not null default 0,
  add column if not exists subject text,
  add column if not exists config jsonb not null default '{}'::jsonb;

alter table public.action_plan_steps drop constraint if exists action_plan_steps_channel_check;
alter table public.action_plan_steps add constraint action_plan_steps_channel_check
  check (channel in ('sms', 'email', 'call', 'task', 'wait', 'stage', 'tag', 'assign'));

-- delay_hours was "hours since enrolment"; delay_minutes is "minutes since the
-- previous step". Existing rows convert by differencing along the sequence.
-- delay_hours is kept, and kept cumulative, because lib/crm.ts still reads it.
with c as (
  select id,
         greatest(0, delay_hours - coalesce(lag(delay_hours) over (partition by plan_id order by position), 0)) * 60 as m
  from public.action_plan_steps
)
update public.action_plan_steps s set delay_minutes = c.m from c where c.id = s.id;

alter table public.enrollments
  add column if not exists stopped_reason text;

create index if not exists enrollments_seller_active_idx
  on public.enrollments (seller_id) where status = 'active';
create index if not exists tasks_enrollment_open_idx
  on public.tasks (enrollment_id) where not done;

-- ---- merge fields, in SQL -----------------------------------------------------

-- The same fields lib/sms.ts fills, both brace styles, unknown fields left as
-- typed. Only the fields a seller row can answer; the rep's own fields are
-- filled when the message is actually sent.
create or replace function public.plan_render_merge(body text, fields jsonb)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  k text;
  v text;
  out_text text := body;
begin
  if body is null then return null; end if;
  for k, v in select key, value from jsonb_each_text(fields) loop
    out_text := regexp_replace(out_text, '\{\{?\s*' || k || '\s*\}?\}', coalesce(v, ''), 'gi');
  end loop;
  return btrim(regexp_replace(regexp_replace(out_text, '[ \t]{2,}', ' ', 'g'), '\s+([,.;:!?])', '\1', 'g'));
end;
$$;

-- ---- enrol ---------------------------------------------------------------------

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

    v_type := case st.channel when 'sms' then 'text' when 'call' then 'call' when 'email' then 'email' else 'todo' end;
    v_title := case st.channel
      when 'sms'    then 'Text ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'call'   then 'Call ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'email'  then 'Email ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'stage'  then 'Move ' || v_first || ' to ' || coalesce(st.config->>'stage', 'stage')
      when 'tag'    then 'Tag ' || v_first || ' "' || coalesce(st.config->>'tag', '') || '"'
      when 'assign' then 'Reassign ' || v_first
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

-- ---- stop ----------------------------------------------------------------------

create or replace function public.plan_stop_enrollment(p_enr bigint, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update enrollments set status = 'done', completed_at = now(), stopped_reason = p_reason
  where id = p_enr and status = 'active';
  if found then
    delete from tasks where enrollment_id = p_enr and not done;
  end if;
end;
$$;

-- ---- triggers ------------------------------------------------------------------

-- A reply or a connected call: smart stop.
create or replace function public.plan_on_communication()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_key text;
  e record;
begin
  if new.seller_id is null then return new; end if;
  if new.direction = 'inbound' and new.channel in ('sms', 'text', 'email') then
    v_key := 'stop_on_reply';
  elsif new.channel = 'call' and coalesce(new.duration_s, 0) > 0 then
    v_key := 'stop_on_call';
  else
    return new;
  end if;
  for e in
    select en.id from enrollments en join action_plans p on p.id = en.plan_id
    where en.seller_id = new.seller_id and en.status = 'active'
      and coalesce((p.settings ->> v_key)::boolean, false)
  loop
    perform plan_stop_enrollment(e.id, case v_key when 'stop_on_reply' then 'reply' else 'call' end);
  end loop;
  return new;
end;
$$;

drop trigger if exists plan_on_communication on public.communications;
create trigger plan_on_communication
  after insert on public.communications
  for each row execute function public.plan_on_communication();

-- A stage change or a new tag: stop what asked to stop, start what it triggers.
create or replace function public.plan_on_seller_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  e record;
  p record;
begin
  if tg_op = 'INSERT' then
    for p in select id from action_plans where workspace_id = new.workspace_id and active and trigger_type = 'new_lead' loop
      perform plan_enroll(new.workspace_id, p.id, new.id, new.created_by);
    end loop;
    return new;
  end if;

  if new.lead_stage is distinct from old.lead_stage then
    for e in
      select en.id from enrollments en join action_plans pl on pl.id = en.plan_id
      where en.seller_id = new.id and en.status = 'active'
        and coalesce((pl.settings ->> 'stop_on_stage')::boolean, false)
    loop
      perform plan_stop_enrollment(e.id, 'stage');
    end loop;
    for p in
      select id from action_plans
      where workspace_id = new.workspace_id and active and trigger_type = 'stage' and trigger_value = new.lead_stage
    loop
      perform plan_enroll(new.workspace_id, p.id, new.id, null);
    end loop;
  end if;

  if new.tags is distinct from old.tags then
    for p in
      select id from action_plans
      where workspace_id = new.workspace_id and active and trigger_type = 'tag'
        and trigger_value = any(new.tags) and not (trigger_value = any(coalesce(old.tags, '{}')))
    loop
      perform plan_enroll(new.workspace_id, p.id, new.id, null);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists plan_on_seller_change on public.sellers;
create trigger plan_on_seller_change
  after insert or update of lead_stage, tags on public.sellers
  for each row execute function public.plan_on_seller_change();

-- The last task done: the enrolment is done, and the next plan starts.
create or replace function public.plan_on_task_done()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  r record;
  v_next bigint;
begin
  if new.enrollment_id is null or not new.done or old.done then return new; end if;
  update enrollments
    set step_index = (select count(*) from tasks where enrollment_id = new.enrollment_id and done)
    where id = new.enrollment_id;
  if not exists (select 1 from tasks where enrollment_id = new.enrollment_id and not done) then
    update enrollments set status = 'done', completed_at = now()
      where id = new.enrollment_id and status = 'active'
      returning workspace_id, plan_id, seller_id into r;
    if found and r.seller_id is not null then
      select on_end_next_plan_id into v_next from action_plans where id = r.plan_id;
      if v_next is not null then
        perform plan_enroll(r.workspace_id, v_next, r.seller_id, new.assigned_to);
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists plan_on_task_done on public.tasks;
create trigger plan_on_task_done
  after update of done on public.tasks
  for each row execute function public.plan_on_task_done();

-- ---- grants ----------------------------------------------------------------------
-- Migrations 10 and 14: a new function in public is callable by anon and
-- authenticated through PUBLIC until told otherwise. These run from triggers
-- and nothing else.
revoke execute on function public.plan_render_merge(text, jsonb) from public, anon, authenticated;
revoke execute on function public.plan_enroll(bigint, bigint, bigint, uuid) from public, anon, authenticated;
revoke execute on function public.plan_stop_enrollment(bigint, text) from public, anon, authenticated;
revoke execute on function public.plan_on_communication() from public, anon, authenticated;
revoke execute on function public.plan_on_seller_change() from public, anon, authenticated;
revoke execute on function public.plan_on_task_done() from public, anon, authenticated;
