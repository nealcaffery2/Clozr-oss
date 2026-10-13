-- 204 · A submission from an archived contact brings it back instead of vanishing.
--
-- ingest_apply matches a named person by phone. When that phone belonged to a
-- seller someone had archived (not merged), resolve_live_seller (164) found no
-- live row, sellers_phone_uniq stopped a new one, and the event was recorded
-- "applied" with no seller and no deal. A partner's whole Jotform pipeline
-- hangs off one contact, so archiving it after one terminated deal silently
-- dropped every later submission. Now the archived, unmerged seller is
-- un-archived and takes the lead. A merged seller still resolves to its
-- target, and a broken merge chain still attaches nothing.
--
-- Repair: every lead/wholesaler event with a named person, no seller, and a
-- phone on an archived, unmerged seller is re-applied through
-- ingest_apply_flat (its ledger row is replaced). Round robin is not dealt
-- for these; the contact keeps the rep it had.

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
      -- 204: the phone is held by an archived seller that was not merged. A
      -- new submission brings that contact back; sellers_phone_uniq keeps the
      -- phone on the row, so no second seller can be made and the lead used
      -- to be dropped.
      if v_seller_id is null and v_found is not null then
        update public.sellers set archived_at = null
         where id = v_found and workspace_id = p_workspace_id
           and archived_at is not null
           and public.seller_merged_into(tags, lead_stage, notes) is null
        returning id into v_seller_id;
      end if;
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

-- ============================================================ repair
do $repair$
declare
  e record;
begin
  for e in
    select ev.id, ev.workspace_id, ev.payload
      from public.ingest_events ev
     where ev.seller_id is null
       and ev.payload->>'mode' in ('lead', 'wholesaler')
       and nullif(ev.payload->'person'->>'name', '') is not null
       and exists (
         select 1 from public.sellers s
          where s.workspace_id = ev.workspace_id and s.phone_key = ev.phone_key
            and s.archived_at is not null
            and public.seller_merged_into(s.tags, s.lead_stage, s.notes) is null)
     order by ev.id
  loop
    delete from public.ingest_events where id = e.id;
    perform public.ingest_apply_flat(e.workspace_id, e.payload);
  end loop;
end
$repair$;
