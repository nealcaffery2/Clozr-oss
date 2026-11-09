-- 426: one enrollment per person per plan, and never the same plan twice in 30 days.
--
-- Compr workspace, 2026-10-19 to 10-28: 303 people got the "Hi X, my name is
-- Alex" intro two or three times (358 extra texts). Plan 77 held 383
-- duplicate enrollment rows (three rows per buyer at the same second), plan 48
-- 205, plan 78 53; people also got re-enrolled in a plan they had finished a
-- week earlier, and the intro went out again. Every enroll path (the app's
-- bulk enroll, plan_enroll, the Compr sequences, cal-booking) checked only for
-- an *active* row, each in its own way, so the database now refuses instead.
--
-- enrollments_once: BEFORE INSERT. The row is dropped (the insert returns no
-- row, which the app's bulk enroll already reads as "the plan refused them")
-- when the same record is already on that plan (active or paused) or was
-- enrolled in it inside the last 30 days, whatever happened to that run.
-- plan_enroll (101) learns to stop when the insert returned nothing, so no
-- orphan tasks.
--
-- Cleanup: of the duplicate active rows, the lowest id stays; the rest end
-- with stop reason 'duplicate' (plan_enrollment_stopped closes their tasks).
-- Idempotent.

create or replace function public.enrollment_once()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if exists (
    select 1 from enrollments x
     where x.workspace_id = new.workspace_id
       and x.plan_id = new.plan_id
       and x.buyer_id  is not distinct from new.buyer_id
       and x.seller_id is not distinct from new.seller_id
       and x.deal_id   is not distinct from new.deal_id
       and (x.status in ('active', 'paused') or x.enrolled_at > now() - interval '30 days')
  ) then
    return null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists enrollments_once on public.enrollments;
create trigger enrollments_once
  before insert on public.enrollments
  for each row execute function public.enrollment_once();

-- Duplicate active rows already there: keep the first, end the rest.
with ranked as (
  select id, row_number() over (partition by workspace_id, plan_id, buyer_id, seller_id, deal_id order by id) rn
    from enrollments where status in ('active', 'paused')
)
update enrollments e
   set status = 'done', completed_at = now(), stopped_reason = 'duplicate'
  from ranked r
 where r.id = e.id and r.rn > 1;

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
  v_phone text;
  v_lib bigint;
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
  v_phone := nullif(regexp_replace(coalesce(v_seller.phone, ''), '\D', '', 'g'), '');
  if v_phone is not null and length(v_phone) = 10 then v_phone := '1' || v_phone; end if;
  if v_phone is not null and length(v_phone) = 11 and left(v_phone, 1) = '1' then v_phone := '+' || v_phone; else v_phone := null; end if;

  insert into enrollments (workspace_id, plan_id, seller_id, created_by)
  values (p_workspace, p_plan, p_seller, p_actor)
  returning id into v_enr;
  -- enrollments_once (below) can refuse the row: nothing to queue then.
  if v_enr is null then return null; end if;

  for st in select * from action_plan_steps where plan_id = p_plan order by position loop
    v_offset := v_offset + coalesce(st.delay_minutes, 0);
    if st.channel = 'wait' then continue; end if;

    v_type := case st.channel
      when 'sms' then 'text' when 'call' then 'call' when 'email' then 'email'
      when 'compr_report' then 'compr_report' when 'rvm' then 'rvm' else 'todo' end;
    v_title := case st.channel
      when 'sms'    then 'Text ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'call'   then 'Call ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'email'  then 'Email ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
      when 'stage'  then 'Move ' || v_first || ' to ' || coalesce(st.config->>'stage', 'stage')
      when 'tag'    then 'Tag ' || v_first || ' "' || coalesce(st.config->>'tag', '') || '"'
      when 'assign' then 'Reassign ' || v_first
      when 'compr_report' then 'Send Compr ' || case when st.config->>'audience' = 'buyer' then 'buyer' else 'seller' end || ' report' || case when st.config->>'audience' = 'buyer' then ' for ' || v_first else ' to ' || v_first end
      when 'rvm'    then 'RVM ' || v_first || case when st.title is not null and st.title <> '' then ' — ' || st.title else '' end
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

    if st.channel = 'rvm' then
      v_lib := null;
      begin
        v_lib := nullif(st.config->>'library_id', '')::bigint;
      exception when others then v_lib := null;
      end;
      insert into rvm_drops (workspace_id, seller_id, phone_e164, library_id, script, variant_group, scheduled_at, enrollment_id, plan_step_id, created_by)
      values (
        p_workspace, p_seller, v_phone, v_lib,
        plan_render_merge(st.body, v_fields),
        coalesce(nullif(st.config->>'variant_group', ''), 'default'),
        now() + make_interval(mins => v_offset),
        v_enr, st.id, p_actor
      );
    end if;
  end loop;

  return v_enr;
end;
$$;
