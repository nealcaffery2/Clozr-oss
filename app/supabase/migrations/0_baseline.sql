-- 0_baseline: the schema migrations 1–22 and 29–32 created, plus the tables,
-- functions and policies the live project gained outside any committed file.
-- Those files were never committed, so this is regenerated from the database
-- catalog. It runs first (number 0) and is safe to re-run: every statement is
-- create-if-missing, create-or-replace or guarded. Columns, constraints,
-- indexes and triggers that a later file adds are left to that file, so each
-- later file meets the schema it was written against; what no file covers is
-- restored in 258_baseline_tail. Policies are the live ones: later files alter
-- them in place.
--
-- Needs, like everything else in this folder, the Supabase platform schemas
-- (auth, storage, vault, extensions).

set check_function_bodies = off;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------- functions

CREATE OR REPLACE FUNCTION public.address_key(p_line1 text, p_city text, p_state text, p_zip text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when public.normalize_address(p_line1) is null then null
    when nullif(regexp_replace(coalesce(p_zip, ''), '[^0-9]', '', 'g'), '') is not null
      then public.normalize_address(p_line1) || '|' ||
           left(regexp_replace(p_zip, '[^0-9]', '', 'g'), 5)
    else public.normalize_address(p_line1) || '|' ||
         upper(coalesce(p_state, '')) || '|' || upper(coalesce(p_city, ''))
  end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_buyer_parsed_fields(p_buyer_id bigint, p_extra jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_extra IS NULL OR p_extra = '{}'::jsonb THEN
    RETURN;
  END IF;

  UPDATE public.buyers SET
    source_id = COALESCE(NULLIF(p_extra->>'source_id',''), source_id),
    source = COALESCE(NULLIF(p_extra->>'source',''), source),
    buyer_type = COALESCE(NULLIF(p_extra->>'buyer_type',''), buyer_type),
    vip = COALESCE((p_extra->>'vip')::boolean, vip),
    website = CASE WHEN p_extra ? 'website' THEN NULLIF(p_extra->>'website','') ELSE website END,
    tags = CASE WHEN p_extra ? 'tags' THEN public.text_array_from_jsonb(p_extra->'tags') ELSE tags END,
    min_purchase_price = CASE WHEN p_extra ? 'min_purchase_price' THEN NULLIF(p_extra->>'min_purchase_price','')::numeric ELSE min_purchase_price END,
    max_purchase_price = CASE WHEN p_extra ? 'max_purchase_price' THEN NULLIF(p_extra->>'max_purchase_price','')::numeric ELSE max_purchase_price END,
    beds_min = CASE WHEN p_extra ? 'beds_min' THEN NULLIF(p_extra->>'beds_min','')::smallint ELSE beds_min END,
    beds_max = CASE WHEN p_extra ? 'beds_max' THEN NULLIF(p_extra->>'beds_max','')::smallint ELSE beds_max END,
    baths_min = CASE WHEN p_extra ? 'baths_min' THEN NULLIF(p_extra->>'baths_min','')::numeric ELSE baths_min END,
    baths_max = CASE WHEN p_extra ? 'baths_max' THEN NULLIF(p_extra->>'baths_max','')::numeric ELSE baths_max END,
    sqft_min = CASE WHEN p_extra ? 'sqft_min' THEN NULLIF(p_extra->>'sqft_min','')::integer ELSE sqft_min END,
    sqft_max = CASE WHEN p_extra ? 'sqft_max' THEN NULLIF(p_extra->>'sqft_max','')::integer ELSE sqft_max END,
    year_built_min = CASE WHEN p_extra ? 'year_built_min' THEN NULLIF(p_extra->>'year_built_min','')::integer ELSE year_built_min END,
    year_built_max = CASE WHEN p_extra ? 'year_built_max' THEN NULLIF(p_extra->>'year_built_max','')::integer ELSE year_built_max END,
    acreage_min = CASE WHEN p_extra ? 'acreage_min' THEN NULLIF(p_extra->>'acreage_min','')::numeric ELSE acreage_min END,
    acreage_max = CASE WHEN p_extra ? 'acreage_max' THEN NULLIF(p_extra->>'acreage_max','')::numeric ELSE acreage_max END,
    property_types = CASE WHEN p_extra ? 'property_types' THEN public.text_array_from_jsonb(p_extra->'property_types') ELSE property_types END,
    strategy_types = CASE WHEN p_extra ? 'strategy_types' THEN public.text_array_from_jsonb(p_extra->'strategy_types') ELSE strategy_types END,
    financing_types = CASE WHEN p_extra ? 'financing_types' THEN public.text_array_from_jsonb(p_extra->'financing_types') ELSE financing_types END,
    rehab_avoided = CASE WHEN p_extra ? 'rehab_avoided' THEN public.text_array_from_jsonb(p_extra->'rehab_avoided') ELSE rehab_avoided END,
    restrictions = CASE WHEN p_extra ? 'restrictions' THEN public.text_array_from_jsonb(p_extra->'restrictions') ELSE restrictions END,
    requirements = CASE WHEN p_extra ? 'requirements' THEN public.text_array_from_jsonb(p_extra->'requirements') ELSE requirements END,
    strict_fields = CASE WHEN p_extra ? 'strict_fields' THEN public.text_array_from_jsonb(p_extra->'strict_fields') ELSE strict_fields END,
    preferred_channel = CASE WHEN p_extra ? 'preferred_channel' THEN NULLIF(p_extra->>'preferred_channel','') ELSE preferred_channel END,
    wants_follow_ups = COALESCE((p_extra->>'wants_follow_ups')::boolean, wants_follow_ups),
    wants_sold_alerts = COALESCE((p_extra->>'wants_sold_alerts')::boolean, wants_sold_alerts),
    notes = CASE WHEN NULLIF(p_extra->>'notes','') IS NOT NULL THEN p_extra->>'notes' ELSE notes END,
    status = COALESCE(NULLIF(p_extra->>'status',''), status),
    blacklisted_at = CASE
      WHEN COALESCE((p_extra->>'blacklisted')::boolean, false) THEN COALESCE(blacklisted_at, now())
      ELSE blacklisted_at
    END,
    updated_at = now()
  WHERE id = p_buyer_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_buy_box_submission(p_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s record; v_buyer bigint;
begin
  select * into s from public.buy_box_submissions where id = p_id;
  if not found then raise exception 'submission % not found', p_id; end if;
  if s.buyer_id is not null then return s.buyer_id; end if;

  v_buyer := public.create_buyer_entity(
    s.workspace_id, s.contact_name, s.company, s.email, s.phone, s.markets,
    'buy_box_link', 3,
    jsonb_build_object('buyer_type', s.buyer_type, 'entity_type', s.entity_type, 'website', s.website));

  update public.buy_box_submissions
     set status = 'approved', buyer_id = v_buyer, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = p_id;
  return v_buyer;
end $function$;

CREATE OR REPLACE FUNCTION public.build_match_snapshot(p_deal_id bigint, p_min integer DEFAULT 55, p_rematch boolean DEFAULT true)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_ws bigint; v_snap bigint; v_n integer;
begin
  select workspace_id into v_ws from public.deals where id = p_deal_id;
  if v_ws is null then raise exception 'deal % not found', p_deal_id; end if;

  if p_rematch then perform public.match_deal(p_deal_id, p_min); end if;

  insert into public.dispo_match_snapshots (workspace_id, deal_id, min_score, created_by)
  values (v_ws, p_deal_id, p_min, auth.uid())
  returning id into v_snap;

  insert into public.dispo_match_snapshot_rows (workspace_id, snapshot_id, buyer_id, score, reasons, level)
  select v_ws, v_snap, m.buyer_id, m.score, m.reasons, b.level
  from public.deal_buyer_matches m
  join public.buyers b on b.id = m.buyer_id
  where m.deal_id = p_deal_id and m.score >= p_min;
  get diagnostics v_n = row_count;

  update public.dispo_match_snapshots set buyer_count = v_n, updated_at = now() where id = v_snap;
  return v_snap;
end $function$;

CREATE OR REPLACE FUNCTION public.buy_box_form(p_slug text)
 RETURNS TABLE(slug text, name text, headline text, intro text, branding jsonb, template jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select l.slug, l.name, l.headline, l.intro, l.branding,
         case when t.id is null then '{}'::jsonb else to_jsonb(t) - 'workspace_id' - 'created_by' - 'id' end
  from public.buy_box_links l
  left join public.buy_box_templates t on t.id = l.template_id
  where l.slug = p_slug
    and l.active
    and (l.expires_at is null or l.expires_at > now());
$function$;

CREATE OR REPLACE FUNCTION public.buyer_radius_hit(p_buyer_id bigint, p_lat double precision, p_lng double precision)
 RETURNS TABLE(market_name text, miles numeric, restricted boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.name,
         round(public.haversine_miles(m.lat, m.lng, p_lat, p_lng)::numeric, 1),
         m.restricted
  from public.buyer_markets m
  where m.buyer_id = p_buyer_id
    and m.match_type = 'radius'
    and m.lat is not null and m.lng is not null
    and p_lat is not null and p_lng is not null
    and m.radius_miles is not null
    and public.haversine_miles(m.lat, m.lng, p_lat, p_lng) <= m.radius_miles
  order by 2 asc
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.campaign_next_send_slot(p_campaign_id bigint, p_after timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.next_send_slot(p_after, coalesce(d.property_timezone, c.timezone),
                               c.send_days, c.send_start_hour, c.send_end_hour)
  from public.dispo_campaigns c
  join public.deals d on d.id = c.deal_id
  where c.id = p_campaign_id;
$function$;

CREATE OR REPLACE FUNCTION public.can_read_email(p_ws bigint, p_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.has_role(p_ws, 'owner', 'admin', 'tc')
      or exists (select 1 from public.communication_mailboxes m
                 where m.communication_id = p_id and m.user_id = (select auth.uid()))
      or (not exists (select 1 from public.communication_mailboxes m where m.communication_id = p_id)
          and not exists (select 1 from public.communications c where c.id = p_id and c.source = 'gmail'))
$function$;

CREATE OR REPLACE FUNCTION public.comm_status_rank(s text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case lower(coalesce(s, ''))
    when 'queued'      then 1
    when 'sending'     then 1
    when 'accepted'    then 1
    when 'sent'        then 2
    when 'delivered'   then 3
    when 'failed'      then 4
    when 'undelivered' then 4
    when 'rejected'    then 4
    else 0
  end;
$function$;

CREATE OR REPLACE FUNCTION public.compose_outreach_message(p_workspace_id bigint, p_statement text, p_vars jsonb DEFAULT '{}'::jsonb, p_channel text DEFAULT 'sms'::text, p_greeting_id bigint DEFAULT NULL::bigint, p_ending_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  g record; e record; v_body text;
begin
  if nullif(btrim(coalesce(p_statement, '')), '') is null then
    return jsonb_build_object('ok', false, 'error', 'statement_required');
  end if;

  select * into g from public.outreach_snippets
   where workspace_id = p_workspace_id and kind = 'greeting' and active
     and (channel = p_channel or channel = 'both')
     and (p_greeting_id is null or id = p_greeting_id)
   order by case when p_greeting_id is not null then 0 else 1 end, use_count, position, id
   limit 1;

  select * into e from public.outreach_snippets
   where workspace_id = p_workspace_id and kind = 'ending' and active
     and (channel = p_channel or channel = 'both')
     and (p_ending_id is null or id = p_ending_id)
   order by case when p_ending_id is not null then 0 else 1 end, use_count, position, id
   limit 1;

  if g.id is null or e.id is null then
    return jsonb_build_object('ok', false, 'error', 'library_empty',
      'missing', case when g.id is null and e.id is null then 'greeting_and_ending'
                      when g.id is null then 'greeting' else 'ending' end);
  end if;

  v_body := public.render_merge_fields(g.body, p_vars)
            || ' ' || btrim(p_statement)
            || ' ' || public.render_merge_fields(e.body, p_vars);
  v_body := btrim(regexp_replace(v_body, '\s+', ' ', 'g'));

  update public.outreach_snippets set use_count = use_count + 1, updated_at = now()
   where id in (g.id, e.id);

  return jsonb_build_object(
    'ok', true,
    'body', v_body,
    'greeting_id', g.id,
    'ending_id', e.id,
    'length', length(v_body),
    'unresolved', coalesce(array_to_json(
      (select array_agg(distinct m[1]) from regexp_matches(v_body, '\{([a-z_]+)\}', 'g') m))::jsonb, '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.create_buyer_entity(p_workspace_id bigint, p_name text, p_company text, p_email text, p_phone text, p_markets jsonb DEFAULT '[]'::jsonb, p_source text DEFAULT NULL::text, p_level integer DEFAULT 3, p_extra jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_buyer bigint;
  v_contact bigint;
  v_markets jsonb;
BEGIN
  INSERT INTO public.buyers (
    workspace_id, name, company, email, phone, source, source_id, level,
    buyer_type, entity_type, website, status
  ) VALUES (
    p_workspace_id,
    COALESCE(NULLIF(btrim(p_name),''), NULLIF(btrim(p_company),''), 'Unknown'),
    NULLIF(btrim(p_company),''),
    NULLIF(btrim(lower(p_email)),''),
    NULLIF(btrim(p_phone),''),
    COALESCE(NULLIF(p_extra->>'source',''), p_source),
    NULLIF(p_extra->>'source_id',''),
    COALESCE(p_level, 3)::smallint,
    NULLIF(btrim(p_extra->>'buyer_type'),''),
    NULLIF(btrim(p_extra->>'entity_type'),''),
    NULLIF(btrim(p_extra->>'website'),''),
    COALESCE(NULLIF(p_extra->>'status',''), 'active')
  )
  RETURNING id INTO v_buyer;

  INSERT INTO public.buyer_contacts (
    workspace_id, buyer_id, full_name, rank, rank_text, email, is_primary, source
  ) VALUES (
    p_workspace_id, v_buyer,
    COALESCE(NULLIF(btrim(p_name),''), NULLIF(btrim(p_company),''), 'Unknown'),
    1, 'primary', NULLIF(btrim(lower(p_email)),''), true, COALESCE(NULLIF(p_extra->>'source',''), p_source)
  )
  RETURNING id INTO v_contact;

  IF NULLIF(btrim(COALESCE(p_phone,'')),'') IS NOT NULL THEN
    INSERT INTO public.buyer_phones (workspace_id, buyer_id, contact_id, phone, position, source, is_dnc)
    VALUES (
      p_workspace_id, v_buyer, v_contact, btrim(p_phone), 1,
      COALESCE(NULLIF(p_extra->>'source',''), p_source),
      COALESCE((p_extra->>'dnd')::boolean, false)
    )
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.apply_buyer_parsed_fields(v_buyer, COALESCE(p_extra, '{}'::jsonb));

  v_markets := CASE
    WHEN jsonb_typeof(p_markets) = 'array' AND jsonb_array_length(p_markets) > 0 THEN p_markets
    WHEN jsonb_typeof(p_extra->'markets') = 'array' THEN p_extra->'markets'
    ELSE '[]'::jsonb
  END;
  PERFORM public.replace_buyer_markets_from_parsed(v_buyer, v_markets);

  RETURN v_buyer;
END;
$function$;

CREATE OR REPLACE FUNCTION public.deal_auto_archive()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.stage = 'Terminated' and new.archived_at is null
     and (tg_op = 'INSERT' or old.stage is distinct from new.stage) then
    new.archived_at := now();
    new.archived_reason := 'Terminated';
  elsif tg_op = 'UPDATE' and old.stage = 'Terminated' and new.stage is distinct from 'Terminated'
     and new.archived_at is not null and new.archived_reason = 'Terminated' then
    new.archived_at := null;
    new.archived_reason := null;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.deal_dispo_score(p_deal_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with pool as (
    select m.score
    from public.deal_buyer_matches m
    join public.buyers b on b.id = m.buyer_id
    where m.deal_id = p_deal_id and b.blacklisted_at is null
  )
  select jsonb_build_object(
    'final_score', coalesce(round(max(score))::text, '0') || '%',
    'total_count', count(*),
    'pie_graph', jsonb_build_object(
      '0-50%',   count(*) filter (where score <= 50),
      '51-75%',  count(*) filter (where score between 51 and 75),
      '76-100%', count(*) filter (where score >= 76))
  )
  from pool;
$function$;

CREATE OR REPLACE FUNCTION public.deal_image_key()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'vault'
AS $function$
  select decrypted_secret from vault.decrypted_secrets where name = 'deal_image_hmac';
$function$;

CREATE OR REPLACE FUNCTION public.deal_image_target(p_deal_id bigint)
 RETURNS TABLE(lat double precision, lng double precision, hero_image_url text, geo_precision text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.lat, p.lng, d.hero_image_url, p.geo_precision
  from public.deals d left join public.properties p on p.id = d.property_id
  where d.id = p_deal_id;
$function$;

CREATE OR REPLACE FUNCTION public.deal_image_token(p_deal_id bigint)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'vault'
AS $function$
  select encode(
    extensions.hmac(p_deal_id::text,
                    (select decrypted_secret from vault.decrypted_secrets
                      where name = 'deal_image_hmac'), 'sha256'),
    'hex');
$function$;

CREATE OR REPLACE FUNCTION public.deal_listing(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare l record; d record; v_photos jsonb; v_viewers integer := 0;
begin
  select * into l from public.deal_public_links
   where slug = p_slug and active and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  select dl.id, dl.asking_price, dl.arv, dl.marketing_headline, dl.marketing_description,
         p.line1, p.city, p.state, p.zip, p.county, p.beds, p.baths, p.sqft,
         p.year_built, p.property_type, p.lot_sqft, p.condition, p.attributes
  into d
  from public.deals dl left join public.properties p on p.id = dl.property_id
  where dl.id = l.deal_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'url', f.url, 'caption', f.caption, 'category', f.category,
           'is_cover', f.is_cover, 'width', f.width, 'height', f.height)
         order by f.is_cover desc, f.position, f.id), '[]')
  into v_photos
  from public.deal_files f
  where f.deal_id = l.deal_id and f.visible_to_buyers and f.kind = 'photo';

  if l.show_viewers then
    select count(*) into v_viewers from public.deal_page_views v
     where v.link_id = l.id and v.last_seen_at > now() - interval '3 minutes';
  end if;

  return jsonb_build_object(
    'ok', true,
    'slug', l.slug,
    'headline', coalesce(l.headline, d.marketing_headline),
    'description', coalesce(l.description, d.marketing_description),
    'allow_offers', l.allow_offers,
    'show_viewers', l.show_viewers,
    'active_viewers', v_viewers,
    'property', jsonb_build_object(
      'address', case when l.show_address then d.line1 else null end,
      'city', d.city, 'state', d.state, 'zip', d.zip, 'county', d.county,
      'beds', d.beds, 'baths', d.baths, 'sqft', d.sqft, 'lot_sqft', d.lot_sqft,
      'year_built', d.year_built, 'property_type', d.property_type,
      'condition', d.condition, 'attributes', d.attributes),
    'asking_price', d.asking_price,
    'arv', d.arv,
    'photos', v_photos);
end $function$;

CREATE OR REPLACE FUNCTION public.dedupe_buyer_import(p_batch_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n integer := 0;
begin
  with candidate as (
    select r.id, r.workspace_id,
           nullif(btrim(lower(r.parsed->>'email')), '') as email,
           public.normalize_phone(nullif(btrim(r.parsed->>'phone'), '')) as pkey
    from public.buyer_import_rows r
    where r.batch_id = p_batch_id and r.status = 'pending'
  ),
  hit as (
    select distinct on (c.id) c.id, b.id as buyer_id,
           case when c.email is not null and lower(b.email) = c.email then 'email' else 'phone' end as why
    from candidate c
    join public.buyers b on b.workspace_id = c.workspace_id
      and ( (c.email is not null and lower(b.email) = c.email)
         or (c.pkey is not null and b.phone_key = c.pkey) )
    order by c.id, b.id
  )
  update public.buyer_import_rows r
     set status = 'duplicate', duplicate_of_buyer_id = h.buyer_id,
         duplicate_reason = 'matched existing buyer on '||h.why, updated_at = now()
    from hit h where r.id = h.id;
  get diagnostics n = row_count;

  update public.buyer_import_batches
     set duplicate_count = n, status = 'reviewing', updated_at = now()
   where id = p_batch_id;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.discovery_job_progress(p_task_key text, p_phase text DEFAULT NULL::text, p_completed integer DEFAULT NULL::integer, p_total integer DEFAULT NULL::integer, p_message text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare j record;
begin
  update public.discovery_jobs set
    phase      = coalesce(p_phase, phase),
    completed  = coalesce(p_completed, completed),
    total      = coalesce(p_total, total),
    message    = coalesce(p_message, message),
    status     = coalesce(p_status, case when status = 'queued' then 'running' else status end),
    error      = coalesce(p_error, error),
    error_count = error_count + (p_error is not null)::int,
    started_at = coalesce(started_at, now()),
    finished_at = case when coalesce(p_status, status) in ('succeeded','failed','cancelled')
                       then now() else finished_at end,
    updated_at = now()
  where task_key = p_task_key
  returning * into j;

  if not found then return jsonb_build_object('ok', false, 'error', 'job_not_found'); end if;

  return jsonb_build_object(
    'ok', true,
    'task_id', j.task_key,
    'phase', j.phase,
    'status', j.status,
    'progress', case when j.total > 0 then round(100.0 * j.completed / j.total) else 0 end,
    'message', j.message,
    'data', jsonb_build_object(
      'total', j.total, 'completed', j.completed, 'error_count', j.error_count));
end $function$;

CREATE OR REPLACE FUNCTION public.dispo_campaign_safety_check(p_campaign_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c record; d record;
  blocking text[] := '{}';
  warnings text[] := '{}';
  v_recipients integer; v_messages integer; v_photos integer;
  v_no_contact integer; v_bad_links integer; v_outside integer; v_dupe integer;
begin
  select * into c from public.dispo_campaigns where id = p_campaign_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'campaign_not_found'); end if;

  select dl.*, p.state, p.city into d
  from public.deals dl left join public.properties p on p.id = dl.property_id
  where dl.id = c.deal_id;

  select count(*) into v_recipients from public.dispo_campaign_recipients where campaign_id = p_campaign_id;
  select count(*) into v_messages   from public.dispo_campaign_messages   where campaign_id = p_campaign_id;
  select count(*) into v_photos     from public.deal_files
   where deal_id = c.deal_id and kind = 'photo' and visible_to_buyers;

  if v_recipients = 0 then blocking := array_append(blocking, 'No recipients on this campaign.'); end if;
  if v_messages   = 0 then blocking := array_append(blocking, 'No messages queued.'); end if;
  if d.asking_price is null then blocking := array_append(blocking, 'Deal has no asking price.'); end if;
  if coalesce(d.property_timezone, c.timezone) is null then
    blocking := array_append(blocking, 'No property timezone: send window cannot be computed.');
  end if;

  -- Messages whose body still carries an unresolved merge tag.
  select count(*) into v_bad_links from public.dispo_campaign_messages
   where campaign_id = p_campaign_id and (body ~ '\{\{[a-z_]+\}\}' or coalesce(body_html,'') ~ '\{\{[a-z_]+\}\}');
  if v_bad_links > 0 then
    blocking := array_append(blocking, v_bad_links||' message(s) still contain an unresolved merge tag.');
  end if;

  -- Messages scheduled outside the delivery window.
  select count(*) into v_outside from public.dispo_campaign_messages m
   where m.campaign_id = p_campaign_id
     and m.status = 'queued'
     and m.send_at <> public.next_send_slot(m.send_at, coalesce(d.property_timezone, c.timezone),
                                            c.send_days, c.send_start_hour, c.send_end_hour);
  if v_outside > 0 then
    warnings := array_append(warnings, v_outside||' message(s) fall outside the delivery window and will be shifted.');
  end if;

  -- Recipients with no usable channel.
  select count(*) into v_no_contact from public.dispo_campaign_recipients r
   where r.campaign_id = p_campaign_id
     and nullif(r.phone,'') is null and nullif(r.email,'') is null;
  if v_no_contact > 0 then
    warnings := array_append(warnings, v_no_contact||' recipient(s) have neither phone nor email.');
  end if;

  -- Buyers already inside another live campaign's exclusivity window.
  if c.exclusivity_minutes > 0 then
    select count(*) into v_dupe
    from public.dispo_campaign_recipients r
    join public.dispo_campaign_recipients r2 on r2.buyer_id = r.buyer_id and r2.campaign_id <> r.campaign_id
    join public.dispo_campaigns c2 on c2.id = r2.campaign_id
    where r.campaign_id = p_campaign_id
      and c2.stopped_at is null
      and c2.starts_at > now() - make_interval(mins => c.exclusivity_minutes);
    if v_dupe > 0 then
      warnings := array_append(warnings, v_dupe||' buyer(s) are inside another campaign''s exclusivity window.');
    end if;
  end if;

  if v_photos = 0 then warnings := array_append(warnings, 'No buyer-visible photos on this deal.'); end if;
  if c.from_phone is null and c.email_account_id is null then
    blocking := array_append(blocking, 'No sending phone number and no email account selected.');
  end if;

  return jsonb_build_object(
    'ok', cardinality(blocking) = 0,
    'blocking', to_jsonb(blocking),
    'warnings', to_jsonb(warnings),
    'recipients', v_recipients,
    'messages', v_messages,
    'photos', v_photos);
end $function$;

CREATE OR REPLACE FUNCTION public.dispo_campaign_stop(p_campaign_id bigint, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c record; v_cancelled integer;
begin
  select * into c from public.dispo_campaigns where id = p_campaign_id;
  if not found then raise exception 'campaign % not found', p_campaign_id; end if;
  if not public.has_role(c.workspace_id, 'owner', 'admin', 'dispositions') then
    raise exception 'not allowed to stop this campaign' using errcode = '42501';
  end if;

  update public.dispo_campaign_messages
     set status = 'cancelled', last_error = coalesce(p_reason, 'campaign stopped'), updated_at = now()
   where campaign_id = p_campaign_id and status in ('queued', 'sending');
  get diagnostics v_cancelled = row_count;

  update public.dispo_campaigns
     set status = 'cancelled', stopped_at = now(), stopped_by = auth.uid(),
         stop_reason = p_reason, updated_at = now()
   where id = p_campaign_id;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body, actor_id)
  values (c.workspace_id, 'deal', c.deal_id, 'campaign', 'Campaign stopped',
          coalesce(p_reason, 'stopped by user') || ' · ' || v_cancelled || ' queued message(s) cancelled', auth.uid());

  return jsonb_build_object('ok', true, 'cancelled', v_cancelled);
end $function$;

CREATE OR REPLACE FUNCTION public.dispo_log_engagement(p_deal_id bigint, p_buyer_id bigint, p_kind text, p_channel text DEFAULT NULL::text, p_campaign_id bigint DEFAULT NULL::bigint, p_message_id bigint DEFAULT NULL::bigint, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_match record;
begin
  if p_deal_id is null or p_buyer_id is null then return; end if;

  select id, workspace_id into v_match
    from public.deal_buyer_matches
   where deal_id = p_deal_id and buyer_id = p_buyer_id;
  -- No match row means nothing to roll the event up into.
  if not found then return; end if;

  insert into public.dispo_engagement_events
    (workspace_id, deal_id, buyer_id, match_id, campaign_id, message_id, kind, channel, meta)
  values (v_match.workspace_id, p_deal_id, p_buyer_id, v_match.id,
          p_campaign_id, p_message_id, p_kind,
          case when p_channel in ('sms','email','call','web') then p_channel end,
          coalesce(p_meta, '{}'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.dispo_match_refresh(p_min integer DEFAULT 55, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d record;
  v_deals integer := 0;
  v_matches integer := 0;
  v_n integer;
  v_started timestamptz := clock_timestamp();
begin
  for d in
    select dl.id
    from public.deals dl
    join public.deal_stages s on s.label = dl.stage
    where s.active_inventory
      and dl.closed_on is null
      and not coalesce(dl.terminated, false)
    order by dl.updated_at desc
    limit greatest(1, p_limit)
  loop
    begin
      v_n := public.match_deal(d.id, p_min);
      v_deals := v_deals + 1;
      v_matches := v_matches + coalesce(v_n, 0);
    exception when others then
      -- One bad deal must not take the whole nightly run down.
      raise warning 'match_deal(%) failed: %', d.id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object(
    'deals', v_deals,
    'matches', v_matches,
    'min_score', p_min,
    'seconds', round(extract(epoch from clock_timestamp() - v_started)::numeric, 1));
end $function$;

CREATE OR REPLACE FUNCTION public.freeze_match_snapshot(p_snapshot_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s record; v_summary jsonb;
begin
  select * into s from public.dispo_match_snapshots where id = p_snapshot_id;
  if not found then raise exception 'snapshot % not found', p_snapshot_id; end if;
  if s.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'already_'||s.status);
  end if;

  select jsonb_build_object(
    'total',    count(*),
    'sending',  count(*) filter (where not excluded),
    'excluded', count(*) filter (where excluded),
    'by_level', coalesce(jsonb_object_agg(coalesce(level,0)::text, c) filter (where level is not null), '{}'::jsonb),
    'avg_score', round(avg(score) filter (where not excluded), 1)
  ) into v_summary
  from (
    select r.*, count(*) over (partition by r.level) as c
    from public.dispo_match_snapshot_rows r where r.snapshot_id = p_snapshot_id
  ) q;

  update public.dispo_match_snapshots
     set status = 'frozen', frozen_at = now(), summary = coalesce(v_summary, '{}'::jsonb), updated_at = now()
   where id = p_snapshot_id;
  return jsonb_build_object('ok', true, 'summary', v_summary);
end $function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  ws_id bigint;
  display text;
  inv record;
begin
  display := coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1));

  insert into public.profiles (id, full_name, email)
  values (new.id, display, new.email);

  -- An invite waiting for this address joins them to that workspace with the
  -- intended role instead of minting them a workspace of their own.
  select * into inv from public.workspace_invites
  where lower(email) = lower(new.email) and accepted_at is null
  order by created_at desc limit 1;

  if found then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, new.id, inv.role);
    update public.workspace_invites set accepted_at = now() where id = inv.id;
    return new;
  end if;

  insert into public.workspaces (name, owner_id)
  values (coalesce(nullif(new.raw_user_meta_data->>'workspace_name', ''), display || '''s workspace'), new.id)
  returning id into ws_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws_id, new.id, 'owner');

  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.has_role(ws bigint, VARIADIC roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(public.member_role(ws) = any(roles), false)
$function$;

CREATE OR REPLACE FUNCTION public.haversine_miles(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
 RETURNS double precision
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null
    else 3958.7613 * 2 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
    ))
  end;
$function$;

CREATE OR REPLACE FUNCTION public.import_buyer_rows(p_batch_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  bt record; r record; v_buyer bigint; n integer := 0;
begin
  select * into bt from public.buyer_import_batches where id = p_batch_id;
  if not found then raise exception 'batch % not found', p_batch_id; end if;

  for r in
    select * from public.buyer_import_rows
     where batch_id = p_batch_id
       and (status = 'approved' or (bt.include_rejected and status = 'rejected'))
     order by row_no
  loop
    begin
      v_buyer := public.create_buyer_entity(
        r.workspace_id,
        r.parsed->>'name', r.parsed->>'company', r.parsed->>'email', r.parsed->>'phone',
        coalesce(r.parsed->'markets', '[]'::jsonb),
        'csv_import',
        coalesce((r.parsed->>'level')::integer, bt.default_level::integer, 3),
        r.parsed);
      update public.buyer_import_rows
         set status = 'imported', buyer_id = v_buyer, updated_at = now() where id = r.id;
      n := n + 1;
    exception when others then
      update public.buyer_import_rows
         set status = 'error', error = sqlerrm, updated_at = now() where id = r.id;
    end;
  end loop;

  update public.buyer_import_batches
     set imported_count = n, status = 'done', completed_at = now(), updated_at = now()
   where id = p_batch_id;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.inbox_mark_read(p_thread_id bigint)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  update public.inbox_threads set unread_count = 0, updated_at = now() where id = p_thread_id;
$function$;

CREATE OR REPLACE FUNCTION public.is_workspace_member(ws bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.match_contact_by_phone(p_ws bigint, p_phone_key text, OUT buyer_id bigint, OUT seller_id bigint)
 RETURNS record
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    coalesce(
      (select b.id from public.buyers b where b.workspace_id = p_ws and b.phone_key = p_phone_key order by b.id limit 1),
      (select bp.buyer_id from public.buyer_phones bp where bp.workspace_id = p_ws and bp.phone_key = p_phone_key order by bp.position nulls last, bp.id limit 1)
    ),
    (select s.id from public.sellers s where s.workspace_id = p_ws and s.phone_key = p_phone_key order by s.id limit 1)
$function$;

CREATE OR REPLACE FUNCTION public.member_role(ws bigint)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select role from public.workspace_members
  where workspace_id = ws and user_id = auth.uid()
  limit 1
$function$;

CREATE OR REPLACE FUNCTION public.my_email_admin_workspace_ids()
 RETURNS SETOF bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid()) and m.role in ('owner', 'admin', 'tc')
$function$;

CREATE OR REPLACE FUNCTION public.my_role_workspace_ids(VARIADIC p_roles text[])
 RETURNS SETOF bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select w from public.my_workspace_ids() w where public.has_role(w, variadic p_roles)
$function$;

CREATE OR REPLACE FUNCTION public.my_workspace_ids()
 RETURNS SETOF bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
$function$;

CREATE OR REPLACE FUNCTION public.next_send_slot(p_after timestamp with time zone, p_timezone text, p_days smallint[], p_start_hour smallint, p_end_hour smallint)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  tz text := coalesce(nullif(p_timezone, ''), 'America/Chicago');
  local_ts timestamp;
  guard integer := 0;
begin
  if p_days is null or cardinality(p_days) = 0 then return p_after; end if;
  local_ts := (p_after at time zone tz);

  loop
    guard := guard + 1;
    exit when guard > 14;

    if not (extract(isodow from local_ts)::smallint = any(p_days)) then
      -- Wrong day: jump to the start of the next day and re-test.
      local_ts := date_trunc('day', local_ts) + interval '1 day'
                  + make_interval(hours => p_start_hour);
      continue;
    end if;

    if extract(hour from local_ts) < p_start_hour then
      local_ts := date_trunc('day', local_ts) + make_interval(hours => p_start_hour);
    elsif extract(hour from local_ts) >= p_end_hour then
      local_ts := date_trunc('day', local_ts) + interval '1 day'
                  + make_interval(hours => p_start_hour);
      continue;
    end if;

    return (local_ts at time zone tz);
  end loop;

  return p_after;
end $function$;

CREATE OR REPLACE FUNCTION public.normalize_address(p_raw text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  s text;
  row text[];
  -- USPS Publication 28 abbreviations, longest forms first so STREET is
  -- rewritten before STR would be. Only the suffixes and directionals that
  -- actually vary between our sources; this is not the full 200-row table.
  subs text[][] := array[
    ['NORTHEAST','NE'], ['NORTHWEST','NW'], ['SOUTHEAST','SE'], ['SOUTHWEST','SW'],
    ['NORTH','N'], ['SOUTH','S'], ['EAST','E'], ['WEST','W'],
    ['STREET','ST'], ['AVENUE','AVE'], ['BOULEVARD','BLVD'], ['DRIVE','DR'],
    ['ROAD','RD'], ['LANE','LN'], ['COURT','CT'], ['CIRCLE','CIR'],
    ['PLACE','PL'], ['TERRACE','TER'], ['TRAIL','TRL'], ['PARKWAY','PKWY'],
    ['HIGHWAY','HWY'], ['SQUARE','SQ'], ['CROSSING','XING'], ['LOOP','LOOP'],
    ['APARTMENT','APT'], ['SUITE','STE'], ['BUILDING','BLDG'], ['FLOOR','FL'],
    ['NUMBER','#']
  ];
begin
  if p_raw is null then return null; end if;

  s := upper(p_raw);
  s := regexp_replace(s, '[.,]', '', 'g');       -- N. Main St. -> N MAIN ST
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := btrim(s);

  foreach row slice 1 in array subs loop
    s := regexp_replace(s, '\y' || row[1] || '\y', row[2], 'g');
  end loop;

  -- Collapse again: a replacement can leave a double space behind.
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  return nullif(s, '');
end $function$;

CREATE OR REPLACE FUNCTION public.normalize_phone(p_raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_raw is null then null
    else (
      select case
        -- US 10-digit, and 11-digit already carrying the country code.
        when length(d) = 10 then '+1' || d
        when length(d) = 11 and left(d, 1) = '1' then '+' || d
        -- Anything else plausible is kept as-is rather than mangled into a
        -- wrong number; anything implausible becomes null so it never keys.
        when length(d) between 8 and 15 then '+' || d
        else null
      end
      from (select regexp_replace(p_raw, '[^0-9]', '', 'g') as d) x
    )
  end;
$function$;

CREATE OR REPLACE FUNCTION public.promote_discovery_entity(p_entity_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  e record; i record; ci jsonb;
  v_buyer bigint; v_contact bigint; v_pos smallint;
begin
  select * into e from public.discovery_entities where id = p_entity_id;
  if not found then raise exception 'discovery entity % not found', p_entity_id; end if;
  if e.buyer_id is not null then return e.buyer_id; end if;

  insert into public.buyers (workspace_id, name, company, entity_type, source, level,
                             jurisdiction_name, filing_date, is_verified, status)
  values (e.workspace_id, e.name, e.name, 'llc', 'genius_discovery', 3,
          e.jurisdiction_name, e.filing_date, e.is_verified, 'active')
  returning id into v_buyer;

  for i in select * from public.discovery_individuals
            where entity_id = p_entity_id order by rank nulls last, id loop
    insert into public.buyer_contacts (workspace_id, buyer_id, full_name, rank, rank_text,
                                       buyer_type, engagement_score, tags, is_primary, source)
    values (e.workspace_id, v_buyer, i.full_name, coalesce(i.rank, 1), i.rank_text,
            i.buyer_type, coalesce(i.engagement_score, 0), i.tags,
            coalesce(i.rank, 1) = 1, 'genius_discovery')
    on conflict do nothing
    returning id into v_contact;

    if v_contact is not null then
      update public.discovery_individuals set contact_id = v_contact where id = i.id;

      v_pos := 0;
      for ci in select * from jsonb_array_elements(coalesce(i.contact_info, '[]'::jsonb)) loop
        v_pos := v_pos + 1;
        exit when v_pos > 3;
        if nullif(btrim(ci->>'number'), '') is not null then
          insert into public.buyer_phones (workspace_id, buyer_id, contact_id, phone, position,
                                           source, is_dnc, call_count, message_count)
          values (e.workspace_id, v_buyer, v_contact, btrim(ci->>'number'), v_pos,
                  coalesce(nullif(ci->>'source',''), 'genius_discovery'),
                  coalesce((ci->>'is_dnc')::boolean, false),
                  coalesce((ci->>'call_count')::integer, 0),
                  coalesce((ci->>'message_count')::integer, 0))
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end loop;

  update public.discovery_entities
     set buyer_id = v_buyer, promoted_at = now() where id = p_entity_id;
  return v_buyer;
end $function$;

CREATE OR REPLACE FUNCTION public.record_email_open(p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare m record;
begin
  select id, workspace_id, deal_id, buyer_id into m
    from public.deal_buyer_matches where track_token = p_token;
  if not found then return false; end if;

  insert into public.dispo_engagement_events
    (workspace_id, deal_id, buyer_id, match_id, kind, channel)
  values (m.workspace_id, m.deal_id, m.buyer_id, m.id, 'open', 'email');
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.record_link_click(p_token text, p_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare m record; v_slug text;
begin
  select id, workspace_id, deal_id, buyer_id into m
    from public.deal_buyer_matches where track_token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;

  insert into public.dispo_engagement_events
    (workspace_id, deal_id, buyer_id, match_id, kind, channel, url)
  values (m.workspace_id, m.deal_id, m.buyer_id, m.id, 'click',
          case when p_url like '%mailto%' then 'email' else 'web' end, p_url);

  select slug into v_slug from public.deal_public_links
   where deal_id = m.deal_id and active
     and (expires_at is null or expires_at > now())
   limit 1;

  return jsonb_build_object('ok', true, 'url', p_url, 'listing_slug', v_slug);
end $function$;

CREATE OR REPLACE FUNCTION public.render_merge_fields(p_text text, p_vars jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare k text; v text; out_text text := coalesce(p_text, '');
begin
  if p_vars is null then return out_text; end if;
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    if v is not null and btrim(v) <> '' then
      out_text := replace(out_text, '{' || k || '}', v);
    end if;
  end loop;
  return out_text;
end $function$;

CREATE OR REPLACE FUNCTION public.replace_buyer_markets_from_parsed(p_buyer_id bigint, p_markets jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ws bigint;
  m jsonb;
  n integer := 0;
  names text[] := '{}';
BEGIN
  SELECT workspace_id INTO v_ws FROM public.buyers WHERE id = p_buyer_id;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'buyer % not found', p_buyer_id;
  END IF;

  DELETE FROM public.buyer_markets WHERE buyer_id = p_buyer_id;

  FOR m IN SELECT * FROM jsonb_array_elements(COALESCE(p_markets, '[]'::jsonb))
  LOOP
    IF COALESCE(NULLIF(btrim(m->>'name'),''), '') = '' THEN
      CONTINUE;
    END IF;
    INSERT INTO public.buyer_markets (
      workspace_id, buyer_id, kind, name, state, match_type, radius_miles, restricted
    ) VALUES (
      v_ws,
      p_buyer_id,
      COALESCE(NULLIF(m->>'kind',''), 'city'),
      btrim(m->>'name'),
      NULLIF(btrim(m->>'state'),''),
      COALESCE(NULLIF(m->>'match_type',''), 'exact'),
      NULLIF(m->>'radius_miles','')::numeric,
      COALESCE((m->>'restricted')::boolean, false)
    )
    ON CONFLICT DO NOTHING;
    n := n + 1;
    names := names || btrim(m->>'name');
  END LOOP;

  UPDATE public.buyers
     SET markets = names,
         updated_at = now()
   WHERE id = p_buyer_id;

  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.roll_up_engagement_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.match_id is null then return null; end if;

  update public.deal_buyer_matches m set
    sends        = m.sends        + (new.kind = 'sent')::int,
    deliveries   = m.deliveries   + (new.kind = 'delivered')::int,
    opens        = m.opens        + (new.kind = 'open')::int,
    clicks       = m.clicks       + (new.kind = 'click')::int,
    replies      = m.replies      + (new.kind = 'reply')::int,
    calls        = m.calls        + (new.kind = 'call')::int,
    page_views   = m.page_views   + (new.kind = 'page_view')::int,
    photo_clicks = m.photo_clicks + (new.kind = 'photo_click')::int,
    offers       = m.offers       + (new.kind = 'offer')::int,
    bounces      = m.bounces      + (new.kind in ('bounced','failed'))::int,
    session_seconds = m.session_seconds + coalesce((new.meta->>'seconds')::int, 0),
    sent_at   = case when new.kind = 'sent'  then least(coalesce(m.sent_at,   new.occurred_at), new.occurred_at) else m.sent_at end,
    viewed_at = case when new.kind in ('open','page_view')
                     then least(coalesce(m.viewed_at, new.occurred_at), new.occurred_at) else m.viewed_at end,
    replied_at = case when new.kind = 'reply'
                     then least(coalesce(m.replied_at, new.occurred_at), new.occurred_at) else m.replied_at end,
    last_engaged_at = case
      when new.kind in ('open','click','reply','call','page_view','photo_click','offer')
      then greatest(coalesce(m.last_engaged_at, new.occurred_at), new.occurred_at)
      else m.last_engaged_at end,
    updated_at = now()
  where m.id = new.match_id;

  update public.deal_buyer_matches m set temperature = case
      when m.last_engaged_at is null then null
      -- An offer is the strongest signal in the system; it stays hot longer
      -- than a click, because a live offer is still live a fortnight later.
      when m.offers > 0 and m.last_engaged_at > now() - interval '14 days' then 'hot'
      when m.last_engaged_at > now() - interval '3 days'
       and (m.replies > 0 or m.clicks > 0 or m.calls > 0) then 'hot'
      when m.last_engaged_at > now() - interval '14 days'
       and (m.opens > 0 or m.page_views > 0 or m.clicks > 0 or m.replies > 0) then 'warm'
      else 'cold' end
  where m.id = new.match_id;

  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.set_deal_property_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_state text;
begin
  if new.property_timezone is null and new.property_id is not null then
    select state into v_state from public.properties where id = new.property_id;
    new.property_timezone := public.timezone_for_state(v_state);
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.set_snapshot_exclusion(p_snapshot_id bigint, p_buyer_id bigint, p_excluded boolean, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  update public.dispo_match_snapshot_rows
     set excluded = p_excluded,
         excluded_reason = case when p_excluded then p_reason else null end,
         excluded_by     = case when p_excluded then auth.uid() else null end,
         excluded_at     = case when p_excluded then now() else null end
   where snapshot_id = p_snapshot_id and buyer_id = p_buyer_id;
  if not found then return false; end if;

  update public.dispo_match_snapshots s
     set excluded_count = (select count(*) from public.dispo_match_snapshot_rows r
                            where r.snapshot_id = p_snapshot_id and r.excluded),
         updated_at = now()
   where s.id = p_snapshot_id;
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.submit_buy_box(p_slug text, p_payload jsonb, p_user_agent text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  l record;
  v_phone text := nullif(btrim(p_payload->>'phone'), '');
  v_email text := nullif(btrim(lower(p_payload->>'email')), '');
  v_key   text := public.normalize_phone(v_phone);
  v_dup   bigint;
  v_id    bigint;
begin
  select * into l from public.buy_box_links
   where slug = p_slug and active and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('ok', false, 'error', 'link_not_found'); end if;
  if v_email is null and v_phone is null then
    return jsonb_build_object('ok', false, 'error', 'contact_required');
  end if;

  select b.id into v_dup
  from public.buyers b
  where b.workspace_id = l.workspace_id
    and ( (v_email is not null and lower(b.email) = v_email)
       or (v_key is not null and b.phone_key = v_key) )
  limit 1;

  insert into public.buy_box_submissions (
    workspace_id, link_id, status, company, contact_name, email, phone, phone_key,
    website, buyer_type, entity_type, payload, markets, duplicate_of_buyer_id, user_agent
  ) values (
    l.workspace_id, l.id,
    case when v_dup is not null then 'duplicate' else 'pending' end,
    nullif(btrim(p_payload->>'company'), ''),
    nullif(btrim(p_payload->>'contact_name'), ''),
    v_email, v_phone, v_key,
    nullif(btrim(p_payload->>'website'), ''),
    nullif(btrim(p_payload->>'buyer_type'), ''),
    nullif(btrim(p_payload->>'entity_type'), ''),
    p_payload,
    coalesce(p_payload->'markets', '[]'::jsonb),
    v_dup,
    left(coalesce(p_user_agent, ''), 500)
  ) returning id into v_id;

  update public.buy_box_links set submission_count = submission_count + 1, updated_at = now() where id = l.id;
  return jsonb_build_object('ok', true, 'submission_id', v_id, 'duplicate', v_dup is not null);
end $function$;

CREATE OR REPLACE FUNCTION public.submit_deal_offer(p_slug text, p_payload jsonb, p_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  l record;
  v_match_id bigint;
  v_buyer_id bigint;
  v_property_id bigint;
  v_amount numeric;
  v_offer bigint;
begin
  select * into l from public.deal_public_links
   where slug = p_slug and active and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not l.allow_offers then return jsonb_build_object('ok', false, 'error', 'offers_closed'); end if;

  begin
    v_amount := nullif(regexp_replace(coalesce(p_payload->>'amount',''), '[^0-9.]', '', 'g'), '')::numeric;
  exception when others then
    v_amount := null;
  end;
  if v_amount is null or v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'amount_required');
  end if;

  select property_id into v_property_id from public.deals where id = l.deal_id;

  if p_token is not null then
    select id, buyer_id into v_match_id, v_buyer_id
      from public.deal_buyer_matches
     where track_token = p_token and deal_id = l.deal_id;
  end if;

  insert into public.offers (
    workspace_id, deal_id, property_id, buyer_id, direction, amount, status, basis, notes, terms)
  values (
    l.workspace_id, l.deal_id, v_property_id, v_buyer_id, 'inbound', v_amount, 'received',
    'listing_page',
    nullif(btrim(p_payload->>'notes'), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'financing',      nullif(btrim(p_payload->>'financing'), ''),
      'days_to_close',  nullif(btrim(p_payload->>'days_to_close'), '')::integer,
      'emd',            nullif(regexp_replace(coalesce(p_payload->>'emd',''), '[^0-9.]', '', 'g'), '')::numeric,
      'inspection_days',nullif(btrim(p_payload->>'inspection_days'), '')::integer,
      'contact_name',   nullif(btrim(p_payload->>'contact_name'), ''),
      'contact_email',  nullif(btrim(lower(p_payload->>'email')), ''),
      'contact_phone',  nullif(btrim(p_payload->>'phone'), ''),
      'company',        nullif(btrim(p_payload->>'company'), ''),
      'source',         'listing_page')))
  returning id into v_offer;

  if v_match_id is not null then
    update public.deal_buyer_matches set status = 'offered', updated_at = now() where id = v_match_id;
  end if;

  return jsonb_build_object('ok', true, 'offer_id', v_offer);
end $function$;

CREATE OR REPLACE FUNCTION public.sync_buyer_criteria()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.criteria := public.build_buyer_criteria(new);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.sync_buyer_criteria_from_market()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare b_id bigint := coalesce(new.buyer_id, old.buyer_id);
begin
  update public.buyers set updated_at = now() where id = b_id;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.text_array_from_jsonb(p jsonb)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p, '[]'::jsonb))), '{}'::text[]);
$function$;

CREATE OR REPLACE FUNCTION public.timezone_for_state(p_state text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case upper(btrim(coalesce(p_state, '')))
    when 'HI' then 'Pacific/Honolulu'
    when 'AK' then 'America/Anchorage'
    when 'WA' then 'America/Los_Angeles'
    when 'OR' then 'America/Los_Angeles'
    when 'CA' then 'America/Los_Angeles'
    when 'NV' then 'America/Los_Angeles'
    when 'AZ' then 'America/Phoenix'
    when 'ID' then 'America/Boise'
    when 'MT' then 'America/Denver'
    when 'WY' then 'America/Denver'
    when 'UT' then 'America/Denver'
    when 'CO' then 'America/Denver'
    when 'NM' then 'America/Denver'
    when 'ND' then 'America/Chicago'
    when 'SD' then 'America/Chicago'
    when 'NE' then 'America/Chicago'
    when 'KS' then 'America/Chicago'
    when 'OK' then 'America/Chicago'
    when 'TX' then 'America/Chicago'
    when 'MN' then 'America/Chicago'
    when 'IA' then 'America/Chicago'
    when 'MO' then 'America/Chicago'
    when 'AR' then 'America/Chicago'
    when 'LA' then 'America/Chicago'
    when 'WI' then 'America/Chicago'
    when 'IL' then 'America/Chicago'
    when 'MS' then 'America/Chicago'
    when 'AL' then 'America/Chicago'
    when 'TN' then 'America/Chicago'
    when 'KY' then 'America/New_York'
    when 'IN' then 'America/Indiana/Indianapolis'
    when 'MI' then 'America/New_York'
    when 'OH' then 'America/New_York'
    when 'WV' then 'America/New_York'
    when 'VA' then 'America/New_York'
    when 'NC' then 'America/New_York'
    when 'SC' then 'America/New_York'
    when 'GA' then 'America/New_York'
    when 'FL' then 'America/New_York'
    when 'PA' then 'America/New_York'
    when 'NY' then 'America/New_York'
    when 'NJ' then 'America/New_York'
    when 'DE' then 'America/New_York'
    when 'MD' then 'America/New_York'
    when 'DC' then 'America/New_York'
    when 'CT' then 'America/New_York'
    when 'RI' then 'America/New_York'
    when 'MA' then 'America/New_York'
    when 'VT' then 'America/New_York'
    when 'NH' then 'America/New_York'
    when 'ME' then 'America/New_York'
    else null
  end;
$function$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.updated_at := now();
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.track_deal_view(p_slug text, p_session_key text, p_token text DEFAULT NULL::text, p_seconds integer DEFAULT 0, p_photo_clicks integer DEFAULT 0, p_referrer text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  l record;
  v_match_id bigint;
  v_buyer_id bigint;
  v_viewers integer := 0;
  v_prior_clicks integer := 0;
  v_is_new boolean := false;
begin
  select * into l from public.deal_public_links
   where slug = p_slug and active and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_token is not null then
    select id, buyer_id into v_match_id, v_buyer_id
      from public.deal_buyer_matches
     where track_token = p_token and deal_id = l.deal_id;
  end if;

  select photo_clicks into v_prior_clicks from public.deal_page_views
   where link_id = l.id and session_key = p_session_key;
  v_is_new := not found;

  insert into public.deal_page_views (
    workspace_id, deal_id, link_id, match_id, buyer_id, session_key,
    seconds, photo_clicks, referrer, user_agent)
  values (l.workspace_id, l.deal_id, l.id, v_match_id, v_buyer_id, p_session_key,
          greatest(coalesce(p_seconds,0), 0), greatest(coalesce(p_photo_clicks,0), 0),
          left(p_referrer, 500), left(p_user_agent, 500))
  on conflict (link_id, session_key) do update
    set last_seen_at = now(),
        seconds      = greatest(public.deal_page_views.seconds, excluded.seconds),
        photo_clicks = greatest(public.deal_page_views.photo_clicks, excluded.photo_clicks),
        match_id     = coalesce(public.deal_page_views.match_id, excluded.match_id),
        buyer_id     = coalesce(public.deal_page_views.buyer_id, excluded.buyer_id);

  if v_match_id is not null then
    -- One page_view event per session, then only the deltas that follow.
    if v_is_new then
      insert into public.dispo_engagement_events
        (workspace_id, deal_id, buyer_id, match_id, kind, channel, meta)
      values (l.workspace_id, l.deal_id, v_buyer_id, v_match_id, 'page_view', 'web',
              jsonb_build_object('seconds', greatest(coalesce(p_seconds,0), 0)));
    end if;
    if coalesce(p_photo_clicks,0) > coalesce(v_prior_clicks,0) then
      insert into public.dispo_engagement_events
        (workspace_id, deal_id, buyer_id, match_id, kind, channel, meta)
      select l.workspace_id, l.deal_id, v_buyer_id, v_match_id, 'photo_click', 'web', '{}'::jsonb
      from generate_series(1, p_photo_clicks - coalesce(v_prior_clicks,0));
    end if;
  end if;

  update public.deal_public_links
     set view_count = view_count + 1,
         unique_viewers = (select count(distinct session_key) from public.deal_page_views where link_id = l.id),
         updated_at = now()
   where id = l.id;

  if l.show_viewers then
    select count(*) into v_viewers from public.deal_page_views v
     where v.link_id = l.id and v.last_seen_at > now() - interval '3 minutes';
  end if;

  return jsonb_build_object('ok', true, 'active_viewers', v_viewers);
end $function$;

CREATE OR REPLACE FUNCTION public.upsert_vetted_buyer(p_workspace_id bigint, p_parsed jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_buyer bigint;
  v_email text := NULLIF(btrim(lower(p_parsed->>'email')), '');
  v_phone text := public.normalize_phone(NULLIF(btrim(p_parsed->>'phone'), ''));
  v_source_id text := NULLIF(btrim(p_parsed->>'source_id'), '');
  v_pkey text := NULLIF(regexp_replace(COALESCE(v_phone,''), '[^0-9]', '', 'g'), '');
BEGIN
  IF NULLIF(p_parsed->>'skip', '') IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF v_source_id IS NOT NULL THEN
    SELECT id INTO v_buyer
      FROM public.buyers
     WHERE workspace_id = p_workspace_id AND source_id = v_source_id
     LIMIT 1;
  END IF;

  IF v_buyer IS NULL AND v_email IS NOT NULL THEN
    SELECT id INTO v_buyer
      FROM public.buyers
     WHERE workspace_id = p_workspace_id AND lower(email) = v_email
     ORDER BY id
     LIMIT 1;
  END IF;

  IF v_buyer IS NULL AND v_phone IS NOT NULL THEN
    SELECT id INTO v_buyer
      FROM public.buyers
     WHERE workspace_id = p_workspace_id AND phone_key = v_phone
     ORDER BY id
     LIMIT 1;
  END IF;

  IF v_buyer IS NULL AND v_pkey IS NOT NULL THEN
    SELECT b.id INTO v_buyer
      FROM public.buyer_phones p
      JOIN public.buyers b ON b.id = p.buyer_id
     WHERE p.workspace_id = p_workspace_id AND p.phone_key = v_phone
     ORDER BY b.id
     LIMIT 1;
  END IF;

  IF v_buyer IS NULL THEN
    v_buyer := public.create_buyer_entity(
      p_workspace_id,
      p_parsed->>'name',
      p_parsed->>'company',
      p_parsed->>'email',
      p_parsed->>'phone',
      COALESCE(p_parsed->'markets', '[]'::jsonb),
      COALESCE(p_parsed->>'source', 'dispogenius'),
      COALESCE(NULLIF(p_parsed->>'level','')::integer, 3),
      p_parsed
    );
  ELSE
    UPDATE public.buyers SET
      name = COALESCE(NULLIF(btrim(p_parsed->>'name'),''), name),
      company = COALESCE(NULLIF(btrim(p_parsed->>'company'),''), company),
      email = COALESCE(v_email, email),
      phone = COALESCE(v_phone, phone),
      updated_at = now()
    WHERE id = v_buyer;
    PERFORM public.apply_buyer_parsed_fields(v_buyer, p_parsed);
    PERFORM public.replace_buyer_markets_from_parsed(v_buyer, COALESCE(p_parsed->'markets', '[]'::jsonb));
  END IF;

  RETURN v_buyer;
END;
$function$;

CREATE OR REPLACE FUNCTION public.inbox_on_communication()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_theirs text;
  v_ours   text;
  v_match  record;
  v_thread public.inbox_threads;
  v_body   text := lower(btrim(coalesce(new.body, '')));
  v_inbound boolean := new.direction = 'inbound';
  v_assignee uuid;
begin
  if new.channel not in ('sms','call','voicemail') or coalesce(new.direction,'') not in ('inbound','outbound') then
    return new;
  end if;
  v_theirs := public.normalize_phone(case when v_inbound then new.from_phone else new.to_phone end);
  v_ours   := public.normalize_phone(case when v_inbound then new.to_phone else new.from_phone end);
  if v_theirs is null then return new; end if;

  -- A sync that sends the same message again (Podio every 10 minutes, a
  -- webhook retry) is an upsert on (workspace_id, source, source_id): this
  -- BEFORE INSERT trigger still runs for it. The message already counted;
  -- nothing more to do.
  if new.source_id is not null and exists (
       select 1 from public.communications c
        where c.workspace_id = new.workspace_id and c.source = new.source and c.source_id = new.source_id) then
    return new;
  end if;

  if new.buyer_id is null and new.seller_id is null then
    select * into v_match from public.match_contact_by_phone(new.workspace_id, v_theirs);
    new.buyer_id  := v_match.buyer_id;
    new.seller_id := case when v_match.buyer_id is null then v_match.seller_id end;
  end if;

  select coalesce(
           (select coalesce(assigned_to, owner_id) from public.buyers  where id = new.buyer_id),
           (select coalesce(assigned_to, owner_id) from public.sellers where id = new.seller_id))
    into v_assignee;

  insert into public.inbox_threads as t (
    workspace_id, phone_key, our_phone, buyer_id, seller_id, assigned_to,
    unread_count, last_message_at, last_inbound_at, last_outbound_at,
    last_direction, last_channel, last_preview, awaiting_reply_since)
  values (
    new.workspace_id, v_theirs, v_ours, new.buyer_id, new.seller_id, v_assignee,
    case when v_inbound and (new.channel <> 'call' or new.status in ('missed','no_answer','no-answer')) then 1 else 0 end,
    new.occurred_at,
    case when v_inbound then new.occurred_at end,
    case when not v_inbound then new.occurred_at end,
    new.direction, new.channel, left(coalesce(new.body, new.summary, initcap(new.channel)), 160),
    case when v_inbound and new.channel = 'sms' then new.occurred_at end)
  on conflict (workspace_id, phone_key) do update set
    our_phone        = coalesce(excluded.our_phone, t.our_phone),
    buyer_id         = coalesce(t.buyer_id, excluded.buyer_id),
    seller_id        = coalesce(t.seller_id, excluded.seller_id),
    assigned_to      = coalesce(t.assigned_to, excluded.assigned_to),
    unread_count     = t.unread_count + excluded.unread_count,
    status           = case when v_inbound then 'open' else t.status end,
    last_inbound_at  = greatest(t.last_inbound_at, excluded.last_inbound_at),
    last_outbound_at = greatest(t.last_outbound_at, excluded.last_outbound_at),
    awaiting_reply_since = case
                             when not v_inbound then null
                             when new.channel = 'sms' then coalesce(t.awaiting_reply_since, excluded.awaiting_reply_since)
                             else t.awaiting_reply_since end,
    last_message_at  = greatest(t.last_message_at, excluded.last_message_at),
    last_direction   = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_direction else t.last_direction end,
    last_channel     = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_channel   else t.last_channel   end,
    last_preview     = case when excluded.last_message_at >= coalesce(t.last_message_at, '-infinity') then excluded.last_preview   else t.last_preview   end,
    updated_at       = now()
  returning * into v_thread;

  new.thread_id := v_thread.id;

  if v_inbound and new.channel = 'sms' then
    if v_body in ('stop','stopall','unsubscribe','cancel','end','quit','revoke','optout','opt out','stop all') then
      update public.inbox_threads set opted_out_at = coalesce(opted_out_at, new.occurred_at) where id = v_thread.id;
      update public.buyer_phones set is_dnc = true, updated_at = now()
       where workspace_id = new.workspace_id and phone_key = v_theirs;
    elsif v_body in ('start','unstop','subscribe') then
      update public.inbox_threads set opted_out_at = null where id = v_thread.id;
      update public.buyer_phones set is_dnc = false, updated_at = now()
       where workspace_id = new.workspace_id and phone_key = v_theirs;
    end if;

    insert into public.notifications (workspace_id, user_id, category, title, body, buyer_id, seller_id, phone_key)
    select new.workspace_id,
           -- Whose conversation: the rep on the text, else the owner of the line it
           -- came in on (rep_phone_numbers, migration 153: the line trigger runs
           -- after this one, so the line is looked up here), else the record's rep,
           -- the thread's, the workspace owner. One person, never the team.
           coalesce(new.rep_id,
                    (select r.user_id from public.rep_phone_numbers r
                      where r.workspace_id = new.workspace_id and r.user_id is not null
                        and right(regexp_replace(r.phone_e164, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_ours, ''), '\D', '', 'g'), 10)
                      limit 1),
                    v_assignee, v_thread.assigned_to, w.owner_id),
           'inbound_sms',
           'New text from ' || coalesce(
              (select name from public.buyers where id = new.buyer_id),
              (select name from public.sellers where id = new.seller_id),
              v_theirs),
           left(coalesce(new.body, ''), 200),
           new.buyer_id, new.seller_id, v_theirs
      from public.workspaces w where w.id = new.workspace_id;
  end if;

  return new;
end $function$;

-- ---------------------------------------------------------------- tables

create table if not exists public.action_plan_steps (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  plan_id bigint not null,
  "position" integer default 0 not null,
  channel text default 'sms'::text not null,
  delay_hours integer default 0 not null,
  title text,
  body text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.action_plans (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text not null,
  trigger_event text,
  active boolean default true not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.activity (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  entity_type text not null,
  entity_id bigint not null,
  kind text not null,
  title text not null,
  body text,
  actor_id uuid,
  occurred_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.appointments (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  seller_id bigint,
  property_id bigint,
  buyer_id bigint,
  title text not null,
  kind text default 'Appointment'::text not null,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone,
  location text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  deal_id bigint
);

create table if not exists public.buy_box_links (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  slug text not null,
  name text not null,
  headline text,
  intro text,
  template_id bigint,
  branding jsonb default '{}'::jsonb not null,
  active boolean default true not null,
  auto_approve boolean default false not null,
  expires_at timestamp with time zone,
  submission_count integer default 0 not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buy_box_submissions (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  link_id bigint not null,
  status text default 'pending'::text not null,
  company text,
  contact_name text,
  email text,
  phone text,
  phone_key text,
  website text,
  buyer_type text,
  entity_type text,
  payload jsonb default '{}'::jsonb not null,
  markets jsonb default '[]'::jsonb not null,
  duplicate_of_buyer_id bigint,
  buyer_id bigint,
  reject_reason text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  submitted_ip inet,
  user_agent text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buy_box_templates (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text not null,
  description text,
  is_default boolean default false not null,
  beds_min smallint,
  beds_max smallint,
  baths_min numeric(3,1),
  baths_max numeric(3,1),
  sqft_min integer,
  sqft_max integer,
  year_built_min integer,
  year_built_max integer,
  acreage_min numeric(10,2),
  acreage_max numeric(10,2),
  price_min numeric,
  price_max numeric,
  property_types text[] default '{}'::text[] not null,
  rehab_levels text[] default '{}'::text[] not null,
  rehab_avoided text[] default '{}'::text[] not null,
  specialty_rehabs text[] default '{}'::text[] not null,
  specialty_avoid text[] default '{}'::text[] not null,
  strategy_types text[] default '{}'::text[] not null,
  financing_types text[] default '{}'::text[] not null,
  restrictions text[] default '{}'::text[] not null,
  requirements text[] default '{}'::text[] not null,
  strict_fields text[] default '{}'::text[] not null,
  max_arv_pct numeric(5,2),
  markets jsonb default '[]'::jsonb not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buyer_contacts (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  buyer_id bigint not null,
  full_name text not null,
  rank smallint default 1 not null,
  rank_text text,
  role text,
  email text,
  buyer_type text,
  engagement_score integer default 0 not null,
  is_verified boolean default false not null,
  is_primary boolean default false not null,
  tags text[] default '{}'::text[] not null,
  source text,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buyer_import_batches (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text,
  storage_path text,
  status text default 'uploaded'::text not null,
  column_map jsonb default '{}'::jsonb not null,
  template_id bigint,
  default_level smallint,
  include_rejected boolean default false not null,
  row_count integer default 0 not null,
  approved_count integer default 0 not null,
  rejected_count integer default 0 not null,
  duplicate_count integer default 0 not null,
  imported_count integer default 0 not null,
  error text,
  created_by uuid,
  cancelled_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buyer_import_column_maps (
  id bigint generated always as identity not null,
  workspace_id bigint,
  name text not null,
  source text not null,
  column_map jsonb not null,
  value_map jsonb default '{}'::jsonb not null,
  skip_rules jsonb default '{}'::jsonb not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buyer_import_rows (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  batch_id bigint not null,
  row_no integer not null,
  raw jsonb default '{}'::jsonb not null,
  parsed jsonb default '{}'::jsonb not null,
  status text default 'pending'::text not null,
  duplicate_of_buyer_id bigint,
  duplicate_reason text,
  reject_reason text,
  error text,
  buyer_id bigint,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buyer_markets (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  buyer_id bigint not null,
  kind text not null,
  name text not null,
  state text,
  match_type text default 'exact'::text not null,
  radius_miles numeric(6,1),
  lat double precision,
  lng double precision,
  restricted boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.buyer_phones (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  buyer_id bigint not null,
  contact_id bigint,
  phone text not null,
  "position" smallint default 1 not null,
  kind text default 'mobile'::text not null,
  source text,
  is_dnc boolean default false not null,
  is_verified boolean default false not null,
  call_count integer default 0 not null,
  message_count integer default 0 not null,
  last_contacted_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  phone_key text generated always as (normalize_phone(phone)) stored
);

create table if not exists public.buyer_rule_states (
  rule_id bigint not null,
  buyer_id bigint not null,
  workspace_id bigint not null,
  was_true boolean default false not null,
  last_applied_at timestamp with time zone,
  apply_count integer default 0 not null
);

create table if not exists public.buyers (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text not null,
  company text,
  email text,
  phone text,
  markets text[] default '{}'::text[] not null,
  max_purchase_price numeric,
  buy_box text,
  status text default 'active'::text not null,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  phone_key text generated always as (normalize_phone(phone)) stored,
  source text,
  source_id text,
  level smallint default 3 not null,
  level_changed_at timestamp with time zone,
  jurisdiction_name text,
  filing_date date,
  is_verified boolean default false not null,
  outreach_numbers text default 'first_two'::text not null,
  beds_min smallint,
  beds_max smallint,
  baths_min numeric(3,1),
  baths_max numeric(3,1),
  sqft_min integer,
  sqft_max integer,
  year_built_min integer,
  year_built_max integer,
  acreage_min numeric(10,2),
  acreage_max numeric(10,2),
  property_types text[] default '{}'::text[] not null,
  rehab_levels text[] default '{}'::text[] not null,
  rehab_avoided text[] default '{}'::text[] not null,
  specialty_rehabs text[] default '{}'::text[] not null,
  specialty_avoid text[] default '{}'::text[] not null,
  strategy_types text[] default '{}'::text[] not null,
  financing_types text[] default '{}'::text[] not null,
  property_preference text,
  restrictions text[] default '{}'::text[] not null,
  requirements text[] default '{}'::text[] not null,
  strict_fields text[] default '{}'::text[] not null,
  max_arv_pct numeric(5,2),
  owner_id uuid,
  compr_signup jsonb
);

create table if not exists public.checklist_template_items (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  template_id bigint not null,
  "position" integer default 0 not null,
  title text not null,
  notes text,
  task_type text,
  priority text default 'Medium'::text,
  due_offset_days integer,
  assign_role text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.checklist_templates (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text not null,
  description text,
  stage text,
  auto_apply boolean default false not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.communications (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  seller_id bigint,
  channel text not null,
  direction text,
  occurred_at timestamp with time zone default now() not null,
  from_phone text,
  to_phone text,
  subject text,
  body text,
  summary text,
  duration_s integer,
  recording_url text,
  source text not null,
  source_id text not null,
  created_at timestamp with time zone default now() not null,
  status text,
  thread_id bigint
);

create table if not exists public.deal_outreach_settings (
  deal_id bigint not null,
  workspace_id bigint not null,
  enabled boolean default false not null,
  from_phone text,
  from_phone_number_id text,
  numbers_to_try text default 'first_two'::text not null,
  daily_cap integer default 100 not null,
  strategy_types text[] default '{}'::text[] not null,
  tone text default 'friendly'::text not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.deal_page_views (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint not null,
  link_id bigint,
  match_id bigint,
  buyer_id bigint,
  session_key text not null,
  first_seen_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  seconds integer default 0 not null,
  photo_clicks integer default 0 not null,
  referrer text,
  user_agent text
);

create table if not exists public.deal_public_links (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint not null,
  slug text not null,
  active boolean default true not null,
  show_viewers boolean default false not null,
  show_address boolean default true not null,
  allow_offers boolean default true not null,
  headline text,
  description text,
  expires_at timestamp with time zone,
  view_count integer default 0 not null,
  unique_viewers integer default 0 not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.deals (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  seller_id bigint,
  property_id bigint,
  stage text default 'Prospect'::text not null,
  offer_amount numeric,
  arv numeric,
  rehab numeric,
  mao numeric,
  assignment_fee numeric,
  contract_date date,
  close_date date,
  owner_id uuid,
  market text,
  source text,
  source_id text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  underwriting_url text,
  condition_notes text,
  occupancy_notes text,
  earnest_money numeric,
  dispo_rep_id uuid,
  dispo_rep2_id uuid,
  buyer_id bigint,
  sold_price numeric,
  marketing_started_on date,
  tc_rep_id uuid,
  title_vendor_id bigint,
  title_contact text,
  title_email text,
  title_phone text,
  closed_on date,
  cogs_bonuses numeric default 0 not null,
  cogs_lockbox numeric default 0 not null,
  cogs_photos numeric default 0 not null,
  cogs_lead numeric default 0 not null,
  cogs_contractor numeric default 0 not null,
  cogs_earnest_lost numeric default 0 not null,
  cogs_notary numeric default 0 not null,
  cogs_title_fees numeric default 0 not null,
  cogs_transactional numeric default 0 not null,
  cogs_realtor numeric default 0 not null,
  lac_pct numeric default 0 not null,
  bac_pct numeric default 0 not null,
  cogs_flat_fee numeric default 0 not null,
  cogs_concessions numeric default 0 not null,
  team_commissions_paid numeric default 0 not null,
  terminated boolean default false not null,
  terminated_on date,
  termination_reason text,
  earnest_refunded boolean,
  wholesale_fee numeric generated always as ((COALESCE(sold_price, (0)::numeric) - COALESCE(offer_amount, (0)::numeric))) stored,
  listing_agent_commission numeric generated always as (((COALESCE(sold_price, (0)::numeric) * lac_pct) / (100)::numeric)) stored,
  buyers_agent_commission numeric generated always as (((COALESCE(sold_price, (0)::numeric) * bac_pct) / (100)::numeric)) stored,
  total_cogs numeric generated always as ((((((((((((((cogs_bonuses + cogs_lockbox) + cogs_photos) + cogs_lead) + cogs_contractor) + cogs_earnest_lost) + cogs_notary) + cogs_title_fees) + cogs_transactional) + cogs_realtor) + ((COALESCE(sold_price, (0)::numeric) * lac_pct) / (100)::numeric)) + ((COALESCE(sold_price, (0)::numeric) * bac_pct) / (100)::numeric)) + cogs_flat_fee) + cogs_concessions)) stored,
  deal_net_profit numeric generated always as (((COALESCE(sold_price, (0)::numeric) - COALESCE(offer_amount, (0)::numeric)) - (((((((((((((cogs_bonuses + cogs_lockbox) + cogs_photos) + cogs_lead) + cogs_contractor) + cogs_earnest_lost) + cogs_notary) + cogs_title_fees) + cogs_transactional) + cogs_realtor) + ((COALESCE(sold_price, (0)::numeric) * lac_pct) / (100)::numeric)) + ((COALESCE(sold_price, (0)::numeric) * bac_pct) / (100)::numeric)) + cogs_flat_fee) + cogs_concessions))) stored,
  final_profit numeric generated always as ((((COALESCE(sold_price, (0)::numeric) - COALESCE(offer_amount, (0)::numeric)) - (((((((((((((cogs_bonuses + cogs_lockbox) + cogs_photos) + cogs_lead) + cogs_contractor) + cogs_earnest_lost) + cogs_notary) + cogs_title_fees) + cogs_transactional) + cogs_realtor) + ((COALESCE(sold_price, (0)::numeric) * lac_pct) / (100)::numeric)) + ((COALESCE(sold_price, (0)::numeric) * bac_pct) / (100)::numeric)) + cogs_flat_fee) + cogs_concessions)) - team_commissions_paid)) stored,
  property_timezone text,
  min_offer_amount numeric,
  buyer_emd_amount numeric,
  inhouse_emd_amount numeric,
  inhouse_emd_due_on date,
  property_access text,
  occupancy_at_close text,
  arv_low numeric,
  arv_high numeric,
  strategy_type text,
  dispogenius_deal_id text,
  compr_lead_id text,
  compr_underwritten_at timestamp with time zone,
  podio_item_id text,
  mao_wholesale numeric,
  mao_institutional numeric,
  underwrite_confidence integer,
  underwrite_comp_count integer,
  underwrite_condition text,
  underwrite_status text,
  underwrite_red_flags jsonb
);

create table if not exists public.discovery_entities (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  job_id bigint not null,
  name text not null,
  jurisdiction_name text,
  filing_date date,
  is_verified boolean default false not null,
  total_owned integer,
  total_value numeric,
  purchased_last_6_months integer,
  purchased_last_12_months integer,
  matched_property_ids bigint[] default '{}'::bigint[] not null,
  buyer_id bigint,
  promoted_at timestamp with time zone,
  raw jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.discovery_individuals (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  entity_id bigint not null,
  full_name text not null,
  rank smallint,
  rank_text text,
  buyer_type text,
  engagement_score integer,
  tags text[] default '{}'::text[] not null,
  personalized_message text,
  contact_info jsonb default '[]'::jsonb not null,
  contact_id bigint,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.discovery_jobs (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint,
  run_id bigint,
  task_key text default encode(gen_random_bytes(12), 'hex'::text) not null,
  phase text default 'properties'::text not null,
  status text default 'queued'::text not null,
  subject jsonb default '{}'::jsonb not null,
  radius_mi numeric(6,1),
  sold_within_months integer,
  property_types text[] default '{}'::text[] not null,
  strategy text,
  asking_price numeric,
  total integer default 0 not null,
  completed integer default 0 not null,
  error_count integer default 0 not null,
  message text,
  error text,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.discovery_properties (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  job_id bigint not null,
  address text,
  city text,
  state text,
  zip text,
  county text,
  lat double precision,
  lng double precision,
  distance_mi numeric(6,2),
  strategy text,
  purchased_price numeric,
  purchase_date date,
  sold_price numeric,
  sold_date date,
  months_between integer,
  price_diff numeric,
  days_on_market integer,
  suggested_rent numeric,
  in_state_absentee_owner boolean,
  likelihood_to_buy smallint,
  percentage_of_arv numeric(6,2),
  zillow_link text,
  raw jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.dispo_engagement_events (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint,
  buyer_id bigint,
  match_id bigint,
  campaign_id bigint,
  message_id bigint,
  kind text not null,
  channel text,
  url text,
  meta jsonb default '{}'::jsonb not null,
  occurred_at timestamp with time zone default now() not null
);

create table if not exists public.dispo_match_snapshot_rows (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  snapshot_id bigint not null,
  buyer_id bigint not null,
  score integer default 0 not null,
  reasons text[] default '{}'::text[] not null,
  level smallint,
  probability smallint,
  excluded boolean default false not null,
  excluded_reason text,
  excluded_by uuid,
  excluded_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.dispo_match_snapshots (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint not null,
  campaign_id bigint,
  status text default 'draft'::text not null,
  min_score integer default 55 not null,
  buyer_count integer default 0 not null,
  excluded_count integer default 0 not null,
  summary jsonb default '{}'::jsonb not null,
  frozen_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.dispogenius_buyer_snapshots (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  run_id bigint,
  dispogenius_deal_id text not null,
  dispogenius_buyer_id text not null,
  buyer_name text,
  buyer_company text,
  email text,
  phone text,
  phone_key text generated always as (normalize_phone(phone)) stored,
  status text,
  temperature text,
  probability_score numeric(6,2),
  stars integer,
  email_opened_count integer,
  link_clicks integer,
  call_count integer,
  message_count integer,
  replied boolean,
  offered boolean,
  offer_amount numeric,
  pct_of_arv numeric(6,2),
  raw jsonb default '{}'::jsonb not null,
  deal_id bigint,
  buyer_id bigint,
  pulled_at timestamp with time zone default now() not null,
  pulled_on date default ((now() AT TIME ZONE 'utc'::text))::date not null
);

create table if not exists public.dispogenius_sync_runs (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  kind text default 'buyers'::text not null,
  status text default 'running'::text not null,
  deals_polled integer default 0 not null,
  rows_written integer default 0 not null,
  error text,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone
);

create table if not exists public.enrollments (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  plan_id bigint not null,
  seller_id bigint,
  status text default 'active'::text not null,
  step_index integer default 0 not null,
  enrolled_at timestamp with time zone default now() not null,
  completed_at timestamp with time zone,
  created_by uuid
);

create table if not exists public.inbox_threads (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  phone_key text not null,
  our_phone text,
  buyer_id bigint,
  seller_id bigint,
  assigned_to uuid,
  status text default 'open'::text not null,
  starred boolean default false not null,
  unread_count integer default 0 not null,
  last_message_at timestamp with time zone,
  last_inbound_at timestamp with time zone,
  last_outbound_at timestamp with time zone,
  last_direction text,
  last_channel text,
  last_preview text,
  awaiting_reply_since timestamp with time zone,
  opted_out_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.ingest_events (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  source text not null,
  source_id text not null,
  event_type text not null,
  occurred_at timestamp with time zone,
  payload jsonb not null,
  address_key text,
  phone_key text,
  property_id bigint,
  seller_id bigint,
  status text default 'applied'::text not null,
  error text,
  received_at timestamp with time zone default now() not null,
  communication_id bigint
);

create table if not exists public.ingest_sources (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text not null,
  label text,
  key_hash text not null,
  key_prefix text not null,
  active boolean default true not null,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  settings jsonb default '{}'::jsonb not null
);

create table if not exists public.notification_preferences (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  user_id uuid not null,
  category text not null,
  in_app boolean default true not null,
  email boolean default false not null,
  sms boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.notifications (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  user_id uuid,
  category text default 'System'::text not null,
  title text not null,
  body text,
  seller_id bigint,
  deal_id bigint,
  read_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.offers (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint,
  property_id bigint,
  buyer_id bigint,
  direction text default 'outbound'::text not null,
  amount numeric,
  status text default 'Sent'::text not null,
  sent_at timestamp with time zone default now() not null,
  responded_at timestamp with time zone,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  kill_reason text,
  offer_score smallint,
  killed_at timestamp with time zone,
  killed_by uuid
);

create table if not exists public.outreach_snippets (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  kind text not null,
  body text not null,
  channel text default 'sms'::text not null,
  active boolean default true not null,
  "position" integer default 0 not null,
  use_count integer default 0 not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.profiles (
  id uuid not null,
  full_name text,
  avatar_url text,
  phone text,
  title text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  email text
);

create table if not exists public.properties (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  address_key text generated always as (address_key(line1, city, state, zip)) stored,
  line1 text not null,
  city text,
  state text,
  zip text,
  apn text,
  beds numeric,
  baths numeric,
  sqft integer,
  year_built integer,
  property_type text,
  source text,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  geo_precision text
);

create table if not exists public.sellers (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  name text not null,
  email text,
  phone text,
  property_address text,
  asking_price numeric,
  motivation text,
  lead_stage text default 'Lead'::text not null,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  property_id bigint,
  phone_key text generated always as (normalize_phone(phone)) stored,
  source text,
  source_id text,
  assigned_to uuid,
  tags text[] default '{}'::text[] not null,
  archived_at timestamp with time zone,
  owner_id uuid
);

create table if not exists public.tasks (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  seller_id bigint,
  deal_id bigint,
  title text not null,
  task_type text default 'Call'::text not null,
  priority text default 'Medium'::text not null,
  due_at timestamp with time zone,
  assigned_to uuid,
  done boolean default false not null,
  completed_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  notes text,
  enrollment_id bigint,
  plan_step_id bigint
);

create table if not exists public.transaction_items (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  transaction_id bigint not null,
  "position" integer default 0 not null,
  label text not null,
  owner_role text,
  due_date date,
  done boolean default false not null,
  completed_at timestamp with time zone,
  blocker text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.transactions (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint,
  property_id bigint,
  seller_id bigint,
  buyer_id bigint,
  title_company text,
  escrow_officer text,
  emd_amount numeric,
  emd_received_at timestamp with time zone,
  close_date date,
  status text default 'Open'::text not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.underwrites (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint not null,
  source text default 'manual'::text not null,
  status text,
  arv numeric,
  arv_low numeric,
  arv_high numeric,
  rehab numeric,
  mao numeric,
  mao_wholesale numeric,
  mao_institutional numeric,
  asking_price numeric,
  target_assignment numeric,
  confidence integer,
  comp_count integer,
  condition text,
  red_flags jsonb,
  report_url text,
  lead_id text,
  notes text,
  is_current boolean default true not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.vendors (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  business_name text not null,
  contact_name text,
  email text,
  phone text,
  service_type text,
  markets text[] default '{}'::text[] not null,
  status text default 'active'::text not null,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.walkthrough_invites (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  slot_id bigint not null,
  buyer_id bigint,
  match_id bigint,
  status text default 'invited'::text not null,
  reminder_at timestamp with time zone,
  reminded_at timestamp with time zone,
  responded_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.walkthrough_slots (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  deal_id bigint not null,
  appointment_id bigint,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null,
  kind text default 'open'::text not null,
  capacity smallint default 1 not null,
  status text default 'available'::text not null,
  access_notes text,
  pre_walkthrough_notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.workspace_goals (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  period text default 'month'::text not null,
  period_start date not null,
  metric text not null,
  target numeric not null,
  owner_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.workspace_invites (
  id bigint generated always as identity not null,
  workspace_id bigint not null,
  email text not null,
  role text not null,
  full_name text,
  invited_by uuid,
  accepted_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.workspace_members (
  workspace_id bigint not null,
  user_id uuid not null,
  role text default 'member'::text not null,
  joined_at timestamp with time zone default now() not null
);

create table if not exists public.workspaces (
  id bigint generated always as identity not null,
  name text not null,
  owner_id uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  calendar_token text,
  settings jsonb default '{}'::jsonb not null
);

CREATE OR REPLACE FUNCTION public.build_buyer_criteria(b buyers)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with m as (
    select kind, name, restricted from public.buyer_markets where buyer_id = b.id
  ),
  place as (
    select
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='city'   and not restricted), '[]') as cities,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='county' and not restricted), '[]') as counties,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='state'  and not restricted), '[]') as states,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='zip'    and not restricted), '[]') as zips,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='city'   and restricted), '[]') as r_cities,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='county' and restricted), '[]') as r_counties,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='state'  and restricted), '[]') as r_states,
      coalesce(jsonb_agg(to_jsonb(name)) filter (where kind='zip'    and restricted), '[]') as r_zips
    from m
  )
  select
    coalesce(b.criteria, '{}'::jsonb)
    -- Geography: only when this buyer actually has coverage rows.
    || case when (select count(*) from m where not restricted) > 0
            then jsonb_build_object('locations',
                   jsonb_build_object('cities', p.cities, 'counties', p.counties,
                                      'states', p.states, 'zips', p.zips))
            else '{}'::jsonb end
    || case when (select count(*) from m where restricted) > 0
            then jsonb_build_object('restricted',
                   jsonb_build_object('cities', p.r_cities, 'counties', p.r_counties,
                                      'states', p.r_states, 'zips', p.r_zips))
            else '{}'::jsonb end
    -- Arrays: an empty typed column leaves whatever the jsonb already held.
    || case when cardinality(b.property_types)  > 0 then jsonb_build_object('property_types',  to_jsonb(b.property_types))  else '{}'::jsonb end
    || case when cardinality(b.restrictions)    > 0 then jsonb_build_object('restrictions',    to_jsonb(b.restrictions))    else '{}'::jsonb end
    || case when cardinality(b.requirements)    > 0 then jsonb_build_object('requirements',    to_jsonb(b.requirements))    else '{}'::jsonb end
    || case when cardinality(b.specialty_avoid) > 0 then jsonb_build_object('specialty_avoid', to_jsonb(b.specialty_avoid)) else '{}'::jsonb end
    || case when cardinality(b.strategy_types)  > 0 then jsonb_build_object('strategy_types',  to_jsonb(b.strategy_types))  else '{}'::jsonb end
    || case when cardinality(b.financing_types) > 0 then jsonb_build_object('financing_types', to_jsonb(b.financing_types)) else '{}'::jsonb end
    || case when cardinality(b.strict_fields)   > 0 then jsonb_build_object('strict',          to_jsonb(b.strict_fields))   else '{}'::jsonb end
    || case when cardinality(b.rehab_avoided) > 0 or cardinality(b.rehab_levels) > 0
            then jsonb_build_object('rehab',
                   coalesce(b.criteria->'rehab', '{}'::jsonb)
                   || case when cardinality(b.rehab_avoided) > 0 then jsonb_build_object('avoided', to_jsonb(b.rehab_avoided)) else '{}'::jsonb end
                   || case when cardinality(b.rehab_levels)  > 0 then jsonb_build_object('wanted',  to_jsonb(b.rehab_levels))  else '{}'::jsonb end)
            else '{}'::jsonb end
    -- Ranges: only when at least one bound is set.
    || case when b.beds_min is not null or b.beds_max is not null
            then jsonb_build_object('beds', jsonb_strip_nulls(jsonb_build_object('min', b.beds_min, 'max', b.beds_max))) else '{}'::jsonb end
    || case when b.baths_min is not null or b.baths_max is not null
            then jsonb_build_object('baths', jsonb_strip_nulls(jsonb_build_object('min', b.baths_min, 'max', b.baths_max))) else '{}'::jsonb end
    || case when b.sqft_min is not null or b.sqft_max is not null
            then jsonb_build_object('sqft', jsonb_strip_nulls(jsonb_build_object('min', b.sqft_min, 'max', b.sqft_max))) else '{}'::jsonb end
    || case when b.year_built_min is not null or b.year_built_max is not null
            then jsonb_build_object('year_built', jsonb_strip_nulls(jsonb_build_object('min', b.year_built_min, 'max', b.year_built_max))) else '{}'::jsonb end
    || case when b.acreage_min is not null or b.acreage_max is not null
            then jsonb_build_object('acreage', jsonb_strip_nulls(jsonb_build_object('min', b.acreage_min, 'max', b.acreage_max))) else '{}'::jsonb end
    || case when b.min_purchase_price is not null or b.max_purchase_price is not null
            then jsonb_build_object('price', jsonb_strip_nulls(jsonb_build_object('min', b.min_purchase_price, 'max', b.max_purchase_price))) else '{}'::jsonb end
    || case when b.max_arv_pct is not null
            then jsonb_build_object('economics', coalesce(b.criteria->'economics', '{}'::jsonb) || jsonb_build_object('max_arv_pct', b.max_arv_pct))
            else '{}'::jsonb end
  from place p;
$function$;

CREATE OR REPLACE FUNCTION public.save_underwrite(p_deal_id bigint, p_source text DEFAULT 'manual'::text, p_arv numeric DEFAULT NULL::numeric, p_arv_low numeric DEFAULT NULL::numeric, p_arv_high numeric DEFAULT NULL::numeric, p_rehab numeric DEFAULT NULL::numeric, p_mao numeric DEFAULT NULL::numeric, p_mao_wholesale numeric DEFAULT NULL::numeric, p_mao_institutional numeric DEFAULT NULL::numeric, p_asking_price numeric DEFAULT NULL::numeric, p_target_assignment numeric DEFAULT NULL::numeric, p_confidence integer DEFAULT NULL::integer, p_comp_count integer DEFAULT NULL::integer, p_condition text DEFAULT NULL::text, p_red_flags jsonb DEFAULT NULL::jsonb, p_report_url text DEFAULT NULL::text, p_lead_id text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS underwrites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_ws  bigint;
  v_row public.underwrites;
begin
  select workspace_id into v_ws from public.deals where id = p_deal_id;
  if v_ws is null then
    raise exception 'deal % does not exist', p_deal_id using errcode = 'no_data_found';
  end if;
  -- SECURITY DEFINER, so the caller's membership is checked explicitly.
  if not public.is_workspace_member(v_ws) then
    raise exception 'not your workspace' using errcode = 'insufficient_privilege';
  end if;

  update public.underwrites set is_current = false
   where deal_id = p_deal_id and is_current;

  insert into public.underwrites (
    workspace_id, deal_id, source, status, arv, arv_low, arv_high, rehab, mao,
    mao_wholesale, mao_institutional, asking_price, target_assignment,
    confidence, comp_count, condition, red_flags, report_url, lead_id, notes,
    is_current, created_by
  ) values (
    v_ws, p_deal_id, coalesce(p_source,'manual'), p_status, p_arv, p_arv_low,
    p_arv_high, p_rehab, p_mao, p_mao_wholesale, p_mao_institutional,
    p_asking_price, p_target_assignment, p_confidence, p_comp_count,
    p_condition, p_red_flags, p_report_url, p_lead_id, p_notes,
    true, auth.uid()
  ) returning * into v_row;

  -- Mirror onto deals. coalesce so a partial save never blanks a column that
  -- the new version simply did not speak to.
  update public.deals d set
    arv                   = coalesce(v_row.arv,               d.arv),
    arv_low               = coalesce(v_row.arv_low,           d.arv_low),
    arv_high              = coalesce(v_row.arv_high,          d.arv_high),
    rehab                 = coalesce(v_row.rehab,             d.rehab),
    mao                   = coalesce(v_row.mao,               d.mao),
    mao_wholesale         = coalesce(v_row.mao_wholesale,     d.mao_wholesale),
    mao_institutional     = coalesce(v_row.mao_institutional, d.mao_institutional),
    asking_price          = coalesce(v_row.asking_price,      d.asking_price),
    target_assignment     = coalesce(v_row.target_assignment, d.target_assignment),
    underwrite_confidence = coalesce(v_row.confidence,        d.underwrite_confidence),
    underwrite_comp_count = coalesce(v_row.comp_count,        d.underwrite_comp_count),
    underwrite_condition  = coalesce(v_row.condition,         d.underwrite_condition),
    underwrite_status     = coalesce(v_row.status,            d.underwrite_status),
    underwrite_red_flags  = coalesce(v_row.red_flags,         d.underwrite_red_flags),
    -- compr_* only when the version actually came from COMPR.
    compr_report_url      = case when v_row.source = 'compr'
                                 then coalesce(v_row.report_url, d.compr_report_url)
                                 else d.compr_report_url end,
    compr_lead_id         = case when v_row.source = 'compr'
                                 then coalesce(v_row.lead_id, d.compr_lead_id)
                                 else d.compr_lead_id end,
    compr_underwritten_at = case when v_row.source = 'compr'
                                 then now() else d.compr_underwritten_at end,
    updated_at            = now()
  where d.id = p_deal_id;

  return v_row;
end $function$;

-- ---------------------------------------------------------------- constraints

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'action_plan_steps_pkey' and conrelid = 'public.action_plan_steps'::regclass) then
    alter table public.action_plan_steps add constraint action_plan_steps_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'action_plans_pkey' and conrelid = 'public.action_plans'::regclass) then
    alter table public.action_plans add constraint action_plans_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'activity_pkey' and conrelid = 'public.activity'::regclass) then
    alter table public.activity add constraint activity_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_pkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_links_pkey' and conrelid = 'public.buy_box_links'::regclass) then
    alter table public.buy_box_links add constraint buy_box_links_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_submissions_pkey' and conrelid = 'public.buy_box_submissions'::regclass) then
    alter table public.buy_box_submissions add constraint buy_box_submissions_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_templates_pkey' and conrelid = 'public.buy_box_templates'::regclass) then
    alter table public.buy_box_templates add constraint buy_box_templates_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_contacts_pkey' and conrelid = 'public.buyer_contacts'::regclass) then
    alter table public.buyer_contacts add constraint buyer_contacts_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_batches_pkey' and conrelid = 'public.buyer_import_batches'::regclass) then
    alter table public.buyer_import_batches add constraint buyer_import_batches_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_column_maps_pkey' and conrelid = 'public.buyer_import_column_maps'::regclass) then
    alter table public.buyer_import_column_maps add constraint buyer_import_column_maps_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_rows_pkey' and conrelid = 'public.buyer_import_rows'::regclass) then
    alter table public.buyer_import_rows add constraint buyer_import_rows_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_markets_pkey' and conrelid = 'public.buyer_markets'::regclass) then
    alter table public.buyer_markets add constraint buyer_markets_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_phones_pkey' and conrelid = 'public.buyer_phones'::regclass) then
    alter table public.buyer_phones add constraint buyer_phones_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_rule_states_pkey' and conrelid = 'public.buyer_rule_states'::regclass) then
    alter table public.buyer_rule_states add constraint buyer_rule_states_pkey PRIMARY KEY (rule_id, buyer_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_pkey' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checklist_template_items_pkey' and conrelid = 'public.checklist_template_items'::regclass) then
    alter table public.checklist_template_items add constraint checklist_template_items_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checklist_templates_pkey' and conrelid = 'public.checklist_templates'::regclass) then
    alter table public.checklist_templates add constraint checklist_templates_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communications_pkey' and conrelid = 'public.communications'::regclass) then
    alter table public.communications add constraint communications_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_outreach_settings_pkey' and conrelid = 'public.deal_outreach_settings'::regclass) then
    alter table public.deal_outreach_settings add constraint deal_outreach_settings_pkey PRIMARY KEY (deal_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_page_views_pkey' and conrelid = 'public.deal_page_views'::regclass) then
    alter table public.deal_page_views add constraint deal_page_views_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_public_links_pkey' and conrelid = 'public.deal_public_links'::regclass) then
    alter table public.deal_public_links add constraint deal_public_links_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_pkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_entities_pkey' and conrelid = 'public.discovery_entities'::regclass) then
    alter table public.discovery_entities add constraint discovery_entities_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_individuals_pkey' and conrelid = 'public.discovery_individuals'::regclass) then
    alter table public.discovery_individuals add constraint discovery_individuals_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_pkey' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_properties_pkey' and conrelid = 'public.discovery_properties'::regclass) then
    alter table public.discovery_properties add constraint discovery_properties_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_pkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshot_rows_pkey' and conrelid = 'public.dispo_match_snapshot_rows'::regclass) then
    alter table public.dispo_match_snapshot_rows add constraint dispo_match_snapshot_rows_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshots_pkey' and conrelid = 'public.dispo_match_snapshots'::regclass) then
    alter table public.dispo_match_snapshots add constraint dispo_match_snapshots_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_buyer_snapshots_pkey' and conrelid = 'public.dispogenius_buyer_snapshots'::regclass) then
    alter table public.dispogenius_buyer_snapshots add constraint dispogenius_buyer_snapshots_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_sync_runs_pkey' and conrelid = 'public.dispogenius_sync_runs'::regclass) then
    alter table public.dispogenius_sync_runs add constraint dispogenius_sync_runs_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'enrollments_pkey' and conrelid = 'public.enrollments'::regclass) then
    alter table public.enrollments add constraint enrollments_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_pkey' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_events_pkey' and conrelid = 'public.ingest_events'::regclass) then
    alter table public.ingest_events add constraint ingest_events_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_sources_pkey' and conrelid = 'public.ingest_sources'::regclass) then
    alter table public.ingest_sources add constraint ingest_sources_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notification_preferences_pkey' and conrelid = 'public.notification_preferences'::regclass) then
    alter table public.notification_preferences add constraint notification_preferences_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_pkey' and conrelid = 'public.notifications'::regclass) then
    alter table public.notifications add constraint notifications_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_pkey' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_snippets_pkey' and conrelid = 'public.outreach_snippets'::regclass) then
    alter table public.outreach_snippets add constraint outreach_snippets_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_pkey' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_pkey' and conrelid = 'public.properties'::regclass) then
    alter table public.properties add constraint properties_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sellers_pkey' and conrelid = 'public.sellers'::regclass) then
    alter table public.sellers add constraint sellers_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_pkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transaction_items_pkey' and conrelid = 'public.transaction_items'::regclass) then
    alter table public.transaction_items add constraint transaction_items_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_pkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'underwrites_pkey' and conrelid = 'public.underwrites'::regclass) then
    alter table public.underwrites add constraint underwrites_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_pkey' and conrelid = 'public.vendors'::regclass) then
    alter table public.vendors add constraint vendors_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_invites_pkey' and conrelid = 'public.walkthrough_invites'::regclass) then
    alter table public.walkthrough_invites add constraint walkthrough_invites_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_pkey' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_goals_pkey' and conrelid = 'public.workspace_goals'::regclass) then
    alter table public.workspace_goals add constraint workspace_goals_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_invites_pkey' and conrelid = 'public.workspace_invites'::regclass) then
    alter table public.workspace_invites add constraint workspace_invites_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_pkey' and conrelid = 'public.workspace_members'::regclass) then
    alter table public.workspace_members add constraint workspace_members_pkey PRIMARY KEY (workspace_id, user_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_pkey' and conrelid = 'public.workspaces'::regclass) then
    alter table public.workspaces add constraint workspaces_pkey PRIMARY KEY (id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_links_slug_key' and conrelid = 'public.buy_box_links'::regclass) then
    alter table public.buy_box_links add constraint buy_box_links_slug_key UNIQUE (slug);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_public_links_slug_key' and conrelid = 'public.deal_public_links'::regclass) then
    alter table public.deal_public_links add constraint deal_public_links_slug_key UNIQUE (slug);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_task_key_key' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_task_key_key UNIQUE (task_key);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_workspace_id_phone_key_key' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_workspace_id_phone_key_key UNIQUE (workspace_id, phone_key);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_invites_workspace_id_email_key' and conrelid = 'public.workspace_invites'::regclass) then
    alter table public.workspace_invites add constraint workspace_invites_workspace_id_email_key UNIQUE (workspace_id, email);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_calendar_token_key' and conrelid = 'public.workspaces'::regclass) then
    alter table public.workspaces add constraint workspaces_calendar_token_key UNIQUE (calendar_token);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'activity_entity_type_check' and conrelid = 'public.activity'::regclass) then
    alter table public.activity add constraint activity_entity_type_check CHECK ((entity_type = ANY (ARRAY['seller'::text, 'deal'::text, 'property'::text, 'buyer'::text, 'transaction'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_submissions_status_check' and conrelid = 'public.buy_box_submissions'::regclass) then
    alter table public.buy_box_submissions add constraint buy_box_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'duplicate'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_batches_status_check' and conrelid = 'public.buyer_import_batches'::regclass) then
    alter table public.buyer_import_batches add constraint buyer_import_batches_status_check CHECK ((status = ANY (ARRAY['uploaded'::text, 'mapping'::text, 'staged'::text, 'reviewing'::text, 'importing'::text, 'done'::text, 'cancelled'::text, 'error'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_rows_status_check' and conrelid = 'public.buyer_import_rows'::regclass) then
    alter table public.buyer_import_rows add constraint buyer_import_rows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'duplicate'::text, 'imported'::text, 'error'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_markets_kind_check' and conrelid = 'public.buyer_markets'::regclass) then
    alter table public.buyer_markets add constraint buyer_markets_kind_check CHECK ((kind = ANY (ARRAY['city'::text, 'county'::text, 'state'::text, 'zip'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_markets_match_type_check' and conrelid = 'public.buyer_markets'::regclass) then
    alter table public.buyer_markets add constraint buyer_markets_match_type_check CHECK ((match_type = ANY (ARRAY['exact'::text, 'radius'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_phones_kind_check' and conrelid = 'public.buyer_phones'::regclass) then
    alter table public.buyer_phones add constraint buyer_phones_kind_check CHECK ((kind = ANY (ARRAY['mobile'::text, 'landline'::text, 'voip'::text, 'unknown'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_phones_position_check' and conrelid = 'public.buyer_phones'::regclass) then
    alter table public.buyer_phones add constraint buyer_phones_position_check CHECK ((("position" >= 1) AND ("position" <= 3)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_level_range' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_level_range CHECK (((level >= 1) AND (level <= 5)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_outreach_numbers_chk' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_outreach_numbers_chk CHECK ((outreach_numbers = ANY (ARRAY['first'::text, 'first_two'::text, 'all'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_year_built_floor' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_year_built_floor CHECK (((year_built_min IS NULL) OR (year_built_min >= 1850)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communications_channel_check' and conrelid = 'public.communications'::regclass) then
    alter table public.communications add constraint communications_channel_check CHECK ((channel = ANY (ARRAY['call'::text, 'sms'::text, 'email'::text, 'voicemail'::text, 'note'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communications_direction_check' and conrelid = 'public.communications'::regclass) then
    alter table public.communications add constraint communications_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_outreach_settings_numbers_to_try_check' and conrelid = 'public.deal_outreach_settings'::regclass) then
    alter table public.deal_outreach_settings add constraint deal_outreach_settings_numbers_to_try_check CHECK ((numbers_to_try = ANY (ARRAY['first'::text, 'first_two'::text, 'all'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_outreach_settings_tone_check' and conrelid = 'public.deal_outreach_settings'::regclass) then
    alter table public.deal_outreach_settings add constraint deal_outreach_settings_tone_check CHECK ((tone = ANY (ARRAY['casual'::text, 'friendly'::text, 'professional'::text, 'urgent'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_phase_check' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_phase_check CHECK ((phase = ANY (ARRAY['properties'::text, 'individuals'::text, 'done'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_status_check' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_channel_check' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'call'::text, 'web'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_kind_check' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_kind_check CHECK ((kind = ANY (ARRAY['sent'::text, 'delivered'::text, 'bounced'::text, 'failed'::text, 'open'::text, 'click'::text, 'reply'::text, 'call'::text, 'page_view'::text, 'photo_click'::text, 'offer'::text, 'unsubscribe'::text, 'complaint'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshots_status_check' and conrelid = 'public.dispo_match_snapshots'::regclass) then
    alter table public.dispo_match_snapshots add constraint dispo_match_snapshots_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'frozen'::text, 'sent'::text, 'cancelled'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_sync_runs_kind_check' and conrelid = 'public.dispogenius_sync_runs'::regclass) then
    alter table public.dispogenius_sync_runs add constraint dispogenius_sync_runs_kind_check CHECK ((kind = ANY (ARRAY['buyers'::text, 'deals'::text, 'managers'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_sync_runs_status_check' and conrelid = 'public.dispogenius_sync_runs'::regclass) then
    alter table public.dispogenius_sync_runs add constraint dispogenius_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_status_check' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_events_status_check' and conrelid = 'public.ingest_events'::regclass) then
    alter table public.ingest_events add constraint ingest_events_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'failed'::text, 'ignored'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_direction_check' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_kill_reason_chk' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_kill_reason_chk CHECK (((kill_reason IS NULL) OR (kill_reason = ANY (ARRAY['price'::text, 'financing_fell_through'::text, 'inspection'::text, 'timeline'::text, 'buyer_ghosted'::text, 'better_offer'::text, 'seller_terminated'::text, 'title_issue'::text, 'other'::text]))));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_snippets_body_len' and conrelid = 'public.outreach_snippets'::regclass) then
    alter table public.outreach_snippets add constraint outreach_snippets_body_len CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 500)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_snippets_channel_check' and conrelid = 'public.outreach_snippets'::regclass) then
    alter table public.outreach_snippets add constraint outreach_snippets_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'both'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_snippets_kind_check' and conrelid = 'public.outreach_snippets'::regclass) then
    alter table public.outreach_snippets add constraint outreach_snippets_kind_check CHECK ((kind = ANY (ARRAY['greeting'::text, 'ending'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_geo_precision_chk' and conrelid = 'public.properties'::regclass) then
    alter table public.properties add constraint properties_geo_precision_chk CHECK (((geo_precision IS NULL) OR (geo_precision = ANY (ARRAY['rooftop'::text, 'zip'::text, 'city'::text]))));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'underwrites_confidence_check' and conrelid = 'public.underwrites'::regclass) then
    alter table public.underwrites add constraint underwrites_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100)));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'underwrites_source_check' and conrelid = 'public.underwrites'::regclass) then
    alter table public.underwrites add constraint underwrites_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'compr'::text, 'dispogenius'::text, 'import'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_invites_status_check' and conrelid = 'public.walkthrough_invites'::regclass) then
    alter table public.walkthrough_invites add constraint walkthrough_invites_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'confirmed'::text, 'declined'::text, 'attended'::text, 'no_show'::text, 'cancelled'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_kind_check' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_kind_check CHECK ((kind = ANY (ARRAY['open'::text, 'private'::text, 'broker'::text, 'inspection'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_status_check' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_status_check CHECK ((status = ANY (ARRAY['available'::text, 'booked'::text, 'completed'::text, 'cancelled'::text, 'no_show'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_time_chk' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_time_chk CHECK ((ends_at > starts_at));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_goals_metric_check' and conrelid = 'public.workspace_goals'::regclass) then
    alter table public.workspace_goals add constraint workspace_goals_metric_check CHECK ((metric = ANY (ARRAY['deals_closed'::text, 'assignment_fee_total'::text, 'assignment_fee_avg'::text, 'new_buyers'::text, 'deals_created'::text, 'offers_received'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_goals_period_check' and conrelid = 'public.workspace_goals'::regclass) then
    alter table public.workspace_goals add constraint workspace_goals_period_check CHECK ((period = ANY (ARRAY['month'::text, 'quarter'::text, 'year'::text])));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'action_plan_steps_plan_id_fkey' and conrelid = 'public.action_plan_steps'::regclass) then
    alter table public.action_plan_steps add constraint action_plan_steps_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES action_plans(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'action_plan_steps_workspace_id_fkey' and conrelid = 'public.action_plan_steps'::regclass) then
    alter table public.action_plan_steps add constraint action_plan_steps_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'action_plans_created_by_fkey' and conrelid = 'public.action_plans'::regclass) then
    alter table public.action_plans add constraint action_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'action_plans_workspace_id_fkey' and conrelid = 'public.action_plans'::regclass) then
    alter table public.action_plans add constraint action_plans_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'activity_actor_id_fkey' and conrelid = 'public.activity'::regclass) then
    alter table public.activity add constraint activity_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'activity_workspace_id_fkey' and conrelid = 'public.activity'::regclass) then
    alter table public.activity add constraint activity_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_buyer_id_fkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_created_by_fkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_deal_id_fkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_property_id_fkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_seller_id_fkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_workspace_id_fkey' and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_links_template_id_fkey' and conrelid = 'public.buy_box_links'::regclass) then
    alter table public.buy_box_links add constraint buy_box_links_template_id_fkey FOREIGN KEY (template_id) REFERENCES buy_box_templates(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_links_workspace_id_fkey' and conrelid = 'public.buy_box_links'::regclass) then
    alter table public.buy_box_links add constraint buy_box_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_submissions_buyer_id_fkey' and conrelid = 'public.buy_box_submissions'::regclass) then
    alter table public.buy_box_submissions add constraint buy_box_submissions_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_submissions_duplicate_of_buyer_id_fkey' and conrelid = 'public.buy_box_submissions'::regclass) then
    alter table public.buy_box_submissions add constraint buy_box_submissions_duplicate_of_buyer_id_fkey FOREIGN KEY (duplicate_of_buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_submissions_link_id_fkey' and conrelid = 'public.buy_box_submissions'::regclass) then
    alter table public.buy_box_submissions add constraint buy_box_submissions_link_id_fkey FOREIGN KEY (link_id) REFERENCES buy_box_links(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_submissions_workspace_id_fkey' and conrelid = 'public.buy_box_submissions'::regclass) then
    alter table public.buy_box_submissions add constraint buy_box_submissions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buy_box_templates_workspace_id_fkey' and conrelid = 'public.buy_box_templates'::regclass) then
    alter table public.buy_box_templates add constraint buy_box_templates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_contacts_buyer_id_fkey' and conrelid = 'public.buyer_contacts'::regclass) then
    alter table public.buyer_contacts add constraint buyer_contacts_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_contacts_workspace_id_fkey' and conrelid = 'public.buyer_contacts'::regclass) then
    alter table public.buyer_contacts add constraint buyer_contacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_batches_template_id_fkey' and conrelid = 'public.buyer_import_batches'::regclass) then
    alter table public.buyer_import_batches add constraint buyer_import_batches_template_id_fkey FOREIGN KEY (template_id) REFERENCES buy_box_templates(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_batches_workspace_id_fkey' and conrelid = 'public.buyer_import_batches'::regclass) then
    alter table public.buyer_import_batches add constraint buyer_import_batches_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_rows_batch_id_fkey' and conrelid = 'public.buyer_import_rows'::regclass) then
    alter table public.buyer_import_rows add constraint buyer_import_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES buyer_import_batches(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_rows_buyer_id_fkey' and conrelid = 'public.buyer_import_rows'::regclass) then
    alter table public.buyer_import_rows add constraint buyer_import_rows_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_rows_duplicate_of_buyer_id_fkey' and conrelid = 'public.buyer_import_rows'::regclass) then
    alter table public.buyer_import_rows add constraint buyer_import_rows_duplicate_of_buyer_id_fkey FOREIGN KEY (duplicate_of_buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_import_rows_workspace_id_fkey' and conrelid = 'public.buyer_import_rows'::regclass) then
    alter table public.buyer_import_rows add constraint buyer_import_rows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_markets_buyer_id_fkey' and conrelid = 'public.buyer_markets'::regclass) then
    alter table public.buyer_markets add constraint buyer_markets_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_markets_workspace_id_fkey' and conrelid = 'public.buyer_markets'::regclass) then
    alter table public.buyer_markets add constraint buyer_markets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_phones_buyer_id_fkey' and conrelid = 'public.buyer_phones'::regclass) then
    alter table public.buyer_phones add constraint buyer_phones_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_phones_contact_id_fkey' and conrelid = 'public.buyer_phones'::regclass) then
    alter table public.buyer_phones add constraint buyer_phones_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES buyer_contacts(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_phones_workspace_id_fkey' and conrelid = 'public.buyer_phones'::regclass) then
    alter table public.buyer_phones add constraint buyer_phones_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_rule_states_buyer_id_fkey' and conrelid = 'public.buyer_rule_states'::regclass) then
    alter table public.buyer_rule_states add constraint buyer_rule_states_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyer_rule_states_workspace_id_fkey' and conrelid = 'public.buyer_rule_states'::regclass) then
    alter table public.buyer_rule_states add constraint buyer_rule_states_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_created_by_fkey' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_owner_id_fkey' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buyers_workspace_id_fkey' and conrelid = 'public.buyers'::regclass) then
    alter table public.buyers add constraint buyers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checklist_template_items_template_id_fkey' and conrelid = 'public.checklist_template_items'::regclass) then
    alter table public.checklist_template_items add constraint checklist_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checklist_template_items_workspace_id_fkey' and conrelid = 'public.checklist_template_items'::regclass) then
    alter table public.checklist_template_items add constraint checklist_template_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checklist_templates_workspace_id_fkey' and conrelid = 'public.checklist_templates'::regclass) then
    alter table public.checklist_templates add constraint checklist_templates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communications_seller_id_fkey' and conrelid = 'public.communications'::regclass) then
    alter table public.communications add constraint communications_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communications_thread_id_fkey' and conrelid = 'public.communications'::regclass) then
    alter table public.communications add constraint communications_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES inbox_threads(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communications_workspace_id_fkey' and conrelid = 'public.communications'::regclass) then
    alter table public.communications add constraint communications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_outreach_settings_deal_id_fkey' and conrelid = 'public.deal_outreach_settings'::regclass) then
    alter table public.deal_outreach_settings add constraint deal_outreach_settings_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_outreach_settings_workspace_id_fkey' and conrelid = 'public.deal_outreach_settings'::regclass) then
    alter table public.deal_outreach_settings add constraint deal_outreach_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_page_views_buyer_id_fkey' and conrelid = 'public.deal_page_views'::regclass) then
    alter table public.deal_page_views add constraint deal_page_views_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_page_views_deal_id_fkey' and conrelid = 'public.deal_page_views'::regclass) then
    alter table public.deal_page_views add constraint deal_page_views_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_page_views_link_id_fkey' and conrelid = 'public.deal_page_views'::regclass) then
    alter table public.deal_page_views add constraint deal_page_views_link_id_fkey FOREIGN KEY (link_id) REFERENCES deal_public_links(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_page_views_workspace_id_fkey' and conrelid = 'public.deal_page_views'::regclass) then
    alter table public.deal_page_views add constraint deal_page_views_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_public_links_deal_id_fkey' and conrelid = 'public.deal_public_links'::regclass) then
    alter table public.deal_public_links add constraint deal_public_links_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deal_public_links_workspace_id_fkey' and conrelid = 'public.deal_public_links'::regclass) then
    alter table public.deal_public_links add constraint deal_public_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_buyer_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_created_by_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_dispo_rep2_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_dispo_rep2_id_fkey FOREIGN KEY (dispo_rep2_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_dispo_rep_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_dispo_rep_id_fkey FOREIGN KEY (dispo_rep_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_owner_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_property_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_seller_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_tc_rep_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_tc_rep_id_fkey FOREIGN KEY (tc_rep_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_title_vendor_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_title_vendor_id_fkey FOREIGN KEY (title_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_workspace_id_fkey' and conrelid = 'public.deals'::regclass) then
    alter table public.deals add constraint deals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_entities_buyer_id_fkey' and conrelid = 'public.discovery_entities'::regclass) then
    alter table public.discovery_entities add constraint discovery_entities_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_entities_job_id_fkey' and conrelid = 'public.discovery_entities'::regclass) then
    alter table public.discovery_entities add constraint discovery_entities_job_id_fkey FOREIGN KEY (job_id) REFERENCES discovery_jobs(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_entities_workspace_id_fkey' and conrelid = 'public.discovery_entities'::regclass) then
    alter table public.discovery_entities add constraint discovery_entities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_individuals_contact_id_fkey' and conrelid = 'public.discovery_individuals'::regclass) then
    alter table public.discovery_individuals add constraint discovery_individuals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES buyer_contacts(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_individuals_entity_id_fkey' and conrelid = 'public.discovery_individuals'::regclass) then
    alter table public.discovery_individuals add constraint discovery_individuals_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES discovery_entities(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_individuals_workspace_id_fkey' and conrelid = 'public.discovery_individuals'::regclass) then
    alter table public.discovery_individuals add constraint discovery_individuals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_deal_id_fkey' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_jobs_workspace_id_fkey' and conrelid = 'public.discovery_jobs'::regclass) then
    alter table public.discovery_jobs add constraint discovery_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_properties_job_id_fkey' and conrelid = 'public.discovery_properties'::regclass) then
    alter table public.discovery_properties add constraint discovery_properties_job_id_fkey FOREIGN KEY (job_id) REFERENCES discovery_jobs(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'discovery_properties_workspace_id_fkey' and conrelid = 'public.discovery_properties'::regclass) then
    alter table public.discovery_properties add constraint discovery_properties_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_buyer_id_fkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_deal_id_fkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_engagement_events_workspace_id_fkey' and conrelid = 'public.dispo_engagement_events'::regclass) then
    alter table public.dispo_engagement_events add constraint dispo_engagement_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshot_rows_buyer_id_fkey' and conrelid = 'public.dispo_match_snapshot_rows'::regclass) then
    alter table public.dispo_match_snapshot_rows add constraint dispo_match_snapshot_rows_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshot_rows_snapshot_id_fkey' and conrelid = 'public.dispo_match_snapshot_rows'::regclass) then
    alter table public.dispo_match_snapshot_rows add constraint dispo_match_snapshot_rows_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES dispo_match_snapshots(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshot_rows_workspace_id_fkey' and conrelid = 'public.dispo_match_snapshot_rows'::regclass) then
    alter table public.dispo_match_snapshot_rows add constraint dispo_match_snapshot_rows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshots_deal_id_fkey' and conrelid = 'public.dispo_match_snapshots'::regclass) then
    alter table public.dispo_match_snapshots add constraint dispo_match_snapshots_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispo_match_snapshots_workspace_id_fkey' and conrelid = 'public.dispo_match_snapshots'::regclass) then
    alter table public.dispo_match_snapshots add constraint dispo_match_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_buyer_snapshots_buyer_id_fkey' and conrelid = 'public.dispogenius_buyer_snapshots'::regclass) then
    alter table public.dispogenius_buyer_snapshots add constraint dispogenius_buyer_snapshots_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_buyer_snapshots_deal_id_fkey' and conrelid = 'public.dispogenius_buyer_snapshots'::regclass) then
    alter table public.dispogenius_buyer_snapshots add constraint dispogenius_buyer_snapshots_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_buyer_snapshots_run_id_fkey' and conrelid = 'public.dispogenius_buyer_snapshots'::regclass) then
    alter table public.dispogenius_buyer_snapshots add constraint dispogenius_buyer_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES dispogenius_sync_runs(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_buyer_snapshots_workspace_id_fkey' and conrelid = 'public.dispogenius_buyer_snapshots'::regclass) then
    alter table public.dispogenius_buyer_snapshots add constraint dispogenius_buyer_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispogenius_sync_runs_workspace_id_fkey' and conrelid = 'public.dispogenius_sync_runs'::regclass) then
    alter table public.dispogenius_sync_runs add constraint dispogenius_sync_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'enrollments_created_by_fkey' and conrelid = 'public.enrollments'::regclass) then
    alter table public.enrollments add constraint enrollments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'enrollments_plan_id_fkey' and conrelid = 'public.enrollments'::regclass) then
    alter table public.enrollments add constraint enrollments_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES action_plans(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'enrollments_seller_id_fkey' and conrelid = 'public.enrollments'::regclass) then
    alter table public.enrollments add constraint enrollments_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'enrollments_workspace_id_fkey' and conrelid = 'public.enrollments'::regclass) then
    alter table public.enrollments add constraint enrollments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_assigned_to_fkey' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_buyer_id_fkey' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_seller_id_fkey' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_workspace_id_fkey' and conrelid = 'public.inbox_threads'::regclass) then
    alter table public.inbox_threads add constraint inbox_threads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_events_communication_id_fkey' and conrelid = 'public.ingest_events'::regclass) then
    alter table public.ingest_events add constraint ingest_events_communication_id_fkey FOREIGN KEY (communication_id) REFERENCES communications(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_events_property_id_fkey' and conrelid = 'public.ingest_events'::regclass) then
    alter table public.ingest_events add constraint ingest_events_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_events_seller_id_fkey' and conrelid = 'public.ingest_events'::regclass) then
    alter table public.ingest_events add constraint ingest_events_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_events_workspace_id_fkey' and conrelid = 'public.ingest_events'::regclass) then
    alter table public.ingest_events add constraint ingest_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_sources_workspace_id_fkey' and conrelid = 'public.ingest_sources'::regclass) then
    alter table public.ingest_sources add constraint ingest_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notification_preferences_workspace_id_fkey' and conrelid = 'public.notification_preferences'::regclass) then
    alter table public.notification_preferences add constraint notification_preferences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_deal_id_fkey' and conrelid = 'public.notifications'::regclass) then
    alter table public.notifications add constraint notifications_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_seller_id_fkey' and conrelid = 'public.notifications'::regclass) then
    alter table public.notifications add constraint notifications_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_user_id_fkey' and conrelid = 'public.notifications'::regclass) then
    alter table public.notifications add constraint notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_workspace_id_fkey' and conrelid = 'public.notifications'::regclass) then
    alter table public.notifications add constraint notifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_buyer_id_fkey' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_created_by_fkey' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_deal_id_fkey' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_property_id_fkey' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'offers_workspace_id_fkey' and conrelid = 'public.offers'::regclass) then
    alter table public.offers add constraint offers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_snippets_workspace_id_fkey' and conrelid = 'public.outreach_snippets'::regclass) then
    alter table public.outreach_snippets add constraint outreach_snippets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_id_fkey' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_workspace_id_fkey' and conrelid = 'public.properties'::regclass) then
    alter table public.properties add constraint properties_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sellers_assigned_to_fkey' and conrelid = 'public.sellers'::regclass) then
    alter table public.sellers add constraint sellers_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sellers_created_by_fkey' and conrelid = 'public.sellers'::regclass) then
    alter table public.sellers add constraint sellers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sellers_owner_id_fkey' and conrelid = 'public.sellers'::regclass) then
    alter table public.sellers add constraint sellers_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sellers_property_id_fkey' and conrelid = 'public.sellers'::regclass) then
    alter table public.sellers add constraint sellers_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sellers_workspace_id_fkey' and conrelid = 'public.sellers'::regclass) then
    alter table public.sellers add constraint sellers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_assigned_to_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_created_by_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_deal_id_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_enrollment_id_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_plan_step_id_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_plan_step_id_fkey FOREIGN KEY (plan_step_id) REFERENCES action_plan_steps(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_seller_id_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_workspace_id_fkey' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transaction_items_transaction_id_fkey' and conrelid = 'public.transaction_items'::regclass) then
    alter table public.transaction_items add constraint transaction_items_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transaction_items_workspace_id_fkey' and conrelid = 'public.transaction_items'::regclass) then
    alter table public.transaction_items add constraint transaction_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_buyer_id_fkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_created_by_fkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_deal_id_fkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_property_id_fkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_seller_id_fkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_workspace_id_fkey' and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions add constraint transactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'underwrites_deal_id_fkey' and conrelid = 'public.underwrites'::regclass) then
    alter table public.underwrites add constraint underwrites_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'underwrites_workspace_id_fkey' and conrelid = 'public.underwrites'::regclass) then
    alter table public.underwrites add constraint underwrites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_created_by_fkey' and conrelid = 'public.vendors'::regclass) then
    alter table public.vendors add constraint vendors_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_workspace_id_fkey' and conrelid = 'public.vendors'::regclass) then
    alter table public.vendors add constraint vendors_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_invites_buyer_id_fkey' and conrelid = 'public.walkthrough_invites'::regclass) then
    alter table public.walkthrough_invites add constraint walkthrough_invites_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_invites_slot_id_fkey' and conrelid = 'public.walkthrough_invites'::regclass) then
    alter table public.walkthrough_invites add constraint walkthrough_invites_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES walkthrough_slots(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_invites_workspace_id_fkey' and conrelid = 'public.walkthrough_invites'::regclass) then
    alter table public.walkthrough_invites add constraint walkthrough_invites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_appointment_id_fkey' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_deal_id_fkey' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'walkthrough_slots_workspace_id_fkey' and conrelid = 'public.walkthrough_slots'::regclass) then
    alter table public.walkthrough_slots add constraint walkthrough_slots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_goals_workspace_id_fkey' and conrelid = 'public.workspace_goals'::regclass) then
    alter table public.workspace_goals add constraint workspace_goals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_invites_invited_by_fkey' and conrelid = 'public.workspace_invites'::regclass) then
    alter table public.workspace_invites add constraint workspace_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_invites_workspace_id_fkey' and conrelid = 'public.workspace_invites'::regclass) then
    alter table public.workspace_invites add constraint workspace_invites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_profile_fkey' and conrelid = 'public.workspace_members'::regclass) then
    alter table public.workspace_members add constraint workspace_members_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_user_id_fkey' and conrelid = 'public.workspace_members'::regclass) then
    alter table public.workspace_members add constraint workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_workspace_id_fkey' and conrelid = 'public.workspace_members'::regclass) then
    alter table public.workspace_members add constraint workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_owner_id_fkey' and conrelid = 'public.workspaces'::regclass) then
    alter table public.workspaces add constraint workspaces_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

-- ---------------------------------------------------------------- indexes

create index if not exists action_plan_steps_plan_idx ON public.action_plan_steps USING btree (plan_id, "position");
create index if not exists activity_entity_idx ON public.activity USING btree (workspace_id, entity_type, entity_id, occurred_at DESC);
create index if not exists appointments_workspace_start_idx ON public.appointments USING btree (workspace_id, starts_at);
create index if not exists idx_appointments_deal ON public.appointments USING btree (deal_id) WHERE (deal_id IS NOT NULL);
create index if not exists idx_buy_box_links_slug ON public.buy_box_links USING btree (slug) WHERE active;
create index if not exists idx_buy_box_links_ws ON public.buy_box_links USING btree (workspace_id);
create index if not exists idx_buy_box_submissions_link ON public.buy_box_submissions USING btree (link_id, status, created_at DESC);
create index if not exists idx_buy_box_submissions_ws ON public.buy_box_submissions USING btree (workspace_id, status);
create unique index if not exists uq_buy_box_templates_default ON public.buy_box_templates USING btree (workspace_id) WHERE is_default;
create unique index if not exists uq_buy_box_templates_name ON public.buy_box_templates USING btree (workspace_id, lower(name));
create index if not exists idx_buyer_contacts_buyer ON public.buyer_contacts USING btree (buyer_id, rank);
create index if not exists idx_buyer_contacts_email ON public.buyer_contacts USING btree (workspace_id, lower(email)) WHERE (email IS NOT NULL);
create unique index if not exists uq_buyer_contacts_primary ON public.buyer_contacts USING btree (buyer_id) WHERE is_primary;
create index if not exists idx_buyer_import_batches_ws ON public.buyer_import_batches USING btree (workspace_id, created_at DESC);
create unique index if not exists uq_buyer_import_column_maps ON public.buyer_import_column_maps USING btree (COALESCE(workspace_id, (0)::bigint), name);
create index if not exists idx_buyer_import_rows_batch ON public.buyer_import_rows USING btree (batch_id, status, row_no);
create unique index if not exists uq_buyer_import_rows ON public.buyer_import_rows USING btree (batch_id, row_no);
create index if not exists idx_buyer_markets_buyer ON public.buyer_markets USING btree (buyer_id);
create index if not exists idx_buyer_markets_radius ON public.buyer_markets USING btree (workspace_id) WHERE (match_type = 'radius'::text);
create index if not exists idx_buyer_markets_ws ON public.buyer_markets USING btree (workspace_id, kind, lower(name));
create unique index if not exists uq_buyer_markets ON public.buyer_markets USING btree (buyer_id, kind, lower(name), COALESCE(upper(state), ''::text));
create index if not exists idx_buyer_phones_buyer ON public.buyer_phones USING btree (buyer_id, "position");
create index if not exists idx_buyer_phones_contact ON public.buyer_phones USING btree (contact_id);
create index if not exists idx_buyer_phones_key ON public.buyer_phones USING btree (workspace_id, phone_key) WHERE (phone_key IS NOT NULL);
create unique index if not exists uq_buyer_phones ON public.buyer_phones USING btree (buyer_id, phone);
create index if not exists idx_buyer_rule_states_buyer ON public.buyer_rule_states USING btree (buyer_id);
create index if not exists buyers_compr_signup_ws ON public.buyers USING btree (workspace_id) WHERE (compr_signup IS NOT NULL);
create index if not exists buyers_phone_idx ON public.buyers USING btree (workspace_id, phone_key) WHERE (phone_key IS NOT NULL);
create index if not exists buyers_workspace_idx ON public.buyers USING btree (workspace_id, updated_at DESC);
create index if not exists idx_buyers_level ON public.buyers USING btree (workspace_id, level);
create index if not exists idx_buyers_property_types ON public.buyers USING gin (property_types);
create index if not exists idx_buyers_strategy_types ON public.buyers USING gin (strategy_types);
create index if not exists idx_checklist_items_template ON public.checklist_template_items USING btree (template_id, "position");
create unique index if not exists uq_checklist_templates_auto ON public.checklist_templates USING btree (workspace_id, stage) WHERE auto_apply;
create unique index if not exists uq_checklist_templates_name ON public.checklist_templates USING btree (workspace_id, lower(name));
create index if not exists communications_seller_idx ON public.communications USING btree (seller_id, occurred_at DESC);
create unique index if not exists communications_source_uniq ON public.communications USING btree (workspace_id, source, source_id);
create index if not exists communications_thread ON public.communications USING btree (thread_id, occurred_at DESC);
create index if not exists idx_deal_page_views_live ON public.deal_page_views USING btree (deal_id, last_seen_at DESC);
create index if not exists idx_deal_page_views_match ON public.deal_page_views USING btree (match_id) WHERE (match_id IS NOT NULL);
create unique index if not exists uq_deal_page_views ON public.deal_page_views USING btree (link_id, session_key);
create index if not exists idx_deal_public_links_slug ON public.deal_public_links USING btree (slug) WHERE active;
create unique index if not exists uq_deal_public_links_deal ON public.deal_public_links USING btree (deal_id) WHERE active;
create index if not exists deals_seller_idx ON public.deals USING btree (seller_id);
create index if not exists deals_workspace_stage_idx ON public.deals USING btree (workspace_id, stage);
create index if not exists idx_deals_compr_lead ON public.deals USING btree (compr_lead_id) WHERE (compr_lead_id IS NOT NULL);
create index if not exists idx_deals_dispogenius ON public.deals USING btree (dispogenius_deal_id) WHERE (dispogenius_deal_id IS NOT NULL);
create index if not exists idx_deals_podio_item ON public.deals USING btree (podio_item_id) WHERE (podio_item_id IS NOT NULL);
create index if not exists idx_discovery_entities_job ON public.discovery_entities USING btree (job_id);
create index if not exists idx_discovery_individuals_entity ON public.discovery_individuals USING btree (entity_id, rank);
create index if not exists idx_discovery_jobs_deal ON public.discovery_jobs USING btree (deal_id, created_at DESC);
create index if not exists idx_discovery_jobs_open ON public.discovery_jobs USING btree (workspace_id, status) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));
create index if not exists idx_discovery_properties_job ON public.discovery_properties USING btree (job_id);
create index if not exists idx_engagement_buyer ON public.dispo_engagement_events USING btree (buyer_id, occurred_at DESC);
create index if not exists idx_engagement_campaign ON public.dispo_engagement_events USING btree (campaign_id, kind);
create index if not exists idx_engagement_deal ON public.dispo_engagement_events USING btree (deal_id, kind, occurred_at DESC);
create index if not exists idx_engagement_match ON public.dispo_engagement_events USING btree (match_id, occurred_at DESC);
create index if not exists idx_snapshot_rows_snapshot ON public.dispo_match_snapshot_rows USING btree (snapshot_id, excluded, score DESC);
create unique index if not exists uq_snapshot_rows ON public.dispo_match_snapshot_rows USING btree (snapshot_id, buyer_id);
create index if not exists idx_match_snapshots_campaign ON public.dispo_match_snapshots USING btree (campaign_id);
create index if not exists idx_match_snapshots_deal ON public.dispo_match_snapshots USING btree (deal_id, created_at DESC);
create index if not exists idx_dg_snap_buyer ON public.dispogenius_buyer_snapshots USING btree (buyer_id, pulled_on DESC);
create index if not exists idx_dg_snap_deal ON public.dispogenius_buyer_snapshots USING btree (deal_id, pulled_on DESC);
create index if not exists idx_dg_snap_match ON public.dispogenius_buyer_snapshots USING btree (workspace_id, pulled_on DESC);
create unique index if not exists uq_dg_buyer_snapshot ON public.dispogenius_buyer_snapshots USING btree (dispogenius_deal_id, dispogenius_buyer_id, pulled_on);
create index if not exists idx_dg_sync_runs ON public.dispogenius_sync_runs USING btree (workspace_id, started_at DESC);
create index if not exists enrollments_plan_idx ON public.enrollments USING btree (plan_id, seller_id);
create index if not exists inbox_threads_assignee ON public.inbox_threads USING btree (assigned_to, last_message_at DESC);
create index if not exists inbox_threads_buyer ON public.inbox_threads USING btree (buyer_id);
create index if not exists inbox_threads_seller ON public.inbox_threads USING btree (seller_id);
create index if not exists inbox_threads_ws_last ON public.inbox_threads USING btree (workspace_id, last_message_at DESC);
create index if not exists inbox_threads_ws_unread ON public.inbox_threads USING btree (workspace_id) WHERE (unread_count > 0);
create unique index if not exists ingest_events_dedupe ON public.ingest_events USING btree (workspace_id, source, source_id);
create index if not exists ingest_events_property ON public.ingest_events USING btree (property_id);
create index if not exists ingest_events_recent ON public.ingest_events USING btree (workspace_id, received_at DESC);
create unique index if not exists ingest_sources_hash_uniq ON public.ingest_sources USING btree (key_hash);
create index if not exists ingest_sources_ws_idx ON public.ingest_sources USING btree (workspace_id, name);
create unique index if not exists uq_notification_preferences ON public.notification_preferences USING btree (workspace_id, user_id, category);
create index if not exists notifications_workspace_idx ON public.notifications USING btree (workspace_id, created_at DESC);
create index if not exists offers_deal_idx ON public.offers USING btree (deal_id);
create index if not exists idx_outreach_snippets ON public.outreach_snippets USING btree (workspace_id, kind, active, "position");
create index if not exists idx_properties_geo_precision ON public.properties USING btree (geo_precision) WHERE (geo_precision IS NOT NULL);
create index if not exists properties_apn_idx ON public.properties USING btree (workspace_id, state, apn) WHERE (apn IS NOT NULL);
create unique index if not exists properties_key_uniq ON public.properties USING btree (workspace_id, address_key) WHERE (address_key IS NOT NULL);
create index if not exists sellers_assigned_idx ON public.sellers USING btree (assigned_to);
create unique index if not exists sellers_phone_uniq ON public.sellers USING btree (workspace_id, phone_key) WHERE (phone_key IS NOT NULL);
create index if not exists sellers_property_idx ON public.sellers USING btree (property_id);
create index if not exists sellers_workspace_idx ON public.sellers USING btree (workspace_id, updated_at DESC);
create index if not exists sellers_workspace_live_idx ON public.sellers USING btree (workspace_id) WHERE (archived_at IS NULL);
create index if not exists tasks_enrollment_idx ON public.tasks USING btree (enrollment_id) WHERE (enrollment_id IS NOT NULL);
create unique index if not exists tasks_enrollment_step_uniq ON public.tasks USING btree (enrollment_id, plan_step_id);
create index if not exists tasks_seller_idx ON public.tasks USING btree (seller_id);
create index if not exists tasks_workspace_due_idx ON public.tasks USING btree (workspace_id, done, due_at);
create index if not exists transaction_items_tx_idx ON public.transaction_items USING btree (transaction_id, "position");
create index if not exists transactions_workspace_idx ON public.transactions USING btree (workspace_id, status);
create index if not exists underwrites_deal_idx ON public.underwrites USING btree (deal_id, created_at DESC);
create unique index if not exists underwrites_one_current_idx ON public.underwrites USING btree (deal_id) WHERE is_current;
create index if not exists underwrites_ws_idx ON public.underwrites USING btree (workspace_id);
create index if not exists vendors_workspace_idx ON public.vendors USING btree (workspace_id, updated_at DESC);
create index if not exists idx_walkthrough_invites_reminder ON public.walkthrough_invites USING btree (reminder_at) WHERE ((reminded_at IS NULL) AND (status = ANY (ARRAY['invited'::text, 'confirmed'::text])));
create unique index if not exists uq_walkthrough_invites ON public.walkthrough_invites USING btree (slot_id, buyer_id);
create index if not exists idx_walkthrough_slots_deal ON public.walkthrough_slots USING btree (deal_id, starts_at);
create unique index if not exists uq_workspace_goals ON public.workspace_goals USING btree (workspace_id, period, period_start, metric, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists workspace_members_user_idx ON public.workspace_members USING btree (user_id);

-- ---------------------------------------------------------------- triggers

drop trigger if exists buy_box_links_touch on public.buy_box_links;
CREATE TRIGGER buy_box_links_touch BEFORE UPDATE ON public.buy_box_links FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buy_box_submissions_touch on public.buy_box_submissions;
CREATE TRIGGER buy_box_submissions_touch BEFORE UPDATE ON public.buy_box_submissions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buy_box_templates_touch on public.buy_box_templates;
CREATE TRIGGER buy_box_templates_touch BEFORE UPDATE ON public.buy_box_templates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buyer_contacts_touch on public.buyer_contacts;
CREATE TRIGGER buyer_contacts_touch BEFORE UPDATE ON public.buyer_contacts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buyer_import_batches_touch on public.buyer_import_batches;
CREATE TRIGGER buyer_import_batches_touch BEFORE UPDATE ON public.buyer_import_batches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buyer_import_rows_touch on public.buyer_import_rows;
CREATE TRIGGER buyer_import_rows_touch BEFORE UPDATE ON public.buyer_import_rows FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buyer_markets_sync_criteria on public.buyer_markets;
CREATE TRIGGER buyer_markets_sync_criteria AFTER INSERT OR DELETE OR UPDATE ON public.buyer_markets FOR EACH ROW EXECUTE FUNCTION sync_buyer_criteria_from_market();
drop trigger if exists buyer_markets_touch on public.buyer_markets;
CREATE TRIGGER buyer_markets_touch BEFORE UPDATE ON public.buyer_markets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buyer_phones_touch on public.buyer_phones;
CREATE TRIGGER buyer_phones_touch BEFORE UPDATE ON public.buyer_phones FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists buyers_sync_criteria on public.buyers;
CREATE TRIGGER buyers_sync_criteria BEFORE INSERT OR UPDATE ON public.buyers FOR EACH ROW EXECUTE FUNCTION sync_buyer_criteria();
drop trigger if exists buyers_touch on public.buyers;
CREATE TRIGGER buyers_touch BEFORE UPDATE ON public.buyers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists checklist_templates_touch on public.checklist_templates;
CREATE TRIGGER checklist_templates_touch BEFORE UPDATE ON public.checklist_templates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists deal_outreach_settings_touch on public.deal_outreach_settings;
CREATE TRIGGER deal_outreach_settings_touch BEFORE UPDATE ON public.deal_outreach_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists deal_public_links_touch on public.deal_public_links;
CREATE TRIGGER deal_public_links_touch BEFORE UPDATE ON public.deal_public_links FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists deals_set_property_timezone on public.deals;
CREATE TRIGGER deals_set_property_timezone BEFORE INSERT OR UPDATE OF property_id ON public.deals FOR EACH ROW EXECUTE FUNCTION set_deal_property_timezone();
drop trigger if exists discovery_jobs_touch on public.discovery_jobs;
CREATE TRIGGER discovery_jobs_touch BEFORE UPDATE ON public.discovery_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists dispo_engagement_events_rollup on public.dispo_engagement_events;
CREATE TRIGGER dispo_engagement_events_rollup AFTER INSERT ON public.dispo_engagement_events FOR EACH ROW EXECUTE FUNCTION roll_up_engagement_event();
drop trigger if exists dispo_match_snapshots_touch on public.dispo_match_snapshots;
CREATE TRIGGER dispo_match_snapshots_touch BEFORE UPDATE ON public.dispo_match_snapshots FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists notification_preferences_touch on public.notification_preferences;
CREATE TRIGGER notification_preferences_touch BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists outreach_snippets_touch on public.outreach_snippets;
CREATE TRIGGER outreach_snippets_touch BEFORE UPDATE ON public.outreach_snippets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists profiles_touch on public.profiles;
CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists properties_touch on public.properties;
CREATE TRIGGER properties_touch BEFORE UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists sellers_touch on public.sellers;
CREATE TRIGGER sellers_touch BEFORE UPDATE ON public.sellers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists vendors_touch on public.vendors;
CREATE TRIGGER vendors_touch BEFORE UPDATE ON public.vendors FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists walkthrough_invites_touch on public.walkthrough_invites;
CREATE TRIGGER walkthrough_invites_touch BEFORE UPDATE ON public.walkthrough_invites FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists walkthrough_slots_touch on public.walkthrough_slots;
CREATE TRIGGER walkthrough_slots_touch BEFORE UPDATE ON public.walkthrough_slots FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists workspace_goals_touch on public.workspace_goals;
CREATE TRIGGER workspace_goals_touch BEFORE UPDATE ON public.workspace_goals FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists workspaces_touch on public.workspaces;
CREATE TRIGGER workspaces_touch BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- row level security

alter table public.action_plan_steps enable row level security;
alter table public.action_plans enable row level security;
alter table public.activity enable row level security;
alter table public.appointments enable row level security;
alter table public.buy_box_links enable row level security;
alter table public.buy_box_submissions enable row level security;
alter table public.buy_box_templates enable row level security;
alter table public.buyer_contacts enable row level security;
alter table public.buyer_import_batches enable row level security;
alter table public.buyer_import_column_maps enable row level security;
alter table public.buyer_import_rows enable row level security;
alter table public.buyer_markets enable row level security;
alter table public.buyer_phones enable row level security;
alter table public.buyer_rule_states enable row level security;
alter table public.buyers enable row level security;
alter table public.checklist_template_items enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.communications enable row level security;
alter table public.deal_outreach_settings enable row level security;
alter table public.deal_page_views enable row level security;
alter table public.deal_public_links enable row level security;
alter table public.deals enable row level security;
alter table public.discovery_entities enable row level security;
alter table public.discovery_individuals enable row level security;
alter table public.discovery_jobs enable row level security;
alter table public.discovery_properties enable row level security;
alter table public.dispo_engagement_events enable row level security;
alter table public.dispo_match_snapshot_rows enable row level security;
alter table public.dispo_match_snapshots enable row level security;
alter table public.dispogenius_buyer_snapshots enable row level security;
alter table public.dispogenius_sync_runs enable row level security;
alter table public.enrollments enable row level security;
alter table public.inbox_threads enable row level security;
alter table public.ingest_events enable row level security;
alter table public.ingest_sources enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;
alter table public.offers enable row level security;
alter table public.outreach_snippets enable row level security;
alter table public.profiles enable row level security;
alter table public.properties enable row level security;
alter table public.sellers enable row level security;
alter table public.tasks enable row level security;
alter table public.transaction_items enable row level security;
alter table public.transactions enable row level security;
alter table public.underwrites enable row level security;
alter table public.vendors enable row level security;
alter table public.walkthrough_invites enable row level security;
alter table public.walkthrough_slots enable row level security;
alter table public.workspace_goals enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspaces enable row level security;

drop policy if exists action_plan_steps_write on public.action_plan_steps;
create policy action_plan_steps_write on public.action_plan_steps as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists action_plans_write on public.action_plans;
create policy action_plans_write on public.action_plans as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists activity_write on public.activity;
create policy activity_write on public.activity as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists appointments_write on public.appointments;
create policy appointments_write on public.appointments as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists buy_box_links_select on public.buy_box_links;
create policy buy_box_links_select on public.buy_box_links as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists buy_box_links_write on public.buy_box_links;
create policy buy_box_links_write on public.buy_box_links as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists buy_box_submissions_select on public.buy_box_submissions;
create policy buy_box_submissions_select on public.buy_box_submissions as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists buy_box_submissions_write on public.buy_box_submissions;
create policy buy_box_submissions_write on public.buy_box_submissions as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists buy_box_templates_select on public.buy_box_templates;
create policy buy_box_templates_select on public.buy_box_templates as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists buy_box_templates_write on public.buy_box_templates;
create policy buy_box_templates_write on public.buy_box_templates as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_contacts_select on public.buyer_contacts;
create policy buyer_contacts_select on public.buyer_contacts as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_contacts_write on public.buyer_contacts;
create policy buyer_contacts_write on public.buyer_contacts as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_import_batches_select on public.buyer_import_batches;
create policy buyer_import_batches_select on public.buyer_import_batches as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_import_batches_write on public.buyer_import_batches;
create policy buyer_import_batches_write on public.buyer_import_batches as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_import_column_maps_select on public.buyer_import_column_maps;
create policy buyer_import_column_maps_select on public.buyer_import_column_maps as permissive for select to public
  using (((workspace_id IS NULL) OR (workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids))));
drop policy if exists buyer_import_column_maps_write on public.buyer_import_column_maps;
create policy buyer_import_column_maps_write on public.buyer_import_column_maps as permissive for all to public
  using (((workspace_id IS NULL) OR (workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids))))
  with check (((workspace_id IS NULL) OR (workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids))));
drop policy if exists buyer_import_rows_select on public.buyer_import_rows;
create policy buyer_import_rows_select on public.buyer_import_rows as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_import_rows_write on public.buyer_import_rows;
create policy buyer_import_rows_write on public.buyer_import_rows as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists buyer_markets_select on public.buyer_markets;
create policy buyer_markets_select on public.buyer_markets as permissive for select to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))))));
drop policy if exists buyer_markets_write on public.buyer_markets;
create policy buyer_markets_write on public.buyer_markets as permissive for all to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))))
  with check ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))));
drop policy if exists buyer_phones_select on public.buyer_phones;
create policy buyer_phones_select on public.buyer_phones as permissive for select to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))))));
drop policy if exists buyer_phones_write on public.buyer_phones;
create policy buyer_phones_write on public.buyer_phones as permissive for all to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))))
  with check ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))));
drop policy if exists buyer_rule_states_select on public.buyer_rule_states;
create policy buyer_rule_states_select on public.buyer_rule_states as permissive for select to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))))));
drop policy if exists buyer_rule_states_write on public.buyer_rule_states;
create policy buyer_rule_states_write on public.buyer_rule_states as permissive for all to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))))
  with check ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))));
drop policy if exists buyers_delete on public.buyers;
create policy buyers_delete on public.buyers as permissive for delete to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
drop policy if exists buyers_insert on public.buyers;
create policy buyers_insert on public.buyers as permissive for insert to authenticated
  with check ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))));
drop policy if exists buyers_select on public.buyers;
create policy buyers_select on public.buyers as permissive for select to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]))))));
drop policy if exists buyers_update on public.buyers;
create policy buyers_update on public.buyers as permissive for update to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))))
  with check ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]))))));
drop policy if exists checklist_template_items_select on public.checklist_template_items;
create policy checklist_template_items_select on public.checklist_template_items as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists checklist_template_items_write on public.checklist_template_items;
create policy checklist_template_items_write on public.checklist_template_items as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)));
drop policy if exists checklist_templates_select on public.checklist_templates;
create policy checklist_templates_select on public.checklist_templates as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists checklist_templates_write on public.checklist_templates;
create policy checklist_templates_write on public.checklist_templates as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)));
drop policy if exists communications_delete on public.communications;
create policy communications_delete on public.communications as permissive for delete to authenticated
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((channel IS DISTINCT FROM 'email'::text) OR (workspace_id IN ( SELECT my_email_admin_workspace_ids() AS my_email_admin_workspace_ids)) OR can_read_email(workspace_id, id))));
drop policy if exists communications_insert on public.communications;
create policy communications_insert on public.communications as permissive for insert to authenticated
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists communications_read on public.communications;
create policy communications_read on public.communications as permissive for select to authenticated
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((channel IS DISTINCT FROM 'email'::text) OR (workspace_id IN ( SELECT my_email_admin_workspace_ids() AS my_email_admin_workspace_ids)) OR can_read_email(workspace_id, id))));
drop policy if exists communications_update on public.communications;
create policy communications_update on public.communications as permissive for update to authenticated
  using (((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)) AND ((channel IS DISTINCT FROM 'email'::text) OR (workspace_id IN ( SELECT my_email_admin_workspace_ids() AS my_email_admin_workspace_ids)) OR can_read_email(workspace_id, id))))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists deal_outreach_settings_select on public.deal_outreach_settings;
create policy deal_outreach_settings_select on public.deal_outreach_settings as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists deal_outreach_settings_write on public.deal_outreach_settings;
create policy deal_outreach_settings_write on public.deal_outreach_settings as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists deal_page_views_select on public.deal_page_views;
create policy deal_page_views_select on public.deal_page_views as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists deal_page_views_write on public.deal_page_views;
create policy deal_page_views_write on public.deal_page_views as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists deal_public_links_select on public.deal_public_links;
create policy deal_public_links_select on public.deal_public_links as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists deal_public_links_write on public.deal_public_links;
create policy deal_public_links_write on public.deal_public_links as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists deals_write on public.deals;
create policy deals_write on public.deals as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists discovery_entities_select on public.discovery_entities;
create policy discovery_entities_select on public.discovery_entities as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_entities_write on public.discovery_entities;
create policy discovery_entities_write on public.discovery_entities as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_individuals_select on public.discovery_individuals;
create policy discovery_individuals_select on public.discovery_individuals as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_individuals_write on public.discovery_individuals;
create policy discovery_individuals_write on public.discovery_individuals as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_jobs_select on public.discovery_jobs;
create policy discovery_jobs_select on public.discovery_jobs as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_jobs_write on public.discovery_jobs;
create policy discovery_jobs_write on public.discovery_jobs as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_properties_select on public.discovery_properties;
create policy discovery_properties_select on public.discovery_properties as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists discovery_properties_write on public.discovery_properties;
create policy discovery_properties_write on public.discovery_properties as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists dispo_engagement_events_select on public.dispo_engagement_events;
create policy dispo_engagement_events_select on public.dispo_engagement_events as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists dispo_engagement_events_write on public.dispo_engagement_events;
create policy dispo_engagement_events_write on public.dispo_engagement_events as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists dispo_match_snapshot_rows_select on public.dispo_match_snapshot_rows;
create policy dispo_match_snapshot_rows_select on public.dispo_match_snapshot_rows as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists dispo_match_snapshot_rows_write on public.dispo_match_snapshot_rows;
create policy dispo_match_snapshot_rows_write on public.dispo_match_snapshot_rows as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists dispo_match_snapshots_select on public.dispo_match_snapshots;
create policy dispo_match_snapshots_select on public.dispo_match_snapshots as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists dispo_match_snapshots_write on public.dispo_match_snapshots;
create policy dispo_match_snapshots_write on public.dispo_match_snapshots as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists dispogenius_buyer_snapshots_select on public.dispogenius_buyer_snapshots;
create policy dispogenius_buyer_snapshots_select on public.dispogenius_buyer_snapshots as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists dispogenius_buyer_snapshots_write on public.dispogenius_buyer_snapshots;
create policy dispogenius_buyer_snapshots_write on public.dispogenius_buyer_snapshots as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)));
drop policy if exists dispogenius_sync_runs_select on public.dispogenius_sync_runs;
create policy dispogenius_sync_runs_select on public.dispogenius_sync_runs as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists dispogenius_sync_runs_write on public.dispogenius_sync_runs;
create policy dispogenius_sync_runs_write on public.dispogenius_sync_runs as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)));
drop policy if exists enrollments_write on public.enrollments;
create policy enrollments_write on public.enrollments as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists inbox_threads_rw on public.inbox_threads;
create policy inbox_threads_rw on public.inbox_threads as permissive for all to public
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists ingest_events_select on public.ingest_events;
create policy ingest_events_select on public.ingest_events as permissive for select to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences as permissive for all to public
  using (((user_id = ( SELECT auth.uid() AS uid)) AND (workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids))))
  with check (((user_id = ( SELECT auth.uid() AS uid)) AND (workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids))));
drop policy if exists notifications_write on public.notifications;
create policy notifications_write on public.notifications as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists offers_select on public.offers;
create policy offers_select on public.offers as permissive for select to authenticated
  using (((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)) OR ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['acquisitions'::text]) AS my_role_workspace_ids)) AND (direction = 'inbound'::text))));
drop policy if exists offers_write on public.offers;
create policy offers_write on public.offers as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)));
drop policy if exists outreach_snippets_select on public.outreach_snippets;
create policy outreach_snippets_select on public.outreach_snippets as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists outreach_snippets_write on public.outreach_snippets;
create policy outreach_snippets_write on public.outreach_snippets as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles as permissive for insert to authenticated
  with check ((id = ( SELECT auth.uid() AS uid)));
drop policy if exists profiles_select_team on public.profiles;
create policy profiles_select_team on public.profiles as permissive for select to authenticated
  using (((id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM (workspace_members a
     JOIN workspace_members b ON ((b.workspace_id = a.workspace_id)))
  WHERE ((a.user_id = ( SELECT auth.uid() AS uid)) AND (b.user_id = profiles.id))))));
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles as permissive for update to authenticated
  using ((id = ( SELECT auth.uid() AS uid)))
  with check ((id = ( SELECT auth.uid() AS uid)));
drop policy if exists properties_delete on public.properties;
create policy properties_delete on public.properties as permissive for delete to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists properties_insert on public.properties;
create policy properties_insert on public.properties as permissive for insert to authenticated
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists properties_select on public.properties;
create policy properties_select on public.properties as permissive for select to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists properties_update on public.properties;
create policy properties_update on public.properties as permissive for update to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists sellers_delete on public.sellers;
create policy sellers_delete on public.sellers as permissive for delete to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
drop policy if exists sellers_insert on public.sellers;
create policy sellers_insert on public.sellers as permissive for insert to authenticated
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists sellers_select on public.sellers;
create policy sellers_select on public.sellers as permissive for select to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists sellers_update on public.sellers;
create policy sellers_update on public.sellers as permissive for update to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists tasks_write on public.tasks;
create policy tasks_write on public.tasks as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists transaction_items_select on public.transaction_items;
create policy transaction_items_select on public.transaction_items as permissive for select to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists transaction_items_write on public.transaction_items;
create policy transaction_items_write on public.transaction_items as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions as permissive for select to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists transactions_write on public.transactions;
create policy transactions_write on public.transactions as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'tc'::text, 'dispositions'::text]) AS my_role_workspace_ids)));
drop policy if exists underwrites_all on public.underwrites;
create policy underwrites_all on public.underwrites as permissive for all to public
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists vendors_delete on public.vendors;
create policy vendors_delete on public.vendors as permissive for delete to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists vendors_insert on public.vendors;
create policy vendors_insert on public.vendors as permissive for insert to authenticated
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists vendors_select on public.vendors;
create policy vendors_select on public.vendors as permissive for select to authenticated
  using ((workspace_id IN ( SELECT m.workspace_id
   FROM workspace_members m
  WHERE (m.user_id = ( SELECT auth.uid() AS uid)))));
drop policy if exists vendors_update on public.vendors;
create policy vendors_update on public.vendors as permissive for update to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists walkthrough_invites_select on public.walkthrough_invites;
create policy walkthrough_invites_select on public.walkthrough_invites as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists walkthrough_invites_write on public.walkthrough_invites;
create policy walkthrough_invites_write on public.walkthrough_invites as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)));
drop policy if exists walkthrough_slots_select on public.walkthrough_slots;
create policy walkthrough_slots_select on public.walkthrough_slots as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists walkthrough_slots_write on public.walkthrough_slots;
create policy walkthrough_slots_write on public.walkthrough_slots as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text]) AS my_role_workspace_ids)));
drop policy if exists workspace_goals_select on public.workspace_goals;
create policy workspace_goals_select on public.workspace_goals as permissive for select to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text, 'dispositions'::text, 'tc'::text, 'member'::text]) AS my_role_workspace_ids)));
drop policy if exists workspace_goals_write on public.workspace_goals;
create policy workspace_goals_write on public.workspace_goals as permissive for all to public
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)));
drop policy if exists invites_manage on public.workspace_invites;
create policy invites_manage on public.workspace_invites as permissive for all to authenticated
  using ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)))
  with check ((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)));
drop policy if exists members_manage on public.workspace_members;
create policy members_manage on public.workspace_members as permissive for all to authenticated
  using (((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)) AND (role <> 'owner'::text)))
  with check (((workspace_id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)) AND (role <> 'owner'::text)));
drop policy if exists members_select on public.workspace_members;
create policy members_select on public.workspace_members as permissive for select to authenticated
  using ((workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids)));
drop policy if exists workspaces_admin_update on public.workspaces;
create policy workspaces_admin_update on public.workspaces as permissive for update to authenticated
  using ((id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)))
  with check ((id IN ( SELECT my_role_workspace_ids(VARIADIC ARRAY['owner'::text, 'admin'::text]) AS my_role_workspace_ids)));
drop policy if exists workspaces_insert_owner on public.workspaces;
create policy workspaces_insert_owner on public.workspaces as permissive for insert to authenticated
  with check ((owner_id = ( SELECT auth.uid() AS uid)));
drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member on public.workspaces as permissive for select to authenticated
  using (is_workspace_member(id));

-- ---------------------------------------------------------------- privileges

-- Members reach their rows through RLS; anon reaches nothing. MAINTAIN
-- exists from Postgres 17, which is what Supabase runs.
do $$
declare
  t text;
  pg17 boolean := current_setting('server_version_num')::int >= 170000;
begin
  foreach t in array array['action_plan_steps', 'action_plans', 'activity', 'appointments', 'buy_box_links', 'buy_box_submissions', 'buy_box_templates', 'buyer_contacts', 'buyer_import_batches', 'buyer_import_column_maps', 'buyer_import_rows', 'buyer_markets', 'buyer_phones', 'buyer_rule_states', 'buyers', 'checklist_template_items', 'checklist_templates', 'communications', 'deal_outreach_settings', 'deal_page_views', 'deal_public_links', 'deals', 'discovery_entities', 'discovery_individuals', 'discovery_jobs', 'discovery_properties', 'dispo_engagement_events', 'dispo_match_snapshot_rows', 'dispo_match_snapshots', 'dispogenius_buyer_snapshots', 'dispogenius_sync_runs', 'enrollments', 'inbox_threads', 'ingest_events', 'notification_preferences', 'notifications', 'offers', 'outreach_snippets', 'profiles', 'properties', 'sellers', 'tasks', 'transaction_items', 'transactions', 'underwrites', 'vendors', 'walkthrough_invites', 'walkthrough_slots', 'workspace_goals', 'workspace_invites', 'workspace_members', 'workspaces'] loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if pg17 then execute format('grant maintain on public.%I to authenticated', t); end if;
    execute format('grant all on public.%I to service_role', t);
  end loop;
  -- ingest_sources: the key hash and secrets stay unreadable; the columns
  -- below are the readable ones.
  revoke all on public.ingest_sources from public, anon, authenticated;
  grant insert, update, delete on public.ingest_sources to authenticated;
  if pg17 then grant maintain on public.ingest_sources to authenticated; end if;
  grant all on public.ingest_sources to service_role;
end $$;
grant select (id) on public.ingest_sources to authenticated;
grant select (workspace_id) on public.ingest_sources to authenticated;
grant select (name) on public.ingest_sources to authenticated;
grant select (label) on public.ingest_sources to authenticated;
grant select (key_prefix) on public.ingest_sources to authenticated;
grant select (active) on public.ingest_sources to authenticated;
grant select (last_used_at) on public.ingest_sources to authenticated;
grant select (created_at) on public.ingest_sources to authenticated;

revoke all on function public.address_key(p_line1 text, p_city text, p_state text, p_zip text) from public, anon, authenticated;
grant execute on function public.address_key(p_line1 text, p_city text, p_state text, p_zip text) to anon, authenticated, service_role;
revoke all on function public.apply_buyer_parsed_fields(p_buyer_id bigint, p_extra jsonb) from public, anon, authenticated;
grant execute on function public.apply_buyer_parsed_fields(p_buyer_id bigint, p_extra jsonb) to public, anon, authenticated, service_role;
revoke all on function public.approve_buy_box_submission(p_id bigint) from public, anon, authenticated;
grant execute on function public.approve_buy_box_submission(p_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.build_buyer_criteria(b buyers) from public, anon, authenticated;
grant execute on function public.build_buyer_criteria(b buyers) to public, anon, authenticated, service_role;
revoke all on function public.build_match_snapshot(p_deal_id bigint, p_min integer, p_rematch boolean) from public, anon, authenticated;
grant execute on function public.build_match_snapshot(p_deal_id bigint, p_min integer, p_rematch boolean) to public, anon, authenticated, service_role;
revoke all on function public.buy_box_form(p_slug text) from public, anon, authenticated;
grant execute on function public.buy_box_form(p_slug text) to authenticated, service_role;
revoke all on function public.buyer_radius_hit(p_buyer_id bigint, p_lat double precision, p_lng double precision) from public, anon, authenticated;
grant execute on function public.buyer_radius_hit(p_buyer_id bigint, p_lat double precision, p_lng double precision) to public, anon, authenticated, service_role;
revoke all on function public.campaign_next_send_slot(p_campaign_id bigint, p_after timestamp with time zone) from public, anon, authenticated;
grant execute on function public.campaign_next_send_slot(p_campaign_id bigint, p_after timestamp with time zone) to public, anon, authenticated, service_role;
revoke all on function public.can_read_email(p_ws bigint, p_id bigint) from public, anon, authenticated;
grant execute on function public.can_read_email(p_ws bigint, p_id bigint) to authenticated, service_role;
revoke all on function public.comm_status_rank(s text) from public, anon, authenticated;
grant execute on function public.comm_status_rank(s text) to public, anon, authenticated, service_role;
revoke all on function public.compose_outreach_message(p_workspace_id bigint, p_statement text, p_vars jsonb, p_channel text, p_greeting_id bigint, p_ending_id bigint) from public, anon, authenticated;
grant execute on function public.compose_outreach_message(p_workspace_id bigint, p_statement text, p_vars jsonb, p_channel text, p_greeting_id bigint, p_ending_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.create_buyer_entity(p_workspace_id bigint, p_name text, p_company text, p_email text, p_phone text, p_markets jsonb, p_source text, p_level integer, p_extra jsonb) from public, anon, authenticated;
grant execute on function public.create_buyer_entity(p_workspace_id bigint, p_name text, p_company text, p_email text, p_phone text, p_markets jsonb, p_source text, p_level integer, p_extra jsonb) to public, anon, authenticated, service_role;
revoke all on function public.deal_auto_archive() from public, anon, authenticated;
grant execute on function public.deal_auto_archive() to public, anon, authenticated, service_role;
revoke all on function public.deal_dispo_score(p_deal_id bigint) from public, anon, authenticated;
grant execute on function public.deal_dispo_score(p_deal_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.deal_image_key() from public, anon, authenticated;
grant execute on function public.deal_image_key() to service_role;
revoke all on function public.deal_image_target(p_deal_id bigint) from public, anon, authenticated;
grant execute on function public.deal_image_target(p_deal_id bigint) to service_role;
revoke all on function public.deal_image_token(p_deal_id bigint) from public, anon, authenticated;
grant execute on function public.deal_image_token(p_deal_id bigint) to authenticated, service_role;
revoke all on function public.deal_listing(p_slug text) from public, anon, authenticated;
grant execute on function public.deal_listing(p_slug text) to authenticated, service_role;
revoke all on function public.dedupe_buyer_import(p_batch_id bigint) from public, anon, authenticated;
grant execute on function public.dedupe_buyer_import(p_batch_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.discovery_job_progress(p_task_key text, p_phase text, p_completed integer, p_total integer, p_message text, p_status text, p_error text) from public, anon, authenticated;
grant execute on function public.discovery_job_progress(p_task_key text, p_phase text, p_completed integer, p_total integer, p_message text, p_status text, p_error text) to public, anon, authenticated, service_role;
revoke all on function public.dispo_campaign_safety_check(p_campaign_id bigint) from public, anon, authenticated;
grant execute on function public.dispo_campaign_safety_check(p_campaign_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.dispo_campaign_stop(p_campaign_id bigint, p_reason text) from public, anon, authenticated;
grant execute on function public.dispo_campaign_stop(p_campaign_id bigint, p_reason text) to public, anon, authenticated, service_role;
revoke all on function public.dispo_log_engagement(p_deal_id bigint, p_buyer_id bigint, p_kind text, p_channel text, p_campaign_id bigint, p_message_id bigint, p_meta jsonb) from public, anon, authenticated;
grant execute on function public.dispo_log_engagement(p_deal_id bigint, p_buyer_id bigint, p_kind text, p_channel text, p_campaign_id bigint, p_message_id bigint, p_meta jsonb) to service_role;
revoke all on function public.dispo_match_refresh(p_min integer, p_limit integer) from public, anon, authenticated;
grant execute on function public.dispo_match_refresh(p_min integer, p_limit integer) to service_role;
revoke all on function public.freeze_match_snapshot(p_snapshot_id bigint) from public, anon, authenticated;
grant execute on function public.freeze_match_snapshot(p_snapshot_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;
revoke all on function public.has_role(ws bigint, VARIADIC roles text[]) from public, anon, authenticated;
grant execute on function public.has_role(ws bigint, VARIADIC roles text[]) to authenticated, service_role;
revoke all on function public.haversine_miles(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) from public, anon, authenticated;
grant execute on function public.haversine_miles(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) to public, anon, authenticated, service_role;
revoke all on function public.import_buyer_rows(p_batch_id bigint) from public, anon, authenticated;
grant execute on function public.import_buyer_rows(p_batch_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.inbox_mark_read(p_thread_id bigint) from public, anon, authenticated;
grant execute on function public.inbox_mark_read(p_thread_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.is_workspace_member(ws bigint) from public, anon, authenticated;
grant execute on function public.is_workspace_member(ws bigint) to authenticated, service_role;
revoke all on function public.match_contact_by_phone(p_ws bigint, p_phone_key text) from public, anon, authenticated;
grant execute on function public.match_contact_by_phone(p_ws bigint, p_phone_key text) to service_role;
revoke all on function public.member_role(ws bigint) from public, anon, authenticated;
grant execute on function public.member_role(ws bigint) to authenticated, service_role;
revoke all on function public.my_email_admin_workspace_ids() from public, anon, authenticated;
grant execute on function public.my_email_admin_workspace_ids() to authenticated, service_role;
revoke all on function public.my_role_workspace_ids(VARIADIC p_roles text[]) from public, anon, authenticated;
grant execute on function public.my_role_workspace_ids(VARIADIC p_roles text[]) to authenticated, service_role;
revoke all on function public.my_workspace_ids() from public, anon, authenticated;
grant execute on function public.my_workspace_ids() to authenticated, service_role;
revoke all on function public.next_send_slot(p_after timestamp with time zone, p_timezone text, p_days smallint[], p_start_hour smallint, p_end_hour smallint) from public, anon, authenticated;
grant execute on function public.next_send_slot(p_after timestamp with time zone, p_timezone text, p_days smallint[], p_start_hour smallint, p_end_hour smallint) to public, anon, authenticated, service_role;
revoke all on function public.normalize_address(p_raw text) from public, anon, authenticated;
grant execute on function public.normalize_address(p_raw text) to anon, authenticated, service_role;
revoke all on function public.normalize_phone(p_raw text) from public, anon, authenticated;
grant execute on function public.normalize_phone(p_raw text) to anon, authenticated, service_role;
revoke all on function public.promote_discovery_entity(p_entity_id bigint) from public, anon, authenticated;
grant execute on function public.promote_discovery_entity(p_entity_id bigint) to public, anon, authenticated, service_role;
revoke all on function public.record_email_open(p_token text) from public, anon, authenticated;
grant execute on function public.record_email_open(p_token text) to authenticated, service_role;
revoke all on function public.record_link_click(p_token text, p_url text) from public, anon, authenticated;
grant execute on function public.record_link_click(p_token text, p_url text) to authenticated, service_role;
revoke all on function public.render_merge_fields(p_text text, p_vars jsonb) from public, anon, authenticated;
grant execute on function public.render_merge_fields(p_text text, p_vars jsonb) to public, anon, authenticated, service_role;
revoke all on function public.replace_buyer_markets_from_parsed(p_buyer_id bigint, p_markets jsonb) from public, anon, authenticated;
grant execute on function public.replace_buyer_markets_from_parsed(p_buyer_id bigint, p_markets jsonb) to public, anon, authenticated, service_role;
revoke all on function public.roll_up_engagement_event() from public, anon, authenticated;
grant execute on function public.roll_up_engagement_event() to public, anon, authenticated, service_role;
revoke all on function public.save_underwrite(p_deal_id bigint, p_source text, p_arv numeric, p_arv_low numeric, p_arv_high numeric, p_rehab numeric, p_mao numeric, p_mao_wholesale numeric, p_mao_institutional numeric, p_asking_price numeric, p_target_assignment numeric, p_confidence integer, p_comp_count integer, p_condition text, p_red_flags jsonb, p_report_url text, p_lead_id text, p_status text, p_notes text) from public, anon, authenticated;
grant execute on function public.save_underwrite(p_deal_id bigint, p_source text, p_arv numeric, p_arv_low numeric, p_arv_high numeric, p_rehab numeric, p_mao numeric, p_mao_wholesale numeric, p_mao_institutional numeric, p_asking_price numeric, p_target_assignment numeric, p_confidence integer, p_comp_count integer, p_condition text, p_red_flags jsonb, p_report_url text, p_lead_id text, p_status text, p_notes text) to authenticated, service_role;
revoke all on function public.set_deal_property_timezone() from public, anon, authenticated;
grant execute on function public.set_deal_property_timezone() to public, anon, authenticated, service_role;
revoke all on function public.set_snapshot_exclusion(p_snapshot_id bigint, p_buyer_id bigint, p_excluded boolean, p_reason text) from public, anon, authenticated;
grant execute on function public.set_snapshot_exclusion(p_snapshot_id bigint, p_buyer_id bigint, p_excluded boolean, p_reason text) to public, anon, authenticated, service_role;
revoke all on function public.submit_buy_box(p_slug text, p_payload jsonb, p_user_agent text) from public, anon, authenticated;
grant execute on function public.submit_buy_box(p_slug text, p_payload jsonb, p_user_agent text) to authenticated, service_role;
revoke all on function public.submit_deal_offer(p_slug text, p_payload jsonb, p_token text) from public, anon, authenticated;
grant execute on function public.submit_deal_offer(p_slug text, p_payload jsonb, p_token text) to authenticated, service_role;
revoke all on function public.sync_buyer_criteria() from public, anon, authenticated;
grant execute on function public.sync_buyer_criteria() to public, anon, authenticated, service_role;
revoke all on function public.sync_buyer_criteria_from_market() from public, anon, authenticated;
grant execute on function public.sync_buyer_criteria_from_market() to public, anon, authenticated, service_role;
revoke all on function public.text_array_from_jsonb(p jsonb) from public, anon, authenticated;
grant execute on function public.text_array_from_jsonb(p jsonb) to public, anon, authenticated, service_role;
revoke all on function public.timezone_for_state(p_state text) from public, anon, authenticated;
grant execute on function public.timezone_for_state(p_state text) to public, anon, authenticated, service_role;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
grant execute on function public.touch_updated_at() to service_role;
revoke all on function public.track_deal_view(p_slug text, p_session_key text, p_token text, p_seconds integer, p_photo_clicks integer, p_referrer text, p_user_agent text) from public, anon, authenticated;
grant execute on function public.track_deal_view(p_slug text, p_session_key text, p_token text, p_seconds integer, p_photo_clicks integer, p_referrer text, p_user_agent text) to authenticated, service_role;
revoke all on function public.upsert_vetted_buyer(p_workspace_id bigint, p_parsed jsonb) from public, anon, authenticated;
grant execute on function public.upsert_vetted_buyer(p_workspace_id bigint, p_parsed jsonb) to public, anon, authenticated, service_role;
revoke all on function public.inbox_on_communication() from public, anon, authenticated;
grant execute on function public.inbox_on_communication() to service_role;

