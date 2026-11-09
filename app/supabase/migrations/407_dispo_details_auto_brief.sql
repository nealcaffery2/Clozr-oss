-- 407: a buyer who answers a blast asking for details gets that blast's deal
-- brief right away.
--
-- On 2026-10-23 Bea Arden texted "Can you send me details?" to the
-- 5323 Sage Hill Road blast. Her own text brief sat queued until the next
-- morning (the line was held), so a rep pasted another buyer's brief by hand,
-- with that buyer's "0.9 miles from the flip you did at 831 Thistle Dr" line.
--
-- dispo_asks_for_details(body): asks for the deal (details, info, address,
-- photos, price, comps, "send", "tell me more", "interested") or opens with a
-- yes ("Sure", "Hi Morgan yes please", "Lol sure"; 50 characters at most).
-- Never over 100 characters (auto-responders), never a reply with no, not,
-- stop, pass, wrong, too, don't, already, only, "who is", agent or realtor,
-- and never a Talkr reaction ("Loved “...”"). On the 10 days of buyer
-- replies to 2026-10-23 it picks every "send details", "Yes please",
-- "What's the address" and none of the passes, opt-outs or seller
-- auto-responders.
--
-- dispo_after_inbound (from 296, body otherwise unchanged):
--   - any reply that is not an opt-out also cancels the recipient's queued
--     intro (it asked "want more details?", which they have answered), the
--     way follow-ups already were;
--   - a text that asks for details moves the recipient's own queued text
--     brief to now, on the blast that last texted them (the newest sent
--     message among their campaigns), so dispo-campaign-tick sends it within
--     a minute on its usual line, gates and opt-out checks. No queued brief
--     (already sent, or the blast had no text brief), or the deal is already
--     Buyer Under Contract, In Escrow, Closed or Terminated: nothing changes.
--
-- Safe to re-run.

create or replace function public.dispo_asks_for_details(p_body text)
 returns boolean
 language sql
 immutable
 set search_path to 'pg_temp'
as $function$
  select length(trim(coalesce(p_body, ''))) between 1 and 100
     and p_body !~* '^\s*(loved|liked|laughed at|emphasized|disliked|questioned)\s+["“]'
     and p_body !~* '\m(no|not|nope|nah|stop|pass|wrong|remove|unsubscribe|don''?t|dont|never|too|to far|already|sold|only|who is|retired|agent|realtor)\M'
     and (p_body ~* '\m(details?|info|address|location|pics?|pictures?|photos?|videos?|price|asking|numbers|comps?|tell me more|more about|send|what[''’]?s the|what is the|what do you have|interested|please do|take a look|willing to look)\M'
       or (length(trim(p_body)) <= 50 and p_body ~* '^\W*((hi|hey|hello|lol|good morning|this is \w+ and)\W+)?(\w+\W+)?(y|ya|yes|yeah|yea|yep|yup|sure|ok|okay|absolutely|definitely)\M'));
$function$;

create or replace function public.dispo_after_inbound()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_class text; v_phone text; rec record; v_first boolean; v_snip text;
        v_details boolean; v_pick bigint; v_pick_at timestamptz; v_last timestamptz;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('sms', 'email') then return new; end if;
  v_class := public.dispo_classify_reply(new.body);
  v_phone := case when new.channel = 'sms' then public.normalize_phone(new.from_phone) end;
  v_details := new.channel = 'sms' and v_class <> 'opted_out' and public.dispo_asks_for_details(new.body);
  -- The first 80 characters of the reply on one line, for the notification.
  v_snip := regexp_replace(trim(coalesce(new.body, '')), '\s+', ' ', 'g');
  if length(v_snip) > 80 then v_snip := left(v_snip, 80) || '…'; end if;
  for rec in
    select r.id, r.buyer_id, r.deal_id, r.status, r.campaign_id from public.dispo_campaign_recipients r
     where r.id in (
             select x.id from public.dispo_campaign_recipients x
              where new.buyer_id is not null and x.workspace_id = new.workspace_id and x.buyer_id = new.buyer_id
             union
             select x.id from public.dispo_campaign_recipients x
              where v_phone is not null and x.workspace_id = new.workspace_id and x.phone_key = v_phone
             union
             select x.id from public.dispo_campaign_recipients x
              where new.channel = 'email' and new.from_email is not null
                and x.workspace_id = new.workspace_id and x.email = lower(new.from_email))
       and r.status not in ('opted_out', 'stopped')
       and exists (select 1 from public.dispo_campaign_messages m where m.recipient_id = r.id and m.sent_at is not null and m.sent_at <= new.occurred_at)
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
       and (kind in ('followup', 'intro') or (v_class = 'opted_out' and channel = new.channel));
    -- The blast they are answering: the one that texted them last.
    if v_details then
      select max(m.sent_at) into v_last from public.dispo_campaign_messages m
       where m.recipient_id = rec.id and m.channel = 'sms' and m.sent_at <= new.occurred_at;
      if v_last is not null and (v_pick_at is null or v_last > v_pick_at)
         and exists (select 1 from public.dispo_campaign_messages m where m.recipient_id = rec.id and m.channel = 'sms' and m.kind = 'brief' and m.status = 'queued')
         and not exists (select 1 from public.deals d where d.id = rec.deal_id and d.stage in ('Buyer Under Contract', 'In Escrow', 'Closed', 'Terminated')) then
        v_pick := rec.id; v_pick_at := v_last;
      end if;
    end if;
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
             -- The push's sender, else the deal's dispo rep, its owner, the buyer's rep, the workspace owner. Never nobody (everyone).
             coalesce(c.created_by, d.dispo_rep_id, d.owner_id, b.assigned_to, (select w.owner_id from public.workspaces w where w.id = new.workspace_id)),
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
  -- They asked for details: their own text brief goes now (dispo-campaign-tick sends it within a minute).
  if v_pick is not null then
    update public.dispo_campaign_messages
       set send_at = now(), last_error = 'buyer asked for details'
     where recipient_id = v_pick and channel = 'sms' and kind = 'brief' and status = 'queued';
  end if;
  return new;
end $function$;

revoke execute on function public.dispo_after_inbound() from public, anon, authenticated;
