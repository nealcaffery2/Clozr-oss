-- 261 · The buyers read without the empty buy-box skeleton, and realtime
-- without two tables nobody listens to.
--
-- crm_buyers (259) sent every buyer's criteria as stored: a large object of
-- nulls, empty strings and empty arrays for a buyer who never filled a buy
-- box. crm_buy_box_slim() drops null, "", [] and {} values at the two levels
-- the buy box has. lib/buyer-profile normalizeBuyBox() rebuilds every missing
-- key from emptyBuyBox(), so the buyer the app shows is the same.
--
-- One edge kept as it was: lib/crm.ts mapBuyer() reads a criteria with no
-- keys at all as "never set" and falls back to markets / max_purchase_price.
-- An all-empty skeleton never took that path, so it comes back as
-- {"price":{}} (still empty to normalizeBuyBox, still one key to mapBuyer).
-- A criteria that is null or {} in the table is sent unchanged.
--
-- Realtime: discovery_jobs and inbox_threads are in supabase_realtime but no
-- client subscribes to either (lib/, app/, components/, functions: no
-- postgres_changes on them), so their writes were decoded for nothing.
--
-- Safe to re-run.

create or replace function public.crm_buy_box_slim(c jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when c is null or jsonb_typeof(c) <> 'object' or c = '{}'::jsonb then c
    else coalesce((
      select jsonb_object_agg(k, v2)
        from (
          select k, case when jsonb_typeof(v) = 'object' then coalesce((
                   select jsonb_object_agg(k2, v3) from jsonb_each(v) e2(k2, v3)
                    where v3 not in ('""'::jsonb, '[]'::jsonb, '{}'::jsonb)), '{}'::jsonb)
                 else v end v2
            from jsonb_each(jsonb_strip_nulls(c)) e(k, v)
        ) s
       where v2 not in ('""'::jsonb, '[]'::jsonb, '{}'::jsonb)), '{"price":{}}'::jsonb)
  end;
$$;

create or replace function public.crm_buyers(p_ws bigint, p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_ws in (select public.my_role_workspace_ids('owner', 'admin', 'dispositions', 'sdr', 'tc', 'member')) then jsonb_build_object(
      'ids', case when p_since is null then null else coalesce((
        select jsonb_agg(b.id order by b.id)
          from public.buyers b
         where b.workspace_id = p_ws and b.source is distinct from 'dispogenius-free-agents'), '[]'::jsonb) end,
      'rows', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.name, x.id)
          from (
            select b.id, b.name, b.company, b.email, b.phone, b.markets, b.max_purchase_price, b.buy_box, b.status,
                   b.notes, b.source, b.buyer_type, b.entity_type, public.crm_buy_box_slim(b.criteria) as criteria,
                   b.vetted_at, b.vip, b.blacklisted_at,
                   b.preferred_channel, b.created_at, b.created_by, b.last_activity_at, b.tags, b.updated_at,
                   b.assigned_to, b.archived_at
              from public.buyers b
             where b.workspace_id = p_ws and b.source is distinct from 'dispogenius-free-agents'
               and (p_since is null or b.updated_at >= p_since)
          ) x), '[]'::jsonb))
    else null
  end;
$$;

do $$
declare t text;
begin
  foreach t in array array['discovery_jobs', 'inbox_threads'] loop
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;
