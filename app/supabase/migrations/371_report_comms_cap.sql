-- 371 · Reporting reads the whole year of communications.
--
-- report_comms (276) capped the read at 20,000 rows and lib/crm.ts asked for
-- 10,000, which for Acme Homes reached back about 45 days (17,600 rows in 90
-- days, 49,000 year to date), so 90 Days, QTD, YTD and All time undercounted
-- calls, texts and leads contacted. Same function, the ceiling raised to
-- 60,000; the client asks for that many. Safe to re-run.

create or replace function public.report_comms(p_ws bigint, p_limit integer default 10000)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_workspace_ids()) then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'seller_id', c.seller_id, 'buyer_id', c.buyer_id, 'rep_id', c.rep_id,
               'from_phone', c.from_phone, 'to_phone', c.to_phone,
               'channel', c.channel, 'direction', c.direction, 'occurred_at', c.occurred_at,
               'duration_s', c.duration_s, 'status', c.status)
             order by c.occurred_at desc, c.id desc)
        from (
          select id, seller_id, buyer_id, rep_id, from_phone, to_phone, channel, direction, occurred_at, duration_s, status
            from public.communications
           where workspace_id = p_ws
           order by occurred_at desc, id desc
           limit least(greatest(coalesce(p_limit, 10000), 1), 60000)
        ) c), '[]'::jsonb)
    else '[]'::jsonb
  end;
$$;

revoke all on function public.report_comms(bigint, integer) from public, anon;
grant execute on function public.report_comms(bigint, integer) to authenticated, service_role;
