-- Public listing page: the buyer-facing front door and its engagement writes.
--
-- Everything downstream of this already exists: dispo_log_engagement writes the
-- event, roll_up_engagement_event folds it into deal_buyer_matches and recomputes
-- temperature. What was missing was the door itself, so these three functions are
-- the only new surface: make a link, record a visit, take an offer.
--
-- All three are SECURITY DEFINER and granted to service_role only. The public
-- never calls them directly; the `listing` edge function does, after it has
-- checked the signed token and the rate limit.

-- ------------------------------------------------------------ make a link

/**
 * The active public link for a deal, creating one on first use. Slug is random
 * rather than the address, so a link cannot be guessed from a street name.
 * Called by the app (as the signed-in rep), not by the public function.
 */
create or replace function public.deal_public_link_ensure(
  p_deal_id bigint,
  p_headline text default null,
  p_description text default null
) returns public.deal_public_links
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_ws bigint; v_link public.deal_public_links; v_slug text;
begin
  select workspace_id into v_ws from public.deals where id = p_deal_id;
  if v_ws is null then raise exception 'deal not found' using errcode = '22023'; end if;
  if not public.has_role(v_ws, 'owner', 'admin', 'dispositions') then
    raise exception 'only owners, admins and dispositions can publish a deal' using errcode = '42501';
  end if;

  select * into v_link from public.deal_public_links where deal_id = p_deal_id and active;
  if found then
    update public.deal_public_links set
      headline    = coalesce(nullif(trim(p_headline), ''), headline),
      description = coalesce(nullif(trim(p_description), ''), description),
      updated_at  = now()
    where id = v_link.id returning * into v_link;
    return v_link;
  end if;

  -- 9 bytes of randomness, base32-ish, lowercase and unambiguous.
  loop
    v_slug := lower(translate(encode(gen_random_bytes(9), 'base64'), '+/=IlO01', 'abcdefgh'));
    exit when not exists (select 1 from public.deal_public_links where slug = v_slug);
  end loop;

  insert into public.deal_public_links (workspace_id, deal_id, slug, headline, description, created_by)
  values (v_ws, p_deal_id, v_slug, nullif(trim(p_headline), ''), nullif(trim(p_description), ''), auth.uid())
  returning * into v_link;
  return v_link;
end $function$;

revoke all on function public.deal_public_link_ensure(bigint, text, text) from public;
grant execute on function public.deal_public_link_ensure(bigint, text, text) to authenticated, service_role;

-- ------------------------------------------------------------ record a visit

/**
 * One visit, folded into the session it belongs to. The first beacon of a
 * session inserts the row and logs a page_view; later beacons only add the new
 * seconds and photo clicks, so a buyer who leaves the tab open is one view, not
 * forty.
 *
 * Seconds are added to the match directly rather than through an event.
 * dispo_engagement_events.kind is a closed list and time-on-page is not one of
 * its kinds; inventing one would mean widening that constraint, and a synthetic
 * event would also re-date last_engaged_at every fifteen seconds, which would
 * make an idle tab look like an engaged buyer.
 */
create or replace function public.dispo_public_view(
  p_link_id bigint,
  p_buyer_id bigint,
  p_session_key text,
  p_seconds int default 0,
  p_photo_clicks int default 0,
  p_referrer text default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_link record; v_view record; v_match bigint;
  v_secs int := greatest(0, least(coalesce(p_seconds, 0), 3600));
  v_clicks int := greatest(0, least(coalesce(p_photo_clicks, 0), 200));
begin
  select id, workspace_id, deal_id into v_link from public.deal_public_links where id = p_link_id and active;
  if not found then return; end if;
  if p_session_key is null or length(p_session_key) < 8 then return; end if;

  select id into v_match from public.deal_buyer_matches
   where deal_id = v_link.deal_id and buyer_id = p_buyer_id;

  select * into v_view from public.deal_page_views
   where link_id = v_link.id and session_key = p_session_key;

  if not found then
    insert into public.deal_page_views
      (workspace_id, deal_id, link_id, match_id, buyer_id, session_key, seconds, photo_clicks, referrer, user_agent)
    values (v_link.workspace_id, v_link.deal_id, v_link.id, v_match, p_buyer_id, p_session_key,
            v_secs, v_clicks, left(p_referrer, 500), left(p_user_agent, 500));

    update public.deal_public_links
       set view_count = view_count + 1,
           unique_viewers = unique_viewers + 1,
           updated_at = now()
     where id = v_link.id;

    if p_buyer_id is not null then
      perform public.dispo_log_engagement(v_link.deal_id, p_buyer_id, 'page_view', 'web', null, null,
        jsonb_build_object('link_id', v_link.id, 'session', left(p_session_key, 64)));
    end if;
  else
    update public.deal_page_views set
      seconds      = seconds + v_secs,
      photo_clicks = photo_clicks + v_clicks,
      last_seen_at = now()
    where id = v_view.id;
  end if;

  if v_match is not null and v_secs > 0 then
    update public.deal_buyer_matches
       set session_seconds = session_seconds + v_secs, updated_at = now()
     where id = v_match;
  end if;

  if p_buyer_id is not null and v_clicks > 0 then
    for i in 1..v_clicks loop
      perform public.dispo_log_engagement(v_link.deal_id, p_buyer_id, 'photo_click', 'web', null, null, '{}'::jsonb);
    end loop;
  end if;
end $function$;

revoke all on function public.dispo_public_view(bigint, bigint, text, int, int, text, text) from public;
grant execute on function public.dispo_public_view(bigint, bigint, text, int, int, text, text) to service_role;

-- ------------------------------------------------------------ take an offer

/**
 * An offer made from the public page. Inbound by definition, attributed to the
 * buyer whose signed link was used, and logged as engagement so the deal board
 * turns the buyer hot without anyone retyping it.
 *
 * Returns the offer id, or null when the link does not take offers.
 */
create or replace function public.dispo_public_offer(
  p_link_id bigint,
  p_buyer_id bigint,
  p_amount numeric,
  p_terms jsonb default '{}'::jsonb,
  p_notes text default null
) returns bigint
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_link record; v_deal record; v_offer bigint; v_name text;
begin
  select id, workspace_id, deal_id, allow_offers into v_link
    from public.deal_public_links where id = p_link_id and active;
  if not found or not v_link.allow_offers then return null; end if;
  if p_buyer_id is null then return null; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then
    raise exception 'offer amount looks wrong' using errcode = '22023';
  end if;

  select id, property_id into v_deal from public.deals where id = v_link.deal_id;
  select coalesce(nullif(trim(name), ''), nullif(trim(company), ''), 'a buyer') into v_name
    from public.buyers where id = p_buyer_id;

  insert into public.offers
    (workspace_id, deal_id, property_id, buyer_id, direction, amount, status, basis, notes, terms, sent_at)
  values (v_link.workspace_id, v_link.deal_id, v_deal.property_id, p_buyer_id, 'inbound', p_amount,
          'received', 'buyer_portal', left(p_notes, 2000),
          coalesce(p_terms, '{}'::jsonb) || jsonb_build_object('source', 'public_listing', 'link_id', v_link.id),
          now())
  returning id into v_offer;

  perform public.dispo_log_engagement(v_link.deal_id, p_buyer_id, 'offer', 'web', null, null,
    jsonb_build_object('offer_id', v_offer, 'amount', p_amount));

  update public.dispo_campaign_recipients
     set offered_at = coalesce(offered_at, now()), updated_at = now()
   where deal_id = v_link.deal_id and buyer_id = p_buyer_id and offered_at is null;

  insert into public.activity (workspace_id, entity_type, entity_id, kind, title, body)
  values (v_link.workspace_id, 'deal', v_link.deal_id, 'offer',
          'Offer from ' || v_name || ' · $' || to_char(p_amount, 'FM999,999,999'),
          'Submitted from the public listing page');

  return v_offer;
end $function$;

revoke all on function public.dispo_public_offer(bigint, bigint, numeric, jsonb, text) from public;
grant execute on function public.dispo_public_offer(bigint, bigint, numeric, jsonb, text) to service_role;
