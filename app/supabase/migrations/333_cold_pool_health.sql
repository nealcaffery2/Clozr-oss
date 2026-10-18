-- 333 · cold_pool_health: the cold pool's health counts in one aggregate.
--
-- cold-campaign-tick's pauseUnhealthy read up to 5,000 cold_sends rows and
-- 5,000 cold_replies rows for a workspace, plus its mailboxes and domains,
-- on every tick (about 50 an hour) and counted them in JS. This returns the
-- same counts in one call: per mailbox and per domain, 7-day sends (not
-- failed), bounces, complaints and replies among them, hard bounces in the
-- last 50 sends (failed ones included, as before), 30-day sends that did not
-- fail, and 30-day unsubscribe replies. The thresholds stay in TS
-- (poolPauseReason), so the pause rules cannot drift from the planner's.
--
-- Proved read-only (this body as a plain SELECT), against the
-- JS it replaces (tick.ts healthFromRows, the old counts() moved as is) fed
-- the rows the old reads return:
--   a live workspace (dozens of mailboxes and sends, some bounced, two
--     domains at 3 hard bounces in their last 50): no field differs
--   synthetic (tables swapped for VALUES): 130 sends across two workspaces,
--     62 on one domain (last-50 cut), failed, queued, replied and null-status
--     rows, bounced_at / replied_at without the matching status, complaints,
--     sends on no mailbox, a paused mailbox and domain, a domain with no
--     mailbox, 30 replies of mixed class: 91 fields, 0 differ; and a complaint
--     set (failed, null status, outside 7 days): 20 fields, 0 differ.
-- Two edges where the old read was looser: it compared timestamps as text
-- for the 7-day split (only a send within the same second as that line can
-- differ)
-- and it stopped at an arbitrary 5,000 rows; this counts every row.
-- About 2 ms on a live workspace.
--
-- Service role only (cold-campaign-tick). The tick falls back to the old
-- reads while this is not applied. Safe to re-run.

create or replace function public.cold_pool_health(p_workspace bigint, p_since7 timestamptz, p_since30 timestamptz)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with box as (
    select m.id, m.domain_id, m.email, m.paused
      from public.cold_mailboxes m
     where m.workspace_id = p_workspace
  ),
  s as (
    select c.mailbox_id, b.domain_id,
           c.status is distinct from 'failed' as live,
           c.sent_at >= p_since7 and c.status is distinct from 'failed' as wk,
           coalesce(c.status = 'bounced', false) or c.bounced_at is not null as bounced,
           coalesce(c.status = 'replied', false) or c.replied_at is not null as replied,
           c.complained_at is not null as complained,
           row_number() over (partition by c.mailbox_id order by c.sent_at desc, c.id desc) as box_rank,
           row_number() over (partition by b.domain_id order by c.sent_at desc, c.id desc) as domain_rank
      from public.cold_sends c
      join box b on b.id = c.mailbox_id
     where c.workspace_id = p_workspace and c.sent_at >= p_since30
  ),
  u as (
    select r.mailbox_id, count(*)::int as n
      from public.cold_replies r
     where r.workspace_id = p_workspace and r.classification = 'unsubscribe' and r.received_at >= p_since30
     group by r.mailbox_id
  ),
  bm as (
    select b.id, b.domain_id, b.email, b.paused,
           count(*) filter (where s.wk)::int as sent7d,
           count(*) filter (where s.wk and s.bounced)::int as bounced7d,
           count(*) filter (where s.box_rank <= 50 and s.bounced)::int as hard50,
           count(*) filter (where s.live)::int as bulk30d,
           count(*) filter (where s.wk and s.complained)::int as complaints7d,
           count(*) filter (where s.wk and s.replied)::int as replied7d
      from box b
      left join s on s.mailbox_id = b.id
     group by b.id, b.domain_id, b.email, b.paused
  ),
  bd as (
    select d.id, d.paused,
           count(s.domain_id) filter (where s.wk)::int as sent7d,
           count(s.domain_id) filter (where s.wk and s.bounced)::int as bounced7d,
           count(s.domain_id) filter (where s.domain_rank <= 50 and s.bounced)::int as hard50,
           count(s.domain_id) filter (where s.live)::int as bulk30d,
           count(s.domain_id) filter (where s.wk and s.complained)::int as complaints7d,
           count(s.domain_id) filter (where s.wk and s.replied)::int as replied7d
      from public.cold_domains d
      left join s on s.domain_id = d.id
     where d.workspace_id = p_workspace
     group by d.id, d.paused
  )
  select json_build_object(
    'mailboxes', coalesce((
      select json_agg(json_build_object(
               'id', bm.id, 'domainId', bm.domain_id, 'email', bm.email, 'paused', bm.paused,
               'sent7d', bm.sent7d, 'bounced7d', bm.bounced7d, 'hardInLast50', bm.hard50, 'bulk30d', bm.bulk30d,
               'unsub30d', coalesce(u.n, 0), 'complaints7d', bm.complaints7d, 'replied7d', bm.replied7d
             ) order by bm.id)
        from bm left join u on u.mailbox_id = bm.id
    ), '[]'::json),
    'domains', coalesce((
      select json_agg(json_build_object(
               'id', bd.id, 'paused', bd.paused,
               'sent7d', bd.sent7d, 'bounced7d', bd.bounced7d, 'hardInLast50', bd.hard50, 'bulk30d', bd.bulk30d,
               'unsub30d', coalesce((select sum(u.n) from u join box b on b.id = u.mailbox_id where b.domain_id = bd.id), 0)::int,
               'complaints7d', bd.complaints7d, 'replied7d', bd.replied7d
             ) order by bd.id)
        from bd
    ), '[]'::json)
  );
$$;

revoke all on function public.cold_pool_health(bigint, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.cold_pool_health(bigint, timestamptz, timestamptz) to service_role;
