-- 391: the reporting reads aggregate in SQL.
--
-- PostgREST returns at most 1,000 rows whatever .limit() says, so every
-- reporting read that paged communications, agent actions or voicemail drops
-- counted the newest thousand and stopped. Each gets a function that returns
-- the numbers the code computed from the rows, grouped the way it grouped them:
--
-- 1. leaderboard_comms: one row per rep, line owner, seller rep, local day,
--    channel and direction (count, talk seconds, conversations, latest time),
--    plus each seller's first outbound contact. The leaderboard engine
--    (lib/leaderboard.ts) reads these as weighted rows. The board's resets
--    (workspaces.settings.leaderboard_resets) are applied here so a reset
--    mid-day still cuts at the instant.
-- 2. report_comms: the same read as 371 with a p_since, so report-mail reads
--    a report's window instead of the newest 10,000 (really 1,000). Dropped
--    and recreated: an overload with a default would be ambiguous to PostgREST.
-- 3. ai_agent_report: per-agent action counts, enrollment load, voice calls
--    and the AI funnel (distinct sellers) for the report; ai_autopilot_today
--    the autopilot view's today tile.
-- 4. rvm_blast_summary: the Talkr RVM tab's blast results per send.
-- Safe to re-run.

-- ---- 1. leaderboard ------------------------------------------------------------------------

create or replace function public.leaderboard_comms(
  p_ws bigint,
  p_tz text default 'America/Chicago',
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_resets jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lines as (
    select distinct on (p10) p10, user_id
      from (select right(regexp_replace(coalesce(phone_e164, ''), '\D', '', 'g'), 10) as p10, user_id, created_at
              from public.rep_phone_numbers where workspace_id = p_ws) r
     where p10 <> ''
     order by p10, created_at desc
  ),
  resets as (
    select r.key as rep, r.value::timestamptz as cut from jsonb_each_text(coalesce(p_resets, '{}'::jsonb)) r
  ),
  base as (
    select c.seller_id, c.rep_id, c.channel, c.direction, c.occurred_at, c.duration_s,
           l.user_id as line_rep,
           case when s.id is null then null
                when exists (select 1 from resets x where x.rep = s.assigned_to::text and s.created_at < x.cut) then null
                else s.assigned_to end as seller_rep
      from public.communications c
      left join public.sellers s on s.id = c.seller_id and s.archived_at is null
      left join lines l on l.p10 = right(regexp_replace(coalesce(case when c.direction = 'inbound' then c.to_phone else c.from_phone end, ''), '\D', '', 'g'), 10)
     where c.workspace_id = p_ws
       and (p_since is null or c.occurred_at >= p_since)
       and (p_until is null or c.occurred_at < p_until)
  ),
  kept as (
    select * from base b
     where not exists (select 1 from resets x where x.rep = coalesce(b.rep_id::text, b.seller_rep::text) and b.occurred_at < x.cut)
  )
  select case
    when p_ws in (select public.my_workspace_ids()) or auth.role() = 'service_role' then jsonb_build_object(
      'comms', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'seller_id', null, 'rep_id', g.rep_id, 'line_rep', g.line_rep, 'seller_rep', g.seller_rep,
                 'channel', g.channel, 'direction', g.direction, 'occurred_at', g.occurred_at, 'duration_s', null, 'status', null,
                 'n', g.n, 'talk_s', g.talk_s, 'convos', g.convos))
          from (
            select rep_id, line_rep, seller_rep, channel, direction,
                   max(occurred_at) as occurred_at, count(*) as n,
                   sum(coalesce(duration_s, 0)) as talk_s,
                   count(*) filter (where duration_s >= 120) as convos
              from kept
             group by rep_id, line_rep, seller_rep, channel, direction, (occurred_at at time zone p_tz)::date
          ) g), '[]'::jsonb),
      'first_touch', coalesce((
        select jsonb_object_agg(f.seller_id, f.at)
          from (select seller_id, min(occurred_at) as at from kept
                 where seller_id is not null and direction is distinct from 'inbound' group by seller_id) f), '{}'::jsonb))
    else jsonb_build_object('comms', '[]'::jsonb, 'first_touch', '{}'::jsonb)
  end;
$$;

revoke all on function public.leaderboard_comms(bigint, text, timestamptz, timestamptz, jsonb) from public, anon;
grant execute on function public.leaderboard_comms(bigint, text, timestamptz, timestamptz, jsonb) to authenticated, service_role;

-- ---- 2. report_comms with a window --------------------------------------------------------

drop function if exists public.report_comms(bigint, integer);

create or replace function public.report_comms(p_ws bigint, p_limit integer default 10000, p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) or auth.role() = 'service_role' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'seller_id', c.seller_id, 'buyer_id', c.buyer_id, 'rep_id', c.rep_id,
               'from_phone', c.from_phone, 'to_phone', c.to_phone,
               'channel', c.channel, 'direction', c.direction, 'occurred_at', c.occurred_at,
               'duration_s', c.duration_s, 'status', c.status)
             order by c.occurred_at desc, c.id desc)
        from (
          select id, seller_id, buyer_id, rep_id, from_phone, to_phone, channel, direction, occurred_at, duration_s, status
            from public.communications
           where workspace_id = p_ws and (p_since is null or occurred_at >= p_since)
           order by occurred_at desc, id desc
           limit least(greatest(coalesce(p_limit, 10000), 1), 60000)
        ) c), '[]'::jsonb)
    else '[]'::jsonb
  end;
$$;

revoke all on function public.report_comms(bigint, integer, timestamptz) from public, anon;
grant execute on function public.report_comms(bigint, integer, timestamptz) to authenticated, service_role;

-- ---- 3. the AI agents' report -----------------------------------------------------------

-- p_contract_stages: the seller stages that mean under contract or closed (lib/stages.ts), so the
-- funnel's "contracts" matches the code's sellerStageGroup.
create or replace function public.ai_agent_report(p_ws bigint, p_since timestamptz, p_tz text default 'America/Chicago', p_contract_stages text[] default '{}')
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with acts as (
    select agent_key, action, status, record_kind, record_id, created_at
      from public.ai_agent_actions where workspace_id = p_ws and created_at >= p_since
  ),
  calls as (
    select agent_key, seller_id, coalesce(duration_s, 0) as duration_s, booked, transferred
      from public.voice_agent_calls where workspace_id = p_ws and occurred_at >= p_since
  ),
  act_sellers as (select record_id as seller_id, action, status from acts where record_kind = 'seller' and record_id is not null),
  convo_calls as (select seller_id from calls where seller_id is not null and duration_s >= 30),
  touched as (
    select seller_id from act_sellers where status = 'done' and action in ('sms_sent', 'email_sent', 'call_placed')
    union select seller_id from convo_calls
  ),
  conversations as (
    select seller_id from act_sellers where action = 'reply_seen'
    union select seller_id from convo_calls
  ),
  qualified as (select distinct seller_id from act_sellers where status = 'done' and action in ('qualification_saved', 'relayed', 'handoff')),
  booked as (
    select seller_id from act_sellers where status = 'done' and action = 'appointment_booked'
    union select seller_id from calls where booked and seller_id is not null
    union select seller_id from public.appointments where workspace_id = p_ws and booked_by = 'ai_agent' and created_at >= p_since and seller_id is not null
  ),
  transferred as (select distinct seller_id from calls where transferred and seller_id is not null),
  reactivated as (
    select distinct seller_id from public.ai_autopilot_leads
     where workspace_id = p_ws and program = 'reactivation' and status = 'enrolled' and queued_at >= p_since and seller_id is not null
  ),
  worked as (select seller_id from touched union select seller_id from booked),
  contracts as (
    select w.seller_id from worked w
     where exists (select 1 from public.contracts k where k.workspace_id = p_ws and k.seller_id = w.seller_id and k.status = 'completed' and k.completed_at >= p_since)
        or exists (select 1 from public.sellers s where s.id = w.seller_id and s.lead_stage = any (p_contract_stages))
  ),
  speed as (
    select seller_id, lead_created_at, first_touch_at,
           case when lead_created_at is null then null
                when extract(dow from (lead_created_at at time zone p_tz)) in (0, 6) then 'weekend'
                when extract(hour from (lead_created_at at time zone p_tz)) * 60 + extract(minute from (lead_created_at at time zone p_tz)) between 540 and 1019 then 'business'
                else 'after_hours' end as bucket,
           case when first_touch_at is not null and lead_created_at is not null and first_touch_at >= lead_created_at
                then extract(epoch from first_touch_at - lead_created_at) end as secs
      from public.ai_autopilot_leads where workspace_id = p_ws and program = 'speed' and queued_at >= p_since
  ),
  bucket as (
    select b.name,
           count(s.*) as leads,
           count(s.*) filter (where s.first_touch_at is not null) as contacted,
           count(s.*) filter (where s.seller_id in (select seller_id from booked)) as booked
      from (values ('business'), ('after_hours'), ('weekend')) b(name)
      left join speed s on s.bucket = b.name
     group by b.name
  )
  select jsonb_build_object(
    'agents', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.agent_key)
        from (
          select a.agent_key,
                 count(*) filter (where a.status = 'done' and a.action = 'sms_sent') as texts,
                 count(*) filter (where a.status = 'done' and a.action = 'email_sent') as emails,
                 count(*) filter (where a.status = 'done' and a.action = 'call_placed') as calls,
                 count(*) filter (where a.status = 'done' and a.action = 'rvm_sent') as voicemails,
                 count(*) filter (where a.action = 'reply_seen') as replies,
                 count(*) filter (where a.status = 'done' and a.action = 'appointment_booked') as booked,
                 count(*) filter (where a.status = 'done' and a.action in ('handoff', 'relayed')) as handoffs,
                 count(*) filter (where a.status = 'done' and a.action = 'marked_dnc') as dnc,
                 count(*) filter (where a.status = 'failed') as failed,
                 count(distinct (a.record_kind, a.record_id)) filter (where a.status = 'done' and a.action in ('sms_sent', 'email_sent', 'call_placed', 'rvm_sent') and a.record_kind is not null and a.record_id is not null) as records_touched,
                 coalesce((
                   select jsonb_object_agg(d.day, d.n)
                     from (select to_char(created_at at time zone p_tz, 'YYYY-MM-DD') as day, count(*) as n
                             from acts x where x.agent_key = a.agent_key and x.status = 'done' and x.action in ('sms_sent', 'email_sent', 'call_placed', 'rvm_sent')
                            group by 1) d), '{}'::jsonb) as by_day
            from acts a group by a.agent_key) a), '[]'::jsonb),
    'enrollments', coalesce((
      select jsonb_agg(to_jsonb(e))
        from (select e.agent_key, count(*) as total,
                     count(*) filter (where e.status = 'active') as active, count(*) filter (where e.status = 'done') as done, count(*) filter (where e.status = 'stopped') as stopped
                from public.ai_agent_enrollments e where e.workspace_id = p_ws group by e.agent_key) e), '[]'::jsonb),
    'voice', coalesce((
      select jsonb_agg(to_jsonb(c))
        from (select c.agent_key, count(*) as calls, count(*) filter (where c.booked) as booked,
                     count(*) filter (where c.transferred) as transferred, sum(greatest(0, c.duration_s)) as seconds
                from calls c group by c.agent_key) c), '[]'::jsonb),
    'funnel', jsonb_build_object(
      'new_leads', (select count(*) from public.sellers where workspace_id = p_ws and created_at >= p_since),
      'speed_queued', (select count(*) from speed),
      'contacted', (select count(*) from touched),
      'median_first_touch_s', (select case when count(*) = 0 then null when count(*) % 2 = 0 then round(percentile_cont(0.5) within group (order by secs)) else percentile_cont(0.5) within group (order by secs) end from speed where secs is not null),
      'under_60s', (select count(*) from speed where secs is not null and secs <= 60),
      'conversations', (select count(*) from conversations),
      'qualified', (select count(*) from qualified),
      'appointments', (select count(*) from booked),
      'transfers', (select count(*) from transferred),
      'contracts', (select count(*) from contracts),
      'reactivated', (select count(*) from reactivated),
      'reactivated_replied', (select count(*) from reactivated r where r.seller_id in (select seller_id from conversations)),
      'reactivated_booked', (select count(*) from reactivated r where r.seller_id in (select seller_id from booked)),
      'by_time', (select jsonb_object_agg(name, jsonb_build_object('leads', leads, 'contacted', contacted, 'booked', booked)) from bucket),
      'ai_calls', (select count(*) from acts where status = 'done' and action = 'call_placed')));
$$;

revoke all on function public.ai_agent_report(bigint, timestamptz, text, text[]) from public, anon, authenticated;
grant execute on function public.ai_agent_report(bigint, timestamptz, text, text[]) to service_role;

create or replace function public.ai_autopilot_today(p_ws bigint, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with leads as (
    select program, status,
           case when first_touch_at is not null and lead_created_at is not null and first_touch_at >= lead_created_at
                then extract(epoch from first_touch_at - lead_created_at) end as secs
      from public.ai_autopilot_leads where workspace_id = p_ws and queued_at >= p_since
  ),
  acts as (
    select action from public.ai_agent_actions
     where workspace_id = p_ws and status = 'done' and action in ('call_placed', 'sms_sent', 'email_sent') and created_at >= p_since and detail ->> 'program' is not null
  )
  select jsonb_build_object(
    'speed_enrolled', (select count(*) from leads where program = 'speed' and status in ('touched', 'enrolled')),
    'speed_skipped', (select count(*) from leads where program = 'speed' and status = 'skipped'),
    'reactivated', (select count(*) from leads where program = 'reactivation' and status = 'enrolled'),
    'calls', (select count(*) from acts where action = 'call_placed'),
    'texts', (select count(*) from acts where action = 'sms_sent'),
    'emails', (select count(*) from acts where action = 'email_sent'),
    'median_first_touch_s', (select case when count(*) = 0 then null when count(*) % 2 = 0 then round(percentile_cont(0.5) within group (order by secs)) else percentile_cont(0.5) within group (order by secs) end from leads where program = 'speed' and secs is not null));
$$;

revoke all on function public.ai_autopilot_today(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_autopilot_today(bigint, timestamptz) to service_role;

-- ---- 4. RVM blast results ------------------------------------------------------------------

create or replace function public.rvm_blast_summary(p_ws bigint, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with d as (
    select created_by, created_at, status, from_e164, callback_at, pool_tier,
           case when blast_id is not null then 'blast:' || blast_id
                when enrollment_id is not null then 'plan'
                else 'legacy:' || coalesce(created_by::text, 'nobody') || ':' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24') end as key,
           case when blast_id is null and enrollment_id is not null then 'plan' else 'blast' end as kind
      from public.rvm_drops where workspace_id = p_ws and created_at >= p_since
  ),
  g as (
    select key, kind,
           (array_agg(created_by order by created_at desc))[1] as created_by,
           min(created_at) as started_at,
           count(*) as total,
           count(*) filter (where status = 'dropped') as delivered,
           count(*) filter (where status = 'failed') as failed,
           count(*) filter (where status = 'skipped') as skipped,
           count(*) filter (where status in ('queued', 'sending', 'dialing', 'ready')) as pending,
           count(*) filter (where callback_at is not null) as callbacks,
           count(*) filter (where pool_tier in ('area_code', 'state', 'phone_state')) as local,
           count(*) filter (where coalesce(pool_tier, '') <> '') as tiered,
           coalesce((
             select jsonb_agg(jsonb_build_object('line', l.line, 'sent', l.sent, 'delivered', l.delivered, 'failed', l.failed, 'callbacks', l.callbacks) order by l.sent desc, l.line)
               from (select from_e164 as line, count(*) as sent, count(*) filter (where status = 'dropped') as delivered,
                            count(*) filter (where status = 'failed') as failed, count(*) filter (where callback_at is not null) as callbacks
                       from d x where x.key = d.key and coalesce(x.from_e164, '') <> '' group by from_e164) l), '[]'::jsonb) as lines
      from d group by key, kind
  )
  select case
    when p_ws in (select public.my_workspace_ids()) or auth.role() = 'service_role'
      then coalesce((select jsonb_agg(to_jsonb(g) order by g.started_at desc) from g), '[]'::jsonb)
    else '[]'::jsonb
  end;
$$;

revoke all on function public.rvm_blast_summary(bigint, timestamptz) from public, anon;
grant execute on function public.rvm_blast_summary(bigint, timestamptz) to authenticated, service_role;
