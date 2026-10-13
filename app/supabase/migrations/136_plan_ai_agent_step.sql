-- 136: "AI agent" as an action-plan step.
--
-- A plan step with channel 'ai_agent' switches the workspace's AI agent
-- (migration 123) ON for the enrolled seller or buyer when the step comes due,
-- with the step's config.goal as the agent's instructions. It does not build
-- another agent: it writes the same ai_agent_enrollments row the ai-agent
-- function's bulk_start writes (status active, plan empty, so the next tick
-- drafts the plan, checks eligibility and do-not-contact, and acts).
--
-- Enrolment (plan_enroll, and the client paths in lib/crm-write.ts) already
-- queues every step as a dated task, so an ai_agent step is a task like any
-- other. plan_ai_agent_start_due() picks up the due, open ones whose plan
-- enrolment is still active (a paused or stopped plan deleted its open tasks),
-- starts the agent, and marks the task done, which advances the plan. When the
-- agent cannot start (no agent works that kind of record, one is already on
-- the record, a VIP buyer or fund), the task is still closed and its notes say
-- why, so the plan moves on instead of retrying forever.
--
-- ai_agent_kick (cron every 2 minutes, migration 123) runs it first, so no new
-- cron job. Idempotent.

alter table public.action_plan_steps drop constraint if exists action_plan_steps_channel_check;
alter table public.action_plan_steps add constraint action_plan_steps_channel_check
  check (channel in ('sms', 'email', 'call', 'task', 'wait', 'stage', 'tag', 'assign', 'compr_report', 'rvm', 'ai_agent'));

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
     where s.channel = 'ai_agent' and not tk.done and tk.due_at <= now() and en.status = 'active'
     order by tk.due_at
     limit 50
     for update of tk skip locked
  loop
    v_kind := case when t.seller_id is not null then 'seller' else 'buyer' end;
    v_rec := coalesce(t.seller_id, t.buyer_id);
    v_goal := left(btrim(coalesce(t.config->>'goal', '')), 2000);
    v_enr := null;
    v_note := null;
    -- The first agent that works this kind of record, as bulk_start picks it.
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
        -- The guard (migration 123) refuses VIP buyers, funds and the wrong audience.
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

-- ai_agent_kick as in 123, starting due plan steps first.
create or replace function public.ai_agent_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  begin
    perform public.plan_ai_agent_start_due();
  exception when others then
    raise warning 'plan_ai_agent_start_due: %', sqlerrm;
  end;
  if not exists (select 1 from public.ai_agent_enrollments where status = 'active' and next_action_at <= now()) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/ai-agent',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.ai_agent_kick() from public, anon, authenticated;
