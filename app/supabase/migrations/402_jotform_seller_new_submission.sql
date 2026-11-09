-- 402: A wholesaler-key (Jotform) submission's seller starts at New Submission.
--
-- 387 put the deal on the Submissions lists, but the seller row ingest_apply
-- creates still started at Lead, so each Jotform submission also showed on the
-- Leads list (the Oct 19 batch). A partner contact already carries New
-- Submission (lib/submission-import.ts), so a wholesaler key now moves a seller
-- that is still at Lead / None to it. A seller already further along (a partner
-- who has sent before) keeps its stage. Same function otherwise, copied from 387.
-- Backfills wholesaler-tagged Jotform sellers still at Lead. Safe to re-run.

create or replace function public.ingest_apply_flat(p_workspace_id bigint, p_envelope jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
        -- 402: a wholesaler's seller row is a partner contact, not a lead.
        lead_stage = coalesce(nullif(p_envelope->'lead'->>'stage', ''),
                              case when v_mode = 'wholesaler' and coalesce(lead_stage, 'Lead') in ('Lead', 'None') then 'New Submission' end,
                              lead_stage),
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
          -- 387: a wholesaler's submission starts on the Submissions lists.
          insert into public.deals (workspace_id, property_id, seller_id, stage, lead_stage, source, source_id, submitted_at,
                                     asking_price, motivation, arv, rehab, garage_spaces, occupancy_notes)
          values (p_workspace_id, v_prop, v_seller, 'Prospect',
                  case when v_mode = 'wholesaler' then 'New Submission' end,
                  v_source, v_source_id, coalesce(v_occurred, now()),
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
        where lower(t) in ('buyer-prospect', 'compr-customer-prospect', 'capital-raise-prospect', 'fb-comment')
      );
    if v_prospect and not exists (
      select 1 from unnest(coalesce(v_tags, '{}'::text[])) t
      where lower(t) in ('buyer-prospect', 'compr-customer-prospect', 'capital-raise-prospect')
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
end $function$;


update public.sellers s set lead_stage = 'New Submission'
 where s.source = 'jotform' and s.lead_stage = 'Lead' and 'Wholesaler' = any(s.tags);
