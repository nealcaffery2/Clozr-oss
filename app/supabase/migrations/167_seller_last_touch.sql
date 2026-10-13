-- 167 · One round trip for "last contact" on every seller.
--
-- The shell used to embed each seller's latest communication and page that
-- a thousand sellers at a time. Workspace 11 has ~12k live sellers, so opening
-- CLOZR waited on a dozen of those reads before People could say who had
-- been touched. This returns the same answer as one jsonb value. The
-- (seller_id, occurred_at desc) index serves the lateral lookup.
--
-- The sellers list itself is ordered by created_at, id among live rows.
-- sellers_workspace_idx is (workspace_id, updated_at), so each page sorted.
-- The partial index matches that order.

create index if not exists sellers_workspace_live_created_idx
  on public.sellers (workspace_id, created_at desc, id desc)
  where archived_at is null;

create or replace function public.seller_last_touch(p_workspace bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'channel', c.channel,
    'occurred_at', c.occurred_at
  )), '[]'::jsonb)
  from public.sellers s
  join lateral (
    select channel, occurred_at
    from public.communications
    where seller_id = s.id
    order by occurred_at desc
    limit 1
  ) c on true
  where s.workspace_id = p_workspace
    and s.archived_at is null;
$$;

revoke all on function public.seller_last_touch(bigint) from public;
grant execute on function public.seller_last_touch(bigint) to authenticated;
