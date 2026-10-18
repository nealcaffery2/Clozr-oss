-- Less work on every communications insert. Same results as before.
-- Bodies are the live definitions (pg_get_functiondef); each change is marked.

-- 1. webhook_emit: the "any subscriber?" check runs before the row is turned
-- into jsonb (to_jsonb(new) / to_jsonb(old) used to run in DECLARE, on every row).
create or replace function public.webhook_emit()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  n   jsonb;
  o   jsonb;
  ev  text;
  p   jsonb;
  who public.sellers;
  adr text;
begin
  if not exists (select 1 from public.webhook_subscriptions
                  where workspace_id = new.workspace_id and active) then
    return null;
  end if;
  n := to_jsonb(new);
  o := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;

  if tg_table_name in ('deals', 'tasks', 'offers', 'contracts', 'communications', 'appointments')
     and (n->>'seller_id') is not null then
    select * into who from public.sellers where id = (n->>'seller_id')::bigint;
  end if;
  if (n->>'property_id') is not null then
    select concat_ws(', ', line1, city, state || ' ' || zip) into adr
      from public.properties where id = (n->>'property_id')::bigint;
  end if;

  case tg_table_name
  when 'sellers' then
    ev := case when tg_op = 'INSERT' then 'seller.created'
               when new.lead_stage is distinct from old.lead_stage then 'seller.stage_changed' end;
    p := jsonb_build_object('record_type', 'seller', 'record_id', new.id, 'seller_id', new.id,
      'name', new.name, 'phone', new.phone, 'email', new.email,
      'address', coalesce(adr, new.property_address), 'stage', new.lead_stage, 'old_stage', o->>'lead_stage',
      'asking_price', new.asking_price, 'tags', new.tags, 'source', new.source,
      'url', public.webhook_record_url('seller', new.id));
  when 'deals' then
    ev := case when tg_op = 'INSERT' then 'deal.created'
               when (n->>'stage') is distinct from (o->>'stage') then 'deal.stage_changed' end;
    p := jsonb_build_object('record_type', 'deal', 'record_id', n->'id', 'deal_id', n->'id',
      'seller_id', n->'seller_id', 'buyer_id', n->'buyer_id', 'property_id', n->'property_id',
      'name', who.name, 'phone', who.phone, 'email', who.email, 'address', adr,
      'stage', n->>'stage', 'old_stage', o->>'stage',
      'offer_amount', n->'offer_amount', 'arv', n->'arv', 'mao', n->'mao',
      'assignment_fee', n->'assignment_fee', 'sold_price', n->'sold_price',
      'contract_date', n->'contract_date', 'close_date', n->'close_date',
      'url', public.webhook_record_url('deal', (n->>'id')::bigint));
  when 'buyers' then
    ev := 'buyer.created';
    p := jsonb_build_object('record_type', 'buyer', 'record_id', n->'id', 'buyer_id', n->'id',
      'name', n->>'name', 'company', n->>'company', 'phone', n->>'phone', 'email', n->>'email',
      'max_purchase_price', n->'max_purchase_price', 'markets', n->'markets', 'tags', n->'tags',
      'source', n->>'source', 'url', public.webhook_record_url('buyer', (n->>'id')::bigint));
  when 'tasks' then
    ev := case when (n->>'done')::boolean and not coalesce((o->>'done')::boolean, false) then 'task.completed' end;
    p := jsonb_build_object('record_type', 'task', 'record_id', n->'id', 'task_id', n->'id',
      'title', n->>'title', 'task_type', n->>'task_type', 'seller_id', n->'seller_id', 'deal_id', n->'deal_id',
      'name', who.name, 'phone', who.phone, 'email', who.email, 'completed_at', n->'completed_at',
      'url', case when who.id is not null then public.webhook_record_url('seller', who.id) end);
  when 'offers' then
    ev := case when (n->>'sent_at') is not null and (o->>'sent_at') is null then 'offer.sent'
               when n->>'status' = 'sent' and (o->>'status') is distinct from 'sent' then 'offer.sent' end;
    p := jsonb_build_object('record_type', 'offer', 'record_id', n->'id', 'offer_id', n->'id',
      'amount', n->'amount', 'direction', n->>'direction', 'status', n->>'status', 'expires_on', n->'expires_on',
      'deal_id', n->'deal_id', 'seller_id', n->'seller_id', 'buyer_id', n->'buyer_id',
      'name', who.name, 'phone', who.phone, 'email', who.email, 'address', adr,
      'url', case when who.id is not null then public.webhook_record_url('seller', who.id) end);
  when 'contracts' then
    ev := case when ((n->>'completed_at') is not null and (o->>'completed_at') is null)
                 or (n->>'status' = 'completed' and (o->>'status') is distinct from 'completed') then 'contract.signed'
               when (n->>'viewed_at') is not null and (o->>'viewed_at') is null then 'contract.viewed' end;
    p := jsonb_build_object('record_type', 'contract', 'record_id', n->'id', 'contract_id', n->'id',
      'contract_name', n->>'name', 'kind', n->>'kind', 'status', n->>'status',
      'deal_id', n->'deal_id', 'seller_id', n->'seller_id', 'buyer_id', n->'buyer_id',
      'name', who.name, 'phone', who.phone, 'email', who.email,
      'url', case when (n->>'deal_id') is not null then public.webhook_record_url('deal', (n->>'deal_id')::bigint) end);
  when 'communications' then
    ev := case when n->>'direction' = 'inbound' then 'communication.inbound' end;
    p := jsonb_build_object('record_type', 'communication', 'record_id', n->'id', 'communication_id', n->'id',
      'channel', n->>'channel', 'from_phone', n->>'from_phone', 'from_email', n->>'from_email',
      'subject', n->>'subject', 'body', left(n->>'body', 2000), 'occurred_at', n->'occurred_at',
      'seller_id', n->'seller_id', 'buyer_id', n->'buyer_id',
      'name', who.name, 'phone', who.phone, 'email', who.email, 'address', adr,
      'url', case when who.id is not null then public.webhook_record_url('seller', who.id)
                  when (n->>'buyer_id') is not null then public.webhook_record_url('buyer', (n->>'buyer_id')::bigint) end);
  when 'appointments' then
    ev := 'appointment.created';
    p := jsonb_build_object('record_type', 'appointment', 'record_id', n->'id', 'appointment_id', n->'id',
      'title', n->>'title', 'kind', n->>'kind', 'starts_at', n->'starts_at', 'ends_at', n->'ends_at',
      'location', n->>'location', 'seller_id', n->'seller_id', 'buyer_id', n->'buyer_id',
      'name', who.name, 'phone', who.phone, 'email', who.email, 'address', adr,
      'url', case when who.id is not null then public.webhook_record_url('seller', who.id) end);
  end case;

  if ev is not null then
    perform public.webhook_enqueue(new.workspace_id, ev, p);
  end if;
  return null;
end $function$;

-- 2. communications_last_touch: an insert no longer re-reads the seller's
-- newest communication when the answer is already known.
--   newer than the seller's last touch: it is the newest; write it directly.
--   older than the seller's last touch: nothing changes; skip.
--   equal, null last touch, or null occurred_at: recompute as before
--   (ties break on id, and a null occurred_at sorts first in seller_last_touch_set).
-- Updates and deletes are unchanged. seller_last_touch_set already writes only
-- when a value changes.
create or replace function public.communications_last_touch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'INSERT' then
    if new.seller_id is null then return null; end if;
    update public.sellers
       set last_touch_at = new.occurred_at, last_touch_channel = new.channel
     where id = new.seller_id and last_touch_at < new.occurred_at;
    if found then return null; end if;
    if exists (select 1 from public.sellers where id = new.seller_id and last_touch_at > new.occurred_at) then
      return null;
    end if;
    perform public.seller_last_touch_set(new.seller_id);
    return null;
  end if;
  perform public.seller_last_touch_set(old.seller_id);
  if tg_op = 'UPDATE' and new.seller_id is distinct from old.seller_id then
    perform public.seller_last_touch_set(new.seller_id);
  end if;
  return null;
end $function$;

-- 3. dispo_after_inbound: a stored phone_key (the same normalize_phone() the
-- trigger applied to r.phone on every row) and one indexed branch per match
-- (buyer, phone, email) instead of an OR that scanned the workspace.
-- Indexes: 297 (workspace_id, phone_key), 298 (workspace_id, email).
alter table public.dispo_campaign_recipients
  add column if not exists phone_key text generated always as (public.normalize_phone(phone)) stored;

create or replace function public.dispo_after_inbound()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
end $function$;
