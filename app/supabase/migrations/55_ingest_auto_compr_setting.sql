-- 55 · A per-key switch for the provider on ingested deals.
--
-- The ingest function underwrites a deal it just created when the sender asks
-- (options.run_compr, the Deal Machine extension's "Auto-run underwriting" toggle)
-- unless the key's settings say auto_compr = 'off'. Without this migration the
-- sender's toggle alone decides; this lets an owner/admin veto it per key:
--   select public.set_ingest_setting(<key id>, 'auto_compr', 'off');
-- Same function as migration 41, one more whitelisted key.

create or replace function public.set_ingest_setting(p_id bigint, p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare ws bigint; v_name text;
begin
  select workspace_id, name into ws, v_name from public.ingest_sources where id = p_id;
  if ws is null or not public.has_role(ws, 'owner', 'admin') then
    raise exception 'only an owner or admin can change a key' using errcode = '42501';
  end if;
  if p_key = 'creates' and p_value in ('seller', 'buyer') then null;
  elsif p_key = 'auto_compr' and p_value in ('on', 'off') then null;
  elsif p_key = 'jotform_api_key' and v_name = 'jotform' and length(coalesce(p_value, '')) between 16 and 128 then null;
  else raise exception 'unsupported setting' using errcode = '22023';
  end if;
  update public.ingest_sources
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = p_id;
end $$;
revoke all on function public.set_ingest_setting(bigint, text, text) from public, anon;
grant execute on function public.set_ingest_setting(bigint, text, text) to authenticated;
