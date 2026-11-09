-- 405: an opt-out reply makes no bell row.
--
-- 405 of the 1,000 'inbound_sms' notifications in the 10 days to 2026-10-23
-- were the word STOP. The text is still filed, the thread still marked opted
-- out and the number DNC (inbox_on_communication, 291), the dispo recipient
-- still opted_out (dispo_after_inbound); only the notification is dropped.
--
-- is_opt_out_reply: the STOP words inbox_on_communication honors (plus
-- "remove", "please stop") as a line of their own (or the reply after an
-- "Email reply" row's subject), and classifyReply's unsubscribe and spam
-- phrases anywhere (_shared/cold-campaign.ts UNSUB and COMPLAINT, plus
-- texting). Another business's text with a "Reply STOP to unsubscribe"
-- footer is not an opt-out and still notifies. On the last 10 days of rows
-- this drops 427 of 1,052 inbound_sms (none of them a real reply) and no
-- Email reply. cold_reply rows are skipped in cold-campaign-tick on the same
-- classification.
--
-- Safe to re-run.

create or replace function public.is_opt_out_reply(p_body text)
 returns boolean
 language sql
 immutable
 set search_path to 'pg_temp'
as $function$
  select coalesce(p_body, '') !~* '\m(reply|text|txt|send|respond)(\s+with)?\s+\W?stop\M'
     and (coalesce(p_body, '') ~* '(?n)(^|·)\W*((please|permanently)\s+)?(stop|stopall|stop all|unsubscribe|cancel|end|quit|revoke|optout|opt out|remove|remove me)\W*$'
       or coalesce(p_body, '') ~* '\m(unsubscribe|remove me|opt[\s-]?out|take me off|stop (texting|emailing|contacting)|do not (text|email|contact)|don[''’]?t (text|email|contact)|this is spam|marked as spam|junk mail|reported as spam|spam reported)\M');
$function$;

-- One guard where every inbound_sms and Email reply row goes in
-- (inbox_on_communication, sms_flow_after_inbound, notify_email_reply).
create or replace function public.notifications_skip_opt_out()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if public.is_opt_out_reply(new.body) then return null; end if;
  return new;
end $function$;

drop trigger if exists notifications_skip_opt_out on public.notifications;
create trigger notifications_skip_opt_out
  before insert on public.notifications
  for each row when (new.category in ('inbound_sms', 'Email reply'))
  execute function public.notifications_skip_opt_out();
