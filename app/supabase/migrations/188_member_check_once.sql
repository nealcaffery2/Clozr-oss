-- 188 · The membership check runs once per query, not once per row.
--
-- 113 policies on 87 tables read `is_workspace_member(workspace_id)`. That
-- function is SECURITY DEFINER, so Postgres cannot inline it: it is called
-- for every row a query looks at, about 130 µs each. The app's activity read
-- (newest 300 rows) looked at all 46,000 of the workspace's rows to sort
-- them and spent 7.4 s in the check alone, right at the 8 s statement
-- timeout. With the database busy, reads like it (and ingest_apply_flat
-- behind them) timed out, and website leads stopped reaching CLOZR on
-- 2026-10-08.
--
-- sellers, deals and properties already say
-- `workspace_id IN (SELECT my_workspace_ids())`, which Postgres evaluates
-- once into a hashed set and then checks each row against for free. Both say
-- the same thing (a row of a workspace the caller belongs to; a null
-- workspace_id passes neither), so every policy here is rewritten to it in
-- place: USING and WITH CHECK, nothing else about the policy changes.
--
-- Also an index for the activity read itself (workspace_id, occurred_at
-- desc): 7.4 s to 17 ms.
--
-- Both were applied on the live project ahead of this file, table by table
-- with a short lock wait (ALTER POLICY locks its table, and one transaction
-- over all 87 would hold every lock until the end), and the index built
-- without blocking writes. Here they are no-ops: the loop only touches a policy that
-- still has the old check, and the index already exists.

create index if not exists activity_ws_occurred_idx
  on public.activity (workspace_id, occurred_at desc);

do $$
declare
  p record;
  old_check constant text := 'is_workspace_member(workspace_id)';
  new_check constant text := '(workspace_id IN ( SELECT my_workspace_ids() AS my_workspace_ids))';
  stmt text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') like '%' || old_check || '%' or coalesce(with_check, '') like '%' || old_check || '%')
    order by tablename, policyname
  loop
    stmt := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if p.qual is not null then
      stmt := stmt || format(' using (%s)', replace(p.qual, old_check, new_check));
    end if;
    if p.with_check is not null then
      stmt := stmt || format(' with check (%s)', replace(p.with_check, old_check, new_check));
    end if;
    execute stmt;
  end loop;
end $$;
