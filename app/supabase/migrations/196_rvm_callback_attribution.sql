-- 196: every reply to a ringless voicemail finds its drop, its sender and its deal.
--
-- Before, migration 135's trigger credited an inbound call, voicemail or text
-- to a drop only when the row already named the same seller or buyer. A
-- reply from a number on no record (a drop to a seller's second phone, a
-- relative calling back, a buyer whose number is not on file), or a call row
-- re-linked to its seller later (call-sync), was never credited: the rep
-- never heard, and it sat unfiled.
--
-- Now:
--   rvm_match_drop(ws, seller, buyer, from, to, at)   the drop a reply answers:
--       a delivered drop in the last 7 days to the same seller or buyer, or
--       to the number calling; one from the line they called comes first.
--       A reply to a line in the RVM pool looks back 30 days by number.
--   communications_attribute_rvm  BEFORE INSERT (named to run before
--       communications_inbox): sets rvm_drop_id, files a reply from an
--       unknown number on the drop's seller or buyer, fills deal_id (the
--       drop's deal, else the seller's newest live deal) and the summary.
--   communications_rvm_inbound    AFTER INSERT (rvm_after_inbound, replaced):
--       credits the drop (callback_at / channel / comm id, first reply wins)
--       and notifies whoever sent it, with the record and the deal. A reply
--       to a pool line that matches no drop notifies the workspace's owners
--       and admins instead, so nothing lands unfiled and unseen.
--   communications_rvm_relink     AFTER UPDATE OF seller_id, buyer_id: a row
--       linked to its record after the insert gets the same treatment.
-- Every path catches its own errors: a reply is never lost to this. Safe to run again.

create index if not exists rvm_drops_phone_sent
  on public.rvm_drops (workspace_id, phone_e164, sent_at desc) where status = 'dropped';

-- The drop an inbound reply answers, or null.
create or replace function public.rvm_match_drop(
  p_ws bigint, p_seller bigint, p_buyer bigint, p_from text, p_to text, p_at timestamptz
) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_from text := public.normalize_phone(p_from);
  v_to text := public.normalize_phone(p_to);
  v_at timestamptz := coalesce(p_at, now());
  v_id bigint;
begin
  select d.id into v_id
    from public.rvm_drops d
   where d.workspace_id = p_ws
     and d.status = 'dropped'
     and d.sent_at <= v_at and d.sent_at >= v_at - interval '7 days'
     and ((p_seller is not null and d.seller_id = p_seller)
       or (p_buyer is not null and d.buyer_id = p_buyer)
       or (v_from is not null and d.phone_e164 = v_from))
   -- Their own record's drop before another record's on a shared phone, then
   -- the line they called (a drop with no line sorts after it), then the newest.
   order by coalesce((p_seller is not null and d.seller_id = p_seller) or (p_buyer is not null and d.buyer_id = p_buyer), false) desc,
            coalesce(v_to is not null and d.from_e164 = v_to, false) desc,
            d.sent_at desc
   limit 1;
  if v_id is not null or v_to is null or v_from is null then return v_id; end if;
  -- They called or texted a line that only ever carries ringless drops: the
  -- latest drop to their number from that line, then from any line, in 30 days.
  if exists (select 1 from public.caller_lines cl where cl.workspace_id = p_ws and cl.phone_e164 = v_to and cl.pool = 'rvm') then
    select d.id into v_id
      from public.rvm_drops d
     where d.workspace_id = p_ws
       and d.status = 'dropped'
       and d.phone_e164 = v_from
       and d.sent_at <= v_at and d.sent_at >= v_at - interval '30 days'
     order by coalesce(d.from_e164 = v_to, false) desc, d.sent_at desc
     limit 1;
  end if;
  return v_id;
end $$;
revoke execute on function public.rvm_match_drop(bigint, bigint, bigint, text, text, timestamptz) from public, anon, authenticated;

-- The deal a reply is about: the drop's own, else the seller's newest live deal.
create or replace function public.rvm_drop_deal(p_drop bigint, p_seller bigint)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select d.deal_id from public.rvm_drops d where d.id = p_drop),
    (select dl.id from public.deals dl where p_seller is not null and dl.seller_id = p_seller and dl.archived_at is null
      order by dl.updated_at desc nulls last, dl.id desc limit 1));
$$;
revoke execute on function public.rvm_drop_deal(bigint, bigint) from public, anon, authenticated;

-- BEFORE INSERT: link the reply to its drop and, through it, to its record and deal.
create or replace function public.rvm_link_inbound()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_drop record;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('call', 'voicemail', 'sms') or new.rvm_drop_id is not null then
    return new;
  end if;
  begin
    select d.id, d.seller_id, d.buyer_id, d.sent_at into v_drop
      from public.rvm_drops d
     where d.id = public.rvm_match_drop(new.workspace_id, new.seller_id, new.buyer_id, new.from_phone, new.to_phone, new.occurred_at);
    if not found then return new; end if;
    new.rvm_drop_id := v_drop.id;
    -- A number on no record: the reply is filed on the person the drop went to.
    if new.seller_id is null and new.buyer_id is null then
      new.seller_id := v_drop.seller_id;
      new.buyer_id := v_drop.buyer_id;
    end if;
    if new.deal_id is null then
      new.deal_id := public.rvm_drop_deal(v_drop.id, coalesce(new.seller_id, v_drop.seller_id));
    end if;
    new.summary := coalesce(nullif(new.summary, ''),
      case new.channel when 'sms' then 'Texted back' when 'voicemail' then 'Left a voicemail' else 'Called back' end
      || ' after the ringless voicemail of ' || to_char(v_drop.sent_at at time zone 'America/Chicago', 'Mon FMDD'));
  exception when others then
    raise warning 'rvm_link_inbound: %', sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public.rvm_link_inbound() from public, anon, authenticated;

-- Credit the drop with its first reply and tell whoever sent it. p_comm is the reply row.
create or replace function public.rvm_credit_reply(p_comm bigint)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record; d record;
  v_to uuid; v_name text; v_addr text; v_when text; v_verb text; v_line text;
begin
  select id, workspace_id, channel, occurred_at, seller_id, buyer_id, deal_id, from_phone, to_phone, rvm_drop_id
    into c from public.communications where id = p_comm;
  if not found or c.rvm_drop_id is null then return; end if;
  select id, created_by, sent_at, seller_id, buyer_id, from_e164, callback_at into d from public.rvm_drops where id = c.rvm_drop_id;
  if not found or d.callback_at is not null then return; end if;
  update public.rvm_drops
     set callback_at = coalesce(c.occurred_at, now()), callback_channel = c.channel, callback_comm_id = c.id
   where id = d.id and callback_at is null;
  if not found then return; end if;

  if c.seller_id is not null then
    select s.name, coalesce(s.assigned_to, s.owner_id) into v_name, v_to from public.sellers s where s.id = c.seller_id;
  elsif c.buyer_id is not null then
    select coalesce(nullif(trim(b.company), ''), b.name), coalesce(b.assigned_to, b.owner_id) into v_name, v_to from public.buyers b where b.id = c.buyer_id;
  end if;
  -- The sender of the drop first; the record's owner when a plan or the system sent it.
  v_to := coalesce(d.created_by, v_to, (select owner_id from public.workspaces where id = c.workspace_id));
  if v_to is null then return; end if;
  select nullif(trim(p.line1), '') into v_addr
    from public.deals dl join public.properties p on p.id = dl.property_id where dl.id = c.deal_id;
  v_when := to_char(d.sent_at at time zone 'America/Chicago', 'Mon FMDD');
  v_verb := case c.channel when 'sms' then 'texted back' when 'voicemail' then 'left a voicemail' else 'called back' end;
  v_line := case when d.from_e164 is not null
    then ' on ' || regexp_replace(d.from_e164, '^\+1(\d{3})(\d{3})(\d{4})$', '(\1) \2-\3') else '' end;
  insert into public.notifications (workspace_id, user_id, category, title, body, seller_id, buyer_id, deal_id, phone_key)
  values (c.workspace_id, v_to, 'RVM',
          case c.channel when 'sms' then 'Texted back after your RVM' when 'voicemail' then 'Left a voicemail after your RVM' else 'Called back after your RVM' end,
          coalesce(nullif(trim(v_name), ''), coalesce(public.normalize_phone(c.from_phone), 'Someone')) || ' ' || v_verb
            || coalesce(' about ' || v_addr, '') || ' after the ringless voicemail of ' || v_when || v_line || '.',
          c.seller_id, c.buyer_id, c.deal_id, public.normalize_phone(c.from_phone));
end $$;
revoke execute on function public.rvm_credit_reply(bigint) from public, anon, authenticated;

-- AFTER INSERT (replaces 135's): credit and notify, or flag a reply to a pool line that matched nothing.
create or replace function public.rvm_after_inbound()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_to text; v_from text; v_admin uuid;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('call', 'voicemail', 'sms') then return new; end if;
  begin
    if new.rvm_drop_id is not null then
      perform public.rvm_credit_reply(new.id);
      return new;
    end if;
    -- Not a drop's reply. When it came in on a line that only carries ringless
    -- drops, somebody still has to see it: the owners and admins do.
    v_to := public.normalize_phone(new.to_phone);
    v_from := public.normalize_phone(new.from_phone);
    if v_to is null or new.seller_id is not null or new.buyer_id is not null then return new; end if;
    if not exists (select 1 from public.caller_lines cl where cl.workspace_id = new.workspace_id and cl.phone_e164 = v_to and cl.pool = 'rvm') then
      return new;
    end if;
    -- Once a day per caller: a robocaller or a ten-text thread is one heads-up, not ten.
    if exists (select 1 from public.notifications n
                where n.workspace_id = new.workspace_id and n.category = 'RVM' and n.phone_key = v_from
                  and n.seller_id is null and n.buyer_id is null and n.created_at > now() - interval '1 day') then
      return new;
    end if;
    for v_admin in
      select m.user_id from public.workspace_members m
       where m.workspace_id = new.workspace_id and m.role in ('owner', 'admin') and m.user_id is not null
    loop
      insert into public.notifications (workspace_id, user_id, category, title, body, phone_key)
      values (new.workspace_id, v_admin, 'RVM', 'Reply on an RVM line from an unknown number',
              coalesce(v_from, 'A caller') || ' ' || case new.channel when 'sms' then 'texted' when 'voicemail' then 'left a voicemail on' else 'called' end
                || ' ' || v_to || ', and no ringless voicemail went to that number in the last 30 days. It is in the Inbox.',
              v_from);
    end loop;
  exception when others then
    raise warning 'rvm_after_inbound: %', sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public.rvm_after_inbound() from public, anon, authenticated;

-- AFTER UPDATE OF seller_id, buyer_id: a reply filed on its record later (call-sync's re-link).
create or replace function public.rvm_after_relink()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_drop bigint;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('call', 'voicemail', 'sms') or new.rvm_drop_id is not null then
    return new;
  end if;
  begin
    v_drop := public.rvm_match_drop(new.workspace_id, new.seller_id, new.buyer_id, new.from_phone, new.to_phone, new.occurred_at);
    if v_drop is null then return new; end if;
    update public.communications
       set rvm_drop_id = v_drop,
           deal_id = coalesce(deal_id, public.rvm_drop_deal(v_drop, new.seller_id))
     where id = new.id and rvm_drop_id is null;
    perform public.rvm_credit_reply(new.id);
  exception when others then
    raise warning 'rvm_after_relink: %', sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public.rvm_after_relink() from public, anon, authenticated;

drop trigger if exists communications_attribute_rvm on public.communications;
create trigger communications_attribute_rvm before insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function public.rvm_link_inbound();

drop trigger if exists communications_rvm_inbound on public.communications;
create trigger communications_rvm_inbound after insert on public.communications for each row
  when (new.source is distinct from 'podio' or new.occurred_at > now() - interval '1 day')
  execute function public.rvm_after_inbound();

drop trigger if exists communications_rvm_relink on public.communications;
create trigger communications_rvm_relink after update of seller_id, buyer_id on public.communications for each row
  when (new.rvm_drop_id is null and (old.seller_id is distinct from new.seller_id or old.buyer_id is distinct from new.buyer_id))
  execute function public.rvm_after_relink();
