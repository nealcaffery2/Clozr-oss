-- 384: Smart drip for text-only plans, and each sender's own people.
--
-- plan_smart_drip (381) picked only buyers with a verified email, so a plan
-- with no email step (Morgan's and Riley's text intros) started nobody. It
-- now asks for a verified email only when the plan has an email step (or an
-- AI step allowed to email). It also picks only buyers the drip sender owns
-- or nobody owns, so two reps' plans in one workspace never take each
-- other's people. Everything else is as 381. Safe to re-run.

create or replace function public.plan_smart_drip(p_plan bigint, p_dry boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws bigint;
  v_settings jsonb;
  v_sender uuid;
  v_tz text;
  v_today date;
  v_max int;
  v_sms int;
  v_email int;
  v_call int;
  v_n numeric;
  v_codes text[];
  v_rep text;
  v_enrolled int := 0;
  v_needs_email boolean;
  v_out jsonb;
begin
  select workspace_id, coalesce(settings, '{}'::jsonb), coalesce(nullif(settings->>'drip_sender', '')::uuid, created_by)
    into v_ws, v_settings, v_sender
    from action_plans where id = p_plan and active;
  if v_ws is null then return jsonb_build_object('plan', p_plan, 'error', 'not an active plan'); end if;
  if v_sender is null then return jsonb_build_object('plan', p_plan, 'error', 'the plan has no sender'); end if;
  v_tz := coalesce(nullif(v_settings->>'drip_timezone', ''), 'America/Chicago');
  v_today := next_business_day((now() at time zone v_tz)::date);
  v_max := greatest(coalesce(nullif(v_settings->>'drip_max', '')::int, 2000), 0);

  select exists (select 1 from action_plan_steps s where s.plan_id = p_plan
                   and (s.channel = 'email' or (s.channel = 'ai_agent' and coalesce(s.config, '{}'::jsonb)->'allowed' ? 'send_email')))
    into v_needs_email;

  -- Room a day on each channel.
  select coalesce(sum(case when f is null or now() - f < interval '3 days' then 50
                           when now() - f < interval '7 days' then 100
                           when now() - f < interval '14 days' then 150 else 200 end), 0)
    into v_sms
    from (select (select min(c.occurred_at) from communications c
                   where c.workspace_id = v_ws and c.channel = 'sms' and c.direction = 'outbound' and c.from_phone = r.phone_e164) f
            from rep_phone_numbers r where r.workspace_id = v_ws and r.user_id = v_sender) l;
  select coalesce(sum(daily_cap), 0) into v_email
    from cold_mailboxes where workspace_id = v_ws and status = 'active' and not coalesce(paused, false);
  if v_email = 0 then v_email := 50; end if;
  select coalesce(sum(case when now() - created_at < interval '3 days' then 30
                           when now() - created_at < interval '7 days' then 50
                           when now() - created_at < interval '14 days' then 75 else 100 end), 0)
    into v_call
    from voice_agent_numbers where workspace_id = v_ws and status = 'active' and el_phone_number_id is not null;

  -- The most new starts that keep every channel under its room on every day ahead.
  with st as (
    select s.channel, coalesce(s.config, '{}'::jsonb) cfg,
           sum(coalesce(s.delay_minutes, 0)) over (order by s.position) off
      from action_plan_steps s where s.plan_id = p_plan
  ), per as (
    select next_business_day(((now() at time zone v_tz) + make_interval(mins => off::int))::date) d,
           (channel = 'sms' or (channel = 'ai_agent' and cfg->'allowed' ? 'send_sms'))::int sms,
           (channel = 'email' or (channel = 'ai_agent' and cfg->'allowed' ? 'send_email'))::int email,
           (channel = 'ai_agent' and (cfg->'channels' ? 'call' or cfg->'allowed' ? 'call'))::int calls
      from st
  ), load as (
    select d, sum(sms) sms, sum(email) email, sum(calls) calls from per group by d
  ), queued as (
    select greatest(next_business_day((t.due_at at time zone v_tz)::date), v_today) d,
           count(*) filter (where s.channel = 'sms' and t.assigned_to = v_sender) sms,
           count(*) filter (where s.channel = 'email') email,
           count(*) filter (where s.channel = 'ai_agent' and coalesce(s.config, '{}'::jsonb)->'channels' ? 'call') calls
      from tasks t join action_plan_steps s on s.id = t.plan_step_id
     where t.workspace_id = v_ws and not t.done and t.plan_step_id is not null and t.due_at < now() + interval '30 days'
     group by 1
  )
  select min(least(
           case when l.sms > 0 then floor((v_sms - coalesce(q.sms, 0))::numeric / l.sms) else 1e9 end,
           case when l.email > 0 then floor((v_email - coalesce(q.email, 0))::numeric / l.email) else 1e9 end,
           case when l.calls > 0 then floor((v_call - coalesce(q.calls, 0))::numeric / l.calls) else 1e9 end))
    into v_n
    from load l left join queued q on q.d = l.d;
  v_n := least(greatest(coalesce(v_n, 0), 0), v_max);

  v_out := jsonb_build_object('plan', p_plan, 'day', v_today, 'room', jsonb_build_object('sms', v_sms, 'email', v_email, 'calls', v_call), 'can_start', v_n::int);
  if p_dry or v_n < 1 then return v_out || jsonb_build_object('enrolled', 0); end if;

  select array_agg(distinct left(right(regexp_replace(phone_e164, '\D', '', 'g'), 10), 3)) into v_codes
    from rep_phone_numbers where workspace_id = v_ws and user_id = v_sender;
  select coalesce(nullif(split_part(trim(coalesce(full_name, '')), ' ', 1), ''), '') into v_rep from profiles where id = v_sender;

  with pick as (
    select b.id, b.name, b.company, b.phone, b.assigned_to,
           coalesce(nullif(split_part(trim(coalesce(b.name, '')), ' ', 1), ''), trim(coalesce(b.name, ''))) first
      from buyers b
     where b.workspace_id = v_ws and b.archived_at is null and b.blacklisted_at is null
       and (b.email_safe_to_send is true or not v_needs_email)
       and (b.assigned_to is null or b.assigned_to = v_sender)
       and length(regexp_replace(coalesce(b.phone, ''), '\D', '', 'g')) between 10 and 11
       and coalesce(b.wants_calls, true) and b.compr_signup is null
       and not (coalesce(b.tags, '{}') && array['dnc', 'do not contact', 'do-not-contact', 'secret-blacklist', 'compr-master-exclude', 'compr-signup', 'compr-trial', 'compr-paid'])
       and not exists (select 1 from enrollments e where e.buyer_id = b.id)
       and not exists (select 1 from buyer_phones bp where bp.buyer_id = b.id and bp.is_dnc)
     order by (left(right(regexp_replace(b.phone, '\D', '', 'g'), 10), 3) = any(coalesce(v_codes, '{}'))) desc, b.id
     limit v_n::int
  ), enr as (
    insert into enrollments (workspace_id, plan_id, buyer_id, created_by)
    select v_ws, p_plan, id, v_sender from pick
    returning id, buyer_id
  ), steps as (
    select s.*, sum(coalesce(s.delay_minutes, 0)) over (order by s.position) off
      from action_plan_steps s where s.plan_id = p_plan
  ), ins_tasks as (
    insert into tasks (workspace_id, buyer_id, title, task_type, priority, due_at, assigned_to, notes, enrollment_id, plan_step_id, created_by)
    select v_ws, p.id,
           case s.channel when 'sms' then 'Text ' || p.first || ' — ' || s.title
                          when 'email' then 'Email ' || p.first || ' — ' || s.title
                          when 'call' then 'Call ' || p.first || ' — ' || s.title
                          when 'rvm' then 'RVM ' || p.first || ' — ' || s.title
                          when 'ai_agent' then 'AI agent starts on ' || p.first
                          else coalesce(s.title, 'Follow up with ' || p.first) end,
           case s.channel when 'sms' then 'text' when 'call' then 'call' when 'email' then 'email' when 'rvm' then 'rvm' else 'todo' end,
           case when s.config->>'priority' in ('low', 'high') then s.config->>'priority' else 'normal' end,
           now() + make_interval(mins => s.off::int),
           coalesce(nullif(s.config->>'assignee', '')::uuid, p.assigned_to, v_sender),
           case when coalesce(s.body, '') = '' then null else
             replace(replace(replace(replace(replace(s.body, '{{first_name}}', p.first), '{{name}}', coalesce(p.name, '')),
               '{{contact_name}}', coalesce(p.name, '')), '{{company}}', coalesce(p.company, '')), '{{rep_name}}', v_rep) end,
           e.id, s.id, v_sender
      from enr e join pick p on p.id = e.buyer_id cross join steps s
     where s.channel <> 'wait'
    on conflict (enrollment_id, plan_step_id) do nothing
    returning 1
  ), ins_rvm as (
    insert into rvm_drops (workspace_id, buyer_id, phone_e164, library_id, script, variant_group, status, scheduled_at, enrollment_id, plan_step_id, created_by)
    select v_ws, p.id, '+1' || right(regexp_replace(p.phone, '\D', '', 'g'), 10), null,
           replace(s.body, '{{first_name}}', p.first), coalesce(nullif(s.config->>'variant_group', ''), 'default'), 'queued',
           now() + make_interval(mins => s.off::int), e.id, s.id, v_sender
      from enr e join pick p on p.id = e.buyer_id cross join steps s where s.channel = 'rvm'
    returning 1
  ), own as (
    update buyers set assigned_to = v_sender where id in (select id from pick) and assigned_to is null returning 1
  )
  select count(*) into v_enrolled from enr;

  v_out := v_out || jsonb_build_object('enrolled', v_enrolled, 'at', now());
  update action_plans set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('last_drip', v_out) where id = p_plan;
  return v_out;
end;
$$;

