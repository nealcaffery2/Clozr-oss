-- 86 · A buyer replying to a dispo campaign rings the bell.
--
-- Migration 53's dispo_after_inbound() stops a buyer's follow-ups when they
-- reply, but nobody was told: the reply sat on the buyer's thread until someone
-- happened to open it. The function now also writes one notification (category
-- 'Dispo') the first time a campaign recipient replies, which the bell reads
-- from public.notifications like every other note.
--
-- Who it is for: the rep who launched the campaign (dispo_campaigns.created_by);
-- if that user is gone, the deal's dispo rep; if neither, the whole workspace
-- (user_id null, which the bell shows to everyone in it).
--
-- Only a first reply notifies. replied_at is read under a row lock before the
-- existing update stamps it, so two inbound rows racing for the same buyer
-- still give one notification, and a later message from the same buyer gives
-- none. An opt-out ("STOP") stops the follow-ups as before but does not ring
-- the bell: there is nothing to answer.
--
-- The rest of the body is the live function's, unchanged: migration 53's
-- loop plus the dispo_log_engagement call the p11 engagement migration added
-- (a reply or unsubscribe is logged to dispo analytics). Safe to run again:
-- the function is replaced and the trigger re-created exactly as 53 made it.

create or replace function public.dispo_after_inbound()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_class text; v_phone text; rec record; v_first boolean; v_snip text;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('sms', 'email') then return new; end if;
  v_class := public.dispo_classify_reply(new.body);
  v_phone := case when new.channel = 'sms' then public.normalize_phone(new.from_phone) end;
  -- The first 80 characters of the reply on one line, for the notification.
  v_snip := regexp_replace(trim(coalesce(new.body, '')), '\s+', ' ', 'g');
  if length(v_snip) > 80 then v_snip := left(v_snip, 80) || '…'; end if;
  for rec in
    select r.id, r.buyer_id, r.deal_id, r.status, r.campaign_id from public.dispo_campaign_recipients r
     where r.workspace_id = new.workspace_id
       and r.status not in ('opted_out', 'stopped')
       and exists (select 1 from public.dispo_campaign_messages m where m.recipient_id = r.id and m.sent_at is not null and m.sent_at <= new.occurred_at)
       and ((new.buyer_id is not null and r.buyer_id = new.buyer_id)
         or (v_phone is not null and public.normalize_phone(r.phone) = v_phone)
         or (new.channel = 'email' and new.from_email is not null and r.email = lower(new.from_email)))
  loop
    -- Whether this is the recipient's first reply, read under the row lock the
    -- update below takes anyway, so a concurrent reply waits and then sees it stamped.
    select r.replied_at is null into v_first
      from public.dispo_campaign_recipients r where r.id = rec.id for update;
    update public.dispo_campaign_recipients
       set replied_at = coalesce(replied_at, new.occurred_at), replied_channel = coalesce(replied_channel, new.channel),
           status = case when v_class = 'opted_out' then 'opted_out'
                         when status = 'active' then v_class else status end
     where id = rec.id;
    update public.dispo_campaign_messages
       set status = 'cancelled', last_error = case when v_class = 'opted_out' then 'buyer opted out' else 'buyer replied' end
     where recipient_id = rec.id and status = 'queued'
       and (kind = 'followup' or (v_class = 'opted_out' and channel = new.channel));
    update public.deal_buyer_matches
       set replied_at = coalesce(replied_at, new.occurred_at),
           status = case when v_class = 'not_interested' and status in ('matched', 'sent', 'viewed') then 'not_interested' else status end
     where deal_id = rec.deal_id and buyer_id = rec.buyer_id;
    if new.buyer_id is null then
      update public.communications set buyer_id = rec.buyer_id where id = new.id and buyer_id is null;
    end if;
    perform public.dispo_log_engagement(
      rec.deal_id, rec.buyer_id,
      case when v_class = 'opted_out' then 'unsubscribe' else 'reply' end,
      new.channel, rec.campaign_id, null,
      jsonb_build_object('classification', v_class));
    -- Tell the rep, once per recipient, unless the reply was an opt-out.
    if v_first and v_class <> 'opted_out' then
      insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, deal_id)
      select new.workspace_id,
             coalesce(c.created_by, d.dispo_rep_id),
             'Dispo',
             'Buyer replied',
             coalesce(nullif(trim(b.company), ''), nullif(trim(b.name), ''), 'A buyer')
               || case when v_snip <> '' then ': ' || v_snip else '' end,
             rec.buyer_id,
             rec.deal_id
        from public.dispo_campaigns c
        left join public.deals d on d.id = rec.deal_id
        left join public.buyers b on b.id = rec.buyer_id
       where c.id = rec.campaign_id;
    end if;
    perform public.dispo_campaign_finish(rec.campaign_id);
  end loop;
  return new;
end $$;
revoke execute on function public.dispo_after_inbound() from public, anon, authenticated;
drop trigger if exists communications_dispo_inbound on public.communications;
create trigger communications_dispo_inbound after insert on public.communications
  for each row execute function public.dispo_after_inbound();
