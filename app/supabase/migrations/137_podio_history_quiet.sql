-- Podio history comes in quietly (docs/podio.md "Acquisitions and Communications").
--
-- The live sync now backfills a team's Acquisitions app (~9,500 sellers) and
-- its smrtPhone Communications app (~43,000 calls and texts). Those are history:
-- they must not open inbox threads, wake AI agents, classify dispo replies,
-- credit RVM drops, start action plans or fire webhooks. A row from Podio more
-- than a day old skips those triggers; a fresh one (a text that reached Podio
-- in the last ten minutes) behaves like any other.
--
-- Sellers: only the INSERT half is gated, so a stage change made later on an
-- imported seller still runs plans and webhooks.

-- communications: every insert-time side effect.
drop trigger if exists ai_agent_reply_wakes on public.communications;
create trigger ai_agent_reply_wakes after insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function ai_agent_reply_wakes();

drop trigger if exists communications_dispo_inbound on public.communications;
create trigger communications_dispo_inbound after insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function dispo_after_inbound();

drop trigger if exists communications_inbox on public.communications;
create trigger communications_inbox before insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function inbox_on_communication();

drop trigger if exists communications_rvm_inbound on public.communications;
create trigger communications_rvm_inbound after insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function rvm_after_inbound();

drop trigger if exists plan_on_communication on public.communications;
create trigger plan_on_communication after insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function plan_on_communication();

drop trigger if exists webhook_emit on public.communications;
create trigger webhook_emit after insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function webhook_emit();

-- sellers: the insert half gated on the Podio created date the sync writes; updates unchanged.
drop trigger if exists plan_on_seller_change on public.sellers;
drop trigger if exists plan_on_seller_insert on public.sellers;
create trigger plan_on_seller_insert after insert on public.sellers for each row
  when (new.source is distinct from 'podio' or new.created_at > now() - interval '1 day')
  execute function plan_on_seller_change();
create trigger plan_on_seller_change after update of lead_stage, tags on public.sellers for each row
  execute function plan_on_seller_change();

drop trigger if exists webhook_emit on public.sellers;
drop trigger if exists webhook_emit_insert on public.sellers;
create trigger webhook_emit_insert after insert on public.sellers for each row
  when (new.source is distinct from 'podio' or new.created_at > now() - interval '1 day')
  execute function webhook_emit();
create trigger webhook_emit after update of lead_stage on public.sellers for each row
  execute function webhook_emit();
