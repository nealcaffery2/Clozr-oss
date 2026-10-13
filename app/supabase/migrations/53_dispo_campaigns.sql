-- 53 · Dispo campaigns: a buyer blast that runs by itself.
--
-- The builder on a dispo property (components/DispoCampaign.tsx) renders every
-- message for every buyer in the browser — intro, deal brief, follow-ups —
-- where the rep can read and edit each one, then launches them here in one
-- transaction. From then on nothing depends on a tab being open:
--
--   pg_cron  clozr-dispo-campaign-kick  every minute
--     → dispo_campaign_kick() posts to the dispo-campaign-tick edge function
--       (only when a message is due, or every 5 minutes while SMS recipients
--       are active so Talkr threads are checked for replies)
--     → the function sends what is due: email from the chosen Gmail account
--       through the mailbox guard (window, caps, spacing, suppressions),
--       texts through Talkr as the rep who launched it (quiet hours,
--       suppression, per-number caps stay Talkr's), records each in
--       communications with buyer_id, and stamps deal_buyer_matches.sent_at.
--
-- A reply (communications inbound, matched by buyer, phone or email), an
-- offer, or an opt-out stops that buyer's queued follow-ups right here in the
-- database, whichever path wrote the row.
--
-- The kick reads two Vault secrets; create them once:
--   select vault.create_secret('https://<your-project-ref>.supabase.co', 'clozr_project_url');
--   select vault.create_secret('<service role key>', 'clozr_service_role_key');
-- Until both exist the kick does nothing and queued messages wait.
-- (Webhook record links, migration 41, also read 'clozr_app_url': the app's
-- public URL, e.g. select vault.create_secret('https://your-app.example.com', 'clozr_app_url');)

alter table public.buyers add column if not exists active_again_at timestamptz;

-- ---- tables -------------------------------------------------------------------
create table if not exists public.dispo_campaigns (
  id                    bigint generated always as identity primary key,
  workspace_id          bigint not null references public.workspaces(id) on delete cascade,
  deal_id               bigint not null references public.deals(id) on delete cascade,
  created_by            uuid references auth.users(id) on delete set null,
  status                text not null default 'running' check (status in ('running', 'paused', 'done', 'cancelled')),
  settings              jsonb not null default '{}'::jsonb,
  timezone              text not null default 'America/Chicago',
  from_phone_number_id  text,
  from_phone            text,
  email_account_id      bigint references public.google_accounts(id) on delete set null,
  from_name             text,
  starts_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists dispo_campaigns_deal_idx on public.dispo_campaigns (deal_id, created_at desc);
create index if not exists dispo_campaigns_ws_idx on public.dispo_campaigns (workspace_id);

create table if not exists public.dispo_campaign_recipients (
  id                     bigint generated always as identity primary key,
  workspace_id           bigint not null references public.workspaces(id) on delete cascade,
  campaign_id            bigint not null references public.dispo_campaigns(id) on delete cascade,
  deal_id                bigint not null references public.deals(id) on delete cascade,
  buyer_id               bigint not null references public.buyers(id) on delete cascade,
  phone                  text,
  email                  text,
  level                  smallint,
  probability            smallint,
  status                 text not null default 'active'
    check (status in ('active', 'replied', 'interested', 'not_interested', 'offered', 'opted_out', 'stopped', 'done')),
  talkr_conversation_id  text,
  replied_at             timestamptz,
  replied_channel        text,
  offered_at             timestamptz,
  checked_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (campaign_id, buyer_id)
);
create index if not exists dispo_recipients_buyer_idx on public.dispo_campaign_recipients (buyer_id);
create index if not exists dispo_recipients_deal_idx on public.dispo_campaign_recipients (deal_id);
create index if not exists dispo_recipients_active_idx on public.dispo_campaign_recipients (workspace_id) where status = 'active';

create table if not exists public.dispo_campaign_messages (
  id                bigint generated always as identity primary key,
  workspace_id      bigint not null references public.workspaces(id) on delete cascade,
  campaign_id       bigint not null references public.dispo_campaigns(id) on delete cascade,
  recipient_id      bigint not null references public.dispo_campaign_recipients(id) on delete cascade,
  buyer_id          bigint not null references public.buyers(id) on delete cascade,
  channel           text not null check (channel in ('sms', 'email')),
  kind              text not null check (kind in ('intro', 'brief', 'followup')),
  seq               smallint not null default 0,
  subject           text,
  body              text not null check (length(body) between 1 and 20000),
  body_html         text,
  media_urls        text[] not null default '{}',
  send_at           timestamptz not null,
  only_if_no_reply  boolean not null default false,
  status            text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled')),
  attempts          smallint not null default 0,
  last_error        text,
  sent_at           timestamptz,
  provider_id       text,
  communication_id  bigint references public.communications(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists dispo_messages_due_idx on public.dispo_campaign_messages (send_at) where status = 'queued';
create index if not exists dispo_messages_campaign_idx on public.dispo_campaign_messages (campaign_id);
create index if not exists dispo_messages_recipient_idx on public.dispo_campaign_messages (recipient_id);
create index if not exists dispo_messages_comm_idx on public.dispo_campaign_messages (communication_id);
create index if not exists dispo_messages_buyer_idx on public.dispo_campaign_messages (buyer_id);

do $$ declare t text; begin
  foreach t in array array['dispo_campaigns', 'dispo_campaign_recipients', 'dispo_campaign_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (public.has_role(workspace_id, 'owner', 'admin', 'dispositions', 'tc', 'member'))$p$, t || '_select', t);
    -- Rows are created by dispo_campaign_launch(); a dispo rep may pause a
    -- campaign, mark a buyer interested, or edit / cancel a queued message.
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format($p$create policy %I on public.%I for update to authenticated
      using (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'))
      with check (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'))$p$, t || '_update', t);
    execute format('grant select, update on public.%I to authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- ---- launch -------------------------------------------------------------------
/**
 * One campaign, its recipients and every message, in one transaction.
 *
 * p_delivery:   { from_phone_number_id, from_phone, email_account_id, from_name, timezone, starts_at }
 * p_recipients: [{ buyer_id, level, probability, messages: [{ channel, kind, seq, subject, body, body_html, media_urls, send_at, only_if_no_reply }] }]
 *
 * The browser decided who and what; this re-checks what must not be trusted
 * to it: the buyer is in the workspace, not blacklisted or inactive; a text
 * needs a phone and a buyer who has not asked for email only (and the reverse);
 * a follow-up needs a buyer who wants follow-ups; the Gmail account is the
 * caller's own (or any, for an owner/admin) and can send. Anything that fails
 * is dropped, not sent. Returns the campaign id.
 */
create or replace function public.dispo_campaign_launch(
  p_workspace_id bigint, p_deal_id bigint, p_settings jsonb, p_delivery jsonb, p_recipients jsonb
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_campaign bigint; v_account bigint := nullif(p_delivery->>'email_account_id', '')::bigint;
  r jsonb; m jsonb; b record; v_rec bigint; v_channel text; v_kind text; v_send timestamptz; v_n int := 0; v_msgs int := 0;
  v_media text[];
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin', 'dispositions') then
    raise exception 'only owners, admins and dispositions can launch campaigns' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deals where id = p_deal_id and workspace_id = p_workspace_id) then
    raise exception 'deal not found' using errcode = '22023';
  end if;
  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 or jsonb_array_length(p_recipients) > 2000 then
    raise exception 'recipients must be 1 to 2000 buyers' using errcode = '22023';
  end if;
  if v_account is not null and not exists (
    select 1 from public.google_accounts a where a.id = v_account and a.workspace_id = p_workspace_id
       and a.status = 'active' and a.gmail_send
       and (a.user_id = auth.uid() or public.has_role(p_workspace_id, 'owner', 'admin'))
  ) then
    raise exception 'that Gmail account cannot send for you' using errcode = '42501';
  end if;

  insert into public.dispo_campaigns (workspace_id, deal_id, created_by, settings, timezone, from_phone_number_id, from_phone, email_account_id, from_name, starts_at)
  values (p_workspace_id, p_deal_id, auth.uid(), coalesce(p_settings, '{}'::jsonb),
          coalesce(nullif(p_delivery->>'timezone', ''), 'America/Chicago'),
          nullif(p_delivery->>'from_phone_number_id', ''), nullif(p_delivery->>'from_phone', ''), v_account,
          left(nullif(regexp_replace(coalesce(p_delivery->>'from_name', ''), '[\r\n<>"]', '', 'g'), ''), 80),
          greatest(now(), coalesce((p_delivery->>'starts_at')::timestamptz, now())))
  returning id into v_campaign;

  for r in select * from jsonb_array_elements(p_recipients) loop
    select id, phone, email, preferred_channel, wants_follow_ups, blacklisted_at, status into b
      from public.buyers where id = (r->>'buyer_id')::bigint and workspace_id = p_workspace_id;
    continue when b.id is null or b.blacklisted_at is not null or lower(coalesce(b.status, '')) = 'inactive';
    insert into public.dispo_campaign_recipients (workspace_id, campaign_id, deal_id, buyer_id, phone, email, level, probability)
    values (p_workspace_id, v_campaign, p_deal_id, b.id, nullif(b.phone, ''), nullif(lower(b.email), ''),
            nullif(r->>'level', '')::smallint, nullif(r->>'probability', '')::smallint)
    on conflict (campaign_id, buyer_id) do nothing
    returning id into v_rec;
    continue when v_rec is null;
    v_n := v_n + 1;
    for m in select * from jsonb_array_elements(coalesce(r->'messages', '[]'::jsonb)) loop
      v_channel := m->>'channel'; v_kind := m->>'kind';
      continue when v_channel not in ('sms', 'email') or v_kind not in ('intro', 'brief', 'followup');
      continue when v_channel = 'sms' and (nullif(b.phone, '') is null or b.preferred_channel = 'email_only' or length(coalesce(m->>'body', '')) > 1600);
      continue when v_channel = 'email' and (nullif(b.email, '') is null or b.preferred_channel = 'sms_only' or v_account is null or nullif(trim(coalesce(m->>'subject', '')), '') is null);
      continue when v_kind = 'followup' and not coalesce(b.wants_follow_ups, true);
      continue when nullif(trim(coalesce(m->>'body', '')), '') is null;
      v_send := least(greatest(coalesce((m->>'send_at')::timestamptz, now()), now()), now() + interval '30 days');
      select coalesce(array_agg(u), '{}') into v_media
        from (select jsonb_array_elements_text(coalesce(m->'media_urls', '[]'::jsonb)) u limit 5) x where u ~ '^https://';
      insert into public.dispo_campaign_messages (workspace_id, campaign_id, recipient_id, buyer_id, channel, kind, seq, subject, body, body_html, media_urls, send_at, only_if_no_reply)
      values (p_workspace_id, v_campaign, v_rec, b.id, v_channel, v_kind, coalesce((m->>'seq')::smallint, 0),
              case when v_channel = 'email' then left(regexp_replace(m->>'subject', '[\r\n]+', ' ', 'g'), 300) end,
              left(m->>'body', 20000), case when v_channel = 'email' then left(m->>'body_html', 400000) end,
              case when v_channel = 'sms' then v_media else '{}' end, v_send, coalesce((m->>'only_if_no_reply')::boolean, v_kind = 'followup'));
      v_msgs := v_msgs + 1;
    end loop;
  end loop;

  if v_msgs = 0 then
    raise exception 'nothing to send: every buyer was skipped (blacklisted, inactive, no phone or email for the channel, or channel preference)' using errcode = '22023';
  end if;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
  values (p_workspace_id, 'deal', p_deal_id, 'campaign', 'Campaign launched · ' || v_n || ' buyers', v_msgs || ' messages queued', auth.uid());
  return v_campaign;
end $$;
revoke execute on function public.dispo_campaign_launch(bigint, bigint, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.dispo_campaign_launch(bigint, bigint, jsonb, jsonb, jsonb) to authenticated;

-- ---- a message went out ---------------------------------------------------------
/**
 * Called by dispo-campaign-tick (service role) and by the browser's "send due
 * texts now" when server texting is not configured. Marks the message, stamps
 * the match (creating it for a hand-added prospect), and finishes the campaign
 * when nothing is left queued.
 */
create or replace function public.dispo_message_sent(p_message_id bigint, p_provider_id text, p_communication_id bigint, p_status text default 'sent', p_conversation_id text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare msg public.dispo_campaign_messages; c public.dispo_campaigns;
begin
  select * into msg from public.dispo_campaign_messages where id = p_message_id;
  if msg.id is null then return; end if;
  if auth.role() <> 'service_role' and not public.has_role(msg.workspace_id, 'owner', 'admin', 'dispositions') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into c from public.dispo_campaigns where id = msg.campaign_id;
  update public.dispo_campaign_messages
     set status = case when p_status in ('sent', 'delivered') then p_status else 'sent' end,
         sent_at = now(), provider_id = p_provider_id, last_error = null,
         communication_id = coalesce(p_communication_id, communication_id)
   where id = msg.id;
  if p_conversation_id is not null then
    update public.dispo_campaign_recipients set talkr_conversation_id = p_conversation_id where id = msg.recipient_id and talkr_conversation_id is null;
  end if;
  insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons, status, sent_at)
  values (msg.workspace_id, c.deal_id, msg.buyer_id, 0, array['Added to a campaign'], 'sent', now())
  on conflict (deal_id, buyer_id) do update
    set sent_at = coalesce(public.deal_buyer_matches.sent_at, excluded.sent_at),
        status = case when public.deal_buyer_matches.status = 'matched' then 'sent' else public.deal_buyer_matches.status end;
  update public.buyers set last_activity_at = now() where id = msg.buyer_id;
  perform public.dispo_campaign_finish(c.id);
end $$;
revoke execute on function public.dispo_message_sent(bigint, text, bigint, text, text) from public, anon;
grant execute on function public.dispo_message_sent(bigint, text, bigint, text, text) to authenticated, service_role;

create or replace function public.dispo_campaign_finish(p_campaign_id bigint)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.dispo_campaigns set status = 'done'
   where id = p_campaign_id and status = 'running'
     and not exists (select 1 from public.dispo_campaign_messages where campaign_id = p_campaign_id and status in ('queued', 'sending'));
$$;
revoke execute on function public.dispo_campaign_finish(bigint) from public, anon, authenticated;

-- ---- replies, opt-outs, offers stop follow-ups ------------------------------------
/**
 * How a reply reads. Deliberately narrow: an unmistakable opt-out word on its
 * own, or a plain pass. Everything else is just "replied" and a person reads it.
 */
create or replace function public.dispo_classify_reply(p_body text)
returns text language sql immutable set search_path = pg_temp as $$
  select case
    when coalesce(p_body, '') ~* '^\s*(stop|stopall|unsubscribe|remove me|quit|cancel|end|opt out)\s*[.!]*\s*$' then 'opted_out'
    when coalesce(p_body, '') ~* '(not interested|no thanks|no thank you|not for us|not for me|i''ll pass|we''ll pass|pass on this|going to pass|gonna pass)' then 'not_interested'
    else 'replied' end;
$$;

create or replace function public.dispo_after_inbound()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_class text; v_phone text; rec record;
begin
  if coalesce(new.direction, '') <> 'inbound' or new.channel not in ('sms', 'email') then return new; end if;
  v_class := public.dispo_classify_reply(new.body);
  v_phone := case when new.channel = 'sms' then public.normalize_phone(new.from_phone) end;
  for rec in
    select r.id, r.buyer_id, r.deal_id, r.status, r.campaign_id from public.dispo_campaign_recipients r
     where r.workspace_id = new.workspace_id
       and r.status not in ('opted_out', 'stopped')
       and exists (select 1 from public.dispo_campaign_messages m where m.recipient_id = r.id and m.sent_at is not null and m.sent_at <= new.occurred_at)
       and ((new.buyer_id is not null and r.buyer_id = new.buyer_id)
         or (v_phone is not null and public.normalize_phone(r.phone) = v_phone)
         or (new.channel = 'email' and new.from_email is not null and r.email = lower(new.from_email)))
  loop
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
    perform public.dispo_campaign_finish(rec.campaign_id);
  end loop;
  return new;
end $$;
revoke execute on function public.dispo_after_inbound() from public, anon, authenticated;
drop trigger if exists communications_dispo_inbound on public.communications;
create trigger communications_dispo_inbound after insert on public.communications
  for each row execute function public.dispo_after_inbound();

create or replace function public.dispo_after_offer()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.direction <> 'inbound' or new.buyer_id is null or new.deal_id is null then return new; end if;
  update public.dispo_campaign_recipients set status = 'offered', offered_at = coalesce(offered_at, new.sent_at)
   where deal_id = new.deal_id and buyer_id = new.buyer_id and status not in ('opted_out');
  update public.dispo_campaign_messages m set status = 'cancelled', last_error = 'buyer made an offer'
    from public.dispo_campaign_recipients r
   where m.recipient_id = r.id and r.deal_id = new.deal_id and r.buyer_id = new.buyer_id and m.status = 'queued' and m.kind = 'followup';
  update public.deal_buyer_matches set status = 'offered'
   where deal_id = new.deal_id and buyer_id = new.buyer_id and status in ('matched', 'sent', 'viewed', 'interested');
  return new;
end $$;
revoke execute on function public.dispo_after_offer() from public, anon, authenticated;
drop trigger if exists offers_dispo_offer on public.offers;
create trigger offers_dispo_offer after insert on public.offers
  for each row execute function public.dispo_after_offer();

-- ---- the schedule ----------------------------------------------------------------
create or replace function public.dispo_campaign_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.dispo_campaign_messages where status = 'queued' and send_at <= now())
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
revoke execute on function public.dispo_campaign_kick() from public, anon, authenticated;

select cron.unschedule('clozr-dispo-campaign-kick') where exists (select 1 from cron.job where jobname = 'clozr-dispo-campaign-kick');
select cron.schedule('clozr-dispo-campaign-kick', '* * * * *', 'select public.dispo_campaign_kick()');

-- ---- "Write my own" intros and follow-ups, from the owner's examples -------------
-- Shared, audience buyer, one set per workspace; a name already there is left alone.
insert into public.message_templates (workspace_id, owner_id, shared, name, channel, audience, category, body_text, merge_fields)
select w.id, w.owner_id, true, t.name, 'sms', 'buyer', t.category, t.body, t.fields
  from public.workspaces w
  cross join (values
    ('Dispo intro · Recent flip nearby', 'dispo-intro',
     'Hey {{first_name}} - It''s {{rep_first_name}}. I noticed you wrapped up a flip on {{last_purchase_address}} about {{last_purchase_ago}} ago. I''ve got a {{property_type}} fixer project that''s just {{deal_distance}} away.{{similar_size}} Want more details?',
     array['first_name', 'rep_first_name', 'last_purchase_address', 'last_purchase_ago', 'property_type', 'deal_distance', 'similar_size']),
    ('Dispo intro · Rental nearby', 'dispo-intro',
     'Hello {{first_name}} - {{rep_first_name}} here. I noticed you picked up a {{property_type}} rental on {{last_purchase_address}}. I''ve got a {{property_type}} rental that''s just {{deal_distance}} away. Open to doing another one in the area?',
     array['first_name', 'rep_first_name', 'property_type', 'last_purchase_address', 'deal_distance']),
    ('Dispo follow-up · Still available', 'dispo-followup',
     'Hey {{first_name}}, {{rep_first_name}} again. {{address}} in {{city}} is still available. Want me to send the numbers?',
     array['first_name', 'rep_first_name', 'address', 'city']),
    ('Dispo follow-up · Quick check', 'dispo-followup',
     'Hi {{first_name}} - checking whether {{address}} is one you''d look at. Happy to set up a walkthrough.',
     array['first_name', 'address'])
  ) as t(name, category, body, fields)
 where not exists (select 1 from public.message_templates x where x.workspace_id = w.id and x.name = t.name and x.archived_at is null);

insert into public.message_templates (workspace_id, owner_id, shared, name, channel, audience, category, subject, body_text, merge_fields)
select w.id, w.owner_id, true, 'Dispo follow-up · Email', 'email', 'buyer', 'dispo-followup',
       'Still available: {{address}}',
       E'Hi {{first_name}},\n\nFollowing up on {{address}} in {{city}}. It is still available. Reply here if you want the details or a walkthrough.\n\n{{rep_name}}\n{{company}}',
       array['first_name', 'address', 'city', 'rep_name', 'company']
  from public.workspaces w
 where not exists (select 1 from public.message_templates x where x.workspace_id = w.id and x.name = 'Dispo follow-up · Email' and x.archived_at is null);
