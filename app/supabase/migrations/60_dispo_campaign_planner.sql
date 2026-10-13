-- The campaign planner: deal + audience -> the phased payload launch expects.
--
-- dispo_campaign_launch already does the hard part (freezing the audience,
-- suppression, channel preferences, the safety check). What nothing did was
-- compose what goes in: who gets which message, in which order, at what minute.
-- That is this file.
--
-- The shape, copied from what the market expects of a blast:
--   intro  (sms)            t0
--   brief  (sms or email)   t0 + brief_delay
--   followup xN             each + its own delay, only_if_no_reply
--
-- Three things decide the minute a message goes out:
--   * the send window      next_send_slot() pushes it to the next open hour
--   * the stagger          successive buyers are spaced, so 400 texts are not
--                          one burst that reads as spam to a carrier
--   * the VIP head start   VIPs get the deal first, by however many minutes

-- ------------------------------------------------------------ strict merge

/**
 * Render {{tags}} from a jsonb bag, returning NULL if any tag is left
 * unresolved or resolves to blank. Null is the point: the safety check blocks a
 * campaign whose bodies still contain a merge tag, so the planner uses null to
 * mean "fall back to the generic line" rather than send "a flip on  about  ago".
 */
create or replace function public.dispo_render_strict(p_body text, p_fields jsonb)
returns text
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare v_out text := p_body; v_tag text; v_val text;
begin
  if p_body is null then return null; end if;
  for v_tag in select distinct m[1] from regexp_matches(p_body, '\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}', 'g') m loop
    v_val := nullif(trim(coalesce(p_fields->>v_tag, '')), '');
    if v_val is null then return null; end if;
    v_out := regexp_replace(v_out, '\{\{\s*' || v_tag || '\s*\}\}', v_val, 'g');
  end loop;
  -- Anything still wearing braces means a tag we do not know how to fill.
  if v_out ~ '\{\{' then return null; end if;
  return v_out;
end $function$;

revoke all on function public.dispo_render_strict(text, jsonb) from public;
grant execute on function public.dispo_render_strict(text, jsonb) to authenticated, service_role;

-- ------------------------------------------------------------ the planner

/**
 * The recipients payload for dispo_campaign_launch, fully composed.
 *
 * p_links maps buyer id to that buyer's signed listing URL (the `listing`
 * function's /links route mints them). A buyer with no link still gets the
 * messages, just without the {{listing_url}} line, because an unresolved tag
 * would block the whole campaign.
 *
 * Read-only: it plans, it does not send. Call dispo_campaign_create to do both.
 */
create or replace function public.dispo_campaign_plan(
  p_deal_id bigint,
  p_snapshot_id bigint default null,
  p_links jsonb default '{}'::jsonb,
  p_templates jsonb default '{}'::jsonb,
  p_options jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  d record; b record; v_ws bigint;
  v_tz text; v_days smallint[]; v_start smallint; v_end smallint;
  v_t0 timestamptz; v_stagger int; v_throttle int; v_gap int;
  v_vip_head int; v_brief_delay int; v_email_on boolean; v_sms_first boolean;
  v_rep text; v_fields jsonb; v_out jsonb := '[]'::jsonb; v_msgs jsonb;
  v_body text; v_subject text; v_at timestamptz; v_i int := 0;
  v_intro text; v_intro_fb text; v_brief_sms text; v_brief_sub text; v_brief_body text;
  v_fu jsonb; v_fu_body text; v_n int;
  v_price text; v_arv text;
begin
  select dl.*, p.line1, p.city, p.state, p.zip, p.beds, p.baths, p.sqft, p.property_type
    into d
  from public.deals dl left join public.properties p on p.id = dl.property_id
  where dl.id = p_deal_id;
  if not found then raise exception 'deal not found' using errcode = '22023'; end if;
  v_ws := d.workspace_id;
  if not public.has_role(v_ws, 'owner', 'admin', 'dispositions') then
    raise exception 'not allowed on this workspace' using errcode = '42501';
  end if;

  -- delivery shape
  v_tz       := coalesce(nullif(p_options->>'timezone',''), d.property_timezone, 'America/Chicago');
  v_days     := coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(p_options->'send_days') x), '{1,2,3,4,5}'::smallint[]);
  v_start    := coalesce((p_options->>'send_start_hour')::smallint, 9);
  v_end      := coalesce((p_options->>'send_end_hour')::smallint, 19);
  v_throttle := greatest(1, coalesce((p_options->>'throttle_per_hour')::int, 200));
  v_gap      := greatest(1, (3600 / v_throttle));
  v_stagger  := greatest(v_gap, coalesce((p_options->>'stagger_seconds')::int, 20));
  v_vip_head := greatest(0, least(coalesce((p_options->>'vip_head_start_minutes')::int, 0), 1440));
  v_brief_delay := greatest(0, coalesce((p_options->>'brief_delay_minutes')::int, 10));
  v_email_on := coalesce((p_options->>'email_enabled')::boolean, false);
  v_sms_first := coalesce((p_options->>'sms_first')::boolean, true);

  -- Anchor once, inside the window. Offsets are added to this, not to now():
  -- adding them first and snapping after collapses every buyer onto the same
  -- opening minute whenever the campaign is planned outside working hours.
  v_t0 := public.next_send_slot(
            greatest(now(), coalesce((p_options->>'start_at')::timestamptz, now())),
            v_tz, v_days, v_start, v_end);

  select coalesce(nullif(trim(split_part(coalesce(full_name, ''), ' ', 1)), ''), 'your rep')
    into v_rep from public.profiles where id = auth.uid();
  v_rep := coalesce(v_rep, 'your rep');

  v_price := case when d.asking_price is not null then '$' || to_char(d.asking_price, 'FM999,999,999') end;
  v_arv   := case when d.arv is not null then '$' || to_char(d.arv, 'FM999,999,999') end;

  -- templates, with generics that never leave a hole
  v_intro     := coalesce(nullif(p_templates->>'intro_sms',''),
                 'Hey {{first_name}}, it''s {{rep_first_name}}. Got a {{property_type}} in {{city}} that looks like your buy box. Want the details?');
  v_intro_fb  := coalesce(nullif(p_templates->>'intro_sms_fallback',''),
                 'Hi, it''s {{rep_first_name}}. Got a deal in {{city}} that may fit what you buy. Want the details?');
  v_brief_sms := coalesce(nullif(p_templates->>'brief_sms',''),
                 '{{address}} - {{price}}. Full numbers and photos here: {{listing_url}}');
  v_brief_sub := coalesce(nullif(p_templates->>'brief_email_subject',''), 'Off-market: {{address}}');
  v_brief_body:= coalesce(nullif(p_templates->>'brief_email_body',''),
                 'Hi {{first_name}},' || chr(10) || chr(10) ||
                 '{{address}} is available at {{price}}.' || chr(10) ||
                 'Full numbers, photos and an offer form: {{listing_url}}' || chr(10) || chr(10) ||
                 '{{rep_first_name}}');

  -- audience: the frozen snapshot when there is one, else current matches
  for b in
    select bu.id, bu.name, bu.company, bu.vip, bu.level, bu.wants_follow_ups,
           coalesce(s.score, m.score, 0) as score
      from public.buyers bu
      left join public.dispo_match_snapshot_rows s
        on p_snapshot_id is not null and s.snapshot_id = p_snapshot_id and s.buyer_id = bu.id and not s.excluded
      left join public.deal_buyer_matches m
        on p_snapshot_id is null and m.deal_id = p_deal_id and m.buyer_id = bu.id
     where bu.workspace_id = v_ws
       and bu.blacklisted_at is null
       and lower(coalesce(bu.status,'')) <> 'inactive'
       and ((p_snapshot_id is not null and s.buyer_id is not null)
         or (p_snapshot_id is null and m.buyer_id is not null))
     order by bu.vip desc nulls last, coalesce(bu.level,0) desc, coalesce(s.score, m.score, 0) desc, bu.id
  loop
    v_fields := jsonb_strip_nulls(jsonb_build_object(
      'first_name', nullif(trim(split_part(coalesce(b.name, ''), ' ', 1)), ''),
      'company', nullif(trim(coalesce(b.company, '')), ''),
      'rep_first_name', v_rep,
      'address', nullif(trim(coalesce(d.line1, '')), ''),
      'city', nullif(trim(coalesce(d.city, '')), ''),
      'state', nullif(trim(coalesce(d.state, '')), ''),
      'property_type', coalesce(nullif(trim(coalesce(d.property_type, '')), ''), 'property'),
      'price', v_price,
      'arv', v_arv,
      'beds', nullif(d.beds::text, ''),
      'baths', nullif(d.baths::text, ''),
      'sqft', nullif(d.sqft::text, ''),
      'listing_url', nullif(trim(coalesce(p_links->>b.id::text, '')), '')
    ));

    -- Where this buyer sits in the queue, and whether they are in the early group.
    v_at := v_t0
          + make_interval(secs => v_i * v_stagger)
          + case when coalesce(b.vip, false) then interval '0' else make_interval(mins => v_vip_head) end;
    v_at := public.next_send_slot(v_at, v_tz, v_days, v_start, v_end);
    v_i := v_i + 1;

    v_msgs := '[]'::jsonb;

    -- intro sms: personal line when every field is there, generic when not
    v_body := coalesce(public.dispo_render_strict(v_intro, v_fields),
                       public.dispo_render_strict(v_intro_fb, v_fields));
    if v_body is not null then
      v_msgs := v_msgs || jsonb_build_object(
        'channel', 'sms', 'kind', 'intro', 'seq', 0,
        'body', v_body, 'send_at', v_at, 'only_if_no_reply', false);
    end if;

    -- the brief, carrying the tracked listing link
    v_at := public.next_send_slot(v_at + make_interval(mins => v_brief_delay), v_tz, v_days, v_start, v_end);
    if v_sms_first then
      v_body := public.dispo_render_strict(v_brief_sms, v_fields);
      if v_body is not null then
        v_msgs := v_msgs || jsonb_build_object(
          'channel', 'sms', 'kind', 'brief', 'seq', 1,
          'body', v_body, 'send_at', v_at, 'only_if_no_reply', true);
      end if;
    end if;
    if v_email_on then
      v_body := public.dispo_render_strict(v_brief_body, v_fields);
      v_subject := public.dispo_render_strict(v_brief_sub, v_fields);
      if v_body is not null and v_subject is not null then
        v_msgs := v_msgs || jsonb_build_object(
          'channel', 'email', 'kind', 'brief', 'seq', 1,
          'subject', v_subject, 'body', v_body, 'send_at', v_at, 'only_if_no_reply', true);
      end if;
    end if;

    -- follow-ups, each only if they have not replied by then
    if coalesce(b.wants_follow_ups, true) then
      v_n := 2;
      for v_fu in select * from jsonb_array_elements(coalesce(p_templates->'followups', '[]'::jsonb)) loop
        v_at := public.next_send_slot(
                  v_at + make_interval(hours => greatest(1, coalesce((v_fu->>'delay_hours')::int, 24))),
                  v_tz, v_days, v_start, v_end);
        v_fu_body := public.dispo_render_strict(v_fu->>'body', v_fields);
        continue when v_fu_body is null;
        if coalesce(v_fu->>'channel', 'sms') = 'email' then
          continue when not v_email_on;
          v_subject := public.dispo_render_strict(coalesce(nullif(v_fu->>'subject',''), v_brief_sub), v_fields);
          continue when v_subject is null;
          v_msgs := v_msgs || jsonb_build_object('channel', 'email', 'kind', 'followup', 'seq', v_n,
            'subject', v_subject, 'body', v_fu_body, 'send_at', v_at, 'only_if_no_reply', true);
        else
          v_msgs := v_msgs || jsonb_build_object('channel', 'sms', 'kind', 'followup', 'seq', v_n,
            'body', v_fu_body, 'send_at', v_at, 'only_if_no_reply', true);
        end if;
        v_n := v_n + 1;
      end loop;
    end if;

    continue when jsonb_array_length(v_msgs) = 0;

    v_out := v_out || jsonb_build_object(
      'buyer_id', b.id,
      'level', b.level,
      'probability', least(95, greatest(0, b.score)),
      'messages', v_msgs);
  end loop;

  return v_out;
end $function$;

revoke all on function public.dispo_campaign_plan(bigint, bigint, jsonb, jsonb, jsonb) from public;
grant execute on function public.dispo_campaign_plan(bigint, bigint, jsonb, jsonb, jsonb) to authenticated, service_role;

-- ------------------------------------------------------------ plan and launch

/**
 * Plan a campaign and launch it in one transaction. If the safety check inside
 * dispo_campaign_launch refuses, the whole thing unwinds and nothing is queued.
 * Pass p_dry_run to see the plan and the recipient count without sending.
 */
create or replace function public.dispo_campaign_create(
  p_deal_id bigint,
  p_snapshot_id bigint default null,
  p_links jsonb default '{}'::jsonb,
  p_templates jsonb default '{}'::jsonb,
  p_options jsonb default '{}'::jsonb,
  p_delivery jsonb default '{}'::jsonb,
  p_dry_run boolean default false
) returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare v_recipients jsonb; v_campaign bigint; v_msgs int;
begin
  v_recipients := public.dispo_campaign_plan(p_deal_id, p_snapshot_id, p_links, p_templates, p_options);

  select coalesce(sum(jsonb_array_length(r->'messages')), 0) into v_msgs
    from jsonb_array_elements(v_recipients) r;

  if p_dry_run then
    return jsonb_build_object(
      'ok', jsonb_array_length(v_recipients) > 0,
      'dry_run', true,
      'recipients', jsonb_array_length(v_recipients),
      'messages', v_msgs,
      'first', v_recipients->0);
  end if;

  if jsonb_array_length(v_recipients) = 0 then
    raise exception 'nothing to send: no buyer produced a usable message' using errcode = '22023';
  end if;

  v_campaign := public.dispo_campaign_launch(
    (select workspace_id from public.deals where id = p_deal_id),
    p_deal_id,
    coalesce(p_options, '{}'::jsonb) || jsonb_build_object('snapshot_id', p_snapshot_id),
    coalesce(p_delivery, '{}'::jsonb),
    v_recipients);

  return jsonb_build_object(
    'ok', true,
    'campaign_id', v_campaign,
    'recipients', jsonb_array_length(v_recipients),
    'messages', v_msgs,
    'safety', public.dispo_campaign_safety_check(v_campaign));
end $function$;

revoke all on function public.dispo_campaign_create(bigint, bigint, jsonb, jsonb, jsonb, jsonb, boolean) from public;
grant execute on function public.dispo_campaign_create(bigint, bigint, jsonb, jsonb, jsonb, jsonb, boolean) to authenticated, service_role;
