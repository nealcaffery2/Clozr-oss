-- 383: Bounces and the AI's own calls no longer stop an action plan.
-- plan_on_communication stopped a plan with stop_on_reply on any inbound email,
-- and cold-campaign-tick files a bounce as an inbound email, so a bounced
-- address ended the person's whole plan (texts, calls, AI agent and
-- voicemails too). With stop_on_call on, any call longer than 0 seconds ended
-- it, the AI agent's own outbound calls included, so a call that reached
-- voicemail ended the plan that asked for it. Now a communication with status
-- 'bounced' (cold-campaign-tick) and a call placed by the AI agent
-- (call_origin 'ai_agent') leave plans alone. Bounced cold replies already
-- filed are marked bounced. Same function as 285 otherwise. Safe to re-run.

create or replace function public.plan_on_communication()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_key text;
  e record;
begin
  if coalesce(new.status, '') = 'bounced' or coalesce(new.call_origin, '') = 'ai_agent' then
    return new;
  end if;
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
end $function$;

update public.communications c set status = 'bounced'
  from public.cold_replies r
 where r.communication_id = c.id and r.classification = 'bounce' and coalesce(c.status, '') <> 'bounced';
