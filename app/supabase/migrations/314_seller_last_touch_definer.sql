-- 314 · seller_last_touch as security definer with one membership check.
--
-- 282 left it security invoker, so sellers_select ran on every live seller
-- of the workspace. lib/crm.ts only calls it when the seller rows came from
-- the paged fallback (rowsCarryLastTouch), so it runs when the database is
-- already struggling: about half a second mean in pg_stat_statements
-- (most of those calls predate 282's columns; the calls since average about
-- 200 ms), against ~45 ms run directly.
--
-- Same signature (jsonb), same rows, same order (the body is 282's), granted
-- to authenticated only. Not a member: '[]', what the policy answered before.
-- Measured as an acquisitions rep: output identical (md5). Safe to re-run.

create or replace function public.seller_last_touch(p_workspace bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_workspace in (select public.my_workspace_ids()) then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id,
               'channel', s.last_touch_channel,
               'occurred_at', s.last_touch_at
             ))
        from public.sellers s
       where s.workspace_id = p_workspace
         and s.archived_at is null
         and s.last_touch_at is not null), '[]'::jsonb)
    else '[]'::jsonb
  end;
$$;

revoke all on function public.seller_last_touch(bigint) from public, anon, service_role;
grant execute on function public.seller_last_touch(bigint) to authenticated;
