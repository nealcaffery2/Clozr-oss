-- 431 · Daisy takes over Compr's AI outreach from Cody (owner call 2026-10-29).
--
-- An ai_agent plan step that starts the AI agent (no `allowed` list) used the
-- workspace's oldest agent for that kind of record, which in Compr is Cody.
-- The step can now name its agent in config.agent_key; with none, or one that
-- does not work that kind of record, the old rule holds.
--
-- In Compr workspaces that have a Daisy:
-- * every ai_agent step names Daisy, and its goal says Daisy where it said
--   Cody (the decide-once step's script signs its texts with the name);
-- * the decide-once step's "Is this AI" answer drops the MLS claim, matching
--   the voice agents' prompt (comps are public records, not an MLS feed);
-- * active AI enrollments still on Cody move to Daisy, with "Cody" in their
--   instructions swapped, and a took_over action on each so the agent's log
--   says when and why. Their history stays as it was.
-- Inbound calls to the Compr numbers still go to Cody (voice_agent_numbers).
-- Safe to re-run: a step or enrollment already on Daisy is left alone.

create or replace function public.plan_ai_agent_start_due()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
AS $function$
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
      join action_plans p on p.id = en.plan_id
     where s.channel = 'ai_agent' and not (s.config ? 'allowed') and not tk.done and tk.due_at <= now() and en.status = 'active' and p.active
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
    -- The step's own agent (config.agent_key) when it works this kind of record, else the oldest that does.
    select agent_key into v_agent from voice_agent_settings
     where workspace_id = t.workspace_id and audience in (v_kind || 's', 'both')
     order by agent_key is not distinct from nullif(t.config->>'agent_key', '') desc, created_at limit 1;

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

with ws as (
  select w.id from public.workspaces w
   where w.settings->>'buyer_profile' = 'compr'
     and exists (select 1 from public.voice_agent_settings v where v.workspace_id = w.id and v.agent_key = 'daisy')
)
update public.action_plan_steps s set config = jsonb_set(s.config, '{agent_key}', '"daisy"')
  || case when s.config ? 'goal' then jsonb_build_object('goal',
       replace(regexp_replace(s.config->>'goal', '\mCody\M', 'Daisy', 'g'),
               'It pulls from public records and licensed MLS partners and shows you every comp',
               'It pulls from public records and shows you every comp'))
     else '{}'::jsonb end
 where s.channel = 'ai_agent' and s.workspace_id in (select id from ws)
   and s.config->>'agent_key' is distinct from 'daisy';

with ws as (
  select w.id from public.workspaces w
   where w.settings->>'buyer_profile' = 'compr'
     and exists (select 1 from public.voice_agent_settings v where v.workspace_id = w.id and v.agent_key = 'daisy')
), moved as (
  update public.ai_agent_enrollments a
     set agent_key = 'daisy', instructions = regexp_replace(a.instructions, '\mCody\M', 'Daisy', 'g'), updated_at = now()
   where a.workspace_id in (select id from ws) and a.status = 'active' and a.agent_key = 'cody'
  returning a.id, a.workspace_id, a.record_kind, a.record_id
)
insert into public.ai_agent_actions (workspace_id, agent_key, enrollment_id, record_kind, record_id, channel, action, summary, detail)
select m.workspace_id, 'daisy', m.id, m.record_kind, m.record_id, 'system', 'took_over',
       'From Cody: Compr outreach moved to Daisy (owner call 2026-10-29).', '{"from_agent": "cody", "reason": "owner switched Compr outreach to Daisy"}'::jsonb
  from moved m;
