-- Buyer prospects stay off the real buyer list and off deal matching.
--
-- Genius, buyr and Facebook comment captures insert with status Prospect and
-- a list tag (buyer-prospect, capital-raise-prospect).
-- match_deal / match_buyer skip that status, so a blast cannot pick them up
-- until someone vets them onto Active. Re-submitting a buyer who is already
-- on the list does not demote them.

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
  v_prospect boolean := false;
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

-- Same bodies as migration 61, with Prospect excluded alongside Inactive.
create or replace function public.match_deal(p_deal_id bigint, p_min integer default 55)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  d record; b record; sc record; n integer := 0; price numeric;
begin
  select dl.id, dl.workspace_id, dl.arv, dl.offer_amount, dl.assignment_fee, dl.sold_price,
         p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft, p.year_built, p.property_type, p.condition, p.attributes
  into d
  from public.deals dl left join public.properties p on p.id = dl.property_id
  where dl.id = p_deal_id;
  if d.id is null then return 0; end if;
  price := coalesce(d.sold_price, d.offer_amount + coalesce(d.assignment_fee, 0), d.offer_amount);
  for b in select id, criteria, vetted_at from public.buyers
           where workspace_id = d.workspace_id and blacklisted_at is null
             and lower(coalesce(status,'')) not in ('inactive', 'prospect')
  loop
    select * into sc from public.score_buyer_deal(b.criteria, price, d.arv, d.city, d.state, d.zip, d.county, d.beds, d.baths, d.sqft, d.year_built, d.property_type, d.condition, coalesce(d.attributes, '{}'));
    if sc.score >= p_min then
      insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons)
      values (d.workspace_id, d.id, b.id, sc.score, sc.reasons)
      on conflict (deal_id, buyer_id) do update set score = excluded.score, reasons = excluded.reasons, updated_at = now();
      n := n + 1;
    else
      delete from public.deal_buyer_matches where deal_id = d.id and buyer_id = b.id and status = 'matched';
    end if;
  end loop;
  delete from public.deal_buyer_matches dbm
  where dbm.deal_id = d.id and dbm.status = 'matched'
    and not exists (
      select 1 from public.buyers bb
      where bb.id = dbm.buyer_id and bb.workspace_id = d.workspace_id
        and bb.blacklisted_at is null and lower(coalesce(bb.status,'')) not in ('inactive', 'prospect')
    );
  return n;
end $$;

create or replace function public.match_buyer(p_buyer_id bigint, p_min integer default 55)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  b record; d record; sc record; n integer := 0; price numeric;
begin
  select id, workspace_id, criteria, blacklisted_at, status into b from public.buyers where id = p_buyer_id;
  if b.id is null or b.blacklisted_at is not null then return 0; end if;
  if lower(coalesce(b.status, '')) in ('inactive', 'prospect') then return 0; end if;
  for d in select dl.id, dl.arv, dl.offer_amount, dl.assignment_fee, dl.sold_price,
                  p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft, p.year_built, p.property_type, p.condition, p.attributes
           from public.deals dl join public.deal_stages st on st.label = dl.stage
           left join public.properties p on p.id = dl.property_id
           where dl.workspace_id = b.workspace_id and st.active_inventory
           order by dl.created_at desc limit 200
  loop
    price := coalesce(d.sold_price, d.offer_amount + coalesce(d.assignment_fee, 0), d.offer_amount);
    select * into sc from public.score_buyer_deal(b.criteria, price, d.arv, d.city, d.state, d.zip, d.county, d.beds, d.baths, d.sqft, d.year_built, d.property_type, d.condition, coalesce(d.attributes, '{}'));
    if sc.score >= p_min then
      insert into public.deal_buyer_matches (workspace_id, deal_id, buyer_id, score, reasons)
      values (b.workspace_id, d.id, b.id, sc.score, sc.reasons)
      on conflict (deal_id, buyer_id) do update set score = excluded.score, reasons = excluded.reasons, updated_at = now();
      n := n + 1;
    else
      delete from public.deal_buyer_matches where deal_id = d.id and buyer_id = b.id and status = 'matched';
    end if;
  end loop;
  return n;
end $$;

grant execute on function public.match_deal(bigint, integer) to authenticated, service_role;
grant execute on function public.match_buyer(bigint, integer) to authenticated, service_role;
