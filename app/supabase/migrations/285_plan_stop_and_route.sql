-- 285: stopping an action plan stops the rest of it.
--
-- plan_on_communication ignored any communication with no seller, so a buyer
-- reply, text or call kept a stop_on_reply sequence going. Pausing or
-- stopping deleted the open tasks and left a queued ringless drop, and an AI
-- agent the plan had started, still running.

create or replace function public.plan_on_communication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
  e record;
begin
  if new.direction = 'inbound' and new.channel in ('sms', 'text', 'email') then
    v_key := 'stop_on_reply';
  elsif new.channel = 'call' and coalesce(new.duration_s, 0) > 0 then
    v_key := 'stop_on_call';
  else
    return new;
  end if;
  if new.seller_id is not null then
    for e in
      select en.id from public.enrollments en
      join public.action_plans p on p.id = en.plan_id
      where en.seller_id = new.seller_id and en.status = 'active'
        and coalesce((p.settings ->> v_key)::boolean, false)
    loop
      perform public.plan_stop_enrollment(e.id, case v_key when 'stop_on_reply' then 'reply' else 'call' end);
    end loop;
  end if;
  if new.buyer_id is not null then
    for e in
      select en.id from public.enrollments en
      join public.action_plans p on p.id = en.plan_id
      where en.buyer_id = new.buyer_id and en.status = 'active'
        and coalesce((p.settings ->> v_key)::boolean, false)
    loop
      perform public.plan_stop_enrollment(e.id, case v_key when 'stop_on_reply' then 'reply' else 'call' end);
    end loop;
  end if;
  return new;
end $$;

revoke all on function public.plan_on_communication() from public, anon, authenticated;

-- Leaving active (stopped, paused, or finished) pulls queued ringless drops.
-- A hand stop, a reply, a connected call, a stage change, or switching the
-- plan off also stops an AI agent still running on that record, and writes
-- the activity line. Finishing the sequence, and the agent taking over, do
-- not stop the agent.
create or replace function public.plan_enrollment_stopped()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_id bigint;
  v_kind text;
  v_title text;
  v_body text;
begin
  if old.status is distinct from 'active' or new.status = 'active' then return null; end if;
  update public.rvm_drops
     set status = 'skipped', skip_reason = 'plan_stopped'
   where enrollment_id = new.id and status in ('queued', 'ready');

  if new.stopped_reason in ('manual', 'reply', 'call', 'stage', 'plan_paused') then
    update public.ai_agent_enrollments
       set status = 'stopped', stop_reason = 'action plan stopped',
           stopped_at = now(), next_action_at = null
     where workspace_id = new.workspace_id
       and status in ('active', 'paused')
       and (
         (new.seller_id is not null and record_kind = 'seller' and record_id = new.seller_id)
         or (new.buyer_id is not null and record_kind = 'buyer' and record_id = new.buyer_id)
       );
  end if;

  if new.stopped_reason is null or new.stopped_reason = 'ai_agent' then return null; end if;
  v_id := coalesce(new.buyer_id, new.seller_id);
  if v_id is null then return null; end if;
  v_kind := case when new.buyer_id is not null then 'buyer' else 'seller' end;
  select ap.name into v_name from public.action_plans ap where ap.id = new.plan_id;
  v_name := coalesce(nullif(btrim(v_name), ''), 'an action plan');
  if new.status = 'paused' then
    v_title := 'Paused "' || v_name || '"';
    v_body := case new.stopped_reason
      when 'plan_paused' then 'The plan was switched off. Nothing else will send until it is switched back on.'
      else 'Paused by hand. Nothing else in this plan will send until it is played again.'
    end;
  else
    v_title := 'Stopped "' || v_name || '"';
    v_body := case new.stopped_reason
      when 'manual' then 'Stopped by hand. Nothing else in this plan will send.'
      when 'reply' then 'They replied, so the rest of the plan will not send.'
      when 'call' then 'A call connected, so the rest of the plan will not send.'
      when 'stage' then 'The stage changed, so the rest of the plan will not send.'
      else 'The plan stopped (' || new.stopped_reason || '). Nothing else will send.'
    end;
  end if;
  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, occurred_at)
  values (new.workspace_id, v_kind, v_id, 'plan', v_title, v_body, now());
  return null;
end $$;

revoke all on function public.plan_enrollment_stopped() from public, anon, authenticated;

drop trigger if exists enrollments_plan_stopped on public.enrollments;
create trigger enrollments_plan_stopped
  after update of status on public.enrollments
  for each row execute function public.plan_enrollment_stopped();
