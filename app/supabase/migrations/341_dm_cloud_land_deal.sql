-- 341 · Deal Machine Cloud lands a find's deal in one call.
--
-- deal-machine-cloud land() made, for each find that passed, after
-- ingest_apply: a read of the deal by source_id (a seq scan of the workspace's
-- deals), the deal update or insert, a
-- read of the deal's file urls and the insert of the new photo links. Four
-- round trips per landed find, and the two reads ignored their errors (a
-- failed deal read inserted a second deal).
--
-- dm_cloud_land_deal(p_ws, p_source_id, p_property_id, p_seller_id,
-- p_submitted_at, p_cols, p_links) does the four in one transaction, with the
-- same writes:
--
--   1. The deal with source 'deal_machine' and this source_id in p_ws, lowest
--      id first. Found: only the columns in p_cols are set (ingest-deal.ts
--      dealColumns leaves out absent fields so they never blank a value, and
--      an UPDATE OF trigger fires only for a column the old update listed),
--      seller_id only when the deal has none, and updated_at. Not found:
--      inserted at stage Prospect with p_cols, created = true.
--   2. The p_links ([{kind, name, url}], dealLinks) the deal does not have
--      yet (by url), in order, source 'deal_machine'.
--
-- A transaction advisory lock on (workspace, source_id) makes find-or-insert
-- one step: two overlapping lands of the same find queue, and the second
-- finds the first's deal. Every row read or written is in p_ws. A p_cols key
-- outside the Deal Tracker columns raises (PostgREST raised on an unknown
-- column too).
--
-- Returns {"deal_id": n, "created": bool}. Service role only
-- (deal-machine-cloud, which falls back to the four calls while this is
-- missing). Safe to re-run.

create or replace function public.dm_cloud_land_deal(
  p_ws bigint, p_source_id text, p_property_id bigint, p_seller_id bigint,
  p_submitted_at timestamptz, p_cols jsonb, p_links jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cols jsonb := coalesce(p_cols, '{}'::jsonb);
  v_keys text[];
  v_row jsonb;
  v_id bigint;
  v_seller bigint;
  v_created boolean := false;
begin
  if p_ws is null or p_source_id is null or p_property_id is null then
    raise exception 'dm_cloud_land_deal: p_ws, p_source_id and p_property_id are required';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(v_cols) k;
  if not v_keys <@ array['asking_price', 'offer_amount', 'arv', 'rehab', 'mao', 'assignment_fee', 'marketed_price',
      'marketed_fee', 'dispo_fee', 'earnest_money', 'transaction_type', 'contract_status', 'lead_source', 'acq_agent',
      'dispo_agent', 'lead_manager', 'coordinator', 'motivation', 'market', 'notes'] then
    raise exception 'dm_cloud_land_deal: p_cols names a column it does not set (%)', array_to_string(v_keys, ', ');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dm_cloud_land_deal:' || p_ws || ':' || p_source_id, 0));

  select d.id, d.seller_id into v_id, v_seller
    from public.deals d
   where d.workspace_id = p_ws and d.source = 'deal_machine' and d.source_id = p_source_id
   order by d.id
   limit 1;

  if v_id is not null then
    execute format('update public.deals d set %s from jsonb_populate_record(null::public.deals, $1) r where d.id = $2 and d.workspace_id = $4',
      concat_ws(', ',
        (select string_agg(format('%1$I = r.%1$I', k), ', ') from unnest(v_keys) k),
        case when v_seller is null then 'seller_id = $3' end,
        'updated_at = now()'))
      using v_cols, v_id, p_seller_id, p_ws;
  else
    v_row := v_cols || jsonb_build_object('workspace_id', p_ws, 'property_id', p_property_id, 'seller_id', p_seller_id,
      'stage', 'Prospect', 'source', 'deal_machine', 'source_id', p_source_id, 'submitted_at', coalesce(p_submitted_at, now()));
    execute format('insert into public.deals (%1$s) select %1$s from jsonb_populate_record(null::public.deals, $1) returning id',
      (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(v_row) k))
      into v_id
      using v_row;
    v_created := true;
  end if;

  insert into public.deal_files (workspace_id, deal_id, source, kind, name, url)
  select p_ws, v_id, 'deal_machine', e.v->>'kind', e.v->>'name', e.v->>'url'
    from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) with ordinality as e(v, ord)
   where e.v->>'url' is not null
     and not exists (select 1 from public.deal_files f where f.workspace_id = p_ws and f.deal_id = v_id and f.url = e.v->>'url')
   order by e.ord
  on conflict do nothing;

  return jsonb_build_object('deal_id', v_id, 'created', v_created);
end
$$;

revoke all on function public.dm_cloud_land_deal(bigint, text, bigint, bigint, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.dm_cloud_land_deal(bigint, text, bigint, bigint, timestamptz, jsonb, jsonb) to service_role;
