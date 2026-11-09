-- 389: Action plans' AI steps work on buyers.
--
-- 1. Decide-once AI steps (config.allowed) closed every buyer enrolment with
--    "decide-once AI steps work seller leads only": plan_agent_runs had no
--    buyer column and plan_agent_claim passed seller_id alone. The run now
--    carries buyer_id; plan-agent decides for either.
-- 2. An AI agent step (no config.allowed) skipped with "an AI agent is already
--    on this record" when the agent on the record was the one an earlier step
--    of the same enrolment started (First call, then Third call). Now that
--    agent takes the new step's instructions and channels and acts again.
--    An agent from anywhere else still blocks the step, as before.
-- plan_ai_agent_start_due is 382's otherwise. Safe to re-run.

alter table public.plan_agent_runs add column if not exists buyer_id bigint references public.buyers(id) on delete cascade;

create or replace function public.plan_agent_claim(p_limit integer default 10)
returns setof public.plan_agent_runs
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select tk.id, tk.workspace_id, tk.enrollment_id, tk.plan_step_id, tk.seller_id, tk.buyer_id, s.config
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
  insert into plan_agent_runs as r (workspace_id, enrollment_id, task_id, plan_step_id, seller_id, buyer_id, goal, allowed)
  select d.workspace_id, d.enrollment_id, d.id, d.plan_step_id, d.seller_id, case when d.seller_id is null then d.buyer_id end,
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

create or replace function public.plan_ai_agent_start_due()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  t record;
  v_kind text;
  v_rec bigint;
  v_goal text;
  v_agent text;
  v_enr bigint;
  v_own bigint;
  v_note text;
  v_channels text[];
  n integer := 0;
begin
  for t in
    select tk.id, tk.workspace_id, tk.seller_id, tk.buyer_id, tk.enrollment_id, en.created_by, s.config
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
    v_own := null;
    v_note := null;
    v_channels := case
      when jsonb_typeof(t.config->'channels') = 'array' then
        array(select c from unnest(array['sms', 'email', 'call']) c
               where t.config->'channels' ? c)
      else '{sms,email}'::text[] end;
    select agent_key into v_agent from voice_agent_settings
     where workspace_id = t.workspace_id and audience in (v_kind || 's', 'both')
     order by created_at limit 1;

    -- The agent already working this record, when an earlier step of this same enrolment started it.
    select a.id into v_own from ai_agent_enrollments a
     where a.workspace_id = t.workspace_id and a.record_kind = v_kind and a.record_id = v_rec and a.status = 'active'
       and exists (select 1 from ai_agent_actions x join tasks pt on pt.id = (x.detail->>'plan_task_id')::bigint
                    where x.enrollment_id = a.id and x.action = 'started' and pt.enrollment_id = t.enrollment_id);

    if v_rec is null then
      v_note := 'the task has no seller or buyer';
    elsif cardinality(v_channels) = 0 then
      v_note := 'the step allows no text, email or call';
    elsif v_agent is null then
      v_note := 'no AI agent works ' || v_kind || 's in this workspace';
    elsif v_own is not null then
      -- This plan's own agent: give it this step's instructions and let it act now.
      update ai_agent_enrollments set
        mode = case when v_goal = '' then 'auto' else 'custom' end,
        instructions = v_goal, channels = v_channels,
        chat = chat || jsonb_build_array(jsonb_build_object('role', 'rep', 'text', coalesce(nullif(v_goal, ''), 'Let the AI decide from the record history.'), 'at', now(), 'by', t.created_by)),
        next_action_at = now(), claimed_at = null
       where id = v_own;
      insert into ai_agent_actions (workspace_id, agent_key, enrollment_id, record_kind, record_id, channel, action, summary, detail, actor_id)
      select t.workspace_id, a.agent_key, v_own, v_kind, v_rec, 'system', 'started',
        'Next action plan step. ' || case when v_goal = '' then 'Deciding from the record history.' else 'Instructions: ' || left(v_goal, 600) end,
        jsonb_build_object('mode', case when v_goal = '' then 'auto' else 'custom' end, 'plan_task_id', t.id, 'channels', v_channels), t.created_by
        from ai_agent_enrollments a where a.id = v_own;
      n := n + 1;
    elsif exists (select 1 from ai_agent_enrollments
                   where workspace_id = t.workspace_id and record_kind = v_kind and record_id = v_rec
                     and status in ('draft', 'active', 'paused')) then
      v_note := 'an AI agent is already on this record';
    else
      begin
        -- The plan that starts the agent keeps running (ai_agent_started_ends_plan skips it).
        perform set_config('clozr.plan_enrollment', t.enrollment_id::text, true);
        insert into ai_agent_enrollments (
          workspace_id, record_kind, record_id, agent_key, status, mode, instructions, channels, plan, chat,
          touches, next_action_at, last_action_at, last_inbound_seen_at, claimed_at, stop_reason,
          started_by, started_at, stopped_by, stopped_at, relayed_from)
        values (
          t.workspace_id, v_kind, v_rec, v_agent, 'active',
          case when v_goal = '' then 'auto' else 'custom' end, v_goal, v_channels, '{}'::jsonb,
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
            jsonb_build_object('mode', case when v_goal = '' then 'auto' else 'custom' end, 'plan_task_id', t.id, 'channels', v_channels), t.created_by);
          n := n + 1;
        end if;
      exception when others then
        v_note := sqlerrm;
      end;
    end if;

    perform set_config('clozr.plan_enrollment', '', true);
    update tasks
       set done = true, completed_at = now(),
           notes = case when v_note is null then notes
                        else concat_ws(E'\n', nullif(notes, ''), 'AI agent not started: ' || v_note) end
     where id = t.id;
  end loop;
  return n;
end $function$;
