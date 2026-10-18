-- 260 · Team stoplight (Reporting, owner/admin only).
--
-- One call returns what each teammate did in a range and what they are
-- leaving undone, so the Reporting "Team stoplight" tab (components/
-- reporting/TeamStoplight.tsx) grades them against lib/stoplight.ts without
-- loading every row into the browser. Counts only: the targets and the
-- green / yellow / red rule live in the client, where they are tested.
--
-- Noise kept out on purpose:
--   * Calendar meetings (appointments.source = 'google') are not seller
--     appointments; they are counted apart as `calendar_meetings`.
--   * Prospect-stage deals (typically a bulk import, often with
--     negative fees) never count as contracts, pipeline or
--     "no next step"; they are reported in `noise`.
--   * Revenue and pipeline only add positive fees.
--   * Buyers added in bulk (source import, podio, dispogenius) are not a
--     rep adding buyers; they are counted apart as `buyers_imported`.
--   * A TC file is open when its transaction is open and its deal is live
--     (not archived, in an active stage, not closed), so the files left open
--     on Closed or Terminated deals do not read as missed work.
--
-- Safe to re-run.

create or replace function public.team_stoplight(
  p_workspace bigint,
  p_from timestamptz,
  p_to timestamptz,
  p_stale_days integer default 7
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
  -- Date columns (contract, close, marketing) compare by Chicago day. The
  -- range's last day is the day of the moment just before p_to: today while
  -- a range is still running (p_to = now), Sunday for last week (p_to =
  -- Monday 00:00), so today's contracts and closings count.
  v_first_day date := (p_from at time zone 'America/Chicago')::date;
  v_last_day date := ((p_to - interval '1 microsecond') at time zone 'America/Chicago')::date;
begin
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  ) then
    raise exception 'Only an owner or admin can read the team stoplight' using errcode = '42501';
  end if;

  with
  mem as (
    select m.user_id, m.role, coalesce(nullif(trim(p.full_name), ''), p.email, 'Teammate') as name, p.avatar_url
    from public.workspace_members m
    join public.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace and m.role not in ('notary')
  ),
  comms as (
    select c.rep_id,
      count(*) filter (where c.channel = 'call' and c.direction = 'outbound' and c.buyer_id is null) as calls,
      coalesce(sum(c.duration_s) filter (where c.channel = 'call' and c.buyer_id is null), 0) as talk_s,
      count(*) filter (where c.channel = 'call' and c.buyer_id is null and coalesce(c.duration_s, 0) >= 60) as conversations,
      count(*) filter (where c.channel = 'call' and c.direction = 'outbound' and c.buyer_id is not null) as buyer_calls,
      coalesce(sum(c.duration_s) filter (where c.channel = 'call' and c.buyer_id is not null), 0) as buyer_talk_s,
      count(*) filter (where c.channel = 'sms' and c.direction = 'outbound' and c.buyer_id is not null) as buyer_texts
    from public.communications c
    where c.workspace_id = p_workspace and c.rep_id is not null
      and c.occurred_at >= p_from and c.occurred_at < p_to
    group by c.rep_id
  ),
  appts as (
    select coalesce(a.assigned_to, a.created_by) as user_id,
      count(*) filter (where coalesce(a.source, 'clozr') <> 'google' and a.seller_id is not null) as appointments,
      count(*) filter (where a.source = 'google') as calendar_meetings
    from public.appointments a
    where a.workspace_id = p_workspace and a.deleted_at is null
      and a.created_at >= p_from and a.created_at < p_to
    group by 1
  ),
  offer_sellers as (
    select o.created_by as user_id, o.seller_id
    from public.offers o
    where o.workspace_id = p_workspace and o.direction = 'outbound' and o.seller_id is not null
      and coalesce(o.sent_at, o.created_at) >= p_from and coalesce(o.sent_at, o.created_at) < p_to
    union
    select se.changed_by, case when se.entity_type = 'deal' then d.seller_id else se.entity_id end
    from public.stage_events se
    left join public.deals d on se.entity_type = 'deal' and d.id = se.entity_id
    where se.workspace_id = p_workspace and se.changed_by is not null
      and se.field = 'lead_stage' and se.to_stage ilike 'Offer Made%'
      and se.changed_at >= p_from and se.changed_at < p_to
  ),
  offers as (
    select user_id, count(distinct seller_id) as offers from offer_sellers where user_id is not null and seller_id is not null group by 1
  ),
  contracts as (
    select d.owner_id as user_id, count(*) as contracts
    from public.deals d
    where d.workspace_id = p_workspace and d.stage <> 'Prospect' and d.owner_id is not null
      and d.contract_date between v_first_day and v_last_day
    group by 1
  ),
  buyer_contracts as (
    select d.dispo_rep_id as user_id, count(distinct d.id) as buyer_contracts
    from public.stage_events se
    join public.deals d on d.id = se.entity_id
    where se.workspace_id = p_workspace and se.entity_type = 'deal' and se.field = 'stage'
      and se.to_stage = 'Buyer Under Contract' and d.dispo_rep_id is not null
      and se.changed_at >= p_from and se.changed_at < p_to
    group by 1
  ),
  marketed as (
    select d.dispo_rep_id as user_id, count(*) as deals_marketed
    from public.deals d
    where d.workspace_id = p_workspace and d.dispo_rep_id is not null
      and d.marketing_started_on between v_first_day and v_last_day
    group by 1
  ),
  buyers_added as (
    select b.created_by as user_id,
      count(*) filter (where coalesce(b.source, '') !~* '(import|podio|dispo?s?genius)') as buyers_added,
      count(*) filter (where coalesce(b.source, '') ~* '(import|podio|dispo?s?genius)') as buyers_imported
    from public.buyers b
    where b.workspace_id = p_workspace and b.created_by is not null
      and b.created_at >= p_from and b.created_at < p_to
    group by 1
  ),
  buyer_offers as (
    select d.dispo_rep_id as user_id, count(*) as buyer_offers
    from public.offers o
    join public.deals d on d.id = o.deal_id
    where o.workspace_id = p_workspace and o.buyer_id is not null and d.dispo_rep_id is not null
      and o.created_at >= p_from and o.created_at < p_to
    group by 1
  ),
  fees as (
    select d.id, d.owner_id, d.dispo_rep_id, d.stage, d.closed_on, d.archived_at,
      coalesce(d.dispo_fee, case when d.wholesale_fee > 0 then d.wholesale_fee end, d.assignment_fee) as fee
    from public.deals d
    where d.workspace_id = p_workspace and d.stage <> 'Prospect'
  ),
  closed as (
    select who, side, count(*) as n, coalesce(sum(fee) filter (where fee > 0), 0) as revenue
    from (
      select owner_id as who, 'acq' as side, fee from fees
      where stage = 'Closed' and owner_id is not null
        and closed_on between v_first_day and v_last_day
      union all
      select dispo_rep_id, 'dispo', fee from fees
      where stage = 'Closed' and dispo_rep_id is not null
        and closed_on between v_first_day and v_last_day
    ) x
    group by 1, 2
  ),
  pipeline as (
    select who, side, coalesce(sum(fee) filter (where fee > 0), 0) as pipeline, count(*) as n
    from (
      select owner_id as who, 'acq' as side, fee from fees
      where archived_at is null and stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow') and owner_id is not null
      union all
      select dispo_rep_id, 'dispo', fee from fees
      where archived_at is null and stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow') and dispo_rep_id is not null
    ) x
    group by 1, 2
  ),
  overdue as (
    select t.assigned_to as user_id, count(*) as n, count(*) filter (where t.deal_id is null) as unlinked
    from public.tasks t
    where t.workspace_id = p_workspace and not t.done and t.due_at < now() and t.assigned_to is not null
    group by 1
  ),
  untouched as (
    select s.assigned_to as user_id, count(*) as n
    from public.sellers s
    where s.workspace_id = p_workspace and s.archived_at is null and s.assigned_to is not null
      and not exists (
        select 1 from public.communications c
        where c.seller_id = s.id and c.channel in ('call', 'sms', 'email') and c.direction = 'outbound'
      )
    group by 1
  ),
  live_deals as (
    select d.id, d.seller_id, d.stage, d.owner_id, d.dispo_rep_id, d.tc_rep_id,
      coalesce(nullif(trim(pr.line1), ''), nullif(trim(s.property_address), ''), s.name, 'Deal ' || d.id) as label
    from public.deals d
    left join public.properties pr on pr.id = d.property_id
    left join public.sellers s on s.id = d.seller_id
    where d.workspace_id = p_workspace and d.archived_at is null and d.closed_on is null
      and d.stage in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow')
  ),
  -- One row per (teammate, deal): someone who owns and also sells or
  -- coordinates a deal is counted once.
  no_next as (
    select distinct ld.*,
      u.user_id
    from live_deals ld
    cross join lateral (values (ld.owner_id), (ld.dispo_rep_id), (ld.tc_rep_id)) u(user_id)
    where u.user_id is not null
      and not exists (
        select 1 from public.tasks t
        where not t.done and (t.deal_id = ld.id or (t.deal_id is null and ld.seller_id is not null and t.seller_id = ld.seller_id))
      )
  ),
  last_call as (
    select m.user_id, (
      select max(c.occurred_at) from public.communications c
      where c.workspace_id = p_workspace and c.rep_id = m.user_id and c.channel = 'call' and c.direction = 'outbound'
    ) as at
    from mem m
  ),
  people as (
    select jsonb_build_object(
      'user_id', m.user_id,
      'name', m.name,
      'role', m.role,
      'avatar_url', m.avatar_url,
      'is_tc', m.role = 'tc' or exists (select 1 from live_deals ld where ld.tc_rep_id = m.user_id),
      'last_call_at', lc.at,
      'metrics', jsonb_build_object(
        'calls', coalesce(cm.calls, 0),
        'talk_min', round(coalesce(cm.talk_s, 0) / 60.0),
        'conversations', coalesce(cm.conversations, 0),
        'appointments', coalesce(ap.appointments, 0),
        'calendar_meetings', coalesce(ap.calendar_meetings, 0),
        'offers', coalesce(o.offers, 0),
        'contracts', coalesce(ct.contracts, 0),
        'buyer_calls', coalesce(cm.buyer_calls, 0),
        'buyer_talk_min', round(coalesce(cm.buyer_talk_s, 0) / 60.0),
        'buyer_texts', coalesce(cm.buyer_texts, 0),
        'buyers_added', coalesce(ba.buyers_added, 0),
        'buyer_offers', coalesce(bo.buyer_offers, 0),
        'deals_marketed', coalesce(mk.deals_marketed, 0),
        'buyer_contracts', coalesce(bc.buyer_contracts, 0),
        'closed_acq', coalesce(ca.n, 0),
        'revenue_acq', coalesce(ca.revenue, 0),
        'closed_dispo', coalesce(cd.n, 0),
        'revenue_dispo', coalesce(cd.revenue, 0),
        'pipeline_acq', coalesce(pa.pipeline, 0),
        'pipeline_dispo', coalesce(pd.pipeline, 0)
      ),
      'gaps', jsonb_build_object(
        'overdue_tasks', coalesce(od.n, 0),
        'overdue_unlinked', coalesce(od.unlinked, 0),
        'untouched_leads', coalesce(ut.n, 0),
        'no_next_step', (select count(distinct nn.id) from no_next nn where nn.user_id = m.user_id)
      ),
      'items', jsonb_build_object(
        'overdue_tasks', coalesce((
          select jsonb_agg(x order by x->>'due_at') from (
            select jsonb_build_object('id', t.id, 'title', t.title, 'due_at', t.due_at, 'seller_id', t.seller_id,
              'deal_id', t.deal_id, 'buyer_id', t.buyer_id, 'who', s.name) as x
            from public.tasks t
            left join public.sellers s on s.id = t.seller_id
            where t.workspace_id = p_workspace and t.assigned_to = m.user_id and not t.done and t.due_at < now()
            order by t.due_at
            limit 25
          ) q
        ), '[]'::jsonb),
        'untouched_leads', coalesce((
          select jsonb_agg(x) from (
            select jsonb_build_object('id', s.id, 'name', s.name, 'address', s.property_address, 'created_at', s.created_at) as x
            from public.sellers s
            where s.workspace_id = p_workspace and s.archived_at is null and s.assigned_to = m.user_id
              and not exists (
                select 1 from public.communications c
                where c.seller_id = s.id and c.channel in ('call', 'sms', 'email') and c.direction = 'outbound'
              )
            order by s.created_at desc
            limit 25
          ) q
        ), '[]'::jsonb),
        'no_next_step', coalesce((
          select jsonb_agg(jsonb_build_object('deal_id', nn.id, 'seller_id', nn.seller_id, 'label', nn.label, 'stage', nn.stage) order by nn.id)
          from no_next nn where nn.user_id = m.user_id
        ), '[]'::jsonb)
      )
    ) as j
    from mem m
    left join comms cm on cm.rep_id = m.user_id
    left join appts ap on ap.user_id = m.user_id
    left join offers o on o.user_id = m.user_id
    left join contracts ct on ct.user_id = m.user_id
    left join buyer_contracts bc on bc.user_id = m.user_id
    left join marketed mk on mk.user_id = m.user_id
    left join buyers_added ba on ba.user_id = m.user_id
    left join buyer_offers bo on bo.user_id = m.user_id
    left join closed ca on ca.who = m.user_id and ca.side = 'acq'
    left join closed cd on cd.who = m.user_id and cd.side = 'dispo'
    left join pipeline pa on pa.who = m.user_id and pa.side = 'acq'
    left join pipeline pd on pd.who = m.user_id and pd.side = 'dispo'
    left join overdue od on od.user_id = m.user_id
    left join untouched ut on ut.user_id = m.user_id
    left join last_call lc on lc.user_id = m.user_id
  ),
  tc_files as (
    select jsonb_build_object(
      'transaction_id', t.id,
      'deal_id', ld.id,
      'seller_id', ld.seller_id,
      'label', ld.label,
      'stage', ld.stage,
      'deal_type', coalesce(t.deal_type, 'assignment'),
      'contract_date', t.contract_date,
      'ctc_target', t.ctc_target,
      'close_date', t.close_date,
      'emd_received_at', t.emd_received_at,
      'checklist', coalesce((select jsonb_agg(k) from jsonb_each(case when jsonb_typeof(t.checklist) = 'object' then t.checklist else '{}'::jsonb end) e(k, v) where v = 'true'::jsonb), '[]'::jsonb),
      'schedule_c', case when jsonb_typeof(t.schedule_c) = 'array' then t.schedule_c else '[]'::jsonb end,
      'tc_rep_id', ld.tc_rep_id,
      'last_activity_at', greatest(
        (select max(c.occurred_at) from public.communications c where c.deal_id = ld.id),
        (select max(c.occurred_at) from public.communications c where ld.seller_id is not null and c.seller_id = ld.seller_id),
        (select max(tk.completed_at) from public.tasks tk where tk.deal_id = ld.id and tk.done),
        (select max(se.changed_at) from public.stage_events se where se.entity_type = 'deal' and se.entity_id = ld.id and se.changed_by is not null)
      )
    ) as j
    from public.transactions t
    join live_deals ld on ld.id = t.deal_id
    where t.workspace_id = p_workspace and t.status = 'open'
  )
  select jsonb_build_object(
    'generated_at', now(),
    'from', p_from,
    'to', p_to,
    'stale_days', p_stale_days,
    'people', coalesce((select jsonb_agg(j order by j->>'name') from people), '[]'::jsonb),
    'tc_files', coalesce((select jsonb_agg(j order by j->>'contract_date') from tc_files), '[]'::jsonb),
    'noise', jsonb_build_object(
      'prospect_deals', (select count(*) from public.deals d where d.workspace_id = p_workspace and d.stage = 'Prospect' and d.archived_at is null),
      'prospect_negative_fee', (select count(*) from public.deals d where d.workspace_id = p_workspace and d.stage = 'Prospect' and d.archived_at is null
        and (coalesce(d.assignment_fee, 0) < 0 or coalesce(d.wholesale_fee, 0) < 0)),
      'open_files_on_ended_deals', (select count(*) from public.transactions t join public.deals d on d.id = t.deal_id
        where t.workspace_id = p_workspace and t.status = 'open'
          and (d.archived_at is not null or d.closed_on is not null or d.stage not in ('Under Contract Seller', 'Ready To Market', 'Buyer Under Contract', 'In Escrow'))),
      'calendar_meetings', (select coalesce(sum(calendar_meetings), 0) from appts),
      'buyers_imported', (select coalesce(sum(buyers_imported), 0) from buyers_added)
    )
  ) into v_out;

  return v_out;
end
$$;

revoke all on function public.team_stoplight(bigint, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.team_stoplight(bigint, timestamptz, timestamptz, integer) to authenticated;

notify pgrst, 'reload schema';
