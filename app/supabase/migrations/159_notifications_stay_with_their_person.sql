-- 159 · Notifications stay with the person in the conversation.
--
-- Owner's ask (2026-10-05): nobody should be notified about someone else's
-- texts, calls, voicemails, Lane, Genius or marketing. Each notification goes
-- to the one person the conversation or file belongs to.
--
-- 1. inbox_on_communication (from 152): a new text notifies the rep on it,
--    else the owner of the line it came in on (rep_phone_numbers), else the
--    record's rep, else the workspace owner. Before, it went to the record's
--    rep even when a teammate's line took the text.
-- 2. dispo_after_inbound (from 86): a buyer's reply to a push never goes out
--    without a recipient. A null user_id read as "everyone in the workspace".
-- 3. offer_accepted_to_dispo (from 130): the deal's TC and dispo rep only,
--    not every dispositions and TC member.
-- The app reads only notifications addressed to the signed-in member
-- (lib/crm.ts), so an old row with no recipient leaves every bell.
-- Functions only: the triggers that call them are unchanged.

create or replace function public.inbox_on_communication()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_theirs text;
  v_ours   text;
  v_match  record;
  v_thread public.inbox_threads;
  v_body   text := lower(btrim(coalesce(new.body, '')));
  v_inbound boolean := new.direction = 'inbound';
  v_assignee uuid;
begin
  if new.channel not in ('sms','call','voicemail') or coalesce(new.direction,'') not in ('inbound','outbound') then
    return new;
  end if;
  v_theirs := public.normalize_phone(case when v_inbound then new.from_phone else new.to_phone end);
  v_ours   := public.normalize_phone(case when v_inbound then new.to_phone else new.from_phone end);
  if v_theirs is null then return new; end if;

  -- A sync that sends the same message again (Podio every 10 minutes, a
  -- webhook retry) is an upsert on (workspace_id, source, source_id): this
  -- BEFORE INSERT trigger still runs for it. The message already counted;
  -- nothing more to do.
  if new.source_id is not null and exists (
       select 1 from public.communications c
        where c.workspace_id = new.workspace_id and c.source = new.source and c.source_id = new.source_id) then
    return new;
  end if;

  if new.buyer_id is null and new.seller_id is null then
    select * into v_match from public.match_contact_by_phone(new.workspace_id, v_theirs);
    new.buyer_id  := v_match.buyer_id;
    new.seller_id := case when v_match.buyer_id is null then v_match.seller_id end;
  end if;

  select coalesce(
           (select coalesce(assigned_to, owner_id) from public.buyers  where id = new.buyer_id),
           (select coalesce(assigned_to, owner_id) from public.sellers where id = new.seller_id))
    into v_assignee;

  insert into public.inbox_threads as t (
    workspace_id, phone_key, our_phone, buyer_id, seller_id, assigned_to,
    unread_count, last_message_at, last_inbound_at, last_outbound_at,
    last_direction, last_channel, last_preview, awaiting_reply_since)
  values (
    new.workspace_id, v_theirs, v_ours, new.buyer_id, new.seller_id, v_assignee,
    case when v_inbound and (new.channel <> 'call' or new.status in ('missed','no_answer','no-answer')) then 1 else 0 end,
    new.occurred_at,
    case when v_inbound then new.occurred_at end,
    case when not v_inbound then new.occurred_at end,
    new.direction, new.channel, left(coalesce(new.body, new.summary, initcap(new.channel)), 160),
    case when v_inbound and new.channel = 'sms' then new.occurred_at end)
  on conflict (workspace_id, phone_key) do update set
    our_phone        = coalesce(excluded.our_phone, t.our_phone),
    buyer_id         = coalesce(t.buyer_id, excluded.buyer_id),
    seller_id        = coalesce(t.seller_id, excluded.seller_id),
    assigned_to      = coalesce(t.assigned_to, excluded.assigned_to),
    unread_count     = t.unread_count + excluded.unread_count,
    status           = case when v_inbound then 'open' else t.status end,
    last_inbound_at  = greatest(t.last_inbound_at, excluded.last_inbound_at),
    last_outbound_at = greatest(t.last_outbound_at, excluded.last_outbound_at),
    awaiting_reply_since = case
                             when not v_inbound then null
                             when new.channel = 'sms' then coalesce(t.awaiting_reply_since, excluded.awaiting_reply_since)
                             else t.awaiting_reply_since end,
    last_message_at  = greatest(t.last_message_at, excluded.last_message_at),
    last_direction   = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_direction else t.last_direction end,
    last_channel     = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_channel   else t.last_channel   end,
    last_preview     = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_preview   else t.last_preview   end,
    updated_at       = now()
  returning * into v_thread;

  new.thread_id := v_thread.id;

  if v_inbound and new.channel = 'sms' then
    if v_body in ('stop','stopall','unsubscribe','cancel','end','quit','revoke','optout','opt out','stop all') then
      update public.inbox_threads set opted_out_at = coalesce(opted_out_at, new.occurred_at) where id = v_thread.id;
      update public.buyer_phones set is_dnc = true, updated_at = now()
       where workspace_id = new.workspace_id and phone_key = v_theirs;
    elsif v_body in ('start','unstop','subscribe') then
      update public.inbox_threads set opted_out_at = null where id = v_thread.id;
      update public.buyer_phones set is_dnc = false, updated_at = now()
       where workspace_id = new.workspace_id and phone_key = v_theirs;
    end if;

    insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id, phone_key)
    select new.workspace_id,
           -- Whose conversation: the rep on the text, else the owner of the line it
           -- came in on (rep_phone_numbers, migration 153: the line trigger runs
           -- after this one, so the line is looked up here), else the record's rep,
           -- the thread's, the workspace owner. One person, never the team.
           coalesce(new.rep_id,
                    (select r.user_id from public.rep_phone_numbers r
                      where r.workspace_id = new.workspace_id and r.user_id is not null
                        and right(regexp_replace(r.phone_e164, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_ours, ''), '\D', '', 'g'), 10)
                      limit 1),
                    v_assignee, v_thread.assigned_to, w.owner_id),
           'inbound_sms',
           'New text from ' || coalesce(
              (select name from public.buyers where id = new.buyer_id),
              (select name from public.sellers where id = new.seller_id),
              v_theirs),
           left(coalesce(new.body, ''), 200),
           new.buyer_id, new.seller_id, v_theirs
      from public.workspaces w where w.id = new.workspace_id;
  end if;

  return new;
end $function$;

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
  return new;
end $$;
revoke execute on function public.dispo_after_inbound() from public, anon, authenticated;

create or replace function public.offer_accepted_to_dispo(p_deal_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.deals;
  v_addr text;
  v_tc uuid;
  v_moved boolean := false;
begin
  select * into d from public.deals where id = p_deal_id;
  if not found then return; end if;
  select nullif(trim(line1), '') into v_addr from public.properties where id = d.property_id;
  v_addr := coalesce(v_addr, 'A property');
  v_tc := public.workspace_tc(d.workspace_id);

  -- A deal still at Prospect (a submission, or a lead's placeholder) joins the
  -- pipeline; one already further along keeps its stage. Written inside a
  -- trigger, so deals_stage_after (depth > 1) leaves the seller's stage alone:
  -- the seller stays at Offer Accepted.
  update public.deals set
    stage = case when coalesce(stage, 'Prospect') = 'Prospect' then 'Under Contract Seller' else stage end,
    tc_rep_id = coalesce(tc_rep_id, v_tc),
    archived_at = null, archived_reason = null
   where id = d.id
  returning (d.stage is distinct from stage) into v_moved;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
  values (d.workspace_id, 'deal', d.id, 'stage',
          case when v_moved then 'Deal opened · Under Contract Seller' else 'Offer accepted' end,
          'Offer accepted on ' || v_addr || '. On the Dispo board'
            || case when coalesce(d.tc_rep_id, v_tc) is not null then ' with a TC.' else '; no TC in the workspace yet.' end);

  -- The deal's own TC and dispo rep hear about it (with neither, the workspace
  -- owner), not every dispositions and TC member; the person who moved it does not.
  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, deal_id)
  select d.workspace_id, u.user_id, 'Dispo', 'Offer accepted · ' || v_addr,
         v_addr || ' is under contract with the seller and on the Dispo board.'
           || case when d.offer_amount is not null then ' Contract price $' || to_char(d.offer_amount, 'FM999,999,999') || '.' else '' end,
         d.seller_id, d.id
    from (
      select coalesce(d.tc_rep_id, v_tc) as user_id
      union
      select coalesce(d.dispo_rep_id, case when coalesce(d.tc_rep_id, v_tc) is null then (select w.owner_id from public.workspaces w where w.id = d.workspace_id) end)
    ) u
   where u.user_id is not null and u.user_id is distinct from auth.uid();
end $$;
revoke all on function public.offer_accepted_to_dispo(bigint) from public, anon, authenticated;
