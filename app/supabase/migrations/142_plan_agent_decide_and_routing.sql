-- 142: action plans get an AI step that decides once, and a "when finished" route.
--
-- 1. The AI agent step (migration 136) gains a second mode. A step whose
--    config carries `allowed` — a subset of send_sms, create_task,
--    update_lead_status — no longer switches the conversational AI agent on.
--    When its task comes due, the plan-agent function reads the lead's history
--    (texts, calls, prior plans, open tasks), asks the model for at most one of
--    each allowed action (or nothing), carries them out through the normal
--    paths (a text through the same Talkr send as everything else: opt-out,
--    quiet hours, length), records the decision and its reason in
--    plan_agent_runs, and closes the task so the plan moves on. A step without
--    `allowed` is the 136 hand-off, unchanged.
--
-- 2. action_plans.on_complete says where a lead goes when the plan ends:
--      { mode: none | fixed | smart, plan_id, candidate_ids[], also_when_stopped }
--    none leaves the plan; fixed continues in plan_id; smart lets the model pick
--    one of candidate_ids from the lead's history. A lead is never routed into
--    a plan it already ran (any enrolment of that plan, finished or not), and a
--    run that was stopped (a reply, a call, a stage change) is routed only when
--    also_when_stopped is set; a rep's own Stop never routes. Where each lead
--    went and why is on the enrolment (routed_enrollment_id, routed_plan_id,
--    routed_reason), which the plan's run table shows. A smart route waits in
--    route_state 'pending' for the plan-agent function.
--
--    on_end_next_plan_id (migration 34) stays, kept equal to a fixed route's
--    plan by the builder, and is read as a fixed route when on_complete is
--    empty, so plans saved before this keep chaining exactly as they did.
--
-- ai_agent_kick (cron every 2 minutes) wakes plan-agent when there is work, so
-- no new cron job. Idempotent.

-- ---- the decision ledger ------------------------------------------------------------

create table if not exists public.plan_agent_runs (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  enrollment_id bigint references public.enrollments(id) on delete cascade,
  task_id       bigint references public.tasks(id) on delete set null,
  plan_step_id  bigint references public.action_plan_steps(id) on delete set null,
  seller_id     bigint references public.sellers(id) on delete cascade,
  status        text not null default 'running' check (status in ('running', 'done', 'skipped', 'failed')),
  goal          text not null default '',
  allowed       text[] not null default '{}',
  -- What the model chose: { send_sms: { body } | null, create_task: { title, type, due_in_hours } | null, update_lead_status: { stage } | null }.
  decision      jsonb not null default '{}'::jsonb,
  reason        text,
  -- What was carried out: [{ kind, ok, detail }].
  actions       jsonb not null default '[]'::jsonb,
  claimed_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists plan_agent_runs_task_key on public.plan_agent_runs (task_id);
create index if not exists plan_agent_runs_enrollment_idx on public.plan_agent_runs (enrollment_id);
create index if not exists plan_agent_runs_workspace_idx on public.plan_agent_runs (workspace_id, created_at desc);
create index if not exists plan_agent_runs_seller_idx on public.plan_agent_runs (seller_id);
create index if not exists plan_agent_runs_step_idx on public.plan_agent_runs (plan_step_id);

alter table public.plan_agent_runs enable row level security;
drop policy if exists plan_agent_runs_select on public.plan_agent_runs;
create policy plan_agent_runs_select on public.plan_agent_runs
  for select to authenticated
  using (
    workspace_id in (
      select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
    )
  );
revoke insert, update, delete on public.plan_agent_runs from anon, authenticated;

-- ---- routing columns ------------------------------------------------------------------

alter table public.action_plans
  add column if not exists on_complete jsonb not null default '{}'::jsonb;

-- Plans that already chain keep chaining, now said in the new shape.
update public.action_plans
   set on_complete = jsonb_build_object('mode', 'fixed', 'plan_id', on_end_next_plan_id, 'candidate_ids', '[]'::jsonb, 'also_when_stopped', false)
 where on_end_next_plan_id is not null and on_complete = '{}'::jsonb;

alter table public.enrollments
  add column if not exists routed_enrollment_id bigint references public.enrollments(id) on delete set null,
  add column if not exists routed_plan_id bigint references public.action_plans(id) on delete set null,
  add column if not exists routed_reason text,
  add column if not exists routed_at timestamptz,
  add column if not exists route_state text;

alter table public.enrollments drop constraint if exists enrollments_route_state_check;
alter table public.enrollments add constraint enrollments_route_state_check
  check (route_state is null or route_state in ('pending', 'done'));

create index if not exists enrollments_route_pending_idx on public.enrollments (id) where route_state = 'pending';
create index if not exists enrollments_routed_enrollment_id_idx on public.enrollments (routed_enrollment_id);
create index if not exists enrollments_routed_plan_id_idx on public.enrollments (routed_plan_id);

-- ---- where a finished lead goes ------------------------------------------------------------

-- The plans a smart route may still pick for this enrolment's lead: named in
-- the route, active, in the workspace, and never run by the lead before.
create or replace function public.plan_route_candidates(p_enr bigint)
returns table (id bigint, name text, description text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, coalesce(p.description, '')
    from enrollments e
    join action_plans src on src.id = e.plan_id
    join action_plans p on p.workspace_id = e.workspace_id
   where e.id = p_enr and e.seller_id is not null
     and p.active
     and p.id in (
       select (x)::bigint from jsonb_array_elements_text(
         case when jsonb_typeof(src.on_complete -> 'candidate_ids') = 'array' then src.on_complete -> 'candidate_ids' else '[]'::jsonb end) x
       where x ~ '^\d+$')
     and not exists (select 1 from enrollments r where r.seller_id = e.seller_id and r.plan_id = p.id)
   order by p.name;
$$;
revoke execute on function public.plan_route_candidates(bigint) from public, anon, authenticated;

-- Runs as the enrolment ends (status → done from active or paused), before
-- the row is written, so where it went lands in the same update.
create or replace function public.plan_on_enrollment_end()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_oc jsonb;
  v_legacy bigint;
  v_mode text;
  v_target bigint;
  v_name text;
  v_active boolean;
  v_new bigint;
  v_count integer;
begin
  if new.status is distinct from 'done' or old.status not in ('active', 'paused') then return new; end if;
  if new.seller_id is null or new.route_state is not null then return new; end if;

  select on_complete, on_end_next_plan_id into v_oc, v_legacy from action_plans where id = new.plan_id;
  v_oc := coalesce(v_oc, '{}'::jsonb);
  v_mode := coalesce(nullif(v_oc ->> 'mode', ''), case when v_legacy is not null then 'fixed' else 'none' end);
  new.routed_at := now();
  new.route_state := 'done';

  if v_mode not in ('fixed', 'smart') then
    new.routed_reason := case when new.stopped_reason is null then 'Finished. Left the plan: nothing is set for when it ends.'
                              else 'Stopped (' || new.stopped_reason || '). Left the plan.' end;
    return new;
  end if;

  if new.stopped_reason = 'manual' then
    new.routed_reason := 'Stopped by hand, so not routed.';
    return new;
  end if;
  if new.stopped_reason is not null and coalesce((v_oc ->> 'also_when_stopped')::boolean, false) is not true then
    new.routed_reason := 'Stopped (' || new.stopped_reason || '), and "also when stopped" is off, so not routed.';
    return new;
  end if;

  if v_mode = 'fixed' then
    begin
      v_target := coalesce(nullif(v_oc ->> 'plan_id', '')::bigint, v_legacy);
    exception when others then v_target := v_legacy;
    end;
    select name, active into v_name, v_active from action_plans where id = v_target and workspace_id = new.workspace_id;
    if v_name is null then
      new.routed_reason := 'The next plan is gone. Left the plan.';
    elsif exists (select 1 from enrollments r where r.seller_id = new.seller_id and r.plan_id = v_target) then
      new.routed_reason := 'Already ran "' || v_name || '", so not routed into it again.';
    elsif not v_active then
      new.routed_reason := '"' || v_name || '" is paused, so not routed.';
    else
      v_new := plan_enroll(new.workspace_id, v_target, new.seller_id, new.created_by);
      if v_new is null then
        new.routed_reason := '"' || v_name || '" did not start.';
      else
        new.routed_enrollment_id := v_new;
        new.routed_plan_id := v_target;
        new.routed_reason := 'Continued in "' || v_name || '" (the fixed next plan).';
      end if;
    end if;
    return new;
  end if;

  -- smart: the model picks among what is left; plan-agent finishes it.
  select count(*) into v_count from plan_route_candidates(new.id);
  if v_count = 0 then
    new.routed_reason := 'No candidate plan left that this lead has not already run. Left the plan.';
    return new;
  end if;
  new.route_state := 'pending';
  new.routed_reason := 'Waiting for AI to pick the next plan.';
  return new;
end;
$$;
revoke execute on function public.plan_on_enrollment_end() from public, anon, authenticated;

drop trigger if exists plan_on_enrollment_end on public.enrollments;
create trigger plan_on_enrollment_end
  before update of status on public.enrollments
  for each row execute function public.plan_on_enrollment_end();

-- The model's pick for a pending smart route, checked again here: still
-- pending, a candidate the lead has not run. p_plan null means "none fits".
create or replace function public.plan_route_apply(p_enr bigint, p_plan bigint, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  e record;
  v_name text;
  v_new bigint;
  v_why text := left(btrim(coalesce(p_reason, '')), 400);
begin
  select * into e from enrollments where id = p_enr for update;
  if not found or e.route_state is distinct from 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not pending');
  end if;
  if p_plan is null then
    update enrollments set route_state = 'done', routed_at = now(),
           routed_reason = 'AI routing left the plan' || case when v_why <> '' then ': ' || v_why else '.' end
     where id = p_enr;
    return jsonb_build_object('ok', true, 'routed', false);
  end if;
  select c.name into v_name from plan_route_candidates(p_enr) c where c.id = p_plan;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not a candidate');
  end if;
  v_new := plan_enroll(e.workspace_id, p_plan, e.seller_id, e.created_by);
  update enrollments
     set route_state = 'done', routed_at = now(),
         routed_enrollment_id = v_new,
         routed_plan_id = case when v_new is null then null else p_plan end,
         routed_reason = case when v_new is null then 'AI picked "' || v_name || '", but it did not start.'
                              else 'AI routed to "' || v_name || '"' || case when v_why <> '' then ': ' || v_why else '.' end end
   where id = p_enr;
  return jsonb_build_object('ok', v_new is not null, 'routed', v_new is not null, 'enrollment_id', v_new, 'plan', v_name);
end;
$$;
revoke execute on function public.plan_route_apply(bigint, bigint, text) from public, anon, authenticated;

-- The last task done: the enrolment is done. Where it goes next is
-- plan_on_enrollment_end's job now (the chain that was here moved there).
create or replace function public.plan_on_task_done()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.enrollment_id is null or not new.done or old.done then return new; end if;
  update enrollments
    set step_index = (select count(*) from tasks where enrollment_id = new.enrollment_id and done)
    where id = new.enrollment_id;
  if not exists (select 1 from tasks where enrollment_id = new.enrollment_id and not done) then
    update enrollments set status = 'done', completed_at = now()
      where id = new.enrollment_id and status = 'active';
  end if;
  return new;
end;
$$;
revoke execute on function public.plan_on_task_done() from public, anon, authenticated;

-- ---- the decide-once AI step ------------------------------------------------------------------

-- Claims due decide-once steps for plan-agent: a run row per task, so two
-- ticks never act on one task. A run left 'running' for ten minutes (the
-- function died) is claimed again.
create or replace function public.plan_agent_claim(p_limit integer default 10)
returns setof public.plan_agent_runs
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select tk.id, tk.workspace_id, tk.enrollment_id, tk.plan_step_id, tk.seller_id, s.config
      from tasks tk
      join action_plan_steps s on s.id = tk.plan_step_id
      join enrollments en on en.id = tk.enrollment_id
     where s.channel = 'ai_agent' and s.config ? 'allowed'
       and not tk.done and tk.due_at <= now() and en.status = 'active'
       and not exists (select 1 from plan_agent_runs r where r.task_id = tk.id
                        and (r.status <> 'running' or r.claimed_at > now() - interval '10 minutes'))
     order by tk.due_at
     limit greatest(1, least(coalesce(p_limit, 10), 25))
     for update of tk skip locked
  )
  insert into plan_agent_runs as r (workspace_id, enrollment_id, task_id, plan_step_id, seller_id, goal, allowed)
  select d.workspace_id, d.enrollment_id, d.id, d.plan_step_id, d.seller_id,
         left(btrim(coalesce(d.config ->> 'goal', '')), 2000),
         array(select x from jsonb_array_elements_text(
                 case when jsonb_typeof(d.config -> 'allowed') = 'array' then d.config -> 'allowed' else '[]'::jsonb end) x
               where x in ('send_sms', 'create_task', 'update_lead_status'))
    from due d
  on conflict (task_id) do update set claimed_at = now()
    where r.status = 'running'
  returning r.*;
end;
$$;
revoke execute on function public.plan_agent_claim(integer) from public, anon, authenticated;

-- 136's start, minus the decide-once steps (those are plan-agent's).
create or replace function public.plan_ai_agent_start_due()
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  t record;
  v_kind text;
  v_rec bigint;
  v_goal text;
  v_agent text;
  v_enr bigint;
  v_note text;
  n integer := 0;
begin
  for t in
    select tk.id, tk.workspace_id, tk.seller_id, tk.buyer_id, en.created_by, s.config
      from tasks tk
      join action_plan_steps s on s.id = tk.plan_step_id
      join enrollments en on en.id = tk.enrollment_id
     where s.channel = 'ai_agent' and not (s.config ? 'allowed') and not tk.done and tk.due_at <= now() and en.status = 'active'
     order by tk.due_at
     limit 50
     for update of tk skip locked
  loop
    v_kind := case when t.seller_id is not null then 'seller' else 'buyer' end;
    v_rec := coalesce(t.seller_id, t.buyer_id);
    v_goal := left(btrim(coalesce(t.config->>'goal', '')), 2000);
    v_enr := null;
    v_note := null;
    select agent_key into v_agent from voice_agent_settings
     where workspace_id = t.workspace_id and audience in (v_kind || 's', 'both')
     order by created_at limit 1;

    if v_rec is null then
      v_note := 'the task has no seller or buyer';
    elsif v_agent is null then
      v_note := 'no AI agent works ' || v_kind || 's in this workspace';
    elsif exists (select 1 from ai_agent_enrollments
                   where workspace_id = t.workspace_id and record_kind = v_kind and record_id = v_rec
                     and status in ('draft', 'active', 'paused')) then
      v_note := 'an AI agent is already on this record';
    else
      begin
        insert into ai_agent_enrollments (
          workspace_id, record_kind, record_id, agent_key, status, mode, instructions, channels, plan, chat,
          touches, next_action_at, last_action_at, last_inbound_seen_at, claimed_at, stop_reason,
          started_by, started_at, stopped_by, stopped_at, relayed_from)
        values (
          t.workspace_id, v_kind, v_rec, v_agent, 'active',
          case when v_goal = '' then 'auto' else 'custom' end, v_goal, '{sms,email}', '{}'::jsonb,
          jsonb_build_array(jsonb_build_object('role', 'rep', 'text', coalesce(nullif(v_goal, ''), 'Let the AI decide from the record history.'), 'at', now(), 'by', t.created_by)),
          0, now(), null, now(), null, null,
          t.created_by, now(), null, null, '{}')
        on conflict (workspace_id, record_kind, record_id) do update set
          agent_key = excluded.agent_key, status = 'active', mode = excluded.mode, instructions = excluded.instructions,
          channels = excluded.channels, plan = excluded.plan, chat = excluded.chat, touches = 0,
          next_action_at = excluded.next_action_at, last_action_at = null, last_inbound_seen_at = excluded.last_inbound_seen_at,
          claimed_at = null, stop_reason = null, started_by = excluded.started_by, started_at = excluded.started_at,
          stopped_by = null, stopped_at = null, relayed_from = '{}'
          where ai_agent_enrollments.status not in ('draft', 'active', 'paused')
        returning id into v_enr;
        if v_enr is null then
          v_note := 'an AI agent is already on this record';
        else
          insert into ai_agent_actions (workspace_id, agent_key, enrollment_id, record_kind, record_id, channel, action, summary, detail, actor_id)
          values (t.workspace_id, v_agent, v_enr, v_kind, v_rec, 'system', 'started',
            'Started by an action plan step. ' || case when v_goal = '' then 'Deciding from the record history.' else 'Instructions: ' || left(v_goal, 600) end,
            jsonb_build_object('mode', case when v_goal = '' then 'auto' else 'custom' end, 'plan_task_id', t.id), t.created_by);
          n := n + 1;
        end if;
      exception when others then
        v_note := sqlerrm;
      end;
    end if;

    update tasks
       set done = true, completed_at = now(),
           notes = case when v_note is null then notes
                        else concat_ws(E'\n', nullif(notes, ''), 'AI agent not started: ' || v_note) end
     where id = t.id;
  end loop;
  return n;
end $$;
revoke execute on function public.plan_ai_agent_start_due() from public, anon, authenticated;

-- ai_agent_kick as in 136, and plan-agent when a decide-once step is due or a smart route waits.
create or replace function public.ai_agent_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text; v_agent boolean; v_plan boolean;
begin
  begin
    perform public.plan_ai_agent_start_due();
  exception when others then
    raise warning 'plan_ai_agent_start_due: %', sqlerrm;
  end;
  v_agent := exists (select 1 from public.ai_agent_enrollments where status = 'active' and next_action_at <= now());
  v_plan := exists (select 1 from public.enrollments where route_state = 'pending')
         or exists (select 1 from public.tasks tk
                      join public.action_plan_steps s on s.id = tk.plan_step_id
                      join public.enrollments en on en.id = tk.enrollment_id
                     where s.channel = 'ai_agent' and s.config ? 'allowed' and not tk.done and tk.due_at <= now()
                       and en.status = 'active');
  if not v_agent and not v_plan then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  if v_agent then
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/ai-agent',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := '{"action":"tick"}'::jsonb,
      timeout_milliseconds := 5000);
  end if;
  if v_plan then
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/plan-agent',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := '{"action":"tick"}'::jsonb,
      timeout_milliseconds := 5000);
  end if;
end $$;
revoke execute on function public.ai_agent_kick() from public, anon, authenticated;
