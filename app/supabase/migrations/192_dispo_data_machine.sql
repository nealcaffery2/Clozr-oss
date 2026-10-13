-- 192 · The dispo data machine: a wholesaler and buyer entity database fed
--       by the dispo Drive's contracts, every found buyer labelled with the
--       method that found them, and a campaign that can also drop a ringless
--       voicemail and place an AI call on schedule.
--
-- 1. wholesaler_entities / wholesaler_deals. Every LLC on an assignment in
--    the Dispositions Drive, as assignor (the wholesaler) or assignee (the
--    end buyer), with the person who signed, their email and phone from the
--    PandaDoc block, the price, the fee and the title company. An alias row
--    (an LLC a brokerage assigns through) points at its parent (the
--    brokerage) through parent_id, so "their top buyers" counts the whole
--    family. wholesaler_top_buyers ranks assignees per wholesaler family.
-- 2. buyers.found_via / found_evidence: how Genius found the buyer and what
--    it saw (the flip it verified from photos, the deed chain it followed).
--    discover_runs.methods: which methods a run asked for.
-- 3. genius_credit_log.kind grows vision / deeds / scrape (the Homefull photo
--    check, the county deed search, the landlord scrape).
-- 4. dispo_campaign_messages.channel grows rvm and ai_call, and
--    dispo_campaign_launch accepts them: the tick hands an rvm row to
--    rvm_drops at its send time and an ai_call row to the ai-agent's
--    deal_call. Both honour only_if_no_reply like a follow-up.
-- 5. dispo_campaign_presets: the "machine" recipes the one-screen builder
--    offers (Quick blast, Full machine, Email only); a workspace can add its
--    own. dispo_contract_sync: the Drive contract harvester's state and its
--    nightly kick.

-- 1 · entities ---------------------------------------------------------------
create table if not exists public.wholesaler_entities (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces(id) on delete cascade,
  name          text not null,
  name_key      text not null,
  parent_id     bigint references public.wholesaler_entities(id) on delete set null,
  kind          text not null default 'unknown' check (kind in ('wholesaler', 'buyer', 'both', 'title', 'unknown')),
  state         text,
  county        text,
  contact_name  text,
  email         text,
  phone         text,
  website       text,
  source        text not null default 'manual' check (source in ('drive', 'deed', 'manual', 'genius', 'contract')),
  first_seen    date,
  last_seen     date,
  deals         integer not null default 0,
  buyer_id      bigint references public.buyers(id) on delete set null,
  vendor_id     bigint references public.vendors(id) on delete set null,
  notes         text,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, name_key)
);
create index if not exists wholesaler_entities_parent_idx on public.wholesaler_entities (workspace_id, parent_id);
create index if not exists wholesaler_entities_state_idx on public.wholesaler_entities (workspace_id, state, kind);

create table if not exists public.wholesaler_deals (
  id                bigint generated always as identity primary key,
  workspace_id      bigint not null references public.workspaces(id) on delete cascade,
  assignor_id       bigint references public.wholesaler_entities(id) on delete set null,
  assignee_id       bigint references public.wholesaler_entities(id) on delete set null,
  assignor_name     text,
  assignee_name     text,
  assignee_person   text,
  assignee_email    text,
  assignee_phone    text,
  assignor_person   text,
  assignor_email    text,
  assignor_phone    text,
  property_address  text,
  city              text,
  state             text,
  zip               text,
  county            text,
  purchase_price    numeric,
  assignment_fee    numeric,
  total_price       numeric,
  contract_date     date,
  closing_date      date,
  title_company     text,
  leg               text not null default 'unknown' check (leg in ('AB', 'BC', 'AA', 'deed', 'unknown')),
  source            text not null default 'drive' check (source in ('drive', 'deed', 'manual')),
  source_id         text not null,
  source_url        text,
  deal_id           bigint references public.deals(id) on delete set null,
  raw               jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  unique (workspace_id, source, source_id)
);
create index if not exists wholesaler_deals_assignor_idx on public.wholesaler_deals (workspace_id, assignor_id);
create index if not exists wholesaler_deals_assignee_idx on public.wholesaler_deals (workspace_id, assignee_id);
create index if not exists wholesaler_deals_state_idx on public.wholesaler_deals (workspace_id, state, county);

-- The family an entity belongs to: itself, or its parent (one level is enough; aliases point at the root).
create or replace function public.wholesaler_root(p_id bigint)
returns bigint language sql stable as $$
  select coalesce(e.parent_id, e.id) from public.wholesaler_entities e where e.id = p_id
$$;

-- Who each wholesaler family sells to, most often first. Proximity is the caller's job (the state and county are on the row).
create or replace view public.wholesaler_top_buyers as
select d.workspace_id,
       public.wholesaler_root(d.assignor_id) as wholesaler_id,
       public.wholesaler_root(d.assignee_id) as buyer_id,
       count(*)::integer as deals,
       max(coalesce(d.closing_date, d.contract_date)) as last_deal,
       sum(coalesce(d.total_price, d.purchase_price))::numeric as volume,
       array_agg(distinct d.state) filter (where d.state is not null) as states,
       array_agg(distinct d.county) filter (where d.county is not null) as counties
  from public.wholesaler_deals d
 where d.assignor_id is not null and d.assignee_id is not null
 group by d.workspace_id, public.wholesaler_root(d.assignor_id), public.wholesaler_root(d.assignee_id);

alter table public.wholesaler_entities enable row level security;
alter table public.wholesaler_deals enable row level security;
drop policy if exists wholesaler_entities_select on public.wholesaler_entities;
create policy wholesaler_entities_select on public.wholesaler_entities for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));
drop policy if exists wholesaler_entities_write on public.wholesaler_entities;
create policy wholesaler_entities_write on public.wholesaler_entities for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'));
drop policy if exists wholesaler_deals_select on public.wholesaler_deals;
create policy wholesaler_deals_select on public.wholesaler_deals for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));
drop policy if exists wholesaler_deals_write on public.wholesaler_deals;
create policy wholesaler_deals_write on public.wholesaler_deals for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'))
  with check (public.has_role(workspace_id, 'owner', 'admin', 'dispositions'));

create or replace function public.touch_wholesaler_entity() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists wholesaler_entities_touch on public.wholesaler_entities;
create trigger wholesaler_entities_touch before update on public.wholesaler_entities
  for each row execute function public.touch_wholesaler_entity();

-- Deal counts and first/last seen follow the deals table.
create or replace function public.wholesaler_entity_recount() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare ids bigint[];
begin
  ids := array_remove(array[coalesce(new.assignor_id, old.assignor_id), coalesce(new.assignee_id, old.assignee_id), old.assignor_id, old.assignee_id], null);
  update public.wholesaler_entities e set
    deals = (select count(*) from public.wholesaler_deals d where d.assignor_id = e.id or d.assignee_id = e.id),
    first_seen = (select min(coalesce(d.contract_date, d.closing_date)) from public.wholesaler_deals d where d.assignor_id = e.id or d.assignee_id = e.id),
    last_seen = (select max(coalesce(d.closing_date, d.contract_date)) from public.wholesaler_deals d where d.assignor_id = e.id or d.assignee_id = e.id),
    kind = case
      when exists (select 1 from public.wholesaler_deals d where d.assignor_id = e.id) and exists (select 1 from public.wholesaler_deals d where d.assignee_id = e.id) then 'both'
      when exists (select 1 from public.wholesaler_deals d where d.assignor_id = e.id) then 'wholesaler'
      when exists (select 1 from public.wholesaler_deals d where d.assignee_id = e.id) then 'buyer'
      else e.kind end
  where e.id = any (ids);
  return null;
end $$;
drop trigger if exists wholesaler_deals_recount on public.wholesaler_deals;
create trigger wholesaler_deals_recount after insert or update or delete on public.wholesaler_deals
  for each row execute function public.wholesaler_entity_recount();

-- 2 · how a buyer was found -------------------------------------------------
alter table public.buyers add column if not exists found_via text;
alter table public.buyers add column if not exists found_evidence jsonb;
create index if not exists buyers_found_via_idx on public.buyers (workspace_id, found_via) where found_via is not null;
alter table public.discover_runs add column if not exists methods text[] not null default '{}';

-- 3 · what a method costs ---------------------------------------------------
alter table public.genius_credit_log drop constraint if exists genius_credit_log_kind_check;
alter table public.genius_credit_log add constraint genius_credit_log_kind_check
  check (kind in ('search', 'detail', 'skiptrace', 'count', 'vision', 'deeds', 'scrape'));

-- 4 · rvm and ai_call on a campaign ------------------------------------------
alter table public.dispo_campaign_messages drop constraint if exists dispo_campaign_messages_channel_check;
alter table public.dispo_campaign_messages add constraint dispo_campaign_messages_channel_check
  check (channel in ('sms', 'email', 'rvm', 'ai_call'));
alter table public.dispo_campaign_messages add column if not exists rvm_drop_id bigint references public.rvm_drops(id) on delete set null;
alter table public.dispo_campaign_messages add column if not exists conversation_id text;

create or replace function public.dispo_campaign_launch(
  p_workspace_id bigint, p_deal_id bigint, p_settings jsonb, p_delivery jsonb, p_recipients jsonb
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_campaign bigint; v_account bigint := nullif(p_delivery->>'email_account_id', '')::bigint;
  v_provider text := coalesce(nullif(p_delivery->>'email_provider', ''), 'gmail');
  v_sender bigint := nullif(p_delivery->>'email_sender_id', '')::bigint;
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
  if v_provider not in ('resend', 'gmail') then
    raise exception 'email_provider must be resend or gmail' using errcode = '22023';
  end if;
  if v_account is not null and not exists (
    select 1 from public.google_accounts a where a.id = v_account and a.workspace_id = p_workspace_id
       and a.status = 'active' and a.gmail_send
       and (a.user_id = auth.uid() or public.has_role(p_workspace_id, 'owner', 'admin'))
  ) then
    raise exception 'that Gmail account cannot send for you' using errcode = '42501';
  end if;
  if v_provider = 'resend' then
    if v_sender is null then
      select id into v_sender from public.email_senders
       where workspace_id = p_workspace_id and provider = 'resend' and active
       order by id limit 1;
    elsif not exists (
      select 1 from public.email_senders s
       where s.id = v_sender and s.workspace_id = p_workspace_id and s.provider = 'resend' and s.active
    ) then
      raise exception 'that Resend sender is not available' using errcode = '22023';
    end if;
  end if;

  insert into public.dispo_campaigns (workspace_id, deal_id, created_by, settings, timezone, from_phone_number_id, from_phone, email_account_id, email_provider, email_sender_id, from_name, starts_at)
  values (p_workspace_id, p_deal_id, auth.uid(), coalesce(p_settings, '{}'::jsonb),
          coalesce(nullif(p_delivery->>'timezone', ''), 'America/Chicago'),
          nullif(p_delivery->>'from_phone_number_id', ''), nullif(p_delivery->>'from_phone', ''), v_account,
          v_provider, v_sender,
          left(nullif(regexp_replace(coalesce(p_delivery->>'from_name', ''), '[\r\n<>"]', '', 'g'), ''), 80),
          greatest(now(), coalesce((p_delivery->>'starts_at')::timestamptz, now())))
  returning id into v_campaign;

  for r in select * from jsonb_array_elements(p_recipients) loop
    select id, phone, email, preferred_channel, wants_follow_ups, wants_calls, blacklisted_at, status into b
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
      continue when v_channel not in ('sms', 'email', 'rvm', 'ai_call') or v_kind not in ('intro', 'brief', 'followup');
      continue when v_channel = 'sms' and (nullif(b.phone, '') is null or b.preferred_channel = 'email_only' or length(coalesce(m->>'body', '')) > 1600);
      -- A voicemail or a call needs a number and a buyer who takes calls; "email only" rules both out.
      continue when v_channel in ('rvm', 'ai_call') and (nullif(b.phone, '') is null or b.preferred_channel = 'email_only' or coalesce(b.wants_calls, true) = false);
      continue when v_channel = 'email' and (
        nullif(b.email, '') is null
        or b.preferred_channel = 'sms_only'
        or (v_provider = 'gmail' and v_account is null)
        or (v_provider = 'resend' and v_sender is null)
        or nullif(trim(coalesce(m->>'subject', '')), '') is null
      );
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

-- 5 · presets and the contract harvester --------------------------------------
create table if not exists public.dispo_campaign_presets (
  id            bigint generated always as identity primary key,
  workspace_id  bigint references public.workspaces(id) on delete cascade,
  key           text not null,
  name          text not null,
  blurb         text not null default '',
  steps         jsonb not null default '[]'::jsonb,
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint dispo_campaign_presets_steps_is_array check (jsonb_typeof(steps) = 'array')
);
create unique index if not exists dispo_campaign_presets_key_idx on public.dispo_campaign_presets (coalesce(workspace_id, 0), key);
alter table public.dispo_campaign_presets enable row level security;
drop policy if exists dispo_campaign_presets_select on public.dispo_campaign_presets;
create policy dispo_campaign_presets_select on public.dispo_campaign_presets for select to authenticated
  using (workspace_id is null or workspace_id in (select public.my_workspace_ids()));
drop policy if exists dispo_campaign_presets_write on public.dispo_campaign_presets;
create policy dispo_campaign_presets_write on public.dispo_campaign_presets for all to authenticated
  using (workspace_id is not null and public.has_role(workspace_id, 'owner', 'admin', 'dispositions'))
  with check (workspace_id is not null and public.has_role(workspace_id, 'owner', 'admin', 'dispositions'));

-- A step: channel, kind, when (hours after the step before), only_if_no_reply.
insert into public.dispo_campaign_presets (workspace_id, key, name, blurb, steps, position) values
  (null, 'machine', 'Full machine', 'Text, email, voicemail and an AI call over four days. Stops the moment they reply.',
   '[{"channel":"sms","kind":"intro","after_hours":0},{"channel":"email","kind":"brief","after_hours":0.1},{"channel":"sms","kind":"brief","after_hours":1},{"channel":"rvm","kind":"brief","after_hours":3,"only_if_no_reply":true},{"channel":"sms","kind":"followup","after_hours":22,"only_if_no_reply":true},{"channel":"ai_call","kind":"followup","after_hours":26,"only_if_no_reply":true},{"channel":"email","kind":"followup","after_hours":48,"only_if_no_reply":true}]'::jsonb, 0),
  (null, 'blast', 'Quick blast', 'One text and one email now, one text follow-up tomorrow.',
   '[{"channel":"sms","kind":"brief","after_hours":0},{"channel":"email","kind":"brief","after_hours":0.1},{"channel":"sms","kind":"followup","after_hours":24,"only_if_no_reply":true}]'::jsonb, 1),
  (null, 'email', 'Email only', 'The deal by email, then one follow-up email after two days.',
   '[{"channel":"email","kind":"brief","after_hours":0},{"channel":"email","kind":"followup","after_hours":48,"only_if_no_reply":true}]'::jsonb, 2),
  (null, 'calls', 'Voice first', 'Voicemail now, AI call after an hour, text the link, email the details.',
   '[{"channel":"rvm","kind":"brief","after_hours":0},{"channel":"ai_call","kind":"brief","after_hours":1,"only_if_no_reply":true},{"channel":"sms","kind":"brief","after_hours":1.5,"only_if_no_reply":true},{"channel":"email","kind":"brief","after_hours":2}]'::jsonb, 3)
on conflict do nothing;

create table if not exists public.dispo_contract_sync (
  workspace_id    bigint primary key references public.workspaces(id) on delete cascade,
  account_id      bigint references public.google_accounts(id) on delete set null,
  root_folder_id  text not null,
  root_name       text,
  enabled         boolean not null default true,
  state           jsonb not null default '{}'::jsonb,
  files_seen      integer not null default 0,
  contracts_read  integer not null default 0,
  last_run_at     timestamptz,
  last_error      text,
  last_notes      jsonb,
  lock_until      timestamptz,
  updated_at      timestamptz not null default now()
);
alter table public.dispo_contract_sync enable row level security;
drop policy if exists dispo_contract_sync_select on public.dispo_contract_sync;
create policy dispo_contract_sync_select on public.dispo_contract_sync for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));

create or replace function public.dispo_contracts_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.dispo_contract_sync where enabled and account_id is not null) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/dispo-contracts',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"harvest"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.dispo_contracts_kick() from public, anon, authenticated;

select cron.unschedule('clozr-dispo-contracts') where exists (select 1 from cron.job where jobname = 'clozr-dispo-contracts');
-- Nightly at 02:20 UTC, and every 20 minutes while a harvest is mid-tree (the function stops itself when there is nothing queued).
select cron.schedule('clozr-dispo-contracts', '20 2,8,14,20 * * *', 'select public.dispo_contracts_kick()');

-- 6 · (removed in the open-source release: seed rows for one production
-- workspace's wholesalers, deals and Drive folder) -------------------------
