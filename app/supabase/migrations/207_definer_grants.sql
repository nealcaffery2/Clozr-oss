-- Who may call what. Every statement is a grant, a revoke or an alter, so the
-- file re-runs cleanly.

-- 1. wholesaler_top_buyers ran with its owner's rights and has no workspace
--    filter, so any signed-in user read every workspace's buyer volumes. As
--    the caller, wholesaler_deals' RLS (members of the row's workspace) and
--    wholesaler_entities' (the same, for wholesaler_root) decide. It is an
--    aggregate: select is the only privilege that means anything.
alter view public.wholesaler_top_buyers set (security_invoker = true);
revoke all on public.wholesaler_top_buyers from public, anon, authenticated;
grant select on public.wholesaler_top_buyers to authenticated;

-- (ingest_sources_public stays a definer view on purpose: it filters on
-- has_role(owner, admin) itself and exists to hide the secrets in settings.)

-- 2–4 run in one guarded block: a database built from this folder may lack a
-- function the dashboard made, and a revoke on a missing one would fail.
do $$
declare f text;
begin
  -- 2. Trigger functions. Nobody calls these over /rest/v1/rpc; a trigger
  --    fires them without checking EXECUTE.
  foreach f in array array[
    'public.ai_agent_started_ends_plan()',
    'public.ai_agent_started_stops_campaigns()',
    'public.communications_rep_from_line()',
    'public.dispo_recipient_skips_ai_agent()',
    'public.plan_started_stops_ai_agent()',
    'public.rep_phone_numbers_recredit()',
    'public.sms_flow_after_inbound()',
    'public.wholesaler_entity_recount()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
    end if;
  end loop;

  -- 3. Called only by the listing function, as the service role. Each writes
  --    into whatever workspace it is handed (buyers_list_opt_in inserted a
  --    buyer into any workspace for anyone holding the anon key); the listing
  --    function now names the workspace from a live page slug and rate-limits
  --    by IP before calling them.
  foreach f in array array[
    'public.buyers_list_opt_in(bigint, text, text, text, text[], text, boolean, bigint)',
    'public.dispo_public_offer(bigint, bigint, numeric, jsonb, text)',
    'public.dispo_public_view(bigint, bigint, text, integer, integer, text, text)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;

  -- 4. A rep's action (Dispo → Buyer page); it reads auth.uid(). Signed in only.
  if to_regprocedure('public.deal_public_link_ensure(bigint, text, text)') is not null then
    revoke execute on function public.deal_public_link_ensure(bigint, text, text) from public, anon;
    grant execute on function public.deal_public_link_ensure(bigint, text, text) to authenticated;
  end if;
end $$;

-- 5. The pre-listing-function public page API, gated by a slug or a track
--    token. Nothing in CLOZR calls these (the /deal page, the marketplace,
--    unsubscribe, esign and docs-public all go through edge functions) and
--    the API log has no calls; anon keeps nothing it does not use.
-- These were made in the dashboard, not by a migration, so a database built
-- from this folder may not have them.
do $$
declare f text;
begin
  foreach f in array array[
    'public.buy_box_form(text)',
    'public.submit_buy_box(text, jsonb, text)',
    'public.deal_listing(text)',
    'public.submit_deal_offer(text, jsonb, text)',
    'public.track_deal_view(text, text, text, integer, integer, text, text)',
    'public.record_email_open(text)',
    'public.record_link_click(text, text)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon', f);
    end if;
  end loop;
end $$;

-- 6. A fixed search_path on the functions the advisor flags, so a caller's
--    path cannot change what their unqualified names resolve to. Some were
--    made in the dashboard, so each is skipped where it does not exist.
do $$
declare f text;
begin
  foreach f in array array[
    'public.comm_status_rank(text)',
    'public.compr_report_lead_link(text)',
    'public.deal_auto_archive()',
    'public.deals_compr_report_lead_link()',
    'public.disposition_num(jsonb, text)',
    'public.plan_skipped_by_tag(text[], jsonb)',
    'public.seller_merged_into(text[], text, text)',
    'public.source_is_national(text, text, text, text[])',
    'public.touch_wholesaler_entity()',
    'public.webhook_events()',
    'public.webhook_record_url(text, bigint)',
    'public.wholesaler_root(bigint)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('alter function %s set search_path = public, pg_temp', f);
    end if;
  end loop;
end $$;
