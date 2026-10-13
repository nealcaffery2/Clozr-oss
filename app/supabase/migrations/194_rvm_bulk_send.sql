-- 194: bulk ringless voicemail that goes out now, with a pre-send check, and
-- a drop that knows the deal it is about.
--
-- rvm_drops.deal_id: the deal a blast was about (the composer's "About a
-- deal", a dispo push, the Deals list's seller drop). A callback is filed on
-- that deal's timeline and the notification opens it (migration 196).
--
-- rvm_send_preview(ws, seller_ids, buyer_ids): what the composer needs to say,
-- before anything is queued, how many go out now, how many wait for their
-- local window, how many rvm-tick would skip and why (lib/rvm-send.ts runs
-- the tick's own rules over it). Per person: tags, blacklisted_at,
-- wants_calls, the property's state or the buyer's markets, the last
-- delivered drop, the last real conversation (a call of 20s or more, or an
-- RVM call a person answered) and drops already on the way (each read on
-- rvm_drops_person, workspace first). Plus the pool:
-- every caller_lines row with pool = 'rvm', what it carried since Central
-- midnight, and the number guard's verdict on it. Members only.
--
-- rvm_send_now(ws): kicks rvm-tick straight away instead of waiting for the
-- minute cron, so a blast starts the moment it is queued. The tick re-checks
-- every rule at send time; this only changes when it looks. Members only.
--
-- rvm_tick_lease(seconds) / rvm_tick_release(): one tick run at a time
-- (service role). A run counts each pool line's drops today once and then in
-- memory, so two overlapping runs (the cron and a send-now kick) could each
-- spend a line's whole warm-up cap. A lease row, not an advisory lock: the
-- function's connections are pooled. A crashed run's lease simply expires.
-- Safe to run again.

alter table public.rvm_drops
  add column if not exists deal_id bigint references public.deals(id) on delete set null;
create index if not exists rvm_drops_deal on public.rvm_drops (deal_id) where deal_id is not null;

create or replace function public.rvm_send_preview(p_ws bigint, p_seller_ids bigint[], p_buyer_ids bigint[])
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_people jsonb;
  v_pool jsonb;
  v_settings jsonb;
  v_midnight timestamptz := date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago';
  v_sellers bigint[] := (coalesce(p_seller_ids, '{}'::bigint[]))[1:5000];
  v_buyers bigint[] := (coalesce(p_buyer_ids, '{}'::bigint[]))[1:5000];
begin
  if p_ws is null or p_ws not in (select public.my_workspace_ids()) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_people from (
    select 'seller' as kind, se.id, se.tags, null::timestamptz as blacklisted_at, null::boolean as wants_calls,
           pr.state, null::text[] as markets,
           (select max(d.sent_at) from public.rvm_drops d where d.workspace_id = p_ws and d.seller_id = se.id and d.status = 'dropped') as last_drop_at,
           greatest(
             (select max(c.occurred_at) from public.communications c where c.seller_id = se.id and c.channel = 'call' and c.duration_s >= 20),
             (select max(d.sent_at) from public.rvm_drops d where d.workspace_id = p_ws and d.seller_id = se.id and d.status = 'answered')) as last_talk_at,
           (select count(*) from public.rvm_drops d where d.workspace_id = p_ws and d.seller_id = se.id and d.status in ('queued', 'sending', 'dialing')) as pending
      from public.sellers se
      left join public.properties pr on pr.id = se.property_id
     where se.workspace_id = p_ws and se.id = any(v_sellers)
    union all
    select 'buyer', b.id, b.tags, b.blacklisted_at, b.wants_calls, null, b.markets,
           (select max(d.sent_at) from public.rvm_drops d where d.workspace_id = p_ws and d.seller_id is null and d.buyer_id = b.id and d.status = 'dropped'),
           greatest(
             (select max(c.occurred_at) from public.communications c where c.buyer_id = b.id and c.channel = 'call' and c.duration_s >= 20),
             (select max(d.sent_at) from public.rvm_drops d where d.workspace_id = p_ws and d.seller_id is null and d.buyer_id = b.id and d.status = 'answered')),
           (select count(*) from public.rvm_drops d where d.workspace_id = p_ws and d.seller_id is null and d.buyer_id = b.id and d.status in ('queued', 'sending', 'dialing'))
      from public.buyers b
     where b.workspace_id = p_ws and b.id = any(v_buyers)
  ) x;

  -- to_jsonb keeps whatever columns the pool row has (retired_at once 197 is in).
  select coalesce(jsonb_agg(to_jsonb(cl) || jsonb_build_object(
           'used_today', (select count(*) from public.rvm_drops d
                           where d.workspace_id = p_ws and d.from_e164 = cl.phone_e164 and d.sent_at >= v_midnight),
           'paused', h.paused, 'grade', h.grade, 'health_spam_risk', h.spam_risk)), '[]'::jsonb)
    into v_pool
    from public.caller_lines cl
    left join lateral (
      select nh.paused, nh.grade, nh.spam_risk from public.number_health nh
       where nh.workspace_id = p_ws and nh.phone_e164 = cl.phone_e164
       order by nh.checked_at desc nulls last limit 1
    ) h on true
   where cl.workspace_id = p_ws and cl.pool = 'rvm';

  select w.settings -> 'rvm_pool' into v_settings from public.workspaces w where w.id = p_ws;
  return jsonb_build_object('people', v_people, 'pool', v_pool, 'settings', coalesce(v_settings, '{}'::jsonb));
end $$;
revoke all on function public.rvm_send_preview(bigint, bigint[], bigint[]) from public, anon;
grant execute on function public.rvm_send_preview(bigint, bigint[], bigint[]) to authenticated;

create or replace function public.rvm_send_now(p_ws bigint)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_ws is null or p_ws not in (select public.my_workspace_ids()) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  perform public.rvm_kick();
end $$;
revoke all on function public.rvm_send_now(bigint) from public, anon;
grant execute on function public.rvm_send_now(bigint) to authenticated;

create table if not exists public.rvm_tick_lease (id int primary key default 1 check (id = 1), held_until timestamptz not null default 'epoch');
insert into public.rvm_tick_lease (id) values (1) on conflict (id) do nothing;
alter table public.rvm_tick_lease enable row level security;
revoke all on public.rvm_tick_lease from public, anon, authenticated;

create or replace function public.rvm_tick_lease(p_seconds integer)
returns boolean
language sql security definer set search_path = public, pg_temp as $$
  update public.rvm_tick_lease set held_until = now() + make_interval(secs => greatest(10, least(p_seconds, 300)))
   where id = 1 and held_until < now()
  returning true;
$$;
revoke execute on function public.rvm_tick_lease(integer) from public, anon, authenticated;

create or replace function public.rvm_tick_release()
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.rvm_tick_lease set held_until = 'epoch' where id = 1;
$$;
revoke execute on function public.rvm_tick_release() from public, anon, authenticated;
