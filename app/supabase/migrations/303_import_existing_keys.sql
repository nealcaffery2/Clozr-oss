-- 303 · The import's duplicate check reads the workspace in one call.
--
-- lib/import.ts reviewDuplicates read every seller, buyer or vendor of the
-- workspace 1,000 rows a request, one page after the other, often over
-- a hundred pages, before the review
-- screen could show anything.
--
-- import_existing_keys(p_ws, p_kind) answers the same rows as one json array,
-- the same columns the pages selected, ordered by id as they were:
--
--   sellers  id, name, phone, email, property_id, property_address, source_id, lead_stage
--   buyers   id, name, company, phone, email, source_id, status
--   vendors  id, business_name, contact_name, phone, email, service_type
--
-- STABLE, SECURITY INVOKER: row security answers exactly as it did for the
-- pages (buyers_select keeps its role list, sellers and vendors membership),
-- so a member who could not read a buyer still cannot. work_mem 32 MB so the
-- sort by id stays in memory (a large buyers table spilled to disk at the
-- default).
--
-- Any other p_kind raises. Reads only. Safe to re-run.

create or replace function public.import_existing_keys(p_ws bigint, p_kind text)
returns json
language plpgsql
stable
security invoker
set search_path = public, pg_temp
set work_mem = '32MB'
as $$
begin
  if p_kind = 'sellers' then
    return (select coalesce(json_agg(row_to_json(x) order by x.id), '[]'::json) from (
      select id, name, phone, email, property_id, property_address, source_id, lead_stage
        from public.sellers where workspace_id = p_ws) x);
  elsif p_kind = 'buyers' then
    return (select coalesce(json_agg(row_to_json(x) order by x.id), '[]'::json) from (
      select id, name, company, phone, email, source_id, status
        from public.buyers where workspace_id = p_ws) x);
  elsif p_kind = 'vendors' then
    return (select coalesce(json_agg(row_to_json(x) order by x.id), '[]'::json) from (
      select id, business_name, contact_name, phone, email, service_type
        from public.vendors where workspace_id = p_ws) x);
  end if;
  raise exception 'import_existing_keys: % is not an import kind', coalesce(p_kind, 'null');
end $$;

revoke all on function public.import_existing_keys(bigint, text) from public, anon;
grant execute on function public.import_existing_keys(bigint, text) to authenticated;
