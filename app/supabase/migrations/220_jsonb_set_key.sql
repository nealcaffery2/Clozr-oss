-- 220: write one key of a jsonb column without overwriting the rest.
--
-- A field saved from the client used to read the whole jsonb column, change
-- one key and write the whole object back, so two people editing different
-- keys of the same record (or one person with two tabs) silently undid each
-- other. jsonb_set_key changes the one key inside a single UPDATE, so the
-- database merges it with whatever is there now. lib/crm-write.ts
-- `patchJsonKey` is the client.
--
--   jsonb_set_key('deals', 42, 'extras', 'lockbox', '"1234"')  sets extras.lockbox
--   jsonb_set_key('deals', 42, 'extras', 'lockbox', null)      removes it
--
-- SECURITY INVOKER: it runs as the caller, so RLS and column grants decide
-- exactly what a direct update would. The table is resolved in `public` only,
-- the column must be jsonb, and identifiers are quoted with %I. Returns the
-- updated row as jsonb, or null when there is no such row (or RLS hides it).
-- Safe to run again.

-- A column that holds SQL null, JSON null, a scalar or an array (an older
-- client wrote one) is treated as an empty object, so setting a key works
-- instead of raising "cannot set path in scalar".
create or replace function public.jsonb_object_or_empty(p jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$ select case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end $$;

create or replace function public.jsonb_set_key(
  p_table text,
  p_id bigint,
  p_column text,
  p_key text,
  p_value jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rel regclass := to_regclass(format('public.%I', p_table));
  v_type text;
  v_row jsonb;
begin
  if p_key is null or p_key = '' then
    raise exception 'jsonb_set_key: a key is required' using errcode = '22023';
  end if;
  if v_rel is null then
    raise exception 'jsonb_set_key: no table public.%', p_table using errcode = '42P01';
  end if;
  select format_type(a.atttypid, a.atttypmod) into v_type
    from pg_attribute a
   where a.attrelid = v_rel and a.attname = p_column and a.attnum > 0 and not a.attisdropped;
  if v_type is distinct from 'jsonb' then
    raise exception 'jsonb_set_key: %.% is not a jsonb column', p_table, p_column using errcode = '22023';
  end if;
  execute format(
    'update public.%1$I set %2$I = case when $2 is null then public.jsonb_object_or_empty(%2$I) - $1'
    ' else jsonb_set(public.jsonb_object_or_empty(%2$I), array[$1], $2, true) end'
    ' where id = $3 returning to_jsonb(%1$I.*)',
    p_table, p_column
  ) using p_key, p_value, p_id into v_row;
  return v_row;
end;
$$;

revoke all on function public.jsonb_object_or_empty(jsonb) from public, anon;
grant execute on function public.jsonb_object_or_empty(jsonb) to authenticated, service_role;
revoke all on function public.jsonb_set_key(text, bigint, text, text, jsonb) from public, anon;
grant execute on function public.jsonb_set_key(text, bigint, text, text, jsonb) to authenticated, service_role;
