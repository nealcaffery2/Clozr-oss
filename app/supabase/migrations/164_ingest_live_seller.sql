-- 164 · Ingest attaches a deal to the live seller, never an archived or merged one.
--
-- Jotform (and every other source through ingest_apply) matches a person by
-- phone. sellers_phone_uniq keeps that phone on an archived seller, so the
-- upsert attached the new deal to the archived row. Merges have no column:
-- the old seller is tagged merged-into-<id> (lib/people-stack.ts). The same
-- token in lead_stage or notes counts. resolve_live_seller follows it,
-- including a chain, and stops on a cycle, a missing target, a chain past
-- eight hops, or an archived seller with no pointer. Those rules are
-- lib/seller-match.ts. This file replaces functions only; it does not rewrite
-- deals or sellers already stored.

create or replace function public.seller_merged_into(p_tags text[], p_lead_stage text, p_notes text)
returns bigint
language sql
immutable
as $function$
  select (regexp_match(lower(s.blob), 'merged-into-([0-9]+)'))[1]::bigint
    from (
      select u.t as blob, u.ord
        from unnest(coalesce(p_tags, '{}'::text[])) with ordinality as u(t, ord)
      union all
      select p_lead_stage, 1000000::bigint where p_lead_stage is not null
      union all
      select p_notes, 1000001::bigint where p_notes is not null
    ) s
   where s.blob ~* 'merged-into-[0-9]+'
   order by s.ord
   limit 1;
$function$;

revoke all on function public.seller_merged_into(text[], text, text) from public, anon, authenticated;

create or replace function public.resolve_live_seller(p_workspace_id bigint, p_seller_id bigint)
returns bigint
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id   bigint := p_seller_id;
  v_seen bigint[] := '{}';
  v_row  public.sellers;
  v_next bigint;
begin
  if v_id is null then return null; end if;
  loop
    -- A repeated id is a cycle. Eight hops is the same cap as MERGE_HOP_LIMIT.
    if v_id is null or v_id = any (v_seen) or cardinality(v_seen) >= 8 then
      return null;
    end if;
    v_seen := v_seen || v_id;
    select * into v_row from public.sellers
     where id = v_id and workspace_id = p_workspace_id;
    if not found then return null; end if;
    v_next := public.seller_merged_into(v_row.tags, v_row.lead_stage, v_row.notes);
    -- Live, and not itself merged onward: this is the seller a deal may use.
    if v_row.archived_at is null and v_next is null then
      return v_row.id;
    end if;
    if v_next is null then
      return null;
    end if;
    v_id := v_next;
  end loop;
end
$function$;

revoke all on function public.resolve_live_seller(bigint, bigint) from public, anon, authenticated;
grant execute on function public.resolve_live_seller(bigint, bigint) to service_role;

-- ingest_apply (migration 7, plus the communication section from 12 and 29).
-- The person match is the change: phone, name, and phone-only all go through
-- resolve_live_seller. A phone held only by an archived seller with no live
-- target does not win the upsert, and the lead is not attached to that row.
create or replace function public.ingest_apply(p_workspace_id bigint, p_envelope jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_source    text := p_envelope->>'source';
  v_source_id text := p_envelope->>'source_id';
  v_type      text := coalesce(p_envelope->>'type', 'unknown');
  v_occurred  timestamptz := nullif(p_envelope->>'occurred_at', '')::timestamptz;

  prop  jsonb := p_envelope->'property';
  per   jsonb := p_envelope->'person';
  comm  jsonb := p_envelope->'communication';

  v_addr_key  text;
  v_phone_key text;
  v_comm_key  text;
  v_prop_id   bigint;
  v_seller_id bigint;
  v_found     bigint;
  v_comm_id   bigint;
  prior       public.ingest_events;
begin
  if v_source is null or v_source_id is null then
    raise exception 'source and source_id are required' using errcode = '22023';
  end if;

  select * into prior from public.ingest_events
   where workspace_id = p_workspace_id and source = v_source and source_id = v_source_id;
  if found then
    return jsonb_build_object(
      'status', prior.status, 'deduped', true, 'event_id', prior.id,
      'property_id', prior.property_id, 'seller_id', prior.seller_id,
      'communication_id', prior.communication_id,
      'address_key', prior.address_key, 'phone_key', prior.phone_key
    );
  end if;

  v_addr_key := public.address_key(
    prop->>'line1', prop->>'city', prop->>'state', prop->>'zip');
  v_phone_key := public.normalize_phone(
    coalesce(per->>'phone', comm->>'from_phone', comm->>'to_phone'));

  -- The conversation's own identity when the sender has one (a message id that
  -- several events share), the event's identity otherwise. Events stay deduped
  -- on the event id either way — this only decides which row they land on.
  v_comm_key := coalesce(nullif(comm->>'source_id', ''), v_source_id);

  -- ---- the house -------------------------------------------------------
  if v_addr_key is not null then
    insert into public.properties (
      workspace_id, line1, city, state, zip, apn,
      beds, baths, sqft, year_built, property_type, source, source_id)
    values (
      p_workspace_id, prop->>'line1', prop->>'city', prop->>'state', prop->>'zip', prop->>'apn',
      (prop->>'beds')::numeric, (prop->>'baths')::numeric, (prop->>'sqft')::integer,
      (prop->>'year_built')::integer, prop->>'property_type', v_source, v_source_id)
    on conflict (workspace_id, address_key) where address_key is not null
    do update set
      city          = coalesce(excluded.city,          properties.city),
      state         = coalesce(excluded.state,         properties.state),
      zip           = coalesce(excluded.zip,           properties.zip),
      apn           = coalesce(excluded.apn,           properties.apn),
      beds          = coalesce(excluded.beds,          properties.beds),
      baths         = coalesce(excluded.baths,         properties.baths),
      sqft          = coalesce(excluded.sqft,          properties.sqft),
      year_built    = coalesce(excluded.year_built,    properties.year_built),
      property_type = coalesce(excluded.property_type, properties.property_type)
    returning id into v_prop_id;
  end if;

  -- ---- the person ------------------------------------------------------
  -- Phone, name, and a phone with no name all resolve off an archived or
  -- merged seller. Fields still merge onto the live contact and never blank.
  if per is not null and nullif(per->>'name', '') is not null then
    if v_phone_key is not null then
      select id into v_found from public.sellers
       where workspace_id = p_workspace_id and phone_key = v_phone_key
       limit 1;
      v_seller_id := public.resolve_live_seller(p_workspace_id, v_found);
      if v_seller_id is null and v_found is null then
        begin
          insert into public.sellers (
            workspace_id, name, email, phone, property_address, asking_price,
            motivation, notes, property_id, source, source_id)
          values (
            p_workspace_id, per->>'name', per->>'email', per->>'phone',
            prop->>'line1', (p_envelope->'deal'->>'asking_price')::numeric,
            p_envelope->'deal'->>'motivation', p_envelope->'deal'->>'notes',
            v_prop_id, v_source, v_source_id)
          returning id into v_seller_id;
        exception when unique_violation then
          -- Lost a race with another insert of this phone. Attach only if
          -- that row resolves to a live seller.
          select id into v_found from public.sellers
           where workspace_id = p_workspace_id and phone_key = v_phone_key
           limit 1;
          v_seller_id := public.resolve_live_seller(p_workspace_id, v_found);
        end;
      end if;
      if v_seller_id is not null and v_found is not null then
        update public.sellers set
          name             = coalesce(nullif(per->>'name', ''), name),
          email            = coalesce(per->>'email', email),
          property_address = coalesce(prop->>'line1', property_address),
          asking_price     = coalesce((p_envelope->'deal'->>'asking_price')::numeric, asking_price),
          motivation       = coalesce(p_envelope->'deal'->>'motivation', motivation),
          property_id      = coalesce(v_prop_id, property_id)
         where id = v_seller_id and workspace_id = p_workspace_id;
      end if;
    else
      select id into v_found from public.sellers
       where workspace_id = p_workspace_id
         and property_id is not distinct from v_prop_id
         and lower(name) = lower(per->>'name')
       order by archived_at nulls first, id
       limit 1;
      v_seller_id := public.resolve_live_seller(p_workspace_id, v_found);
      if v_seller_id is null then
        insert into public.sellers (
          workspace_id, name, email, phone, property_address, asking_price,
          motivation, notes, property_id, source, source_id)
        values (
          p_workspace_id, per->>'name', per->>'email', per->>'phone',
          prop->>'line1', (p_envelope->'deal'->>'asking_price')::numeric,
          p_envelope->'deal'->>'motivation', p_envelope->'deal'->>'notes',
          v_prop_id, v_source, v_source_id)
        returning id into v_seller_id;
      end if;
    end if;
  elsif v_phone_key is not null then
    -- Match only. A call from an unrecognised number is a communication with
    -- no person attached, not a new lead. An archived match with no live
    -- target stays unattached.
    select id into v_found from public.sellers
     where workspace_id = p_workspace_id and phone_key = v_phone_key
     limit 1;
    v_seller_id := public.resolve_live_seller(p_workspace_id, v_found);
  end if;

  -- Fall back to the person's own property when the envelope named no address.
  if v_prop_id is null and v_seller_id is not null then
    select property_id into v_prop_id from public.sellers where id = v_seller_id;
  end if;

  -- ---- the conversation ------------------------------------------------
  if comm is not null and (comm->>'channel') is not null then
    insert into public.communications (
      workspace_id, property_id, seller_id, channel, direction, occurred_at,
      from_phone, to_phone, subject, body, summary, duration_s, recording_url,
      status, source, source_id)
    values (
      p_workspace_id, v_prop_id, v_seller_id, comm->>'channel', comm->>'direction',
      coalesce(nullif(comm->>'occurred_at','')::timestamptz, v_occurred, now()),
      public.normalize_phone(comm->>'from_phone'),
      public.normalize_phone(comm->>'to_phone'),
      comm->>'subject', comm->>'body', comm->>'summary',
      (comm->>'duration_s')::integer, comm->>'recording_url',
      nullif(comm->>'status', ''),
      v_source, v_comm_key)
    on conflict (workspace_id, source, source_id) do update set
      body          = coalesce(excluded.body,          communications.body),
      summary       = coalesce(excluded.summary,       communications.summary),
      recording_url = coalesce(excluded.recording_url, communications.recording_url),
      duration_s    = coalesce(excluded.duration_s,    communications.duration_s),
      seller_id     = coalesce(excluded.seller_id,     communications.seller_id),
      property_id   = coalesce(excluded.property_id,   communications.property_id),
      status        = case
                        when excluded.status is null then communications.status
                        when public.comm_status_rank(excluded.status)
                             >= public.comm_status_rank(communications.status)
                          then excluded.status
                        else communications.status
                      end
    returning id into v_comm_id;
  end if;

  insert into public.ingest_events (
    workspace_id, source, source_id, event_type, occurred_at, payload,
    address_key, phone_key, property_id, seller_id, communication_id, status)
  values (
    p_workspace_id, v_source, v_source_id, v_type, v_occurred, p_envelope,
    v_addr_key, v_phone_key, v_prop_id, v_seller_id, v_comm_id, 'applied');

  return jsonb_build_object(
    'status', 'applied', 'deduped', false,
    'property_id', v_prop_id, 'seller_id', v_seller_id, 'communication_id', v_comm_id,
    'address_key', v_addr_key, 'phone_key', v_phone_key
  );
end
$function$;

revoke all on function public.ingest_apply(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_apply(bigint, jsonb) to service_role;

-- ingest_apply_flat (132). The attach path (note / activity / email open)
-- used to take an archived seller when that was the only phone or email hit.
-- It now follows the same live-seller walk as ingest_apply. Lead and
-- wholesaler modes already use ingest_apply's seller id, so their deals do too.
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
  v_seller := public.resolve_live_seller(p_workspace_id, v_seller);
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
