-- 41 · Zapier / Jotform in, signed webhooks out.
--
-- Inbound
--   ingest_apply_flat(ws, envelope)  what the `ingest` function calls for the
--        flat sources (zapier, jotform). Same ledger and dedupe as
--        ingest_apply — (workspace, source, source_id) on ingest_events — and
--        leads still go through ingest_apply itself. Adds what it lacked:
--        buyers, and attach-only events (note / activity / email opened) that
--        match an existing seller or buyer by phone or email and never create
--        one. Unmatched attaches write nothing, so a retry after the person
--        exists still lands.
--   ingest_events.buyer_id           the buyer a flat event resolved to.
--   set_ingest_setting(id, key, val) owner/admin; whitelisted keys `creates`
--        ('seller'|'buyer', what a Jotform key makes) and `jotform_api_key`
--        (write-only, read by the jotform-import function via service role).
--   ingest_sources_public            gains `creates` and `has_api_key`. It
--        was security_invoker over a table authenticated cannot SELECT, so it
--        returned "permission denied" and Settings listed no keys; it is now a
--        definer view filtered to owner/admin workspaces, and authenticated
--        gets SELECT on the non-secret columns so `update … where id =` works.
--
-- Outbound
--   webhook_subscriptions / webhook_deliveries, owner/admin only. Row triggers
--   enqueue one delivery per matching active subscription; an AFTER INSERT
--   trigger on deliveries sends it through pg_net, and pg_cron runs
--   webhook_tick() every minute to read responses, retry with backoff
--   (1, 4, 16, 64, 256 min; 6 attempts) and prune after 30 days.
--   Signature: X-Clozr-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, t || '.' || body)).
--
-- ponytail: all delivery runs inside Postgres (pg_net + pg_cron), no edge
-- function. Ceiling: pg_net sends ~200 requests/s per database and keeps
-- responses ~6h, results are read once a minute, and a slow receiver holds a
-- worker up to the 10s timeout. Past a few thousand events an hour, move sending
-- to a queue + edge function.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- =========================================================== inbound
alter table public.ingest_events
  add column if not exists buyer_id bigint references public.buyers(id) on delete set null;
create index if not exists ingest_events_buyer_id_idx on public.ingest_events (buyer_id);
create index if not exists sellers_email_idx on public.sellers (workspace_id, lower(email)) where email is not null;
create index if not exists buyers_email_idx on public.buyers (workspace_id, lower(email)) where email is not null;

create or replace function public.ingest_apply_flat(p_workspace_id bigint, p_envelope jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source    text := p_envelope->>'source';
  v_source_id text := p_envelope->>'source_id';
  v_mode      text := p_envelope->>'mode';
  v_occurred  timestamptz := nullif(p_envelope->>'occurred_at', '')::timestamptz;
  per  jsonb := coalesce(p_envelope->'person', '{}');
  b    jsonb := coalesce(p_envelope->'buyer', '{}');
  act  jsonb := p_envelope->'activity';
  v_phone text;
  v_email text;
  v_tags  text[];
  v_seller bigint;
  v_buyer  bigint;
  r        jsonb;
  prior    public.ingest_events;
begin
  if v_source is null or v_source_id is null or v_mode not in ('lead', 'buyer', 'attach') then
    raise exception 'source, source_id and mode are required' using errcode = '22023';
  end if;

  select * into prior from public.ingest_events
   where workspace_id = p_workspace_id and source = v_source and source_id = v_source_id;
  if found then
    return jsonb_build_object('ok', true, 'deduped', true, 'matched', true,
      'id', coalesce(prior.seller_id, prior.buyer_id),
      'kind', case when prior.buyer_id is not null then 'buyer' else 'seller' end);
  end if;

  -- ---- lead: the existing door, then what the flat contract adds ----------
  if v_mode = 'lead' then
    r := public.ingest_apply(p_workspace_id, p_envelope);
    v_seller := (r->>'seller_id')::bigint;
    if v_seller is not null then
      select array_agg(value) into v_tags from jsonb_array_elements_text(p_envelope->'lead'->'tags');
      update public.sellers set
        lead_stage = coalesce(nullif(p_envelope->'lead'->>'stage', ''), lead_stage),
        tags       = case when v_tags is null then tags
                          else array(select distinct unnest(coalesce(tags, '{}') || v_tags)) end,
        email      = coalesce(email, nullif(per->>'email', ''))
       where id = v_seller;
      if act is not null then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, occurred_at, external_id)
        values (p_workspace_id, 'seller', v_seller, act->>'kind', act->>'title', act->>'body',
                coalesce(v_occurred, now()), v_source || ':' || v_source_id)
        on conflict (workspace_id, kind, external_id) do nothing;
      end if;
    end if;
    return jsonb_build_object('ok', true, 'deduped', false, 'matched', v_seller is not null,
                              'id', v_seller, 'kind', 'seller');
  end if;

  -- ---- buyer: match on phone or email, merge, never blank -----------------
  if v_mode = 'buyer' then
    v_phone := public.normalize_phone(b->>'phone');
    v_email := lower(nullif(b->>'email', ''));
    select id into v_buyer from public.buyers
     where workspace_id = p_workspace_id
       and ((v_phone is not null and phone_key = v_phone) or (v_email is not null and lower(email) = v_email))
     order by id limit 1;
    select array_agg(value) into v_tags from jsonb_array_elements_text(b->'tags');
    if v_buyer is null then
      insert into public.buyers (workspace_id, name, company, email, phone, markets, max_purchase_price,
                                 notes, tags, source, source_id)
      values (p_workspace_id, coalesce(b->>'name', v_email, b->>'phone'), b->>'company', v_email, b->>'phone',
              (select array_agg(value) from jsonb_array_elements_text(b->'markets')),
              (b->>'max_purchase_price')::numeric, b->>'notes', v_tags, v_source, v_source_id)
      returning id into v_buyer;
    else
      update public.buyers set
        name               = coalesce(nullif(name, ''), b->>'name'),
        company            = coalesce(b->>'company', company),
        email              = coalesce(email, v_email),
        phone              = coalesce(phone, b->>'phone'),
        max_purchase_price = coalesce((b->>'max_purchase_price')::numeric, max_purchase_price),
        markets            = coalesce((select array_agg(value) from jsonb_array_elements_text(b->'markets')), markets),
        tags               = case when v_tags is null then tags
                                  else array(select distinct unnest(coalesce(tags, '{}') || v_tags)) end
       where id = v_buyer;
      if nullif(b->>'notes', '') is not null then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, occurred_at, external_id)
        values (p_workspace_id, 'buyer', v_buyer, 'note', 'Submitted again via ' || v_source, b->>'notes',
                coalesce(v_occurred, now()), v_source || ':' || v_source_id)
        on conflict (workspace_id, kind, external_id) do nothing;
      end if;
    end if;
    insert into public.ingest_events (workspace_id, source, source_id, event_type, occurred_at, payload,
                                      phone_key, buyer_id, status)
    values (p_workspace_id, v_source, v_source_id, p_envelope->>'type', v_occurred, p_envelope,
            v_phone, v_buyer, 'applied');
    return jsonb_build_object('ok', true, 'deduped', false, 'matched', true, 'id', v_buyer, 'kind', 'buyer');
  end if;

  -- ---- attach: existing seller, else existing buyer, else nothing ---------
  v_phone := public.normalize_phone(per->>'phone');
  v_email := lower(nullif(per->>'email', ''));
  select id into v_seller from public.sellers
   where workspace_id = p_workspace_id
     and ((v_phone is not null and phone_key = v_phone) or (v_email is not null and lower(email) = v_email))
   order by archived_at nulls first, id limit 1;
  if v_seller is null then
    select id into v_buyer from public.buyers
     where workspace_id = p_workspace_id
       and ((v_phone is not null and phone_key = v_phone) or (v_email is not null and lower(email) = v_email))
     order by id limit 1;
  end if;
  if v_seller is null and v_buyer is null then
    return jsonb_build_object('ok', true, 'deduped', false, 'matched', false, 'id', null);
  end if;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, occurred_at, external_id)
  values (p_workspace_id, case when v_seller is not null then 'seller' else 'buyer' end, coalesce(v_seller, v_buyer),
          act->>'kind', act->>'title', act->>'body', coalesce(v_occurred, now()), v_source || ':' || v_source_id)
  on conflict (workspace_id, kind, external_id) do nothing;
  insert into public.ingest_events (workspace_id, source, source_id, event_type, occurred_at, payload,
                                    phone_key, seller_id, buyer_id, status)
  values (p_workspace_id, v_source, v_source_id, p_envelope->>'type', v_occurred, p_envelope,
          v_phone, v_seller, v_buyer, 'applied');
  return jsonb_build_object('ok', true, 'deduped', false, 'matched', true, 'id', coalesce(v_seller, v_buyer),
                            'kind', case when v_seller is not null then 'seller' else 'buyer' end);
end $$;
revoke all on function public.ingest_apply_flat(bigint, jsonb) from public, anon, authenticated;

create or replace function public.set_ingest_setting(p_id bigint, p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare ws bigint; v_name text;
begin
  select workspace_id, name into ws, v_name from public.ingest_sources where id = p_id;
  if ws is null or not public.has_role(ws, 'owner', 'admin') then
    raise exception 'only an owner or admin can change a key' using errcode = '42501';
  end if;
  if p_key = 'creates' and p_value in ('seller', 'buyer') then null;
  elsif p_key = 'jotform_api_key' and v_name = 'jotform' and length(coalesce(p_value, '')) between 16 and 128 then null;
  else raise exception 'unsupported setting' using errcode = '22023';
  end if;
  update public.ingest_sources
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = p_id;
end $$;
revoke all on function public.set_ingest_setting(bigint, text, text) from public, anon;
grant execute on function public.set_ingest_setting(bigint, text, text) to authenticated;

-- The audit trigger on ingest_sources logs settings; keep the Jotform API key out of audit_log too.
create or replace function public.audit_scrub(j jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select case when j is null then null else
    (j - 'key_hash' - 'calendar_token')
      || case when j ? 'settings' and ((j->'settings') ? 'signing_secret' or (j->'settings') ? 'jotform_api_key')
              then jsonb_build_object('settings', (j->'settings')
                     || case when (j->'settings') ? 'signing_secret' then '{"signing_secret":"[redacted]"}'::jsonb else '{}'::jsonb end
                     || case when (j->'settings') ? 'jotform_api_key' then '{"jotform_api_key":"[redacted]"}'::jsonb else '{}'::jsonb end)
              else '{}'::jsonb end
  end
$$;

grant select (id, workspace_id, name, label, key_prefix, active, last_used_at, created_at)
  on public.ingest_sources to authenticated;

drop view if exists public.ingest_sources_public;
create view public.ingest_sources_public with (security_invoker = false) as
  select id, workspace_id, name, label, key_prefix, active, last_used_at, created_at,
         (settings ? 'signing_secret')  as has_signing_secret,
         coalesce(settings->>'creates', 'seller') as creates,
         (settings ? 'jotform_api_key') as has_api_key
    from public.ingest_sources
   where public.has_role(workspace_id, 'owner', 'admin');
revoke all on public.ingest_sources_public from anon, authenticated;
grant select on public.ingest_sources_public to authenticated;

-- =========================================================== outbound
create table if not exists public.webhook_subscriptions (
  id                bigint generated always as identity primary key,
  workspace_id      bigint not null references public.workspaces(id) on delete cascade,
  url               text   not null check (url ~ '^https://'),
  events            text[] not null,
  secret            text   not null,
  active            boolean not null default true,
  description       text,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  last_status       text,
  last_error        text,
  last_delivered_at timestamptz
);
create index if not exists webhook_subscriptions_ws_idx on public.webhook_subscriptions (workspace_id) where active;
create index if not exists webhook_subscriptions_created_by_idx on public.webhook_subscriptions (created_by);

create table if not exists public.webhook_deliveries (
  id              bigint generated always as identity primary key,
  workspace_id    bigint not null references public.workspaces(id) on delete cascade,
  subscription_id bigint not null references public.webhook_subscriptions(id) on delete cascade,
  event           text   not null,
  payload         jsonb  not null,
  status          text   not null default 'pending'
                  check (status in ('pending', 'sending', 'retrying', 'delivered', 'failed')),
  attempts        integer not null default 0,
  request_id      bigint,
  response_code   integer,
  error           text,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index if not exists webhook_deliveries_sub_idx on public.webhook_deliveries (subscription_id, created_at desc);
create index if not exists webhook_deliveries_ws_idx on public.webhook_deliveries (workspace_id);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (status, next_attempt_at)
  where status in ('sending', 'retrying');

alter table public.webhook_subscriptions enable row level security;
alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_subscriptions, public.webhook_deliveries from anon, authenticated;
-- The secret is shown once by webhook_subscribe and is not selectable after.
grant select (id, workspace_id, url, events, active, description, created_by, created_at,
              last_status, last_error, last_delivered_at) on public.webhook_subscriptions to authenticated;
-- url and events are fixed at subscribe time, where they are validated; delete and re-add to change them.
grant update (active, description) on public.webhook_subscriptions to authenticated;
grant delete on public.webhook_subscriptions to authenticated;
grant select on public.webhook_deliveries to authenticated;

drop policy if exists webhook_subscriptions_admin on public.webhook_subscriptions;
create policy webhook_subscriptions_admin on public.webhook_subscriptions for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));
drop policy if exists webhook_deliveries_admin on public.webhook_deliveries;
create policy webhook_deliveries_admin on public.webhook_deliveries for select to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));

create or replace function public.webhook_events()
returns text[] language sql immutable as $$
  select array['seller.created', 'seller.stage_changed', 'deal.created', 'deal.stage_changed', 'buyer.created',
               'task.completed', 'offer.sent', 'contract.viewed', 'contract.signed',
               'communication.inbound', 'appointment.created']
$$;

-- ponytail: the app does not read these query params yet; the link opens CLOZR.
-- The app's public URL comes from the Vault secret 'clozr_app_url' (set it
-- like the secrets in migration 53); a placeholder stands in until it is set.
create or replace function public.webhook_record_url(p_kind text, p_id bigint)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
           rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'clozr_app_url' limit 1), '/'),
           'https://your-app.example.com')
         || '/app?' || p_kind || '=' || p_id
$$;

-- ---- send one delivery ------------------------------------------------------
create or replace function public.webhook_send(p_delivery_id bigint)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  d   public.webhook_deliveries;
  s   public.webhook_subscriptions;
  v_t text := extract(epoch from now())::bigint::text;
  v_req bigint;
begin
  select * into d from public.webhook_deliveries where id = p_delivery_id;
  select * into s from public.webhook_subscriptions where id = d.subscription_id;
  if d.id is null or s.id is null or not s.active then return; end if;
  -- pg_net sends convert_to(body::text), so the signed text is the sent bytes.
  v_req := net.http_post(
    url := s.url,
    body := d.payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'User-Agent', 'CLOZR-Webhooks/1',
      'X-Clozr-Event', d.event,
      'X-Clozr-Delivery', d.id::text,
      'X-Clozr-Signature', 't=' || v_t || ',v1=' ||
        encode(extensions.hmac(v_t || '.' || d.payload::text, s.secret, 'sha256'), 'hex')),
    timeout_milliseconds := 10000);
  update public.webhook_deliveries
     set status = 'sending', request_id = v_req, attempts = attempts + 1,
         last_attempt_at = now(), next_attempt_at = null
   where id = d.id;
end $$;

create or replace function public.webhook_deliveries_send()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.webhook_send(new.id);
  return null;
end $$;
drop trigger if exists webhook_deliveries_send on public.webhook_deliveries;
create trigger webhook_deliveries_send after insert on public.webhook_deliveries
  for each row execute function public.webhook_deliveries_send();

-- ---- enqueue ----------------------------------------------------------------
create or replace function public.webhook_enqueue(p_workspace_id bigint, p_event text, p_payload jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.webhook_deliveries (workspace_id, subscription_id, event, payload)
  select p_workspace_id, s.id, p_event,
         jsonb_strip_nulls(jsonb_build_object('event', p_event, 'occurred_at', now(), 'workspace_id', p_workspace_id)
                           || p_payload)
    from public.webhook_subscriptions s
   where s.workspace_id = p_workspace_id and s.active and p_event = any(s.events)
$$;

create or replace function public.webhook_emit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n   jsonb := to_jsonb(new);
  o   jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  ev  text;
  p   jsonb;
  who public.sellers;
  adr text;
begin
  -- Cheap exit: nobody in this workspace listens to anything.
  if not exists (select 1 from public.webhook_subscriptions
                  where workspace_id = new.workspace_id and active) then
    return null;
  end if;

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
end $$;

drop trigger if exists webhook_emit on public.sellers;
create trigger webhook_emit after insert or update of lead_stage on public.sellers
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.deals;
create trigger webhook_emit after insert or update of stage on public.deals
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.buyers;
create trigger webhook_emit after insert on public.buyers
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.tasks;
create trigger webhook_emit after update of done on public.tasks
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.offers;
create trigger webhook_emit after insert or update of sent_at, status on public.offers
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.contracts;
create trigger webhook_emit after update of viewed_at, completed_at, status on public.contracts
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.communications;
create trigger webhook_emit after insert on public.communications
  for each row execute function public.webhook_emit();
drop trigger if exists webhook_emit on public.appointments;
create trigger webhook_emit after insert on public.appointments
  for each row execute function public.webhook_emit();

-- ---- responses, retries, retention (every minute) --------------------------
create or replace function public.webhook_tick()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id bigint;
begin
  with done as (
    update public.webhook_deliveries d set
      response_code   = r.status_code,
      error           = case when r.status_code between 200 and 299 then null
                             else left(coalesce(r.error_msg, 'HTTP ' || r.status_code), 500) end,
      status          = case when r.status_code between 200 and 299 then 'delivered'
                             when d.attempts >= 6 then 'failed' else 'retrying' end,
      delivered_at    = case when r.status_code between 200 and 299 then now() end,
      next_attempt_at = case when r.status_code between 200 and 299 or d.attempts >= 6 then null
                             else now() + make_interval(mins => power(4, d.attempts - 1)::int) end
      from net._http_response r
     where d.status = 'sending' and r.id = d.request_id
    returning d.subscription_id, d.status, d.error, d.delivered_at, d.id
  )
  update public.webhook_subscriptions s
     set last_status = x.status, last_error = x.error,
         last_delivered_at = coalesce(x.delivered_at, s.last_delivered_at)
    from (select distinct on (subscription_id) * from done order by subscription_id, id desc) x
   where s.id = x.subscription_id;

  -- A response pg_net never recorded (purged, worker restart) counts as a failed attempt.
  update public.webhook_deliveries
     set status = case when attempts >= 6 then 'failed' else 'retrying' end,
         error = 'no response recorded', next_attempt_at = now()
   where status in ('sending', 'pending') and coalesce(last_attempt_at, created_at) < now() - interval '15 minutes';

  for v_id in
    select d.id from public.webhook_deliveries d
      join public.webhook_subscriptions s on s.id = d.subscription_id and s.active
     where d.status = 'retrying' and d.next_attempt_at <= now()
     order by d.next_attempt_at limit 200
  loop
    perform public.webhook_send(v_id);
  end loop;

  delete from public.webhook_deliveries
   where status in ('delivered', 'failed') and created_at < now() - interval '30 days';
end $$;

select cron.schedule('clozr-webhook-tick', '* * * * *', 'select public.webhook_tick()');

-- ---- client RPCs (owner/admin) ---------------------------------------------
create or replace function public.webhook_subscribe(p_workspace_id bigint, p_url text, p_events text[], p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_secret text := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex'); v_id bigint;
begin
  if not public.has_role(p_workspace_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can add webhooks' using errcode = '42501';
  end if;
  -- ponytail: host check by name only; a DNS name resolving to a private address still passes.
  if p_url !~ '^https://[^/\s]+' or p_url ~* '^https://(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[|0\.)' then
    raise exception 'url must be a public https:// address' using errcode = '22023';
  end if;
  if coalesce(array_length(p_events, 1), 0) = 0 or not (p_events <@ public.webhook_events()) then
    raise exception 'events must be a non-empty subset of %', public.webhook_events() using errcode = '22023';
  end if;
  insert into public.webhook_subscriptions (workspace_id, url, events, secret, description, created_by)
  values (p_workspace_id, p_url, p_events, v_secret, nullif(p_description, ''), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'secret', v_secret);
end $$;

create or replace function public.webhook_send_test(p_subscription_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare s public.webhook_subscriptions; v_id bigint;
begin
  select * into s from public.webhook_subscriptions where id = p_subscription_id;
  if s.id is null or not public.has_role(s.workspace_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can test webhooks' using errcode = '42501';
  end if;
  insert into public.webhook_deliveries (workspace_id, subscription_id, event, payload)
  values (s.workspace_id, s.id, s.events[1], jsonb_build_object(
    'event', s.events[1], 'test', true, 'occurred_at', now(), 'workspace_id', s.workspace_id,
    'record_type', 'seller', 'record_id', 0, 'seller_id', 0, 'name', 'Kara Mitchell',
    'phone', '+15555550136', 'email', 'kara@example.com', 'address', '123 Main St, Springfield, TX 78000',
    'stage', 'Under Contract', 'old_stage', 'Offer Made', 'amount', 235000,
    'url', public.webhook_record_url('seller', 0)))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.webhook_retry(p_delivery_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare ws bigint;
begin
  select workspace_id into ws from public.webhook_deliveries where id = p_delivery_id;
  if ws is null or not public.has_role(ws, 'owner', 'admin') then
    raise exception 'only an owner or admin can retry webhooks' using errcode = '42501';
  end if;
  perform public.webhook_send(p_delivery_id);
end $$;

revoke all on function public.webhook_events() from public, anon;
revoke all on function public.webhook_record_url(text, bigint) from public, anon, authenticated;
revoke all on function public.webhook_send(bigint) from public, anon, authenticated;
revoke all on function public.webhook_deliveries_send() from public, anon, authenticated;
revoke all on function public.webhook_enqueue(bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.webhook_emit() from public, anon, authenticated;
revoke all on function public.webhook_tick() from public, anon, authenticated;
revoke all on function public.webhook_subscribe(bigint, text, text[], text) from public, anon;
revoke all on function public.webhook_send_test(bigint) from public, anon;
revoke all on function public.webhook_retry(bigint) from public, anon;
grant execute on function public.webhook_subscribe(bigint, text, text[], text) to authenticated;
grant execute on function public.webhook_send_test(bigint) to authenticated;
grant execute on function public.webhook_retry(bigint) to authenticated;
