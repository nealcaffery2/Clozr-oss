-- 185 · A buyer hears from one thing at a time: an AI agent or a deal campaign.
--
-- Nothing stopped a buyer the AI agent was working from also landing in a
-- deal blast (or the reverse), so the same buyer could get the agent's text
-- and the campaign's text and email on one day. The AI agent owns a buyer
-- while it is on (active or paused), the same way migration 155 makes
-- action plans and AI agents take turns:
--
-- 1. A campaign recipient row for a buyer an agent is working is not written
--    (BEFORE INSERT returns null). dispo_campaign_launch already skips a row
--    that did not insert, so the launch leaves the buyer out and counts only
--    the buyers it wrote. The composer shows them as "on an AI agent".
-- 2. Switching an agent on for a buyer stops that buyer's campaign follow-ups:
--    open recipients go to 'stopped' and their queued messages are cancelled.
--    A buyer who already replied keeps the conversation with the dispo rep.

create or replace function public.dispo_recipient_skips_ai_agent()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if exists (
    select 1 from public.ai_agent_enrollments e
     where e.workspace_id = new.workspace_id and e.record_kind = 'buyer'
       and e.record_id = new.buyer_id and e.status in ('active', 'paused')
  ) then
    return null;
  end if;
  return new;
end $function$;

drop trigger if exists dispo_recipients_skip_ai_agent on public.dispo_campaign_recipients;
create trigger dispo_recipients_skip_ai_agent before insert on public.dispo_campaign_recipients
  for each row execute function public.dispo_recipient_skips_ai_agent();

create or replace function public.ai_agent_started_stops_campaigns()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ids bigint[];
begin
  if new.record_kind <> 'buyer' or new.status <> 'active' or (tg_op = 'UPDATE' and old.status in ('active', 'paused')) then
    return null;
  end if;
  with stopped as (
    update public.dispo_campaign_recipients r
       set status = 'stopped', updated_at = now()
     where r.workspace_id = new.workspace_id and r.buyer_id = new.record_id and r.status = 'active'
    returning r.id
  )
  select array_agg(id) into v_ids from stopped;
  if v_ids is null then return null; end if;
  update public.dispo_campaign_messages
     set status = 'cancelled', updated_at = now()
   where recipient_id = any (v_ids) and status = 'queued';
  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id, occurred_at)
  values (new.workspace_id, 'buyer', new.record_id, 'ai_agent', 'Campaign follow-ups stopped: the AI agent took over',
          'The AI agent ' || initcap(replace(new.agent_key, '_', ' ')) || ' was switched on, so this buyer''s deal campaign messages that had not gone out were cancelled. One thing reaches a buyer at a time.',
          new.started_by, now());
  return null;
end $function$;

drop trigger if exists ai_agent_enrollments_stop_campaigns on public.ai_agent_enrollments;
create trigger ai_agent_enrollments_stop_campaigns after insert or update of status on public.ai_agent_enrollments
  for each row execute function public.ai_agent_started_stops_campaigns();
