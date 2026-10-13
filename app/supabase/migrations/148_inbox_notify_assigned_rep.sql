-- An inbound text notifies the rep the record is assigned to.
--
-- inbox_on_communication (the inbox thread + "New text from …" bell row on
-- every call and text) picked the recipient from sellers.owner_id /
-- buyers.owner_id, which is who created the record, and then from the
-- thread's first assignee for good. The rep working the record is
-- assigned_to. Now: the record's assigned_to, else its owner_id; the bell
-- row goes to that rep (a reassigned record's texts follow the new rep),
-- else the thread's assignee, else the workspace owner. Everything else is
-- unchanged.

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

    insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id)
    select new.workspace_id,
           coalesce(v_assignee, v_thread.assigned_to, w.owner_id),
           'inbound_sms',
           'New text from ' || coalesce(
              (select name from public.buyers where id = new.buyer_id),
              (select name from public.sellers where id = new.seller_id),
              v_theirs),
           left(coalesce(new.body, ''), 200),
           new.buyer_id, new.seller_id
      from public.workspaces w where w.id = new.workspace_id;
  end if;

  return new;
end $function$;
