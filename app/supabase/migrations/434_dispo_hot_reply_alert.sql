-- 434 · A buyer who says yes to a blast reaches the rep who sent it, by email,
-- within a minute.
--
-- On 2026-10-30 the Gleason blast had 12 buyers asking for numbers, photos and
-- how to offer, and Morgan had 40 unread "Buyer replied" bell rows: every reply,
-- STOP and "too far" included, and only inside CLOZR. Nobody saw the yeses.
--
-- 1. dispo_hot_reply(text): dispo_asks_for_details (407) or a short, negative-
--    free reply about price, offers, walkthroughs, utilities or inspections.
-- 2. Trigger communications_dispo_hot_reply: an inbound text or email (quoted
--    thread and HTML stripped) from a blast recipient that reads hot writes one
--    notifications row, category 'Hot buyer', to the campaign's creator (else
--    the deal's dispo rep, owner, the buyer's rep, the workspace owner), with
--    payload {"alert": "pending"}. One per buyer and deal every 6 hours.
-- 3. dispo_campaign_kick also posts while a hot alert is pending;
--    dispo-campaign-tick emails it to the rep (sendHotAlerts) and stamps the
--    payload 'sent' or 'failed'. Alerts older than 2 hours are not mailed.
-- Safe to re-run.

create or replace function public.dispo_hot_reply(p_body text) returns boolean
language sql immutable set search_path = pg_temp as $$
  select public.dispo_asks_for_details(p_body)
      or (length(trim(coalesce(p_body, ''))) between 1 and 160
          and p_body !~* '^\s*(loved|liked|laughed at|emphasized|disliked|questioned)\s+["“]'
          and p_body !~* '\m(no|not|nope|nah|stop|pass|wrong|remove|unsubscribe|don''?t|dont|never|too|to far|already|sold|only|who is|retired)\M'
          and p_body ~* '(how much|\moffer\M|walk ?through|walkthrough|utilities|inspection|\mcomps?\M|\minterested\M|\mshowing\M|\mlock ?box\M|\maccess\M)');
$$;

-- The reply a person typed: tags, entities and the quoted thread removed.
create or replace function public.reply_text(p_body text) returns text
language sql immutable set search_path = pg_temp as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(regexp_replace(coalesce(p_body, ''), '<(style|script)[^>]*>.*?</\1>', ' ', 'gi'), '<[^>]+>|&nbsp;|&#160;', ' ', 'gi'),
      '(\sOn\s.{0,250}?wrote:|-{2,}\s*Original Message|\sFrom:\s.*?Sent:|\sSent (from|with) ).*$', '', 'i'),
    '\s+', ' ', 'g'));
$$;

create or replace function public.dispo_hot_reply_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_text text; v_phone text; rec record; v_user uuid; v_who text; v_line text;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('sms', 'email') then return new; end if;
  v_text := case when new.channel = 'email' then public.reply_text(new.body) else btrim(coalesce(new.body, '')) end;
  if not public.dispo_hot_reply(v_text) then return new; end if;
  v_phone := case when new.channel = 'sms' then public.normalize_phone(new.from_phone) end;

  -- The blast this buyer last heard from.
  select r.buyer_id, r.deal_id, r.campaign_id into rec
    from public.dispo_campaign_recipients r
    join public.dispo_campaign_messages m on m.recipient_id = r.id and m.sent_at is not null and m.sent_at <= new.occurred_at
   where r.workspace_id = new.workspace_id
     and r.status not in ('opted_out', 'stopped')
     and m.sent_at > new.occurred_at - interval '21 days'
     and ((new.buyer_id is not null and r.buyer_id = new.buyer_id)
       or (v_phone is not null and r.phone_key = v_phone)
       or (new.channel = 'email' and new.from_email is not null and r.email = lower(new.from_email)))
   order by m.sent_at desc limit 1;
  if rec.campaign_id is null then return new; end if;

  if exists (select 1 from public.notifications n
              where n.workspace_id = new.workspace_id and n.category = 'Hot buyer'
                and n.buyer_id = rec.buyer_id and n.deal_id is not distinct from rec.deal_id
                and n.created_at > now() - interval '6 hours') then return new; end if;

  select coalesce(c.created_by, d.dispo_rep_id, d.owner_id, b.assigned_to, w.owner_id),
         coalesce(nullif(trim(b.name), ''), nullif(trim(b.company), ''), 'A buyer'),
         p.line1
    into v_user, v_who, v_line
    from public.dispo_campaigns c
    join public.workspaces w on w.id = c.workspace_id
    left join public.deals d on d.id = rec.deal_id
    left join public.properties p on p.id = d.property_id
    left join public.buyers b on b.id = rec.buyer_id
   where c.id = rec.campaign_id;
  if v_user is null then return new; end if;

  insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, deal_id, payload)
  values (new.workspace_id, v_user, 'Hot buyer',
          'Hot buyer: ' || v_who || coalesce(' on ' || v_line, ''),
          left(v_text, 300), rec.buyer_id, rec.deal_id,
          jsonb_build_object('alert', 'pending', 'channel', new.channel, 'communication_id', new.id, 'campaign_id', rec.campaign_id));
  return new;
exception when others then
  -- Never fail the insert of the reply itself.
  raise warning 'dispo_hot_reply_alert: %', sqlerrm;
  return new;
end $$;

revoke execute on function public.dispo_hot_reply_alert() from public, anon, authenticated;

drop trigger if exists communications_dispo_hot_reply on public.communications;
create trigger communications_dispo_hot_reply after insert on public.communications
  for each row when (new.direction = 'inbound' and new.occurred_at > now() - interval '1 day')
  execute function public.dispo_hot_reply_alert();

create index if not exists notifications_hot_alert_pending on public.notifications (created_at)
  where category = 'Hot buyer' and (payload ->> 'alert') = 'pending';

-- 53's kick, plus: post while a hot alert waits to be emailed.
create or replace function public.dispo_campaign_kick() returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text; v_campaigns bigint[];
begin
  -- ponytail: no index has status = 'sending', so this scans the table (1 row on 2026-10-17); add a concurrent partial index on (updated_at) where status = 'sending' when it is large.
  with reaped as (
    update public.dispo_campaign_messages set status = 'failed', last_error = 'send outcome unknown; not retried'
     where status = 'sending' and updated_at < now() - interval '30 minutes'
    returning campaign_id)
  select array_agg(distinct campaign_id) into v_campaigns from reaped;
  perform public.dispo_campaign_finish(c) from unnest(v_campaigns) c;

  if not exists (select 1 from public.dispo_campaign_messages where status = 'queued' and send_at <= now())
     and not exists (select 1 from public.notifications where category = 'Hot buyer' and (payload ->> 'alert') = 'pending' and created_at > now() - interval '2 hours')
     and not (extract(minute from now())::int % 5 = 0
              and exists (select 1 from public.dispo_campaign_recipients where status in ('active', 'replied') and talkr_conversation_id is not null and created_at > now() - interval '14 days'))
  then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/dispo-campaign-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
