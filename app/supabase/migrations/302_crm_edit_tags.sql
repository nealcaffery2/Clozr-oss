-- 302 · Bulk tag edits in one statement.
--
-- lib/crm-write.ts editTags read 200 rows, then sent one UPDATE per row that
-- changed: tagging 1,000 leads was 5 reads and up to 1,000 updates, in order.
--
-- crm_edit_tags(p_ws, p_table, p_ids, p_add, p_remove) does it as one UPDATE
-- per call, with the rules of the TypeScript it replaces (nextTags):
--
--   * tags are trimmed; a blank one is ignored. Matching is exact (case kept).
--   * remove drops every copy of a tag; add appends it at the end, once, only
--     when the row does not already carry it. A null tags column reads as {}.
--   * only rows whose tags actually change are written, so webhooks, the tag
--     plan trigger (plan_on_seller_change) and updated_at fire for those alone.
--
-- The new tags are computed from the row being updated (crm_tags_edited in
-- the SET), so a tag another tab added a moment earlier is kept, not lost.
--
-- p_table is 'sellers' or 'buyers'; anything else raises. p_ws null means
-- every workspace the caller can write (the old path filtered only by id).
--
-- SECURITY INVOKER on purpose: this is a write, and the old path went through
-- RLS. buyers_update allows owner, admin, dispositions and sdr only; running
-- as the caller keeps that rule (and sellers_update's membership rule) exactly,
-- with no second copy of it here. A row RLS hides is skipped, as before.
--
-- Returns how many rows changed. Safe to re-run.

create or replace function public.crm_tags_edited(p_tags text[], p_add text[], p_remove text[])
returns text[]
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select array(select t from unnest(coalesce(p_tags, '{}')) with ordinality u(t, o)
                where coalesce(t <> all(coalesce(p_remove, '{}')), true) order by o)
      || array(select a from unnest(coalesce(p_add, '{}')) with ordinality u(a, o)
                where not coalesce(a = any(coalesce(p_tags, '{}')), false) order by o)
$$;

create or replace function public.crm_edit_tags(
  p_ws bigint, p_table text, p_ids bigint[], p_add text[] default '{}', p_remove text[] default '{}'
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_add text[] := array(
    select t from (select btrim(x) t, min(o) o from unnest(coalesce(p_add, '{}')) with ordinality u(x, o)
                    where btrim(x) <> '' group by btrim(x)) s order by o);
  v_remove text[] := array(select btrim(x) from unnest(coalesce(p_remove, '{}')) x where btrim(x) <> '');
  v_n integer;
begin
  if p_table is null or p_table not in ('sellers', 'buyers') then
    raise exception 'crm_edit_tags: % has no tags to edit', coalesce(p_table, 'null');
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 or (cardinality(v_add) = 0 and cardinality(v_remove) = 0) then
    return 0;
  end if;
  execute format($q$
    update public.%I r set tags = public.crm_tags_edited(r.tags, $3, $4)
     where r.id = any($1) and ($2::bigint is null or r.workspace_id = $2)
       and public.crm_tags_edited(r.tags, $3, $4) is distinct from coalesce(r.tags, '{}')
  $q$, p_table) using p_ids, p_ws, v_add, v_remove;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.crm_tags_edited(text[], text[], text[]) from public, anon;
grant execute on function public.crm_tags_edited(text[], text[], text[]) to authenticated;
revoke all on function public.crm_edit_tags(bigint, text, bigint[], text[], text[]) from public, anon;
grant execute on function public.crm_edit_tags(bigint, text, bigint[], text[], text[]) to authenticated;
