-- 284: action plans send the steps they already queue.
--
-- Enrolment writes dated tasks and stops there. A due email or text sat on
-- the list until a person pressed send, a tag step became a to-do, a ringless
-- drop logged a communication and left its task open (so the sequence never
-- moved on), and starting an AI-agent step wrote no activity line.
--
-- plan-tick (service role, verify_jwt on) claims due email, text, tag, assign
-- and stage tasks on plans that set settings.auto_send true. Calls and manual
-- tasks stay on the list. A prospect email goes through the warmed cold pool
-- (plan-tick). A customer email goes through the workspace Resend sender.
-- After this is applied and plan-tick is deployed, due auto-send steps send
-- on the next minute.

alter table public.tasks add column if not exists plan_claim_at timestamptz;

create index if not exists tasks_plan_due_idx
  on public.tasks (due_at)
  where done = false and plan_step_id is not null;

-- The same due rule as plan_kick. A claim older than 10 minutes is free again
-- (the tick died). Two ticks never take the same task.
create or replace function public.plan_send_claim(p_limit integer default 20)
returns table (
  task_id bigint,
  workspace_id bigint,
  enrollment_id bigint,
  plan_step_id bigint,
  seller_id bigint,
  buyer_id bigint,
  assigned_to uuid,
  created_by uuid,
  notes text,
  deal_id bigint,
  channel text,
  subject text,
  step_title text,
  config jsonb,
  plan_name text,
  plan_settings jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select tk.id as id
      from public.tasks tk
      join public.enrollments en on en.id = tk.enrollment_id
      join public.action_plan_steps s on s.id = tk.plan_step_id
      join public.action_plans p on p.id = en.plan_id
     where tk.done = false
       and tk.due_at <= now()
       and en.status = 'active'
       and s.channel in ('email', 'sms', 'tag', 'assign', 'stage')
       and (tk.plan_claim_at is null or tk.plan_claim_at < now() - interval '10 minutes')
       and coalesce(p.settings->>'auto_send', '') = 'true'
     order by tk.due_at, tk.id
     limit least(greatest(coalesce(p_limit, 20), 1), 40)
     for update of tk skip locked
  ),
  claimed as (
    update public.tasks t
       set plan_claim_at = now()
      from due
     where t.id = due.id
    returning t.id, t.workspace_id, t.enrollment_id, t.plan_step_id, t.seller_id, t.buyer_id,
              t.assigned_to, t.created_by, t.notes, t.deal_id
  )
  select c.id, c.workspace_id, c.enrollment_id, c.plan_step_id, c.seller_id, c.buyer_id,
         c.assigned_to, coalesce(c.created_by, en.created_by), c.notes, c.deal_id,
         s.channel, s.subject, s.title, s.config, p.name, p.settings
    from claimed c
    join public.enrollments en on en.id = c.enrollment_id
    join public.action_plan_steps s on s.id = c.plan_step_id
    join public.action_plans p on p.id = en.plan_id;
end $$;

revoke all on function public.plan_send_claim(integer) from public, anon, authenticated;
grant execute on function public.plan_send_claim(integer) to service_role;

create or replace function public.plan_kick()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare v_url text; v_key text;
begin
  if not exists (
    select 1
      from public.tasks tk
      join public.enrollments en on en.id = tk.enrollment_id
      join public.action_plan_steps s on s.id = tk.plan_step_id
      join public.action_plans p on p.id = en.plan_id
     where tk.done = false
       and tk.due_at <= now()
       and en.status = 'active'
       and s.channel in ('email', 'sms', 'tag', 'assign', 'stage')
       and (tk.plan_claim_at is null or tk.plan_claim_at < now() - interval '10 minutes')
       and coalesce(p.settings->>'auto_send', '') = 'true'
  ) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/plan-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;

revoke all on function public.plan_kick() from public, anon, authenticated;

select cron.unschedule('clozr-plan-send') where exists (select 1 from cron.job where jobname = 'clozr-plan-send');
select cron.schedule('clozr-plan-send', '* * * * *', 'select public.plan_kick()');

-- Starting a plan shows on the record. The title matches enrollTitle in plan-send.ts.
create or replace function public.plan_enrollment_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_id bigint;
  v_kind text;
begin
  v_id := coalesce(new.buyer_id, new.seller_id);
  if v_id is null then return null; end if;
  v_kind := case when new.buyer_id is not null then 'buyer' else 'seller' end;
  select ap.name into v_name from public.action_plans ap where ap.id = new.plan_id;
  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
  values (
    new.workspace_id, v_kind, v_id, 'plan',
    'Started "' || coalesce(nullif(btrim(v_name), ''), 'an action plan') || '"',
    'Enrolled in the action plan.',
    new.created_by,
    coalesce(new.enrolled_at, now())
  );
  return null;
end $$;

revoke all on function public.plan_enrollment_activity() from public, anon, authenticated;

drop trigger if exists enrollments_plan_activity on public.enrollments;
create trigger enrollments_plan_activity
  after insert on public.enrollments
  for each row execute function public.plan_enrollment_activity();

insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
select e.workspace_id,
       case when e.buyer_id is not null then 'buyer' else 'seller' end,
       coalesce(e.buyer_id, e.seller_id),
       'plan',
       'Started "' || coalesce(nullif(btrim(p.name), ''), 'an action plan') || '"',
       'Enrolled in the action plan.',
       e.created_by,
       e.enrolled_at
  from public.enrollments e
  join public.action_plans p on p.id = e.plan_id
 where e.enrolled_at >= now() - interval '14 days'
   and coalesce(e.buyer_id, e.seller_id) is not null
   and not exists (
     select 1 from public.activity a
      where a.workspace_id = e.workspace_id
        and a.entity_type = case when e.buyer_id is not null then 'buyer' else 'seller' end
        and a.entity_id = coalesce(e.buyer_id, e.seller_id)
        and a.kind = 'plan'
        and a.title = 'Started "' || coalesce(nullif(btrim(p.name), ''), 'an action plan') || '"'
        and a.occurred_at = e.enrolled_at
   );

-- A ringless drop that has already settled closes its plan task, so the
-- sequence moves on. rvm-tick writes the communication; this writes the done.
create or replace function public.plan_on_rvm_settled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.enrollment_id is null or new.plan_step_id is null then return null; end if;
  if new.status is not distinct from old.status then return null; end if;
  if new.status not in ('dropped', 'skipped', 'failed', 'answered') then return null; end if;
  update public.tasks tk
     set done = true,
         completed_at = coalesce(new.sent_at, now()),
         notes = case
           when new.status in ('dropped', 'answered') then tk.notes
           else left(concat_ws(E'\n', nullif(tk.notes, ''),
             'Ringless voicemail ' || new.status
             || coalesce(': ' || nullif(btrim(coalesce(new.skip_reason, new.last_error, '')), ''), '')), 4000)
         end
   where tk.enrollment_id = new.enrollment_id
     and tk.plan_step_id = new.plan_step_id
     and tk.done = false;
  return null;
end $$;

revoke all on function public.plan_on_rvm_settled() from public, anon, authenticated;

drop trigger if exists rvm_drops_plan_task on public.rvm_drops;
create trigger rvm_drops_plan_task
  after update of status on public.rvm_drops
  for each row execute function public.plan_on_rvm_settled();

update public.tasks tk
   set done = true,
       completed_at = coalesce(d.sent_at, now())
  from public.rvm_drops d
 where tk.enrollment_id = d.enrollment_id
   and tk.plan_step_id = d.plan_step_id
   and tk.done = false
   and d.enrollment_id is not null
   and d.plan_step_id is not null
   and d.status in ('dropped', 'skipped', 'failed', 'answered');

-- plan_ai_agent_start_due already marks the task done. The activity line is
-- what a person reads on the record.
create or replace function public.plan_ai_start_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.action <> 'started' then return null; end if;
  if new.record_id is null or new.record_kind not in ('seller', 'buyer') then return null; end if;
  if not (new.detail ? 'plan_task_id') then return null; end if;
  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
  values (
    new.workspace_id, new.record_kind, new.record_id, 'ai_agent',
    'AI agent started',
    left(coalesce(nullif(btrim(new.summary), ''), 'The action plan started the AI agent.'), 1000),
    new.actor_id,
    coalesce(new.created_at, now())
  );
  return null;
end $$;

revoke all on function public.plan_ai_start_activity() from public, anon, authenticated;

drop trigger if exists ai_agent_actions_plan_activity on public.ai_agent_actions;
create trigger ai_agent_actions_plan_activity
  after insert on public.ai_agent_actions
  for each row execute function public.plan_ai_start_activity();

insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
select a.workspace_id, a.record_kind, a.record_id, 'ai_agent',
       'AI agent started',
       left(coalesce(nullif(btrim(a.summary), ''), 'The action plan started the AI agent.'), 1000),
       a.actor_id, a.created_at
  from public.ai_agent_actions a
 where a.action = 'started'
   and a.detail ? 'plan_task_id'
   and a.record_kind in ('seller', 'buyer')
   and a.record_id is not null
   and a.created_at >= now() - interval '14 days'
   and not exists (
     select 1 from public.activity act
      where act.workspace_id = a.workspace_id
        and act.entity_type = a.record_kind
        and act.entity_id = a.record_id
        and act.kind = 'ai_agent'
        and act.title = 'AI agent started'
        and act.occurred_at = a.created_at
   );

notify pgrst, 'reload schema';
