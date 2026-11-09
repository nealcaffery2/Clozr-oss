-- 459 · plan_progress_inputs grows what the Action plans report reads.
--
-- Same shape as 428 plus: steps carry position and title (the report groups
-- by step); `opens` is the communication ids of plan mail that was opened
-- (email_tracking, the pixel plan-tick now adds to relationship mail only,
-- never cold); `coldBounces` is each cold plan email that bounced after the
-- send (cold_sends.bounced_at, by buyer and time, since the communications
-- row stays 'sent'). buildPlanProgress marks the matching attempt bounced.

create or replace function public.plan_progress_inputs(p_workspace_id bigint)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with enr as (
    select e.id, e.plan_id, e.buyer_id, e.seller_id, e.status, e.enrolled_at, e.stopped_reason
      from enrollments e
     where e.workspace_id = p_workspace_id
       and (e.seller_id is not null or e.buyer_id is not null)
  ),
  since as (select min(enrolled_at) at from enr),
  bids as (select distinct buyer_id id from enr where buyer_id is not null),
  sids as (select distinct seller_id id from enr where seller_id is not null)
  select json_build_object(
    'enrollments', coalesce((
      -- [id, planId, buyerId, sellerId, name, status, enrolledAt, stoppedReason]
      select json_agg(json_build_array(
        e.id, e.plan_id, e.buyer_id, e.seller_id,
        case when e.seller_id is not null then coalesce(nullif(s.name, ''), 'Seller')
             else coalesce(nullif(btrim(b.name), ''), nullif(b.email, ''), 'Buyer') end,
        e.status, e.enrolled_at, e.stopped_reason) order by e.id)
        from enr e
        left join sellers s on s.id = e.seller_id
        left join buyers b on b.id = e.buyer_id), '[]'::json),
    'steps', coalesce((
      select json_agg(json_build_object('id', st.id, 'channel', st.channel, 'position', st.position, 'title', st.title) order by st.id)
        from action_plan_steps st where st.workspace_id = p_workspace_id), '[]'::json),
    'tasks', coalesce((
      -- [id, enrollmentId, planStepId, done, taskType, completedAt, dueAt, title, notes]
      select json_agg(json_build_array(
        t.id, t.enrollment_id, t.plan_step_id, t.done, t.task_type, t.completed_at, t.due_at, t.title,
        case
          when t.notes is null then null
          when t.ch = 'ai_agent' then substring(t.notes from '(?i)(?:AI agent not started|AI step not run):[^\n]{0,250}')
          else nullif(left(split_part(rtrim(t.notes, E' \t\r\n'), E'\n', -1), 400), '') end) order by t.id)
        from (
          -- channelOf(): the step's channel, else the task type (a text is sms).
          -- Calls, to-dos and other non-send tasks are skipped there, so not sent.
          select t.*, coalesce(nullif(st.channel, ''), case when t.task_type = 'text' then 'sms' else t.task_type end) ch
            from tasks t left join action_plan_steps st on st.id = t.plan_step_id and st.workspace_id = p_workspace_id
           where t.enrollment_id in (select id from enr)
        ) t where t.ch in ('email', 'sms', 'rvm', 'ai_agent')), '[]'::json),
    'mail', coalesce((
      select json_agg(json_build_object(
        'id', c.id, 'buyerId', c.buyer_id, 'sellerId', c.seller_id, 'direction', c.direction, 'channel', c.channel,
        'status', c.status, 'sourceId', c.source_id, 'occurredAt', c.occurred_at, 'subject', c.subject,
        'body', null, 'fromEmail', c.from_email) order by c.id)
        from communications c where c.workspace_id = p_workspace_id and c.source_id like 'plan:%'), '[]'::json),
    'inbound', coalesce((
      select json_agg(json_build_object(
        'id', c.id, 'buyerId', c.buyer_id, 'sellerId', c.seller_id, 'direction', c.direction, 'channel', c.channel,
        'status', c.status, 'sourceId', c.source_id, 'occurredAt', c.occurred_at, 'subject', c.subject,
        'body', left(c.body, 1000), 'fromEmail', c.from_email) order by c.id)
        from communications c
       where c.workspace_id = p_workspace_id and c.direction = 'inbound'
         and c.occurred_at >= (select at from since) - interval '2 minutes'
         and (c.buyer_id in (select id from bids) or c.seller_id in (select id from sids))), '[]'::json),
    'sms', coalesce((
      select json_agg(json_build_object(
        'id', c.id, 'buyerId', c.buyer_id, 'sellerId', c.seller_id, 'direction', c.direction, 'channel', c.channel,
        'status', c.status, 'sourceId', c.source_id, 'occurredAt', c.occurred_at, 'subject', c.subject,
        'body', null, 'fromEmail', c.from_email) order by c.id)
        from communications c
       where c.workspace_id = p_workspace_id and c.direction = 'outbound' and c.channel in ('sms', 'text')
         and c.occurred_at >= (select at from since) - interval '30 minutes'
         and (c.buyer_id in (select id from bids) or c.seller_id in (select id from sids))), '[]'::json),
    'drops', coalesce((
      select json_agg(json_build_object(
        'id', d.id, 'enrollmentId', d.enrollment_id, 'planStepId', d.plan_step_id, 'status', d.status,
        'skipReason', d.skip_reason, 'lastError', d.last_error, 'sentAt', d.sent_at, 'buyerId', d.buyer_id, 'sellerId', d.seller_id) order by d.id)
        from rvm_drops d where d.workspace_id = p_workspace_id and d.enrollment_id is not null), '[]'::json),
    'opens', coalesce((
      select json_agg(t.communication_id order by t.communication_id)
        from email_tracking t
       where t.workspace_id = p_workspace_id and t.communication_id is not null and t.opens > 0), '[]'::json),
    'coldBounces', case when exists (select 1 from bids) then coalesce((
      select json_agg(json_build_object('buyerId', ce.buyer_id, 'at', cs.sent_at) order by cs.sent_at)
        from cold_sends cs join cold_enrollments ce on ce.id = cs.enrollment_id
       where cs.workspace_id = p_workspace_id and cs.bounced_at is not null and ce.buyer_id in (select id from bids)), '[]'::json) else '[]'::json end,
    'coldReplies', case when exists (select 1 from bids) then coalesce((
      select json_agg(json_build_object(
        'buyerId', r.buyer_id, 'communicationId', r.communication_id, 'classification', r.classification,
        'receivedAt', r.received_at, 'subject', r.subject, 'snippet', r.snippet, 'fromEmail', r.from_email) order by r.id)
        from cold_replies r where r.workspace_id = p_workspace_id), '[]'::json) else '[]'::json end
  );
$$;

revoke all on function public.plan_progress_inputs(bigint) from public;
grant execute on function public.plan_progress_inputs(bigint) to authenticated;
