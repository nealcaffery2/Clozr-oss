-- 132 · Podio and Jotform keep CLOZR up to date.
--
-- Podio (the original CRM) was brought over once, from an Excel
-- export of 2026-09-13 (tools/podio-excel-import.ts): every submission a deal
-- on its partner's contact (migration 49), keyed source_id
-- "submission:<address key>|<partner key>|<created>", and no Podio item id
-- anywhere. Every stage Podio has moved since is missing here. Jotform synced
-- new submissions only, so an edited submission never reached CLOZR either.
--
-- Podio live sync (podio-import, action `sync`, service role)
--   podio_connections   + sync_enabled (default on), last_sync_at (the last
--                         run that finished), last_sync_error, last_sync_notes
--                         (counts, unmapped stage labels, items that matched
--                         more than one record), sync_cursor (per app: the
--                         window and offset of a pass in progress, so a long
--                         backfill continues on the next tick) and
--                         sync_lock_until (one run at a time per workspace).
--   podio_items         the ledger: one row per Podio item the sync has seen —
--                         which deal / seller / property it is, how it was
--                         matched (item id, then the Excel import's address +
--                         partner key), its last_event_on (an unchanged item is
--                         skipped), the Podio stage label and whether CLOZR has
--                         a stage for it, and `applied`: the values the sync
--                         last wrote, so a CLOZR edit is only overwritten when
--                         the value changes in Podio again. Several submission
--                         items (a partner resubmitting an address) can point
--                         at one deal, which is why this is a table and not a
--                         column on deals. Members read; only the function writes.
--   podio_sync_kick()   POSTs {"action":"sync"} to podio-import when a
--                         connection has a Submissions or Deals app token;
--                         pg_cron `clozr-podio-sync` every ten minutes. Needs
--                         the vault secrets clozr_project_url and
--                         clozr_service_role_key (migration 110).
--   Stage moves go through the stage_events triggers (125) like any other
--   write, with changed_by null (System), plus the same activity rows the app
--   writes ("Stage → X" on a submission or seller, "Deal → X" on a deal).
--
-- Jotform edits
--   ingest_events.source_updated_at   the Jotform updated_at the ledger last
--                         applied for a submission; the five-minute sync reads
--                         the most recently updated submissions and re-applies
--                         the ones that moved past it.
--   ingest_envelope_diff(old, new)    what a re-sent envelope changes (person,
--                         property, deal, seller, intake, lead, buyer; empty
--                         values and the raw payload ignored).
--   ingest_patch_flat(ws, prior, env) the "Add new info" rule from the import
--                         screen (lib/import-dedupe.ts mergePatch): empty
--                         fields filled, nothing blanked or overwritten, tags
--                         only added, intake notes appended, links added; one
--                         "Submission edited" activity lists what changed.
--   ingest_apply_flat   a submission id already in the ledger whose content
--                         changed is patched ({updated: true}) instead of
--                         answering deduped. Unchanged re-sends and attach
--                         events still dedupe. Otherwise identical to 93.

-- ============================================================ Podio: connection state
alter table public.podio_connections
  add column if not exists sync_enabled    boolean not null default true,
  add column if not exists last_sync_at    timestamptz,
  add column if not exists last_sync_error text,
  add column if not exists last_sync_notes jsonb not null default '{}',
  add column if not exists sync_cursor     jsonb not null default '{}',
  add column if not exists sync_lock_until timestamptz;

-- ============================================================ Podio: the item ledger
create table if not exists public.podio_items (
  workspace_id   bigint not null,
  item_id        bigint not null,
  app_key        text   not null,
  app_id         bigint,
  deal_id        bigint,
  seller_id      bigint,
  property_id    bigint,
  matched_by     text,
  podio_stage    text,
  stage_unmapped boolean not null default false,
  created_on     timestamptz,
  last_event_on  timestamptz,
  applied        jsonb not null default '{}',
  note           text,
  first_seen_at  timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  primary key (workspace_id, item_id)
);
create index if not exists podio_items_deal_idx on public.podio_items (deal_id) where deal_id is not null;
create index if not exists podio_items_seller_idx on public.podio_items (seller_id) where seller_id is not null;
create index if not exists podio_items_unmapped_idx on public.podio_items (workspace_id, podio_stage) where stage_unmapped;

alter table public.podio_items enable row level security;
drop policy if exists podio_items_select on public.podio_items;
create policy podio_items_select on public.podio_items for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.podio_items from anon, authenticated;
grant select on public.podio_items to authenticated;

-- The Excel import's keys, looked up by prefix ("submission:<address>|…").
create index if not exists deals_podio_source_idx on public.deals (workspace_id, source_id text_pattern_ops)
  where source = 'podio';

-- ============================================================ Podio: the kick
create or replace function public.podio_sync_kick()
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_key text;
begin
  if not exists (
    select 1 from public.podio_connections c
     where c.sync_enabled and coalesce(c.client_id, '') <> '' and coalesce(c.client_secret, '') <> ''
       and exists (select 1 from jsonb_array_elements(c.apps) a
                    where a->>'key' in ('submissions', 'deals') and coalesce(a->>'app_token', '') <> '')
  ) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'clozr_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'clozr_service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/podio-import',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke execute on function public.podio_sync_kick() from public, anon, authenticated;

select cron.unschedule('clozr-podio-sync') where exists (select 1 from cron.job where jobname = 'clozr-podio-sync');
select cron.schedule('clozr-podio-sync', '3-53/10 * * * *', 'select public.podio_sync_kick()');

-- ============================================================ Jotform: edits
alter table public.ingest_events add column if not exists source_updated_at timestamptz;

create or replace function public.ingest_envelope_diff(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'section', s.sec, 'key', e.key,
           'from', coalesce(p_old, '{}'::jsonb) -> s.sec -> e.key, 'to', e.value) order by s.ord, e.key), '[]'::jsonb)
    from unnest(array['person', 'property', 'deal', 'seller', 'intake', 'lead', 'buyer']) with ordinality as s(sec, ord)
   cross join lateral jsonb_each(case when jsonb_typeof(p_new -> s.sec) = 'object' then p_new -> s.sec else '{}'::jsonb end) e
   where nullif(e.value #>> '{}', '') is not null
     and e.value not in ('[]'::jsonb, '{}'::jsonb)
     and e.value is distinct from (coalesce(p_old, '{}'::jsonb) -> s.sec -> e.key)
$$;
revoke all on function public.ingest_envelope_diff(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_envelope_diff(jsonb, jsonb) to service_role;

create or replace function public.ingest_patch_flat(p_workspace_id bigint, p_prior public.ingest_events, p_envelope jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source    text := p_envelope->>'source';
  v_source_id text := p_envelope->>'source_id';
  v_mode      text := p_envelope->>'mode';
  per   jsonb := coalesce(p_envelope->'person', '{}');
  b     jsonb := coalesce(p_envelope->'buyer', '{}');
  v_diff  jsonb := public.ingest_envelope_diff(p_prior.payload, p_envelope);
  v_tags  text[];
  v_seller bigint := p_prior.seller_id;
  v_buyer  bigint := p_prior.buyer_id;
  v_prop  bigint;
  v_deal  bigint;
  v_cur   jsonb;
  fresh   jsonb;
  v_note  text := nullif(p_envelope->'intake'->>'notes', '');
  v_phone text := nullif(per->>'phone', '');
  v_lines text;
  v_label text := case v_source when 'jotform' then 'Jotform' when 'zapier' then 'Zapier' else v_source end;
begin
  -- What changed, one line each, for the record's activity feed.
  select string_agg(
           initcap(replace(d->>'key', '_', ' ')) || ': ' || left(d->'to' #>> '{}', 300)
           || case when nullif(d->'from' #>> '{}', '') is not null then ' (was ' || left(d->'from' #>> '{}', 120) || ')' else '' end,
           E'\n')
    into v_lines
    from jsonb_array_elements(v_diff) d;

  if v_buyer is not null then
    select array_agg(distinct value) into v_tags from jsonb_array_elements_text(coalesce(b->'tags', '[]'::jsonb));
    update public.buyers set
      name    = coalesce(nullif(name, ''), nullif(b->>'name', '')),
      company = coalesce(nullif(company, ''), nullif(b->>'company', '')),
      email   = coalesce(email, lower(nullif(b->>'email', ''))),
      phone   = coalesce(phone, nullif(b->>'phone', '')),
      max_purchase_price = coalesce(max_purchase_price, public.disposition_num(b, 'max_purchase_price')),
      markets = case when jsonb_typeof(b->'markets') = 'array'
                     then coalesce(markets, '{}') || array(
                            select m from jsonb_array_elements_text(b->'markets') m
                             where lower(m) not in (select lower(x) from unnest(coalesce(markets, '{}'::text[])) x))
                     else markets end,
      tags    = case when v_tags is null then tags
                     else coalesce(tags, '{}') || array(
                            select t from unnest(v_tags) t
                             where lower(t) not in (select lower(x) from unnest(coalesce(tags, '{}'::text[])) x)) end,
      notes   = case when nullif(b->>'notes', '') is null or strpos(coalesce(notes, ''), b->>'notes') > 0 then notes
                     else concat_ws(E'\n', nullif(notes, ''), b->>'notes') end
     where id = v_buyer and workspace_id = p_workspace_id;
  elsif v_seller is not null then
    select array_agg(distinct value) into v_tags from jsonb_array_elements_text(coalesce(p_envelope->'lead'->'tags', '[]'::jsonb));
    if v_mode = 'wholesaler' then v_tags := coalesce(v_tags, '{}'::text[]) || array['Wholesaler']; end if;
    select coalesce(intake, '{}'::jsonb), property_id into v_cur, v_prop from public.sellers where id = v_seller;
    -- Intake keys the record has no value for; notes add to what is there.
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into fresh
      from jsonb_each(coalesce(p_envelope->'intake', '{}'::jsonb)) e
     where nullif(e.value #>> '{}', '') is not null
       and nullif(v_cur ->> e.key, '') is null;
    if v_note is not null and nullif(v_cur->>'notes', '') is not null and strpos(v_cur->>'notes', v_note) = 0 then
      fresh := fresh || jsonb_build_object('notes', (v_cur->>'notes') || E'\n' || v_note);
    end if;

    update public.sellers s set
      name   = coalesce(nullif(s.name, ''), nullif(per->>'name', '')),
      email  = coalesce(s.email, lower(nullif(per->>'email', ''))),
      -- A number another record already holds stays off this one (sellers_phone_uniq).
      phone  = case when s.phone is null and v_phone is not null and not exists (
                      select 1 from public.sellers o where o.workspace_id = s.workspace_id and o.id <> s.id
                         and o.phone_key = public.normalize_phone(v_phone))
                    then v_phone else s.phone end,
      occupancy     = coalesce(s.occupancy, nullif(p_envelope->'seller'->>'occupancy', '')),
      desired_close = coalesce(s.desired_close, nullif(p_envelope->'seller'->>'desired_close', '')),
      timeline      = coalesce(s.timeline, nullif(p_envelope->'seller'->>'timeline', '')),
      condition     = coalesce(s.condition, nullif(p_envelope->'seller'->>'condition', '')),
      motivation    = coalesce(s.motivation, nullif(p_envelope->'deal'->>'motivation', '')),
      asking_price  = coalesce(s.asking_price, public.disposition_num(p_envelope->'deal', 'asking_price')),
      tags   = case when v_tags is null then s.tags
                    else coalesce(s.tags, '{}') || array(
                           select t from unnest(v_tags) t
                            where lower(t) not in (select lower(x) from unnest(coalesce(s.tags, '{}'::text[])) x)) end,
      intake = coalesce(s.intake, '{}'::jsonb) || fresh
     where s.id = v_seller and s.workspace_id = p_workspace_id;

    if v_prop is not null then
      update public.properties set
        beds = coalesce(beds, public.disposition_num(p_envelope->'property', 'beds')),
        baths = coalesce(baths, public.disposition_num(p_envelope->'property', 'baths')),
        sqft = coalesce(sqft, trunc(public.disposition_num(p_envelope->'property', 'sqft'))::int),
        year_built = coalesce(year_built, trunc(public.disposition_num(p_envelope->'property', 'year_built'))::int),
        property_type = coalesce(property_type, nullif(p_envelope->'property'->>'property_type', ''))
       where id = v_prop;
    end if;

    select id into v_deal from public.deals
     where workspace_id = p_workspace_id and source = v_source and source_id = v_source_id
     order by id limit 1;
    if v_deal is not null then
      update public.deals set
        asking_price = coalesce(asking_price, public.disposition_num(p_envelope->'deal', 'asking_price')),
        motivation = coalesce(motivation, nullif(p_envelope->'deal'->>'motivation', '')),
        arv = coalesce(arv, public.disposition_num(p_envelope->'deal', 'arv')),
        rehab = coalesce(rehab, public.disposition_num(p_envelope->'deal', 'rehab')),
        garage_spaces = coalesce(garage_spaces, public.disposition_num(p_envelope->'deal', 'garage_spaces')),
        occupancy_notes = coalesce(occupancy_notes, nullif(p_envelope->'seller'->>'occupancy', ''))
       where id = v_deal;
      insert into public.deal_files (workspace_id, deal_id, kind, name, url, source)
      select p_workspace_id, v_deal, 'link', x.name, x.url, v_source
        from (values
          ('Photos', nullif(p_envelope->'intake'->>'photos', '')),
          ('Purchase contract', nullif(p_envelope->'intake'->>'contract', '')),
          ('Data tape', nullif(p_envelope->'intake'->>'data_tape', ''))
        ) as x(name, url)
       where x.url ~* '^https?://'
         and not exists (select 1 from public.deal_files f where f.deal_id = v_deal and f.url = x.url);
    end if;
  end if;

  if coalesce(v_seller, v_buyer) is not null and v_lines is not null then
    insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, occurred_at, external_id)
    values (p_workspace_id, case when v_buyer is not null then 'buyer' else 'seller' end, coalesce(v_buyer, v_seller),
            'note', 'Submission edited in ' || v_label, v_lines, now(),
            v_source || ':' || v_source_id || ':edit:' || md5(v_diff::text))
    on conflict (workspace_id, kind, external_id) do nothing;
  end if;

  -- The ledger keeps the latest content, so the next re-send compares with it.
  update public.ingest_events set payload = p_envelope
   where workspace_id = p_workspace_id and source = v_source and source_id = v_source_id;

  return jsonb_build_object('ok', true, 'deduped', false, 'updated', true, 'matched', coalesce(v_seller, v_buyer) is not null,
                            'id', coalesce(v_seller, v_buyer), 'kind', case when v_buyer is not null then 'buyer' else 'seller' end,
                            'deal_id', v_deal, 'changes', jsonb_array_length(v_diff));
end $$;
revoke all on function public.ingest_patch_flat(bigint, public.ingest_events, jsonb) from public, anon, authenticated;

-- ============================================================ ingest_apply_flat (93, plus the patch above)
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
  v_vendor bigint;
  v_prop   bigint;
  v_deal   bigint;
  v_company text;
  v_prospect boolean := false;
  r        jsonb;
  prior    public.ingest_events;
  fresh    jsonb;
begin
  if v_source is null or v_source_id is null or v_mode not in ('lead', 'buyer', 'wholesaler', 'attach') then
    raise exception 'source, source_id and mode are required' using errcode = '22023';
  end if;

  select * into prior from public.ingest_events
   where workspace_id = p_workspace_id and source = v_source and source_id = v_source_id;
  if found then
    -- Seen before. Unchanged (or an attach event) → deduped, as always. Changed
    -- (an edited Jotform submission re-posted or re-synced) → patched with the
    -- "Add new info" rule: ingest_patch_flat.
    if v_mode <> 'attach' and jsonb_array_length(public.ingest_envelope_diff(prior.payload, p_envelope)) > 0 then
      return public.ingest_patch_flat(p_workspace_id, prior, p_envelope);
    end if;
    return jsonb_build_object('ok', true, 'deduped', true, 'matched', true,
      'id', coalesce(prior.seller_id, prior.buyer_id),
      'kind', case when prior.buyer_id is not null then 'buyer' else 'seller' end);
  end if;

  -- A wholesaler key files the company on the Wholesalers list and, when the
  -- payload is a property, the same seller lead a seller key would.
  if v_mode = 'wholesaler' then
    v_phone := public.normalize_phone(per->>'phone');
    v_email := lower(nullif(per->>'email', ''));
    v_company := coalesce(nullif(p_envelope->'intake'->>'entity', ''), nullif(per->>'name', ''), v_email, per->>'phone');
    if v_company is not null then
      select id into v_vendor from public.vendors
       where workspace_id = p_workspace_id
         and service_type = 'Wholesaler'
         and (
           (v_email is not null and lower(email) = v_email)
           or (v_phone is not null and public.normalize_phone(phone) = v_phone)
           or lower(business_name) = lower(v_company)
         )
       order by id limit 1;
      if v_vendor is null then
        insert into public.vendors (workspace_id, business_name, contact_name, email, phone, service_type, source, source_id)
        values (p_workspace_id, v_company,
                case when nullif(per->>'name', '') is not null and per->>'name' <> v_company then per->>'name' else null end,
                v_email, nullif(per->>'phone', ''), 'Wholesaler', v_source, v_source_id)
        returning id into v_vendor;
      else
        update public.vendors set
          business_name = coalesce(nullif(business_name, ''), v_company),
          email = coalesce(email, v_email),
          phone = coalesce(phone, nullif(per->>'phone', ''))
         where id = v_vendor;
      end if;
    end if;
  end if;

  if v_mode in ('lead', 'wholesaler') then
    r := public.ingest_apply(p_workspace_id, p_envelope);
    v_seller := (r->>'seller_id')::bigint;
    v_prop := nullif(r->>'property_id', '')::bigint;
    if v_seller is not null then
      if v_prop is null then
        select property_id into v_prop from public.sellers where id = v_seller;
      end if;
      select array_agg(value) into v_tags from jsonb_array_elements_text(p_envelope->'lead'->'tags');
      if v_mode = 'wholesaler' then
        v_tags := coalesce(v_tags, '{}'::text[]) || array['Wholesaler'];
      end if;

      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into fresh
        from jsonb_each(coalesce(p_envelope->'intake', '{}'::jsonb)) e
       where nullif(e.value #>> '{}', '') is not null
         and nullif(coalesce((select s.intake from public.sellers s where s.id = v_seller), '{}'::jsonb) ->> e.key, '') is null;

      update public.sellers set
        lead_stage = coalesce(nullif(p_envelope->'lead'->>'stage', ''), lead_stage),
        tags       = case when v_tags is null then tags
                          else array(select distinct unnest(coalesce(tags, '{}') || v_tags)) end,
        email      = coalesce(email, nullif(per->>'email', '')),
        occupancy  = coalesce(occupancy, nullif(p_envelope->'seller'->>'occupancy', '')),
        desired_close = coalesce(desired_close, nullif(p_envelope->'seller'->>'desired_close', '')),
        timeline   = coalesce(timeline, nullif(p_envelope->'seller'->>'timeline', '')),
        condition  = coalesce(condition, nullif(p_envelope->'seller'->>'condition', '')),
        motivation = coalesce(motivation, nullif(p_envelope->'deal'->>'motivation', '')),
        asking_price = coalesce(asking_price, public.disposition_num(p_envelope->'deal', 'asking_price')),
        intake     = coalesce(intake, '{}'::jsonb) || coalesce(fresh, '{}'::jsonb)
       where id = v_seller;

      if v_prop is not null then
        update public.properties set
          beds = coalesce(beds, public.disposition_num(p_envelope->'property', 'beds')),
          baths = coalesce(baths, public.disposition_num(p_envelope->'property', 'baths')),
          sqft = coalesce(sqft, trunc(public.disposition_num(p_envelope->'property', 'sqft'))::int),
          year_built = coalesce(year_built, trunc(public.disposition_num(p_envelope->'property', 'year_built'))::int),
          property_type = coalesce(property_type, nullif(p_envelope->'property'->>'property_type', ''))
         where id = v_prop;
      end if;

      if v_prop is not null and (
           public.disposition_num(p_envelope->'deal', 'asking_price') is not null
        or public.disposition_num(p_envelope->'deal', 'arv') is not null
        or public.disposition_num(p_envelope->'deal', 'rehab') is not null
        or nullif(p_envelope->'property'->>'property_type', '') is not null
        or nullif(p_envelope->'intake'->>'photos', '') is not null
        or nullif(p_envelope->'intake'->>'garage', '') is not null
        or nullif(p_envelope->'intake'->>'disposition', '') is not null
        or nullif(p_envelope->'intake'->>'contract', '') is not null
        or nullif(p_envelope->'intake'->>'portfolio', '') is not null
      ) then
        select id into v_deal from public.deals
         where workspace_id = p_workspace_id and source = v_source and source_id = v_source_id
         order by id limit 1;
        if v_deal is null then
          insert into public.deals (workspace_id, property_id, seller_id, stage, source, source_id, submitted_at,
                                     asking_price, motivation, arv, rehab, garage_spaces, occupancy_notes)
          values (p_workspace_id, v_prop, v_seller, 'Prospect', v_source, v_source_id, coalesce(v_occurred, now()),
                  public.disposition_num(p_envelope->'deal', 'asking_price'),
                  nullif(p_envelope->'deal'->>'motivation', ''),
                  public.disposition_num(p_envelope->'deal', 'arv'),
                  public.disposition_num(p_envelope->'deal', 'rehab'),
                  public.disposition_num(p_envelope->'deal', 'garage_spaces'),
                  nullif(p_envelope->'seller'->>'occupancy', ''))
          returning id into v_deal;
        else
          update public.deals set
            seller_id = coalesce(seller_id, v_seller),
            asking_price = coalesce(asking_price, public.disposition_num(p_envelope->'deal', 'asking_price')),
            motivation = coalesce(motivation, nullif(p_envelope->'deal'->>'motivation', '')),
            arv = coalesce(arv, public.disposition_num(p_envelope->'deal', 'arv')),
            rehab = coalesce(rehab, public.disposition_num(p_envelope->'deal', 'rehab')),
            garage_spaces = coalesce(garage_spaces, public.disposition_num(p_envelope->'deal', 'garage_spaces')),
            occupancy_notes = coalesce(occupancy_notes, nullif(p_envelope->'seller'->>'occupancy', ''))
           where id = v_deal;
        end if;

        insert into public.deal_files (workspace_id, deal_id, kind, name, url, source)
        select p_workspace_id, v_deal, 'link', x.name, x.url, v_source
          from (values
            ('Photos', nullif(p_envelope->'intake'->>'photos', '')),
            ('Purchase contract', nullif(p_envelope->'intake'->>'contract', '')),
            ('Data tape', nullif(p_envelope->'intake'->>'data_tape', ''))
          ) as x(name, url)
         where x.url ~* '^https?://'
           and not exists (select 1 from public.deal_files f where f.deal_id = v_deal and f.url = x.url);

        if v_vendor is not null then
          insert into public.deal_parties (workspace_id, deal_id, role, vendor_id, company, email, phone, source, source_id)
          select p_workspace_id, v_deal, 'wholesaler', v_vendor, v_company, v_email, nullif(per->>'phone', ''), v_source, v_source_id
           where not exists (
             select 1 from public.deal_parties dp
              where dp.deal_id = v_deal and dp.role = 'wholesaler' and dp.vendor_id = v_vendor
           );
        end if;
      end if;

      if act is not null then
        insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, occurred_at, external_id)
        values (p_workspace_id, 'seller', v_seller, act->>'kind', act->>'title', act->>'body',
                coalesce(v_occurred, now()), v_source || ':' || v_source_id)
        on conflict (workspace_id, kind, external_id) do nothing;
      end if;
    end if;
    return jsonb_build_object('ok', true, 'deduped', false, 'matched', v_seller is not null,
                              'id', v_seller, 'kind', 'seller', 'vendor_id', v_vendor, 'deal_id', v_deal);
  end if;

  if v_mode = 'buyer' then
    v_phone := public.normalize_phone(b->>'phone');
    v_email := lower(nullif(b->>'email', ''));
    select id into v_buyer from public.buyers
     where workspace_id = p_workspace_id
       and ((v_phone is not null and phone_key = v_phone) or (v_email is not null and lower(email) = v_email))
     order by id limit 1;
    select array_agg(value) into v_tags from jsonb_array_elements_text(b->'tags');
    v_prospect := v_source in ('buyr', 'genius')
      or exists (
        select 1 from unnest(coalesce(v_tags, '{}'::text[])) t
        where lower(t) in ('buyer-prospect', 'capital-raise-prospect', 'fb-comment')
      );
    if v_prospect and not exists (
      select 1 from unnest(coalesce(v_tags, '{}'::text[])) t
      where lower(t) in ('buyer-prospect', 'capital-raise-prospect')
    ) then
      v_tags := coalesce(v_tags, '{}'::text[]) || array['buyer-prospect'];
    end if;
    if v_buyer is null then
      insert into public.buyers (workspace_id, name, company, email, phone, markets, max_purchase_price,
                                 notes, tags, source, source_id, status)
      values (p_workspace_id, coalesce(b->>'name', v_email, b->>'phone'), b->>'company', v_email, b->>'phone',
              (select array_agg(value) from jsonb_array_elements_text(b->'markets')),
              (b->>'max_purchase_price')::numeric, b->>'notes', v_tags, v_source, v_source_id,
              case when v_prospect then 'Prospect' else 'Active' end)
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
    return jsonb_build_object('ok', true, 'deduped', false, 'matched', true, 'id', v_buyer, 'kind', 'buyer',
                              'prospect', v_prospect);
  end if;

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
grant execute on function public.ingest_apply_flat(bigint, jsonb) to service_role;
