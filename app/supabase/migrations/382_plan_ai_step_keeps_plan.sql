-- 382: An action plan step that hands the lead to the AI agent no longer ends
-- that same plan. 155 ends every plan on a record when an AI agent starts on it
-- (one sequence at a time), so a plan whose step 3 started the agent for calls
-- ended itself and deleted its own texts, emails and voicemails before any
-- went out. plan_ai_agent_start_due now marks the enrolment it is starting the
-- agent for (clozr.plan_enrollment, this transaction only) and
-- ai_agent_started_ends_plan leaves that one running; any other plan on the
-- record still ends. Same functions as 330 and 155 otherwise. Safe to re-run.

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
    v_note := null;
    v_channels := case
      when jsonb_typeof(t.config->'channels') = 'array' then
        array(select c from unnest(array['sms', 'email', 'call']) c
               where t.config->'channels' ? c)
      else '{sms,email}'::text[] end;
    select agent_key into v_agent from voice_agent_settings
     where workspace_id = t.workspace_id and audience in (v_kind || 's', 'both')
     order by created_at limit 1;

    if v_rec is null then
      v_note := 'the task has no seller or buyer';
    elsif cardinality(v_channels) = 0 then
      v_note := 'the step allows no text, email or call';
    elsif v_agent is null then
      v_note := 'no AI agent works ' || v_kind || 's in this workspace';
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
       and e.id::text is distinct from nullif(current_setting('clozr.plan_enrollment', true), '')
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
