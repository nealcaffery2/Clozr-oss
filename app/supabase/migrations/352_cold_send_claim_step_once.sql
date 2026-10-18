-- 352 · cold_send_claim refuses a sequence step that already has a send.
--
-- cold-campaign-tick claims the enrollment row (next_send_at moved 15
-- minutes on), claims the send here, sends, then moves the enrollment to the
-- next step. When that last write failed, the row came due again 15 minutes
-- later on the same step, and the same step went out a second time. Now a
-- claim for an enrollment and step position that already has a cold_sends row
-- that did not fail (queued, sent, bounced or replied) returns
-- {ok: false, reason: 'step_sent'} with that row's id, status, sent_at,
-- rfc_message_id and mailbox_id, and the tick moves the enrollment on
-- instead of sending (cold-campaign-tick/tick.ts priorSend, advancePatch).
--
-- plan-tick's sends (variant 'plan') are left out on both sides: plan-tick
-- claims every email of a plan as step 1 of the same finished enrollment
-- (one row per campaign and address), so a plan with four email steps sends
-- four times on one enrollment and step, by design. plan-tick keeps each
-- step once by its task claim (plan-tick/pool.ts closeSent).
--
-- Everything else is the live body (pg_get_functiondef), the
-- same caps, the same advisory locks in the same order, and the same
-- grants. The new check runs under the mailbox lock, so two claims on one
-- mailbox for one step cannot both pass it; claims on two mailboxes are kept
-- apart by the enrollment row claim before them (cold-campaign-tick
-- claimEnrollment, #445). It reads cold_sends_enrollment_idx
-- (enrollment_id, sent_at desc): an enrollment has one row per step sent.
--
-- Proved read-only (this check as a plain SELECT) on live sends, all from
-- plan-tick: none would have been refused, and no campaign step claim is
-- refused; without the plan exclusion every one of those enrollments would
-- refuse its next plan email.
--
-- Service role only. Safe to re-run.

create or replace function public.cold_send_claim(
  p_workspace bigint, p_mailbox bigint, p_domain bigint, p_campaign bigint, p_enrollment bigint,
  p_step integer, p_to text, p_from text, p_subject text, p_variant text, p_in_reply_to text,
  p_day_start timestamptz, p_mailbox_daily integer, p_mailbox_hourly integer, p_domain_daily integer, p_gap_seconds integer,
  p_body_hash text default null, p_recipient_provider text default null,
  p_recipient_domain_cap integer default null, p_recipient_day_start timestamptz default null
) returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today integer; v_hour integer; v_oldest timestamptz; v_last timestamptz; v_domain integer; v_id bigint;
  v_pinned bigint; v_recip_domain text; v_recip_today integer; v_prior record;
begin
  perform pg_advisory_xact_lock(420166, (p_mailbox % 2147483647)::integer);
  perform pg_advisory_xact_lock(420167, (p_domain % 2147483647)::integer);
  if p_variant is distinct from 'plan' then
    select s.id, s.status, s.sent_at, s.rfc_message_id, s.mailbox_id into v_prior
      from public.cold_sends s
     where s.enrollment_id = p_enrollment and s.step_position = p_step
       and s.status <> 'failed' and s.variant_key is distinct from 'plan'
     order by s.sent_at desc
     limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'step_sent', 'send_id', v_prior.id, 'send_status', v_prior.status,
        'sent_at', v_prior.sent_at, 'rfc_message_id', v_prior.rfc_message_id, 'mailbox_id', v_prior.mailbox_id);
    end if;
  end if;
  select mailbox_id into v_pinned
    from public.cold_enrollments
   where id = p_enrollment and workspace_id = p_workspace;
  if v_pinned is not null and v_pinned <> p_mailbox then
    return jsonb_build_object('ok', false, 'reason', 'pinned_sender');
  end if;
  if exists (
    select 1 from public.cold_enrollments
     where workspace_id = p_workspace and lower(email) = lower(p_to) and status = 'active' and id <> p_enrollment
  ) then
    return jsonb_build_object('ok', false, 'reason', 'active_sequence');
  end if;
  v_recip_domain := lower(split_part(p_to, '@', 2));
  v_recip_today := 0;
  -- Same free-inbox list as deliverability-rules.ts FREE_MAIL. Company domains only.
  if p_recipient_domain_cap is not null and p_recipient_day_start is not null
     and v_recip_domain <> ''
     and v_recip_domain not in (
       'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
       'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com'
     )
  then
    perform pg_advisory_xact_lock(420168, hashtext(v_recip_domain));
    select count(*) into v_recip_today
      from public.cold_sends
     where workspace_id = p_workspace
       and sent_at >= p_recipient_day_start
       and status <> 'failed'
       and lower(split_part(to_email, '@', 2)) = v_recip_domain;
    if v_recip_today + 1 > p_recipient_domain_cap then
      return jsonb_build_object('ok', false, 'reason', 'recipient_domain_cap', 'recipient_domain_today', v_recip_today);
    end if;
  end if;
  select count(*) filter (where sent_at >= p_day_start and status <> 'failed'),
         count(*) filter (where sent_at >= now() - interval '1 hour' and status <> 'failed'),
         min(sent_at) filter (where sent_at >= now() - interval '1 hour' and status <> 'failed'),
         max(sent_at) filter (where status <> 'failed')
    into v_today, v_hour, v_oldest, v_last
    from public.cold_sends
   where mailbox_id = p_mailbox and sent_at >= least(p_day_start, now() - interval '1 hour');
  select count(*) into v_domain
    from public.cold_sends s
    join public.cold_mailboxes m on m.id = s.mailbox_id
   where m.domain_id = p_domain and s.sent_at >= p_day_start and s.status <> 'failed';
  if v_today + 1 > p_mailbox_daily or v_hour + 1 > p_mailbox_hourly or v_domain + 1 > p_domain_daily
     or (p_gap_seconds > 0 and v_last is not null and v_last > now() - make_interval(secs => p_gap_seconds))
  then
    return jsonb_build_object('ok', false, 'today', v_today, 'last_hour', v_hour, 'hour_oldest', v_oldest,
      'last_sent_at', v_last, 'domain_today', v_domain, 'recipient_domain_today', v_recip_today);
  end if;
  insert into public.cold_sends (workspace_id, campaign_id, enrollment_id, step_position, mailbox_id, to_email, from_email, subject, variant_key, in_reply_to, body_hash, recipient_provider, status)
  values (p_workspace, p_campaign, p_enrollment, p_step, p_mailbox, lower(p_to), lower(p_from), p_subject, p_variant, p_in_reply_to, p_body_hash, p_recipient_provider, 'queued')
  returning id into v_id;
  update public.cold_enrollments
     set mailbox_id = p_mailbox
   where id = p_enrollment and mailbox_id is null;
  return jsonb_build_object('ok', true, 'id', v_id, 'today', v_today, 'last_hour', v_hour, 'domain_today', v_domain);
end $$;

revoke all on function public.cold_send_claim(bigint, bigint, bigint, bigint, bigint, integer, text, text, text, text, text, timestamptz, integer, integer, integer, integer, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.cold_send_claim(bigint, bigint, bigint, bigint, bigint, integer, text, text, text, text, text, timestamptz, integer, integer, integer, integer, text, text, integer, timestamptz) to service_role;
