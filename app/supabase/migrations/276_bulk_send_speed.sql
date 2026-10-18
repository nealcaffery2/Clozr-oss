-- 276 · Bulk email that sends, and a reporting read that does not stall.
--
-- email_safety_flags(ws, emails): the send guard (mailguard.ts
-- verificationFlags) read buyers, buyer_contacts, sellers and buyer_emails
-- with one `email ilike` query per table, which the (workspace_id,
-- lower(email)) indexes from 41/165 cannot serve: a scan of every buyer
-- before every send. One call, one index probe per table, service role only
-- (the guard runs as the service role).
--
-- report_comms(ws, limit): reporting loads up to 10,000 communications a
-- workspace in pages of 1,000 (lib/crm.ts loadReportComms) on every open and
-- after every save. For a member who is not owner/admin/tc the row policy
-- ran can_read_email() on every email row the scan passed: about half a second a
-- page on a large workspace. Reporting counts calls, texts and
-- emails — channel, direction, when, how long, who — never a subject or a
-- body, so a member gets those columns for every row of their workspace as
-- one jsonb value, like seller_last_touch (113). Nobody outside the
-- workspace gets anything.

create or replace function public.email_safety_flags(p_ws bigint, p_emails text[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with want as (
    select distinct lower(trim(e)) as email from unnest(coalesce(p_emails, '{}')) as e where e like '%@%'
  ),
  found as (
    select lower(b.email) as email, b.email_safe_to_send as safe
      from public.buyers b join want w on lower(b.email) = w.email
     where b.workspace_id = p_ws and b.email is not null
    union all
    select lower(c.email), c.email_safe_to_send
      from public.buyer_contacts c join want w on lower(c.email) = w.email
     where c.workspace_id = p_ws and c.email is not null
    union all
    select lower(s.email), s.email_safe_to_send
      from public.sellers s join want w on lower(s.email) = w.email
     where s.workspace_id = p_ws and s.email is not null
    union all
    select be.email_key, be.email_safe_to_send
      from public.buyer_emails be join want w on be.email_key = w.email
     where be.workspace_id = p_ws
  )
  select coalesce(jsonb_agg(jsonb_build_object('email', email, 'safe', safe)), '[]'::jsonb) from found;
$$;

revoke all on function public.email_safety_flags(bigint, text[]) from public, anon, authenticated;
grant execute on function public.email_safety_flags(bigint, text[]) to service_role;

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
           limit least(greatest(coalesce(p_limit, 10000), 1), 20000)
        ) c), '[]'::jsonb)
    else '[]'::jsonb
  end;
$$;

revoke all on function public.report_comms(bigint, integer) from public, anon;
grant execute on function public.report_comms(bigint, integer) to authenticated, service_role;
