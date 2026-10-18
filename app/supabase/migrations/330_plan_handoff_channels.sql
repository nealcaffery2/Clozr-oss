-- An action plan step that hands the lead to the AI agent says how the agent
-- may reach them: config.channels, any of sms / email / call. Before this the
-- hand-off always started the agent on text and email, so a step whose goal
-- said "call them" could never lead to a call. A step without channels keeps
-- text and email; one with an empty list starts nothing and says so on the task.
-- Same function as before otherwise (136/142). Safe to re-run.

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

    update tasks
       set done = true, completed_at = now(),
           notes = case when v_note is null then notes
                        else concat_ws(E'\n', nullif(notes, ''), 'AI agent not started: ' || v_note) end
     where id = t.id;
  end loop;
  return n;
end $function$;
